/**
 * Routes: file CRUD + patch + append.
 *
 * Each handler MUST be parse → call → respond. All file-content behavior
 * (path resolution, content-type detection, atomic write, indexing decision,
 * patch edit application) lives in `src/vault/files.ts`. A handler that
 * needs a helper function probably belongs in the core.
 */

import grayMatter from "gray-matter";
import type { Context, Hono } from "hono";
import { InvalidBodyError, InvalidQueryError, UnsupportedMediaTypeError } from "../../errors.ts";
import { AppendBody, ListFilesQuery, PatchFileBody, PutMarkdownBody } from "../../schemas/index.ts";
import { isMarkdownPath, isPdfPath } from "../../vault/contentType.ts";
import {
  appendFile,
  deleteFile,
  listFiles,
  patchFile,
  readFile,
  writeFile,
} from "../../vault/files.ts";
import { extractPdfMarkdown } from "../../vault/pdfText.ts";
import { getParam } from "./params.ts";
import type { RouteDeps } from "./types.ts";
import { zodIssuesToInvalidInput } from "./zod.ts";

async function readBodyBytes(c: Context): Promise<Uint8Array> {
  const buf = await c.req.arrayBuffer();
  return new Uint8Array(buf);
}

function isJsonContentType(c: Context): boolean {
  const ct = c.req.header("content-type") ?? "";
  return ct.toLowerCase().includes("application/json");
}

function frontmatterToObject(fm: unknown): Record<string, unknown> {
  if (fm === null || typeof fm !== "object" || Array.isArray(fm)) return {};
  // Coerce Date values to ISO strings so the JSON variant emits stable keys.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm as Record<string, unknown>)) {
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

/**
 * Mount file routes on `app` under `/v1/vaults/:slug/files`. We register on
 * the main app (rather than a sub-app via `app.route`) so the `:slug` param
 * is visible to every handler and Hono's path matchers can disambiguate the
 * `:append` suffix from a regular wildcard tail.
 */
export function mountFileRoutes(app: Hono, deps: RouteDeps): void {
  // GET /v1/vaults/:slug/files — list.
  app.get("/v1/vaults/:slug/files", async (c) => {
    const raw = c.req.query();
    const parsed = ListFilesQuery.safeParse(raw);
    if (!parsed.success) {
      throw new InvalidQueryError("invalid list-files query", {
        issues: parsed.error.issues,
      });
    }
    const slug = getParam(c, "slug");
    const opts: { prefix?: string; limit?: number; cursor?: string } = {
      limit: parsed.data.limit,
    };
    if (parsed.data.prefix !== undefined) opts.prefix = parsed.data.prefix;
    if (parsed.data.cursor !== undefined) opts.cursor = parsed.data.cursor;
    const result = await listFiles(deps, slug, opts);
    return c.json(result);
  });

  // POST /v1/vaults/:slug/files/*path:append — must be matched before the
  // generic PUT/PATCH/GET wildcards. Hono matches in registration order.
  app.post("/v1/vaults/:slug/files/:path{.+:append}", async (c) => {
    const slug = getParam(c, "slug");
    const raw = getParam(c, "path");
    const path = raw.replace(/:append$/, "");
    let bytes: Uint8Array;
    if (isJsonContentType(c)) {
      let parsed: unknown;
      try {
        parsed = await c.req.json();
      } catch {
        throw new InvalidBodyError("body is not valid JSON");
      }
      const result = AppendBody.safeParse(parsed);
      if (!result.success) throw zodIssuesToInvalidInput(result.error);
      bytes = new TextEncoder().encode(result.data.content);
    } else {
      bytes = await readBodyBytes(c);
    }
    const out = await appendFile(deps, slug, path, bytes);
    return c.json({ ...out, created: false });
  });

  // GET /v1/vaults/:slug/files/*path — read.
  app.get("/v1/vaults/:slug/files/:path{.+}", async (c) => {
    const slug = getParam(c, "slug");
    const path = getParam(c, "path");
    const accept = c.req.header("accept") ?? "";
    const wantsJson = accept.includes("application/json");
    const result = await readFile(deps, slug, path);
    if (wantsJson) {
      if (isMarkdownPath(path)) {
        const text = new TextDecoder().decode(result.bytes);
        const parsed = grayMatter(text);
        return c.json({
          path: result.path,
          content: parsed.content,
          frontmatter: frontmatterToObject(parsed.data),
          mtimeMs: result.mtimeMs,
          size: result.size,
          sha256: result.sha256,
        });
      }
      if (isPdfPath(path)) {
        // PDFs return extracted text (no frontmatter). Parse failure throws
        // PdfExtractionError → mapped to 422 `extraction_failed`. `size`/
        // `sha256` still describe the on-disk bytes.
        const extraction = await extractPdfMarkdown(result.bytes);
        return c.json({
          path: result.path,
          content: extraction.markdown,
          contentType: result.contentType,
          pdf: { pages: extraction.pages, hasTextLayer: extraction.hasTextLayer },
          mtimeMs: result.mtimeMs,
          size: result.size,
          sha256: result.sha256,
        });
      }
      // Spec: JSON variant on any other non-Markdown, non-PDF file → 406.
      return c.json(
        {
          error: {
            code: "unsupported_media_type",
            message: "JSON variant is only available for Markdown and PDF files",
            details: { path },
          },
        },
        406,
      );
    }
    return new Response(result.bytes, {
      status: 200,
      headers: {
        "content-type": result.contentType,
        "content-length": String(result.bytes.byteLength),
      },
    });
  });

  // PUT /v1/vaults/:slug/files/*path — create / replace.
  app.put("/v1/vaults/:slug/files/:path{.+}", async (c) => {
    const slug = getParam(c, "slug");
    const path = getParam(c, "path");
    let result: Awaited<ReturnType<typeof writeFile>>;
    if (isJsonContentType(c)) {
      let raw: unknown;
      try {
        raw = await c.req.json();
      } catch {
        throw new InvalidBodyError("body is not valid JSON");
      }
      const parsed = PutMarkdownBody.safeParse(raw);
      if (!parsed.success) {
        throw zodIssuesToInvalidInput(parsed.error);
      }
      const body: Parameters<typeof writeFile>[3] = {
        kind: "markdown",
        content: parsed.data.content,
        ...(parsed.data.frontmatter !== undefined ? { frontmatter: parsed.data.frontmatter } : {}),
      };
      result = await writeFile(deps, slug, path, body);
    } else {
      const ct = c.req.header("content-type") ?? "application/octet-stream";
      const bytes = await readBodyBytes(c);
      result = await writeFile(deps, slug, path, { kind: "raw", contentType: ct, bytes });
    }
    return c.json(result);
  });

  // PATCH /v1/vaults/:slug/files/*path — find/replace edits.
  app.patch("/v1/vaults/:slug/files/:path{.+}", async (c) => {
    const slug = getParam(c, "slug");
    const path = getParam(c, "path");
    if (!isJsonContentType(c)) {
      throw new UnsupportedMediaTypeError("PATCH requires application/json", path);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new InvalidBodyError("body is not valid JSON");
    }
    const parsed = PatchFileBody.safeParse(raw);
    if (!parsed.success) throw zodIssuesToInvalidInput(parsed.error);
    const result = await patchFile(deps, slug, path, parsed.data);
    return c.json(result);
  });

  // DELETE /v1/vaults/:slug/files/*path.
  app.delete("/v1/vaults/:slug/files/:path{.+}", async (c) => {
    const slug = getParam(c, "slug");
    const path = getParam(c, "path");
    await deleteFile(deps, slug, path);
    return new Response(null, { status: 204 });
  });
}

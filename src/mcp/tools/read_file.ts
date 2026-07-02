/**
 * MCP tool: `read_file`. Mirrors `GET /v1/vaults/:slug/files/*path`.
 *
 * Spec: Markdown / text files are returned with `encoding: "utf-8"` and the
 * raw text in `content`. Binary files (anything not text-classified by the
 * service core's `isTextMimeType`) are returned with `encoding: "base64"`
 * and the base64-encoded bytes in `content`. Markdown additionally returns
 * the parsed YAML front-matter object so the JSON view matches REST's
 * `Accept: application/json` variant.
 */

import grayMatter from "gray-matter";
import { z } from "zod";
import {
  detectContentType,
  isMarkdownPath,
  isPdfPath,
  isTextMimeType,
} from "../../vault/contentType.ts";
import { type VaultServiceDeps, readFile } from "../../vault/files.ts";
import { PdfExtractionError, extractPdfMarkdown } from "../../vault/pdfText.ts";
import { type ToolDefinition, tool } from "../tool.ts";

const Input = z
  .object({
    vault: z.string().min(1),
    path: z.string().min(1),
    format: z.enum(["text", "binary"]).default("text"),
  })
  .strict();

/**
 * Coerce a YAML front-matter object so the MCP payload matches the REST
 * JSON variant byte-for-byte: `Date` values become ISO strings; everything
 * else passes through. Same shape as `frontmatterToObject` in the REST
 * adapter, but kept private so the two adapters' helpers can drift
 * independently if they ever need to.
 */
function frontmatterToObject(fm: unknown): Record<string, unknown> {
  if (fm === null || typeof fm !== "object" || Array.isArray(fm)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fm as Record<string, unknown>)) {
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

export function readFileTool(deps: VaultServiceDeps): ToolDefinition {
  return tool(
    "read_file",
    "Read any file from a vault. Returns `{ encoding: 'utf-8' | 'base64', content, contentType, mtimeMs, size, sha256 }`; Markdown additionally returns the parsed `frontmatter` object. PDFs return extracted text by default (`encoding: 'utf-8'`, plus a `pdf: { pages, hasTextLayer }` object); pass `format: 'binary'` for the verbatim base64 bytes of any file. Mirrors REST GET /v1/vaults/:slug/files/*path.",
    Input,
    async (args) => {
      const result = await readFile(deps, args.vault, args.path);
      const contentType = detectContentType(args.path);
      // `format: "binary"` is a verbatim byte read for ANY file type — no
      // frontmatter parsing, no PDF extraction. The text-producing branches
      // below are gated on `format === "text"` (the default) so binary falls
      // through to the single base64 return at the bottom.
      const wantsText = args.format === "text";
      // PDFs return extracted text under `format: "text"`. `size`/`sha256`
      // still describe the on-disk bytes (identity fields), not the text.
      if (wantsText && isPdfPath(args.path)) {
        try {
          const extraction = await extractPdfMarkdown(result.bytes);
          return {
            path: result.path,
            contentType,
            encoding: "utf-8" as const,
            content: extraction.markdown,
            pdf: { pages: extraction.pages, hasTextLayer: extraction.hasTextLayer },
            mtimeMs: result.mtimeMs,
            size: result.size,
            sha256: result.sha256,
          };
        } catch (err) {
          // Only remap genuine extraction failures. Any other error (a bug,
          // an unexpected throw) must propagate unchanged so it is NOT
          // mislabelled `extraction_failed`.
          if (!(err instanceof PdfExtractionError)) throw err;
          // Preserve the original parse-cause message (REST surfaces the same
          // "failed to parse PDF: <cause>") and append the caller-facing hint
          // so the two adapters' `extraction_failed` messages stay at parity.
          // Keep the original error as `cause` so its stack is not lost.
          const remapped = new PdfExtractionError(
            `${err.message}; retry with format:"binary" to fetch the raw bytes`,
          );
          remapped.cause = err;
          throw remapped;
        }
      }
      // Branch on the same `isTextMimeType` rule the REST adapter uses for
      // its `Accept: application/json` variant — keeps the two adapters'
      // text/binary boundary identical.
      if (wantsText && isTextMimeType(contentType)) {
        const text = new TextDecoder().decode(result.bytes);
        if (isMarkdownPath(args.path)) {
          const parsed = grayMatter(text);
          return {
            path: result.path,
            contentType,
            encoding: "utf-8" as const,
            content: parsed.content,
            frontmatter: frontmatterToObject(parsed.data),
            mtimeMs: result.mtimeMs,
            size: result.size,
            sha256: result.sha256,
          };
        }
        return {
          path: result.path,
          contentType,
          encoding: "utf-8" as const,
          content: text,
          mtimeMs: result.mtimeMs,
          size: result.size,
          sha256: result.sha256,
        };
      }
      return {
        path: result.path,
        contentType,
        encoding: "base64" as const,
        content: Buffer.from(result.bytes).toString("base64"),
        mtimeMs: result.mtimeMs,
        size: result.size,
        sha256: result.sha256,
      };
    },
  );
}

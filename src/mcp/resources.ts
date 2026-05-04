/**
 * MCP resource handler — exposes vault Markdown documents under the
 * `obvault://<slug>/<path>` URI scheme so MCP hosts that prefer the
 * resource model (over tool calls) can browse a vault.
 *
 * Lists are paginated one vault page per call: a `resources/list` with no
 * cursor returns the first page of the first configured vault; the
 * returned `nextCursor` is opaque and is the base64 encoding of
 * `${slug}\0${innerCursor}`, where `innerCursor` is the service core's own
 * `listFiles` cursor (itself base64 of the last-seen path). The NUL byte
 * is the field separator so a slug containing `:` doesn't break parsing.
 * When a vault is exhausted but more vaults exist, the cursor advances to
 * the next slug with an empty inner cursor. Reads return the document text
 * with `mimeType: "text/markdown"`. Unknown URIs surface an MCP error
 * result with code `not_found` so the SDK forwards a JSON-RPC error to
 * the client (the mirror behavior to a 404 from `read_file`).
 *
 * The handler is a thin adapter over `listFiles` + `readFile` from
 * `src/vault/files.ts`. It MUST NOT contain any vault-walking logic of its
 * own — that lives in the service core.
 */

import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { OBError } from "../errors.ts";
import { isMarkdownPath } from "../vault/contentType.ts";
import { type VaultServiceDeps, listFiles, readFile } from "../vault/files.ts";

/** Per-page resource budget. Same default as REST `list_files`. */
export const RESOURCE_PAGE_LIMIT = 100;

/** URI scheme advertised by the resource handler. */
export const URI_SCHEME = "obvault://" as const;

/** Markdown MIME type used in `resources/read` responses. */
export const MARKDOWN_MIME = "text/markdown" as const;

/** Shape returned by `resources/list` (matches the SDK schema). */
export interface ResourceListResult {
  readonly resources: readonly {
    readonly uri: string;
    readonly name: string;
    readonly mimeType: string;
  }[];
  readonly nextCursor?: string;
}

/** Shape returned by `resources/read` (matches the SDK schema). */
export interface ResourceReadResult {
  readonly contents: readonly [
    { readonly uri: string; readonly mimeType: string; readonly text: string },
  ];
}

/** Public surface bound onto the per-session `Server`. */
export interface ResourceHandler {
  list(cursor: string | undefined): Promise<ResourceListResult>;
  read(uri: string): Promise<ResourceReadResult>;
}

interface ParsedUri {
  readonly slug: string;
  readonly path: string;
}

interface ParsedCursor {
  readonly slug: string;
  readonly innerCursor: string | undefined;
}

/**
 * JSON-RPC error code we surface to the client when a `resources/read`
 * request can't be satisfied. The MCP spec for unknown URIs requires the
 * response to carry `code: "not_found"`, so we wrap the JSON-RPC error
 * `data` field with that string. `-32002` is the SDK's "resource not found"
 * code constant — picked so well-behaved clients can interpret the numeric
 * error as well.
 */
const RESOURCE_NOT_FOUND = -32002;

function notFound(uri: string): McpError {
  return new McpError(RESOURCE_NOT_FOUND, `resource "${uri}" not found`, {
    code: "not_found",
    uri,
  });
}

/**
 * Parse an `obvault://<slug>/<path>` URI into its components. Throws an
 * `McpError` carrying our canonical `not_found` code in `data` for any
 * malformed input.
 */
export function parseObVaultUri(uri: string): ParsedUri {
  if (!uri.startsWith(URI_SCHEME)) {
    throw notFound(uri);
  }
  const rest = uri.slice(URI_SCHEME.length);
  const slash = rest.indexOf("/");
  // `obvault://slug` (no path) and `obvault://slug/` (empty path) are both
  // unaddressable — reject them before they reach the service core.
  if (slash <= 0 || slash === rest.length - 1) {
    throw notFound(uri);
  }
  return { slug: rest.slice(0, slash), path: rest.slice(slash + 1) };
}

/**
 * Encode the `(slug, innerCursor)` pair as a single opaque token so MCP
 * clients can't peek at the underlying `listFiles` cursor and synthesise
 * something that bypasses our prefix check. The token is just the
 * service-core cursor scoped to the slug — the service core's own cursor is
 * already base64 of the last path, so we only need to namespace it.
 */
function encodeCursor(slug: string, innerCursor: string | null): string {
  // `innerCursor === null` means "no more pages" — we never produce a token
  // in that case (caller checks first), but keep the type honest.
  return Buffer.from(`${slug}\0${innerCursor ?? ""}`, "utf8").toString("base64");
}

/**
 * Decode a cursor produced by `encodeCursor`. Returns `undefined` for the
 * empty cursor (means "start from the first vault, first page") so callers
 * can treat absence and the default identically.
 */
export function decodeCursor(cursor: string | undefined): ParsedCursor | undefined {
  if (cursor === undefined || cursor === "") return undefined;
  // `Buffer.from(_, "base64")` is total — garbage decodes to garbage; we
  // surface that as "no inner cursor" rather than throwing, matching the
  // service core's own cursor semantics.
  const decoded = Buffer.from(cursor, "base64").toString("utf8");
  const nul = decoded.indexOf("\0");
  if (nul < 0) return { slug: decoded, innerCursor: undefined };
  const inner = decoded.slice(nul + 1);
  return {
    slug: decoded.slice(0, nul),
    innerCursor: inner === "" ? undefined : inner,
  };
}

/**
 * Build the resource handler. `slugs()` returns the configured vault list in
 * stable order (matches the order the supervisor reports them in).
 *
 * `pageLimit` defaults to `RESOURCE_PAGE_LIMIT` and is exposed only so tests
 * can drive the multi-page cursor branch without writing 100+ fixture files.
 */
export function buildResourceHandler(
  deps: VaultServiceDeps,
  slugs: () => readonly string[],
  pageLimit: number = RESOURCE_PAGE_LIMIT,
): ResourceHandler {
  return {
    async list(cursor: string | undefined): Promise<ResourceListResult> {
      const all = slugs();
      if (all.length === 0) return { resources: [] };
      const decoded = decodeCursor(cursor);
      // Pick the slug to page within: the cursor's slug if present, else the
      // first configured slug.
      const startSlug = decoded?.slug ?? all[0];
      // Defensive: if a stale cursor names an unknown slug we can't read
      // from, treat the listing as exhausted rather than 500-ing.
      if (!all.includes(startSlug ?? "")) return { resources: [] };
      const slug = startSlug as string;
      const opts: { limit: number; cursor?: string } = { limit: pageLimit };
      if (decoded?.innerCursor !== undefined) opts.cursor = decoded.innerCursor;
      const page = await listFiles(deps, slug, opts);
      const resources = page.items
        .filter((it) => isMarkdownPath(it.path))
        .map((it) => ({
          uri: `${URI_SCHEME}${slug}/${it.path}`,
          name: it.path,
          mimeType: MARKDOWN_MIME,
        }));
      // Decide the next cursor:
      // - more pages within this slug → wrap the inner cursor with the slug.
      // - this slug exhausted, more slugs → start the next slug.
      // - no more slugs → no cursor.
      if (page.nextCursor !== null) {
        return { resources, nextCursor: encodeCursor(slug, page.nextCursor) };
      }
      const idx = all.indexOf(slug);
      const next = all[idx + 1];
      if (next === undefined) return { resources };
      return { resources, nextCursor: encodeCursor(next, null) };
    },

    async read(uri: string): Promise<ResourceReadResult> {
      const { slug, path } = parseObVaultUri(uri);
      // Reject non-Markdown reads up-front — `obvault://` is documented as a
      // Markdown surface, and the alternative is `read_file` which returns
      // base64 for binaries.
      if (!isMarkdownPath(path)) {
        throw notFound(uri);
      }
      // Any `OBError` (vault_not_found, not_found, invalid_path) → translate
      // into the canonical resource not-found shape so the spec's "Unknown
      // URIs MUST return an MCP error with code `not_found`" holds for every
      // unaddressable URI.
      let result: Awaited<ReturnType<typeof readFile>>;
      try {
        result = await readFile(deps, slug, path);
      } catch (e) {
        // Any typed service-core error (vault_not_found, not_found,
        // invalid_path, …) means "the URI doesn't address a real document"
        // — translate into the spec-mandated `not_found` MCP error. Non-
        // typed errors propagate so the SDK produces a generic JSON-RPC
        // server error.
        if (e instanceof OBError) throw notFound(uri);
        throw e;
      }
      return {
        contents: [{ uri, mimeType: MARKDOWN_MIME, text: new TextDecoder().decode(result.bytes) }],
      };
    },
  };
}

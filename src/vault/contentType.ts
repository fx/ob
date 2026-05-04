/**
 * Content-Type detection by file extension.
 *
 * `detectContentType(path)` returns the MIME type the REST adapter sets on
 * `Content-Type` for `GET` responses (and that `list_files` reports as
 * `contentType` per the REST spec). Mappings are intentionally limited to the
 * extensions the spec calls out — every other extension falls back to
 * `application/octet-stream`.
 *
 * `isTextPath(path)` decides whether `PATCH` and `:append` are allowed
 * against a given file. The rule from the REST spec: any extension whose
 * MIME type is `text/*`, `application/json`, `application/yaml`, or any
 * `+xml` / `+json` variant. We implement that rule against the MIME emitted
 * by `detectContentType` (rather than a hardcoded extension list) so that
 * structured-suffix variants like `image/svg+xml` and `application/geo+json`
 * are correctly classified as text without us having to chase every long-tail
 * extension.
 */

const EXT_TO_MIME: Record<string, string> = {
  md: "text/markdown; charset=utf-8",
  markdown: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  csv: "text/csv; charset=utf-8",
  toml: "application/toml",
  html: "text/html; charset=utf-8",
  xml: "application/xml",
  svg: "image/svg+xml",
  geojson: "application/geo+json",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  pdf: "application/pdf",
};

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);

function extOf(path: string): string {
  const dot = path.lastIndexOf(".");
  if (dot < 0) return "";
  // `lastIndexOf` returns -1 when no dot — but we also need to make sure the
  // dot is part of the basename (e.g. "foo.bar/baz" should yield ""). The
  // cheapest way is to check for a separator after the dot.
  const sep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  if (dot < sep) return "";
  return path.slice(dot + 1).toLowerCase();
}

/**
 * Map an extension to its content type. Returns `application/octet-stream`
 * for unknown extensions (and the empty string). Special-cases `.toml`
 * (`application/toml`) — which isn't text-prefixed but is allowed by spec.
 */
export function detectContentType(path: string): string {
  const ext = extOf(path);
  return EXT_TO_MIME[ext] ?? "application/octet-stream";
}

/**
 * MIME-based "is this text?" classifier matching the REST spec rule:
 *   - any `text/*`
 *   - `application/json`, `application/yaml`, `application/toml`
 *   - any structured-suffix variant ending in `+json` or `+xml` (catches
 *     `image/svg+xml`, `application/geo+json`, `application/ld+json`, etc.)
 *
 * Unknown extensions resolve to `application/octet-stream`, which is
 * deliberately NOT a text type.
 */
export function isTextMimeType(mime: string): boolean {
  // Drop any `; charset=utf-8` suffix before matching the type.
  const base = mime.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (base.startsWith("text/")) return true;
  if (base === "application/json") return true;
  if (base === "application/yaml") return true;
  if (base === "application/toml") return true;
  if (base === "application/xml") return true;
  // Structured suffixes (RFC 6838 §4.2.8) — the part after the `+`.
  const plus = base.lastIndexOf("+");
  if (plus < 0) return false;
  const suffix = base.slice(plus + 1);
  return suffix === "json" || suffix === "xml";
}

/** True when the file should accept `PATCH` and `:append` per the REST spec. */
export function isTextPath(path: string): boolean {
  return isTextMimeType(detectContentType(path));
}

/** True for `.md` / `.markdown` — the only extensions that get indexed. */
export function isMarkdownPath(path: string): boolean {
  return MARKDOWN_EXTENSIONS.has(extOf(path));
}

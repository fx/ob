# REST API

## Overview

The REST API exposes vault-scoped CRUD over arbitrary files (Markdown, images, PDFs, attachments — anything stored in the vault) and natural-language search over the indexed Markdown content of each vault. It runs in the same Bun process as the supervisor and indexer and shares their in-memory state. There is no authentication in v1 — deployment is private-network only.

## Background

- Built on [Hono](https://hono.dev/) for first-class Bun fit and minimal overhead.
- REST is one of two **adapters** over the shared service core defined in [Architecture › Shared Service Core](../architecture/index.md#shared-service-core). It MUST contain no vault behavior of its own; every route is parse → call → respond. The other adapter is [MCP Server](../mcp-server/) and MUST behave identically against the same inputs.
- Related specs: [Architecture](../architecture/), [Obsidian Sync](../obsidian-sync/), [Vault Indexer](../vault-indexer/).

## Requirements

### Routing & versioning

- The HTTP server MUST mount the API under `/v1`.
- Vault-scoped routes MUST use the slug, not the human name: `/v1/vaults/:slug/...`.
- Vault sub-resources are namespaced by segment (`files`, `search`, future: `sync`) so that `GET /v1/vaults/:slug` (vault metadata) and `GET /v1/vaults/:slug/files/*path` (a file inside the vault) never collide.
- File paths MUST appear as wildcard segments: `/v1/vaults/:slug/files/*path` where `*path` is the relative path inside the vault, slash-separated, no leading slash. Any extension is allowed.
- An unknown vault slug MUST return `404` with body `{ "error": { "code": "vault_not_found", "message": "..." } }`.

### Health endpoints

- `GET /healthz` MUST return `200 {"ok":true}` once the process has bound the port.
- `GET /readyz` MUST return `200` only when every configured vault has reached indexer state `ready`. Otherwise `503` with a body listing per-vault state.

### Vault listing & status

- `GET /v1/vaults` MUST return `200` with `[{ slug, name, sync, indexer }]` where:
  - `sync` is the supervisor's `VaultStatus`
  - `indexer` is the indexer's `IndexerStatus`
- `GET /v1/vaults/:slug` MUST return the same object for a single vault, or `404`.

#### Scenario: List vaults during boot

- **GIVEN** two configured vaults, one indexer-ready, one still scanning
- **WHEN** the client calls `GET /v1/vaults`
- **THEN** response is `200`
- **AND** body lists both with their respective `sync.state` and `indexer.state` fields

### File CRUD

For all routes below, `:slug` is the vault slug and `*path` is the file path inside the vault. Any file type is supported (Markdown, images, PDFs, attachments). Only `.md` / `.markdown` files are indexed for search; binaries are stored on disk and round-tripped through `ob sync` but not embedded in v1.

#### `GET /v1/vaults/:slug/files`

- Lists files. Query params: `prefix` (string, MUST match path prefix), `limit` (int, default 100, max 1000), `cursor` (opaque string).
- MUST return `200 { items: [{ path, mtimeMs, size, sha256, contentType }], nextCursor: string | null }` where `contentType` is the detected MIME type by extension.
- MUST stream from the on-disk vault directory and MUST include all file types (not just Markdown).
- MUST omit any path containing a `/.obsidian/` or `/.trash/` segment, any dotfile, and any symlink (symlinks are detected by `Dirent` type and never followed).

#### `GET /v1/vaults/:slug/files/*path`

- Returns the raw file bytes.
- Response `Content-Type` MUST be the detected MIME type by extension (`text/markdown; charset=utf-8` for `.md`/`.markdown`, `image/png` for `.png`, `application/pdf` for `.pdf`, etc.); fallback `application/octet-stream`.
- If the file is `.md`/`.markdown` AND the request sends `Accept: application/json`, the response MUST be `{ path, content, frontmatter, mtimeMs, size, sha256 }` with `frontmatter` parsed.
- If the file is `.pdf` AND the request sends `Accept: application/json`, the response MUST be `200 { path, content, contentType, pdf: { pages, hasTextLayer }, mtimeMs, size, sha256 }` where `content` is the extracted plain-text/Markdown content (page-marker and normalization semantics defined in [Change 0013](../../changes/0013-pdf-text-extraction.md); shared with MCP `read_file`). No `frontmatter` field. A scanned/image-only PDF MUST succeed with `content: ""` and `pdf.hasTextLayer: false`. A corrupt or password-protected PDF MUST return `422` with `error.code = "extraction_failed"`. `size` and `sha256` MUST describe the on-disk bytes, not the extracted text. The plain (non-JSON) GET is unaffected and keeps serving verbatim bytes.
- For all other non-Markdown files the JSON variant MUST return `406 Not Acceptable`.
- `404` if the file does not exist; `400` if the path is invalid (see Path validation).

#### Scenario: JSON read of a PDF returns extracted text

- **GIVEN** vault `v` contains `papers/attention.pdf` with a text layer
- **WHEN** the client `GET`s `/v1/vaults/v/files/papers/attention.pdf` with `Accept: application/json`
- **THEN** the response is `200` JSON with `content` = extracted text and `pdf.pages` ≥ 1
- **AND** a plain `GET` of the same URL still returns the verbatim bytes with `Content-Type: application/pdf`

#### Scenario: Unparseable PDF fails closed

- **GIVEN** vault `v` contains a password-protected `secret.pdf`
- **WHEN** the client `GET`s it with `Accept: application/json`
- **THEN** the response is `422` with `error.code = "extraction_failed"`

#### `PUT /v1/vaults/:slug/files/*path`

- Creates or replaces the file.
- Request body MUST be either:
  - any non-JSON content type (raw bytes; `Content-Type` from the request is recorded but not interpreted), or
  - `application/json` `{ content: string, frontmatter?: object }` — only valid when `*path` ends in `.md`/`.markdown`. `frontmatter` is serialized into the file.
- Response MUST be `200 { path, mtimeMs, size, sha256, contentType, created: boolean, indexed: boolean }`. `indexed` is `true` iff the file was Markdown and was upserted into the index in the same request.
- The handler MUST `mkdir -p` the parent directory inside the vault, write the file atomically (temp file + rename).
- For Markdown files the handler MUST then `await indexer.reindex(slug, path)` before responding. For non-Markdown files the handler MUST NOT call the indexer.
- The handler MUST refuse to write outside the vault root (Path validation).

#### `DELETE /v1/vaults/:slug/files/*path`

- Deletes the file.
- Response MUST be `204` on success, `404` if the file did not exist.
- The handler MUST `unlink` the file. If the path was Markdown, the handler MUST also `await indexer.drop(slug, path)` before responding.

#### `PATCH /v1/vaults/:slug/files/*path`

- Surgical text edits via find-and-replace pairs. Designed to let an LLM modify a long note without re-sending the whole file.
- Request body MUST be `application/json`: `{ edits: Edit[] }` where `Edit = { old: string, new: string, replaceAll?: boolean }`. `edits` MUST be non-empty.
- The handler MUST refuse non-text files. A file is "text" if its extension maps to a `text/*` MIME type, `application/json`, `application/yaml`, or any `+xml` / `+json` variant — practically: `.md`, `.markdown`, `.txt`, `.json`, `.yaml`, `.yml`, `.csv`, `.toml`, `.html`, `.xml`. Otherwise `415 unsupported_media_type`.
- The handler MUST refuse empty files (`404 not_found`) — PATCH is for editing, use PUT to create.
- Each `Edit` is applied in order against the running buffer. For each edit:
  - If `replaceAll` is `true`, every occurrence of `old` MUST be replaced with `new`. Zero occurrences MUST yield `409 patch_no_match` with `details: { editIndex }`.
  - If `replaceAll` is omitted/false, exactly one occurrence of `old` MUST exist. Zero occurrences MUST yield `409 patch_no_match`. Two or more MUST yield `409 patch_ambiguous` with `details: { editIndex, occurrences }`.
- The patch is atomic: any failed edit MUST abort the whole patch with no write to disk.
- After all edits succeed, the handler writes atomically (temp + rename), reindexes if Markdown, and returns `200 { path, mtimeMs, size, sha256, contentType, indexed, edits: number }` matching the `PUT` response shape plus `edits` (count applied).
- An edit with `old === new` MUST be rejected with `400 invalid_body` (no-op edits are bugs, not features).

#### Scenario: Single-edit success

- **GIVEN** vault `v` containing `notes/x.md` with body `# Title\n\n- a\n- b\n`
- **WHEN** the client `PATCH`es `/v1/vaults/v/files/notes/x.md` with `{ edits: [{ old: "- b\n", new: "- b\n- c\n" }] }`
- **THEN** the response is `200`
- **AND** the file body is `# Title\n\n- a\n- b\n- c\n`
- **AND** within the same response cycle the LanceDB table reflects the new content

#### Scenario: Ambiguous old

- **GIVEN** vault `v` containing `notes/x.md` with body `foo\nfoo\n`
- **WHEN** the client `PATCH`es with `{ edits: [{ old: "foo", new: "bar" }] }`
- **THEN** the response is `409` with `error.code = "patch_ambiguous"` and `details.occurrences = 2`
- **AND** the file is unchanged

#### Scenario: Atomic abort

- **GIVEN** vault `v` containing `notes/x.md` with body `alpha\nbeta\n`
- **WHEN** the client `PATCH`es with `{ edits: [{ old: "alpha", new: "ALPHA" }, { old: "gamma", new: "GAMMA" }] }`
- **THEN** the response is `409` with `error.code = "patch_no_match"` and `details.editIndex = 1`
- **AND** the file body remains `alpha\nbeta\n`

#### Scenario: Binary rejected

- **GIVEN** vault `v` containing `attachments/diagram.png`
- **WHEN** the client `PATCH`es that path with any body
- **THEN** the response is `415` with `error.code = "unsupported_media_type"`

#### `POST /v1/vaults/:slug/files/*path:append`

- Append-only convenience for daily-notes, logs, and capture flows. Avoids sending any context.
- Request body MUST be either raw text (any non-JSON content type) or `application/json` `{ content: string }`.
- The file MUST exist (`404 not_found` otherwise — use `PUT` to create).
- The file MUST be a text file by the same rule as `PATCH`. Binaries get `415`.
- The handler MUST append the bytes verbatim. It MUST NOT add or normalize a trailing newline; callers control the bytes they send.
- After append, the handler MUST reindex if Markdown.
- Response shape mirrors `PUT` (`200 { path, mtimeMs, size, sha256, contentType, indexed, created: false }`).

#### Scenario: Append to daily note

- **GIVEN** vault `v` containing `daily/2026-05-03.md` with body `# Today\n`
- **WHEN** the client `POST`s `/v1/vaults/v/files/daily/2026-05-03.md:append` with body `- 14:30 had coffee\n`
- **THEN** the response is `200`
- **AND** the file body is `# Today\n- 14:30 had coffee\n`

### Folder CRUD

Folders are a separate surface from files because `GET /v1/vaults/:slug/files` only emits `Dirent.isFile()` entries: a folder with no descendant files is invisible to the file API. Obsidian Sync preserves empty folders (verified against a live vault; no upstream toggle exists per [Sync settings](https://obsidian.md/help/sync/settings)), so the API MUST expose them too. `FolderEntry = { path, mtimeMs }` — folders carry no size, sha256, or contentType.

#### `GET /v1/vaults/:slug/folders`

- Lists folders. Query params: `prefix` (string, MUST match path prefix), `limit` (int, default 100, max 1000), `cursor` (opaque string) — same shape and semantics as the file list endpoint.
- MUST return `200 { items: [{ path, mtimeMs }], nextCursor: string | null }` where `path` is the vault-relative folder path with no trailing slash.
- MUST walk the on-disk vault directory and emit directory entries in pre-order lexicographic walk (parent before children) so cursor resumption advances into subtrees predictably.
- MUST omit any folder containing a `/.obsidian/` or `/.trash/` segment, any dotfolder, and any symlink (same omission rules as `GET /v1/vaults/:slug/files`).
- MUST NOT emit the vault root itself.

#### `PUT /v1/vaults/:slug/folders/*path`

- Creates the folder (and any missing ancestors); `mkdir -p` semantics.
- Request body MUST be ignored (folders carry no content). Senders SHOULD send `Content-Length: 0`.
- Response MUST be `200 { path, mtimeMs, created: boolean }`. `created` is `true` on first creation and `false` on idempotent no-op against an existing folder.
- If the path already exists as a file (not a directory), the response MUST be `400` with `error.code = "invalid_path"`.

#### `DELETE /v1/vaults/:slug/folders/*path`

- Deletes the folder.
- Optional query string `?recursive=true` opts into recursive removal of all descendants.
- Without `recursive=true`, a non-empty folder MUST yield `409` with `error.code = "folder_not_empty"`. The folder MUST remain unchanged.
- With `recursive=true`, the handler MUST collect every Markdown descendant first, call `await indexer.drop(slug, mdPath)` for each (best-effort; failures logged), then `fs.rm(abs, { recursive: true, force: false })`.
- If the path does not exist, MUST return `404` with `error.code = "not_found"`.
- If the path exists but is a file, MUST return `400` with `error.code = "invalid_path"` — callers should use `DELETE /files/*path` for files.
- On success: `204` (no body).

#### Scenario: Empty-folder visibility

- **GIVEN** vault `v` containing only the empty folder `notes/scratchpad/`
- **WHEN** the client calls `GET /v1/vaults/v/folders`
- **AND** then calls `GET /v1/vaults/v/files`
- **THEN** the folders response includes `notes/scratchpad`
- **AND** the files response is `{ items: [], nextCursor: null }`

#### Scenario: Idempotent create

- **GIVEN** vault `v` with no `archive/2026/` folder
- **WHEN** the client `PUT`s `/v1/vaults/v/folders/archive/2026`
- **THEN** the response is `200` with `created: true`
- **AND** a replay of the same `PUT` returns `200` with `created: false` and the same `mtimeMs`

#### Scenario: Non-empty refused without recursive flag

- **GIVEN** vault `v` containing `social-graphs/people/peter-thiel/intro.md`
- **WHEN** the client `DELETE`s `/v1/vaults/v/folders/social-graphs/people/peter-thiel`
- **THEN** the response is `409` with `error.code = "folder_not_empty"`
- **AND** `social-graphs/people/peter-thiel/intro.md` is unchanged

#### Scenario: Recursive delete drops Markdown index entries

- **GIVEN** vault `v` containing `archive/2024/jan.md` and `archive/2024/cover.png`
- **WHEN** the client `DELETE`s `/v1/vaults/v/folders/archive/2024?recursive=true`
- **THEN** the response is `204`
- **AND** the indexer recorded exactly one `drop` call for `archive/2024/jan.md` (zero for the binary)
- **AND** the folder `archive/2024/` no longer exists on disk

### Path validation

- A path MUST NOT contain `..` segments, MUST NOT start with `/`, MUST NOT contain a NUL byte, MUST NOT exceed 1024 bytes.
- Resolution MUST be performed via `path.resolve(vaultRoot, path)` followed by a `startsWith(vaultRoot + sep)` check. Any failure MUST return `400 { error: { code: "invalid_path", ... } }`.
- Any extension is permitted on read, write, and delete. Reserved/hidden segments (`/.obsidian/`, `/.trash/`, dotfiles at any depth) MUST return `400` with code `invalid_path` to keep callers from corrupting `ob`'s own state.

#### Scenario: Path traversal blocked

- **GIVEN** a request `PUT /v1/vaults/v/files/../../etc/passwd`
- **WHEN** the server handles it
- **THEN** response is `400` with `error.code = "invalid_path"`
- **AND** no file is created

#### Scenario: Markdown round-trip with indexing

- **GIVEN** a healthy vault `v` with no file `notes/x.md`
- **WHEN** the client `PUT`s body `# hi` to `/v1/vaults/v/files/notes/x.md`
- **AND** then `GET`s `/v1/vaults/v/files/notes/x.md`
- **THEN** the response body equals `# hi` with `Content-Type: text/markdown; charset=utf-8`
- **AND** within the same response cycle the LanceDB table contains a row with `path = "notes/x.md"`

#### Scenario: Binary file round-trip without indexing

- **GIVEN** a healthy vault `v`
- **WHEN** the client `PUT`s a PNG body to `/v1/vaults/v/files/attachments/diagram.png`
- **THEN** the response `indexed` field is `false`
- **AND** `GET /v1/vaults/v/files/attachments/diagram.png` returns the same bytes with `Content-Type: image/png`
- **AND** no row for this path exists in the LanceDB table

### Search

- `POST /v1/vaults/:slug/search` body:

  ```ts
  {
    query: string;
    limit?: number;
    filter?: { tag?: string; pathPrefix?: string };
    mode?: "hybrid" | "vector" | "fts";   // default "hybrid"
    threshold?: number;                    // default 0; range [0, 1]
    mmrLambda?: number;                    // default 0.5; range [0, 1]
    maxPerPath?: number;                   // default 3; range [1, 100]
  }
  ```

- Response `200 { hits: SearchHit[] }` (see [Vault Indexer](../vault-indexer/) for `SearchHit`, including the optional per-arm `scores`).
- `query` MUST be 1–4096 chars; otherwise `400`.
- `limit` MUST be 1–100 (default 20); otherwise `400`.
- `mode` MUST be one of `"hybrid"`, `"vector"`, `"fts"`; otherwise `400`.
- `threshold`, `mmrLambda` MUST be numbers in `[0, 1]`; `maxPerPath` MUST be an integer in `[1, 100]`. Otherwise `400`.
- The behavior of these knobs is defined in [Vault Indexer › Search relevance](../vault-indexer/index.md#search-relevance); REST is a thin pass-through.

### Error model

- Every error response MUST be JSON `{ error: { code: string, message: string, details?: unknown } }`.
- `code` MUST come from a closed set: `vault_not_found`, `not_found`, `invalid_input`, `invalid_path`, `invalid_body`, `invalid_query`, `unsupported_media_type`, `patch_no_match`, `patch_ambiguous`, `folder_not_empty`, `extraction_failed`, `embedder_failed`, `internal`. `invalid_input` is the canonical code for any Zod schema-validation failure and is shared with the MCP adapter; `invalid_body` and `invalid_query` are HTTP-specific codes for malformed request envelopes (e.g. unparseable JSON body or unknown query string); `folder_not_empty` is the 409 response from `DELETE /v1/vaults/:slug/folders/*path` without `?recursive=true` against a non-empty folder; `extraction_failed` is the 422 response when a PDF requested as text cannot be parsed (corrupt or password-protected).
- 5xx responses MUST log `error` and `requestId`. The response MUST include `requestId` in `details`.

### Request logging

- Every request MUST be logged with `method`, `path`, `status`, `durationMs`, `requestId`. PII (request bodies) MUST NOT be logged at `info`; debug-level body logging MAY be enabled by `LOG_LEVEL=debug`.

## Design

### App composition

```ts
// src/http/index.ts
export function buildHttpApp(deps: { cfg, sup, idx }) {
  const app = new Hono();
  app.get("/healthz", health(deps));
  app.get("/readyz", ready(deps));
  app.route("/v1/vaults", buildVaultRoutes(deps));
  app.route("/mcp", buildMcpRoutes(deps));    // see MCP spec
  app.onError(jsonErrorHandler);
  app.notFound(jsonNotFound);
  return app;
}
```

### Atomic write

```ts
const tmp = `${target}.tmp.${crypto.randomUUID()}`;
await Bun.write(tmp, body);
await fs.promises.rename(tmp, target);
```

### Path resolution helper

```ts
function safeJoin(root: string, rel: string): string {
  if (rel.includes("\0") || rel.length > 1024) throw badPath();
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw badPath();
  return abs;
}
```

## Constraints

- v1 has NO authentication and NO authorization. The image is for deployment on a private network or behind another auth-providing reverse proxy.
- The API MUST NOT spawn additional `ob` invocations on writes. It writes to disk; the supervisor's running `ob sync --continuous` picks up the change.
- Wikilink rewriting on rename/move is OUT OF SCOPE for v1. A `PUT` to a new path is treated as a new document; the caller is responsible for any link maintenance.

## Open Questions

- **Move/rename endpoint.** Adding `POST /v1/vaults/:slug/files/*path:move` would be cleaner than client-side delete-then-put, but punting per user direction. **Default**: not in v1; revisit if a real workflow needs it.
- **Bulk operations.** `POST /v1/vaults/:slug/files:bulk` for batched writes. **Default**: not in v1.
- **Streaming `GET docs`.** For large vaults, server-sent events for `list` would help. **Default**: cursor pagination is sufficient for v1.

## References

- [Hono](https://hono.dev/)
- Mirror surface: [MCP Server](../mcp-server/)

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-05-03 | Initial spec created | — |
| 2026-05-03 | Search request body gains `mode`, `threshold`, `mmrLambda`, `maxPerPath` knobs. Default `mode` is `"hybrid"` — retrieval behavior changes from pre-0008 (was vector-only); the response *shape* is unchanged. | [Change 0008](../../changes/0008-search-relevance.md) |
| 2026-05-25 | Added Folder CRUD section: `GET /v1/vaults/:slug/folders` (list) plus `PUT` and `DELETE` on `/v1/vaults/:slug/folders/*path` (create / delete). Required because `GET /v1/vaults/:slug/files` only emits files, hiding empty folders. New error code `folder_not_empty` (409) added to the closed set. | [Change 0012](../../changes/0012-folder-operations.md) |
| 2026-07-01 | JSON read variant (`Accept: application/json`) now accepts `.pdf` and returns extracted text with `pdf: { pages, hasTextLayer }` metadata; other non-Markdown files still get `406`. New error code `extraction_failed` (422) added to the closed set. Plain GET byte semantics unchanged. | [Change 0013](../../changes/0013-pdf-text-extraction.md) |

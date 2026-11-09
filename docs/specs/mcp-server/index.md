# MCP Server

## Overview

The MCP server exposes the same multi-vault CRUD and search surface as the REST API as Model Context Protocol tools, served over the Streamable HTTP transport. It runs in the same Bun process as the REST API and reuses the same supervisor and indexer instances. There is no MCP-level authentication in v1.

## Background

- We use `@modelcontextprotocol/sdk`'s server with the **Streamable HTTP** transport (protocol revision 2025-03-26 or later). The legacy two-endpoint HTTP+SSE transport is deprecated and MUST NOT be used. Stdio transport is OUT OF SCOPE per user direction.
- MCP is one of two **adapters** over the shared service core defined in [Architecture › Shared Service Core](../architecture/index.md#shared-service-core). The other is [REST API](../rest-api/). Tools MUST be 1:1 with REST endpoints; tools and routes MUST call the same core service functions and validate inputs with the same Zod schemas. Behavior parity is enforced by code reuse and by parity tests, not by re-implementation.
- Related specs: [REST API](../rest-api/), [Vault Indexer](../vault-indexer/), [Architecture](../architecture/).

## Requirements

### Transport

- The MCP server MUST be mounted at `/mcp` on the existing Hono app (plus the scoped variants in [Session scoping](#session-scoping)), handling three methods:
  - `POST /mcp` — client → server JSON-RPC. The response MUST be `Content-Type: application/json` for a single response, or `Content-Type: text/event-stream` when the server needs to stream notifications/responses related to that request.
  - `GET /mcp` — opens a long-lived server → client SSE stream for messages not tied to an in-flight request (server-initiated notifications, late tool results). MAY return `405 Method Not Allowed` if the server has nothing to push, but the implementation SHOULD support it.
  - `DELETE /mcp` — explicit session termination by the client.
- The server MUST issue a session id in the `Mcp-Session-Id` response header on the first request of a session and MUST require that header on every subsequent request for the session.
- The server MUST NOT bind a separate port; it shares `HTTP_PORT`.
- The server MUST emit `tools/list_changed` notifications only when vault membership actually changes (which today is only at startup; this is a forward hook).

### Session scoping

A session MAY be confined to one vault and one folder prefix, so a client (typically an LLM agent using the vault as a memory store) can be given an agent-scoped root inside a shared vault. The scope is carried by the connection URL and MUST NOT be selectable by any tool argument.

| Route | Scope |
|---|---|
| POST/GET/DELETE `/mcp` | Unscoped — the whole configured vault set. |
| POST/GET/DELETE `/mcp/:slug` | Vault `:slug`, prefix empty (vault root). |
| POST/GET/DELETE `/mcp/:slug/:prefix{.+}` | Vault `:slug`, folder prefix `:prefix` (e.g. `/mcp/v/agents/claude-1`). |

- A scoped session MUST see its prefix AS the vault root: every path value crossing the protocol boundary — in tool arguments, tool results, pagination cursors, `obvault://` resource URIs, and the paths echoed in error envelopes — MUST be relative to the prefix, and MUST NOT carry the prefix or any absolute filesystem path. Note *content* is not translated: text, frontmatter, tags, and extracted wikilink targets are returned verbatim even when a note happens to mention its own folder, since every readable note is already fully readable by that session.
- A scoped session MUST NOT be able to read, write, list, or search anything outside its prefix, and MUST NOT be able to address any other vault (`vault_not_found`). `list_vaults` and `resources/list` MUST report only the scoped vault, so a session in a multi-vault deployment cannot enumerate the others.
- The prefix MUST be parsed from the raw, un-normalized request target — NOT from a decoded route param and NOT from `new URL(...).pathname`, which resolves literal and percent-encoded dot segments before validation could reject them — and percent-decoded exactly once per segment (a malformed escape or a segment decoding to a path separator is a rejection, not an input to normalize) and normalized (trailing `/`, empty and single-dot segments dropped) so aliases of one scope produce one scope. A prefix that is empty after normalization is the vault-root scope and MUST be accepted. Every non-empty prefix MUST be validated with the same rules as any other vault-relative path (`..`, absolute paths, hidden segments, NUL, over-length are rejected). An invalid prefix MUST be rejected with HTTP `400` and JSON-RPC error `-32000`; an unknown `:slug` with HTTP `404` and `-32000`. Neither may allocate a session.
- The scope root MUST be checked for symlink escape when the session is bound AND at the start of every scoped request handler — `tools/call`, `resources/list`, and `resources/read` — the per-operation symlink guards stop at the root they are given, which for a scoped session is the scope root itself, so a bind-time-only check leaves the scope root swappable for the life of the session.
- The scope MUST be bound at `initialize` and stored with the session. A request whose URL scope differs from the scope stored for its `Mcp-Session-Id` MUST be rejected as an unknown session (HTTP `404`, `-32001`) and MUST NOT be executed.
- In a scoped session the `vault` argument MUST become optional (defaulting to the scoped slug) and the advertised `inputSchema` MUST drop `"vault"` from `required`. A different slug MUST surface `vault_not_found`.
- A scoped session's `initialize` result MUST carry an `instructions` string stating that all paths are relative to a scoped root, that `vault` may be omitted, and that nothing outside that root is reachable through the session. It MUST NOT describe the root as private — the server has no auth, and the same files stay reachable through the unscoped mount.
- The path tools, `list_tags`, and `grep` follow the same confinement: `list`, `delete`, `copy`, and `grep` address and report only paths inside the scope; both paths of a `move` or `copy` are scope-relative, so neither can leave the scope; `list_tags` counts only documents inside the scope, with a `prefix` nested under it. Link rewriting after a `move` resolves links against the whole vault but rewrites only notes inside the scope, as [Link rewriting › Notes scanned](../rest-api/link-rewriting.md#notes-scanned) defines; rewritten link text is note content and, like all content, is not path-translated.
- Vault-level counts reported by `vault_status` (`documents`, `chunks`, `pending`, `errors`) remain vault-wide in a scoped session; the tool description MUST say so.
- Scoping is a **containment** mechanism for a cooperating client, NOT an authentication or authorization boundary — see [Constraints](#constraints).

### Tool design rules

These rules govern the current tool set and every tool added later.

- **One tool per operation.** Each tool performs exactly one operation. The server MUST NOT expose a dispatcher tool that selects among several operations by argument (a single `file_op` with an `op` field, say): MCP clients grant permissions and honor `readOnlyHint` per tool, so a combined tool would force a read-only operation to carry a mutating one's permission.
- **One tool for files and folders.** An operation that logically applies to both files and folders MUST be a single tool that works on either, never a per-type pair. It is named for the unix verb it mimics and follows that tool's semantics: `list` (`ls`), `delete` (`rm`, with `recursive` for `rm -r`), `move` (`mv -T`), `copy` (`cp -T`, with `recursive` for `cp -r`). Mutating path tools refuse to replace an existing path unless asked (`overwrite: true`), the safer default of `mv -n` / `cp -n`.
- **Type-specific tools only for type-specific operations.** A tool is specific to files or to folders only when its operation is meaningless for the other type: `read_file`, `write_file`, `patch_file`, and `append_file` act on file content, and `create_folder` (`mkdir -p`) creates a folder.
- **REST parity.** Each tool mirrors exactly one REST endpoint (see [REST API](../rest-api/)), and both call the same service-core function.

#### Scenario: No per-type duplicate of a path tool

- **GIVEN** a running server
- **WHEN** the client calls `tools/list`
- **THEN** it contains `list`, `delete`, `move`, and `copy`
- **AND** it contains none of `list_files`, `list_folders`, `delete_file`, `delete_folder`

### Tool surface

> The path tools (`list`, `delete`, `move`, `copy`), `list_tags`, and `grep` are specified by draft changes [0019](../../changes/0019-unified-list-and-delete.md), [0020](../../changes/0020-move-and-copy.md), [0021](../../changes/0021-list-tags.md), and [0022](../../changes/0022-grep.md) and are not yet implemented; until 0019 lands the server still registers `list_files`, `list_folders`, `delete_file`, and `delete_folder`. The table below is the end state once all four have landed; each change adds its own tools, and the registered set in between is whatever the changes landed so far add up to.

The server MUST register exactly these tools. Argument schemas are JSON Schema; every error result MUST set `isError: true` and contain a single text content block with the JSON `{ code, message }`. The read tools (`list_vaults`, `vault_status`, `list`, `read_file`, `search`, `list_tags`, `grep`) MUST advertise `annotations: { readOnlyHint: true }` in `tools/list`, scoped sessions included, so clients can call them without treating them as mutating; no other tool sets it.

| Name | Input | Output | Mirrors |
|---|---|---|---|
| `list_vaults` | `{}` | `VaultSummary[]` | `GET /v1/vaults` |
| `vault_status` | `{ vault: string }` | `VaultSummary` | `GET /v1/vaults/:slug` |
| `list` | `{ vault, prefix?, limit?, cursor?, type?, recursive? }` — `type` is `"file"` or `"folder"`; `recursive` defaults to `true` | `{ items: PathEntry[], nextCursor }` | `GET /v1/vaults/:slug/paths` |
| `read_file` | `{ vault, path, format? }` — `format` is `"text"` (default) or `"binary"` | `{ path, contentType, content, encoding, frontmatter?, pdf?, mtimeMs, size, sha256 }` where `encoding` is `"utf-8"` for text files and extracted-PDF reads, `"base64"` for binary | `GET /v1/vaults/:slug/files/*path` |
| `write_file` | `{ vault, path, content, encoding?, contentType?, frontmatter? }` — `encoding` defaults to `"utf-8"`; `frontmatter` is only valid when path is Markdown | `{ path, contentType, mtimeMs, size, sha256, created, indexed }` | `PUT /v1/vaults/:slug/files/*path` |
| `patch_file` | `{ vault, path, edits: [{ old, new, replaceAll? }] }` — text files only | `{ path, contentType, mtimeMs, size, sha256, indexed, edits: number }` | `PATCH /v1/vaults/:slug/files/*path` |
| `append_file` | `{ vault, path, content }` — text files only | `{ path, contentType, mtimeMs, size, sha256, indexed }` | `POST /v1/vaults/:slug/files/*path:append` |
| `create_folder` | `{ vault, path }` — idempotent (mkdir -p) | `{ path, mtimeMs, created }` | `PUT /v1/vaults/:slug/folders/*path` |
| `delete` | `{ vault, path, recursive? }` — file or folder; `recursive` defaults to `false` | `{ deleted: true }` | `DELETE /v1/vaults/:slug/paths/*path` |
| `move` | `{ vault, path, destination, overwrite?, updateLinks? }` — file or folder; `overwrite` defaults to `false`, `updateLinks` to `true` | the REST `:move` response body | `POST /v1/vaults/:slug/paths/*path:move` |
| `copy` | `{ vault, path, destination, overwrite?, recursive? }` — file, or folder with `recursive: true`; both flags default to `false` | the REST `:copy` response body | `POST /v1/vaults/:slug/paths/*path:copy` |
| `search` | `{ vault, query, limit?, filter?, mode?, threshold?, mmrLambda?, maxPerPath? }` | `{ hits: SearchHit[] }` | `POST /v1/vaults/:slug/search` |
| `list_tags` | `{ vault, prefix?, limit? }` | `{ items: { tag, count }[], total }` | `GET /v1/vaults/:slug/tags` |
| `grep` | `{ vault, pattern, regex?, ignoreCase?, prefix?, limit?, context? }` | the REST grep response body | `POST /v1/vaults/:slug/grep` |

`PathEntry`, and the behavior, defaults, limits, and errors of `list`, `delete`, `move`, `copy`, and `grep`, are owned by [REST API › Path operations](../rest-api/index.md#path-operations), [Link rewriting](../rest-api/link-rewriting.md), and [REST API › Grep](../rest-api/index.md#grep); `list_tags` by [Vault Indexer › Tag listing](../vault-indexer/index.md#tag-listing). The tools take the same values as REST, as JSON booleans and numbers rather than query strings, and return the same payloads; `delete` returns `{ deleted: true }` where REST answers `204`.

`read_file` behavior by file type and `format` (extraction semantics — page markers, whitespace normalization, `pdf` metadata object, `sha256`/`size` meaning — are defined once in [Change 0013](../../changes/0013-pdf-text-extraction.md) and the shared core; both adapters MUST reuse them):

- `format: "text"` (default) — text files (per `isTextMimeType`) return `encoding: "utf-8"` with `frontmatter` parsed for Markdown, unchanged from before. **PDFs MUST return the extracted plain-text/Markdown content** (`encoding: "utf-8"`, `contentType: "application/pdf"`) plus `pdf: { pages, hasTextLayer }`. A scanned/image-only PDF is a success with `content: ""` and `pdf.hasTextLayer: false`, NOT an error. A corrupt or password-protected PDF MUST yield `isError: true` with `code: "extraction_failed"` and a message directing the caller to `format: "binary"`. Other binaries (images, unknown types) return base64 as before.
- `format: "binary"` — verbatim file bytes base64-encoded for ANY file type (including Markdown and PDFs); no frontmatter parsing, no extraction.
- `size` and `sha256` MUST always describe the on-disk file bytes, never the extracted text.

`read_file`'s tool description MUST state that PDFs return extracted text by default and that `format: "binary"` returns the verbatim base64 bytes.

`patch_file`'s tool description MUST tell the agent exactly when to prefer it over `write_file`: "Use `patch_file` whenever you would otherwise re-send the entire file with small changes. Each `old` must appear exactly once in the file, or pass `replaceAll: true`. Edits apply in order and the patch is atomic — any failed edit aborts the whole call." `append_file`'s description MUST direct callers to use it for daily-note / log / capture flows where no existing context is needed.

`create_folder`'s description MUST state that it is idempotent (`mkdir -p` semantics) and that creating a folder whose path already exists as a file returns `invalid_path`.

The path tools' descriptions MUST state that they work on files and folders alike, and:

- `list` — that entries carry `type: "file" | "folder"`, that empty folders are listed, and what `type` and `recursive: false` do.
- `delete` — that a non-empty folder is refused with `folder_not_empty` unless `recursive: true`, which removes everything under it.
- `move` — that `destination` is the exact new path (not a folder to move into), that an existing destination is refused with `already_exists` unless `overwrite: true` (which never applies to folders), and that internal links pointing at the moved files are rewritten unless `updateLinks: false`, with the rewritten notes (each with its own `indexed`) and failed notes reported, and that `indexed` is `true` only when at least one note was indexed and every index update succeeded.
- `copy` — that a folder needs `recursive: true`, that an existing destination is refused unless `overwrite: true` (files only), that links are not rewritten, and that `indexed` is `true` only when at least one copied note was indexed and every index update succeeded.

`list_tags`'s description MUST state that it lists inline tags from the search index with the number of documents carrying each, that nested tags are not rolled up into their parents, and that every listed tag can be passed to `search` as `filter.tag`. `grep`'s description MUST state that it matches exact text (or a regular expression with `regex: true`) line by line in text files on disk, that PDFs and binaries are not searched, that results are capped and flagged `truncated`, and that `search` is the tool for finding notes by meaning.

`search` MUST document in its tool description that it ranks Markdown content only; binary files are not embedded in v1. The description MUST also state: default `mode: "hybrid"` blends vector and full-text retrieval and is the right choice for almost every query; pass `mode: "vector"` only for pure-semantics evaluation; pass `mode: "fts"` only for exact-phrase / proper-noun queries where you've confirmed semantics aren't needed. The other knobs (`threshold`, `mmrLambda`, `maxPerPath`) are tuning levers; the defaults are good.

- Every tool MUST validate its input via a Zod schema and return an `isError` result with `code: "invalid_input"` and the validation message on failure.
- Every tool MUST translate underlying errors using the same `code` set as the REST error model (`vault_not_found`, `not_found`, `invalid_path`, etc.).
- Tools MUST NOT block on long-running work other than the underlying read/write/embed call; long indexing operations are not exposed.

#### Scenario: Read a missing file

- **GIVEN** vault `v` exists but has no `notes/missing.md`
- **WHEN** the client invokes tool `read_file` with `{ vault: "v", path: "notes/missing.md" }`
- **THEN** the response is `isError: true`
- **AND** the text content parses as `{ "code": "not_found", "message": "..." }`

#### Scenario: Read a binary file returns base64

- **GIVEN** vault `v` contains `attachments/diagram.png`
- **WHEN** the client invokes `read_file` with `{ vault: "v", path: "attachments/diagram.png" }`
- **THEN** the response `encoding` is `"base64"`
- **AND** decoding `content` yields the original PNG bytes
- **AND** `contentType` is `"image/png"`

#### Scenario: Read a PDF returns extracted text by default

- **GIVEN** vault `v` contains `papers/attention.pdf` with a text layer
- **WHEN** the client invokes `read_file` with `{ vault: "v", path: "papers/attention.pdf" }`
- **THEN** the response is not an error and `encoding` is `"utf-8"`
- **AND** `content` is the extracted text with `<!-- page N -->` markers between pages
- **AND** `contentType` is `"application/pdf"` and `pdf.hasTextLayer` is `true`

#### Scenario: Explicitly request PDF binary

- **GIVEN** vault `v` contains `papers/attention.pdf`
- **WHEN** the client invokes `read_file` with `{ vault: "v", path: "papers/attention.pdf", format: "binary" }`
- **THEN** the response `encoding` is `"base64"`
- **AND** decoding `content` yields the original PDF bytes

#### Scenario: Scanned PDF signals missing text layer

- **GIVEN** vault `v` contains `scans/receipt.pdf` containing only page images
- **WHEN** the client invokes `read_file` with default `format`
- **THEN** the response is not an error
- **AND** `content` is `""` and `pdf.hasTextLayer` is `false`

#### Scenario: Patch ambiguous edit reported per-edit

- **GIVEN** vault `v` containing `notes/x.md` with body `foo\nfoo\n`
- **WHEN** the client invokes `patch_file` with `{ vault: "v", path: "notes/x.md", edits: [{ old: "foo", new: "bar" }] }`
- **THEN** the response is `isError: true`
- **AND** the text content parses as `{ "code": "patch_ambiguous", "message": "...", "details": { "editIndex": 0, "occurrences": 2 } }`

#### Scenario: Append to existing daily note

- **GIVEN** vault `v` contains `daily/2026-05-03.md`
- **WHEN** the client invokes `append_file` with `{ vault: "v", path: "daily/2026-05-03.md", content: "- 14:30 had coffee\n" }`
- **THEN** the response is not an error
- **AND** the file body ends with `- 14:30 had coffee\n`

#### Scenario: Search for a topic

- **GIVEN** an indexed vault `v` with a note containing the heading "Coffee brewing methods"
- **WHEN** the client invokes tool `search` with `{ vault: "v", query: "how do I make pour over", limit: 5 }`
- **THEN** the response is not an error
- **AND** `hits[0].path` points at that note
- **AND** the result is structurally identical to `POST /v1/vaults/v/search` with the same args

### Resource surface

- The server MUST also expose vault documents as MCP resources for clients that prefer the resource model:
  - `resources/list` MUST page through documents per vault (one page per call, cursor returned).
  - Resource URIs MUST take the form `obvault://<slug>/<path>`.
  - `resources/read` of an `obvault://` URI MUST return the document text with `mimeType: "text/markdown"`.

### Capabilities

- The server's `initialize` response MUST advertise `tools.listChanged: true` and `resources.listChanged: false`.
- It MUST set `serverInfo.name = "ob"` and `serverInfo.version` to the package version.

## Design

### Module layout

```text
src/mcp/
  index.ts        # buildMcpRoutes() — Hono sub-app exposing GET/POST/DELETE /mcp
  server.ts       # MCP Server instance + tool registration
  tools/
    list_vaults.ts
    vault_status.ts
    list.ts
    read_file.ts
    write_file.ts
    patch_file.ts
    append_file.ts
    create_folder.ts
    delete.ts
    move.ts
    copy.ts
    search.ts
    list_tags.ts
    grep.ts
  resources.ts    # obvault:// URI handlers
  scope.ts        # URL scope parsing + scoped service-deps wrapper
```

### Tool implementation pattern

```ts
// src/mcp/tools/read_file.ts
import { z } from "zod";
const Input = z.object({
  vault: z.string().min(1),
  path: z.string().min(1),
  format: z.enum(["text", "binary"]).default("text"),
});
export const readFile = (deps: Deps) => ({
  name: "read_file",
  description: "Read any file from a vault. Returns utf-8 text for Markdown and other text files, extracted text for PDFs, and base64 for other binaries. Pass format: \"binary\" for verbatim base64 bytes of any file.",
  inputSchema: z.toJSONSchema(Input, { io: "input" }),
  handler: async (raw: unknown) => {
    const args = Input.parse(raw);
    const result = await deps.files.read(args.vault, args.path, { format: args.format });
    return ok(result);
  },
});
```

### Shared core with REST

All tool handlers MUST call into the same internal service modules used by REST handlers (e.g. `src/vault/files.ts`). The HTTP route and the MCP tool MUST be thin adapters; behavior parity is enforced by sharing code, not by re-implementing.

## Constraints

- No auth in v1 (mirrors REST). [Session scoping](#session-scoping) does NOT change this: a scoped URL confines a cooperating client, but any caller that can reach a scoped mount can also reach the unscoped `/mcp` and address the whole vault. Scoping MUST NOT be documented or relied on as an authentication or authorization boundary until the auth open question below is resolved.
- Tool names are fixed; clients MUST NOT discover dynamic, vault-specific tool variants. Multi-vault is handled by the `vault` argument on each tool, not by per-vault tool names. A scoped session advertises the same tool names with the same schemas, differing only in that `vault` is not `required`.
- Streaming tool responses are NOT used in v1; every tool returns a single response payload.

## Open Questions

- **Auth.** When we add auth (likely a bearer token shared with REST), MCP transport headers MUST honor it. **Default**: deferred.
- **Prompts.** MCP supports server-defined prompts (e.g. "summarize today's daily note"). **Default**: not in v1.
- **Tool naming convention.** Snake_case (above) vs dot-namespaced (`vault.read_file`). **Default**: snake_case for MCP-client ergonomics; revisit if it conflicts with a host's UI.

## References

- [Model Context Protocol](https://modelcontextprotocol.io/)
- [@modelcontextprotocol/sdk (TypeScript)](https://github.com/modelcontextprotocol/typescript-sdk)
- Mirror surface: [REST API](../rest-api/)

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-05-03 | Initial spec created | — |
| 2026-05-03 | `list_vaults` output flattened to bare `VaultSummary[]` for REST parity | 0005 |
| 2026-05-03 | `search` tool input gains `mode`, `threshold`, `mmrLambda`, `maxPerPath` knobs (mirroring REST) | [Change 0008](../../changes/0008-search-relevance.md) |
| 2026-05-25 | Added `list_folders` / `create_folder` / `delete_folder` tools mirroring the new REST `/v1/vaults/:slug/folders` surface. Required so empty folders (invisible to `list_files`) are reachable. | [Change 0012](../../changes/0012-folder-operations.md) |
| 2026-07-01 | `read_file` gains `format?: "text" \| "binary"` (default `"text"`): PDFs now return extracted text with `pdf: { pages, hasTextLayer }` metadata by default; `format: "binary"` returns verbatim base64 for any file. New error code `extraction_failed` for unparseable PDFs. | [Change 0013](../../changes/0013-pdf-text-extraction.md) |
| 2026-08-09 | Added Session scoping: `/mcp/:slug/:prefix{.+}` binds a session to one vault and folder prefix, and `/mcp/:slug` to a vault root, presented to the client as the vault root. Scoped sessions make `vault` optional, carry `instructions`, and reject session ids presented on a different scope. Containment only — not an auth boundary. | [Change 0014](../../changes/0014-mcp-folder-scoping.md) |
| 2026-10-25 | The six read tools advertise `annotations.readOnlyHint: true` in `tools/list`. | [Change 0018](../../changes/0018-mcp-read-only-annotations.md) |
| 2026-11-09 | New Tool design rules: one tool per operation (no dispatcher tool), and one unix-verb tool for any operation that applies to files and folders, for current and future tools. `list` and `delete` replace `list_files` / `list_folders` and `delete_file` / `delete_folder` (**breaking**: the four tools are removed, no aliases); `list` joins the `readOnlyHint` set in their place. | [Change 0019](../../changes/0019-unified-list-and-delete.md) |
| 2026-11-09 | New `move` (links rewritten by default) and `copy` tools mirroring the REST `:move` / `:copy` routes, with scoped-session rules for both paths and for link rewriting. | [Change 0020](../../changes/0020-move-and-copy.md) |
| 2026-11-09 | New read-only `list_tags` tool. | [Change 0021](../../changes/0021-list-tags.md) |
| 2026-11-09 | New read-only `grep` tool. | [Change 0022](../../changes/0022-grep.md) |

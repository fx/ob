# 0004: REST API

## Summary

Build out the **shared service core** (`src/vault/`, `src/errors.ts`, `src/schemas/`) for vault listing/status, file CRUD (any file type), patch/append, and natural-language search, then wire the Hono routes as a thin adapter over it. The MCP adapter (0005) reuses the same core unchanged; this PR is the one that does the heavy lifting on the service layer per [Architecture › Shared Service Core](../specs/architecture/index.md#shared-service-core).

**Spec:** [REST API](../specs/rest-api/)
**Status:** complete
**Depends On:** 0003

## Motivation

Until the REST surface lands, the indexer and supervisor have no consumer. This PR makes the system usable end-to-end from `curl`, which both unblocks early integration work and gives MCP (next change) a code-reuse target.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint)). CI enforces these as merge gates:

- All tests run under `bun test`; coverage MUST stay at 100% line + branch on `src/`.
- Route tests MUST go through the real Hono app (`app.fetch`), real `safeJoin` resolution, real LanceDB tmp store, and a fake supervisor + fake embedder. Mocking individual services inside the route handlers is forbidden.
- Path-traversal scenarios MUST each have an explicit test asserting both the response code and that the file was never created.
- Search tests MUST use the deterministic fake embedder from 0003 so result ordering is reproducible.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Service core

- `src/vault/files.ts` MUST expose pure functions: `listFiles`, `readFile`, `writeFile`, `patchFile`, `appendFile`, `deleteFile`, each taking `(deps, slug, ...)` and returning typed results.
- `src/vault/search.ts` MUST expose `search(deps, slug, args)` wrapping the indexer.
- `src/vault/status.ts` MUST expose `listVaults(deps)` and `vaultStatus(deps, slug)` aggregating supervisor + indexer state.
- `src/vault/path.ts` MUST expose `safeJoin` and the dotfile/`.obsidian/`/`.trash/` rejection rules.
- `src/vault/contentType.ts` MUST expose `detectContentType(path)` and `isTextPath(path)`.
- `src/errors.ts` MUST export every typed error class with a single canonical `code` field. The closed set MUST match the REST spec.
- `src/schemas/` MUST hold every Zod schema used to validate API inputs and outputs. REST handlers MUST parse with these schemas; the MCP adapter (0005) MUST register tools whose `inputSchema` is derived from the same Zod values.
- `readFile` MUST return `{ path, contentType, bytes: Uint8Array, mtimeMs, size, sha256 }`. The Markdown-with-frontmatter shape used by `Accept: application/json` MUST be a thin wrapper applied at the HTTP layer, not baked into the service function.
- `writeFile` MUST accept raw bytes plus an optional `markdown: { content, frontmatter? }` shape. It MUST call `indexer.reindex` only when the path is Markdown.
- `patchFile` MUST accept `{ edits: Edit[] }`, apply them sequentially against the current file buffer, and reject the whole patch on the first failed edit (no partial writes). It MUST refuse non-text files with a `UnsupportedMediaTypeError`. It MUST reject no-op edits (`old === new`) with `InvalidBodyError`.
- `appendFile` MUST refuse non-text files and missing files. It MUST NOT normalize trailing newlines.
- Both `patchFile` and `appendFile` MUST call `indexer.reindex` only when the path is Markdown, and MUST NOT call the indexer multiple times for a multi-edit patch.
- All service functions MUST be the single source of truth shared by REST handlers (this PR) and MCP tools (0005). The unit-test heavy lifting lands in this PR — adapter tests in 0005 only need to assert that the adapter is faithful, not re-test the behavior.

### Route mounting

- All routes mounted under `/v1`.
- `/v1/vaults` (GET) — list status objects per spec.
- `/v1/vaults/:slug` (GET) — single vault status; `404` on unknown slug.
- `/v1/vaults/:slug/files` (GET) — list with `prefix`, `limit`, `cursor`; includes all file types.
- `/v1/vaults/:slug/files/*path` (GET) — read; `Content-Type` from extension; `application/json` allowed only for Markdown.
- `/v1/vaults/:slug/files/*path` (PUT) — create/replace; raw body for any type, JSON `{ content, frontmatter? }` only for Markdown.
- `/v1/vaults/:slug/files/*path` (PATCH) — find/replace edits via `{ edits: Edit[] }`; text files only; atomic.
- `/v1/vaults/:slug/files/*path:append` (POST) — append-only convenience; text files only; file MUST exist.
- `/v1/vaults/:slug/files/*path` (DELETE) — delete; `204` on success, `404` if absent.
- `/v1/vaults/:slug/search` (POST) — `{ query, limit?, filter? }` → `{ hits }` (Markdown only).

### Path validation

- Centralize `safeJoin(root, rel)` in `src/vault/path.ts`. It MUST reject `..`, leading `/`, NUL bytes, paths > 1024 bytes, any segment beginning with `.`, and paths containing `/.obsidian/` or `/.trash/`.
- Any file extension is permitted; the indexer-or-not branch is taken on Markdown extension match.

#### Scenario: Traversal blocked

- **GIVEN** a fixture vault root and `rel = "../etc/passwd"`
- **WHEN** `safeJoin` is called
- **THEN** it throws `InvalidPathError`

### Atomic writes

- `writeFile` MUST write to `<target>.tmp.<uuid>` then `rename` to `<target>`.
- After rename, when the path is Markdown it MUST `await indexer.reindex(slug, relPath)` before returning so the response sees the row in LanceDB. For non-Markdown paths it MUST skip the indexer.

#### Scenario: Markdown round-trip with index visibility

- **GIVEN** a healthy fake-embedder vault `v`
- **WHEN** the client `PUT`s `/v1/vaults/v/files/notes/x.md`
- **AND** then `POST`s `/v1/vaults/v/search` with a query that matches the contents
- **THEN** the search response includes `notes/x.md` in `hits`

#### Scenario: Binary write does not call indexer

- **GIVEN** a healthy vault `v` and a fake indexer that records every call
- **WHEN** the client `PUT`s a PNG body to `/v1/vaults/v/files/attachments/x.png`
- **THEN** the response `indexed` is `false`
- **AND** the fake indexer recorded zero `reindex` calls for this path

### Error model

- A central `jsonErrorHandler` (Hono `app.onError`) MUST translate typed errors to the documented JSON shape: `{ error: { code, message, details? } }`.
- Mapping table:

| Error class | HTTP | code |
|---|---|---|
| `VaultNotFoundError` | 404 | `vault_not_found` |
| `DocNotFoundError` | 404 | `not_found` |
| `InvalidInputError` | 400 | `invalid_input` (canonical Zod-validation failure; shared with MCP) |
| `InvalidPathError` | 400 | `invalid_path` |
| `InvalidBodyError` | 400 | `invalid_body` (HTTP-specific: unparseable request envelope) |
| `InvalidQueryError` | 400 | `invalid_query` (HTTP-specific: unknown/malformed query string) |
| `UnsupportedMediaTypeError` | 415 | `unsupported_media_type` |
| `PatchNoMatchError` | 409 | `patch_no_match` (with `details: { editIndex }`) |
| `PatchAmbiguousError` | 409 | `patch_ambiguous` (with `details: { editIndex, occurrences }`) |
| `EmbedderError` | 502 | `embedder_failed` |
| any other `Error` | 500 | `internal` (with `requestId`) |

### Request logging

- A `requestId` (uuid) MUST be assigned in middleware and added to the response header `x-request-id`.
- Each request MUST log `{ method, path, status, durationMs, requestId }` at `info`.
- Bodies MUST be logged at `debug` only, truncated to 4 KB.

## Design

### Approach

- Build the service core first (`src/vault/`, `src/errors.ts`, `src/schemas/`) — every behavioral test lives at this layer.
- Then write Hono handlers as one-screen adapters: `parse(req) → call(core) → respond`. A handler that needs a helper function probably belongs in the core.
- Export Zod schemas from `src/schemas/` so MCP can derive `inputSchema` from the exact same values in 0005 (no duplicated field definitions).

### Decisions

- **Wildcard route for paths**: Hono `*path` matcher; decoded once at the route boundary.
  - Alternatives: query-param `?path=`, hex-encoded path; both are uglier and break URL ergonomics.
- **Atomic write via rename**: write-then-rename is single-fs-syscall safe on Linux; survives chokidar noise (rename is one event, not partial-write).
- **`await reindex` before responding**: the round-trip guarantee is more useful than the few extra ms; can be relaxed later if it shows in profiles.

### Non-Goals

- No auth.
- No move/rename endpoint.
- No bulk endpoints.
- No SSE for `list_files`.

## Tasks

- [x] **Service core: `src/vault/path.ts`** — `safeJoin` + dotfile/`.obsidian/`/`.trash/` rejection + tests covering traversal, hidden segments, length limit.
- [x] **Service core: `src/vault/contentType.ts`** — extension → MIME mapping, `isTextPath` + tests.
- [x] **Service core: `src/vault/files.ts`** — list/read/write/delete service functions for arbitrary file types + tests covering markdown and binary paths.
- [x] **Service core: `src/vault/search.ts`** — wraps indexer; tests with deterministic fake embedder.
- [x] **Service core: `src/vault/status.ts`** — `listVaults`, `vaultStatus` aggregating supervisor + indexer; tests.
- [x] **Service core: `src/errors.ts`** — every typed error class with canonical `code` field; tests asserting code uniqueness and shape.
- [x] **Service core: `src/schemas/`** — Zod schemas for every API input + output; tests covering happy and rejection paths.
- [x] **Adapter: error → HTTP-status mapper** — `src/http/errors.ts` + tests for every code in the table above.
- [x] **Adapter: request middleware** — request id, logging, content-type negotiation.
- [x] **Adapter: routes: vaults & status** — `GET /v1/vaults`, `GET /v1/vaults/:slug` + tests asserting the handler bodies are pure parse → call → respond.
- [x] **Adapter: routes: files CRUD** — list/read/write/delete + round-trip tests covering: Markdown with frontmatter, PNG binary, JSON-on-binary returns 406, indexer skipped for binaries.
- [x] **`patchFile` service** — sequential edit application against in-memory buffer, atomic abort on failure, no-op edit rejection, text-only enforcement; tests covering: single edit success, multi-edit success, `replaceAll` zero/one/many, `replaceAll: false` ambiguous, atomic abort with second edit failing, no-op rejection, binary rejection, missing-file rejection.
- [x] **`appendFile` service** — append bytes verbatim, no newline normalization, text-only, file-must-exist; tests covering: text append, Markdown append triggers reindex, binary rejection, missing-file rejection, byte-perfect concat (no inserted newline).
- [x] **Route: `PATCH /files/*path`** — body validation (non-empty `edits`), error mapping, response shape; integration tests for the spec scenarios (single-edit, ambiguous, atomic abort, binary).
- [x] **Route: `POST /files/*path:append`** — accept raw and JSON body forms; integration tests including index visibility for Markdown.
- [x] **Adapter: routes: search** — request validation, response shape + tests with fake embedder.
- [x] **Wire into `server.ts`** — replace placeholder routes; ensure `/healthz` and `/readyz` still 200.
- [x] **Coverage 100%**.

## Outcome

Service core lives under `src/vault/` (`path.ts`, `contentType.ts`, `files.ts`, `search.ts`, `status.ts`, `lock.ts`). Typed errors and the closed-set `ErrorCode` union live in `src/errors.ts`; Zod schemas in `src/schemas/`. Hono adapter is mounted in `src/http/index.ts` with thin routes under `src/http/routes/` and request-id + access-log middleware under `src/http/middleware/`. `bun run lint && bun run typecheck && bun run test:cov` all green; per-file coverage gate at 100% line + branch on `src/` (per the testing-requirements section above) — the gate enforces line + function as the closest available proxy because Bun ≤ 1.3 does not emit branch records, see the comment header in `test/check-coverage.ts`.

## Open Questions

- [x] **`PUT` semantics for missing parent dirs.** Server `mkdir -p` silently (current default) vs require explicit dir creation. Default is silent because Obsidian itself behaves that way.
- [x] **Frontmatter merging on `application/json` PUT.** If a request supplies `frontmatter` and the existing file has frontmatter, do we merge or replace? **Default**: replace; matches spec wording.

## References

- Spec: [REST API](../specs/rest-api/)
- Mirror surface for MCP: [MCP Server](../specs/mcp-server/)
- Related changes: [0003-vault-indexer](./0003-vault-indexer.md)

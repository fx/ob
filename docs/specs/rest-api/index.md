# REST API

## Overview

The REST API exposes vault-scoped CRUD over arbitrary files (Markdown, images, PDFs, attachments — anything stored in the vault), type-agnostic path operations (list, delete, move, copy) over files and folders, tag listing, exact-text grep, and natural-language search over the indexed Markdown content of each vault. It runs in the same Bun process as the supervisor and indexer and shares their in-memory state. There is no authentication in v1 — deployment is private-network only.

## Background

- Built on [Hono](https://hono.dev/) for first-class Bun fit and minimal overhead.
- REST is one of two **adapters** over the shared service core defined in [Architecture › Shared Service Core](../architecture/index.md#shared-service-core). It MUST contain no vault behavior of its own; every route is parse → call → respond. The other adapter is [MCP Server](../mcp-server/) and MUST behave identically against the same inputs.
- Related specs: [Architecture](../architecture/), [Obsidian Sync](../obsidian-sync/), [Vault Indexer](../vault-indexer/).
- Supplementary document: [Link rewriting](link-rewriting.md) — which internal links a move rewrites, how they are resolved, and how the rewritten text is formed. It is part of this spec.

## Requirements

### Routing & versioning

- The HTTP server MUST mount the API under `/v1`.
- Vault-scoped routes MUST use the slug, not the human name: `/v1/vaults/:slug/...`.
- Vault sub-resources are namespaced by segment (`files`, `folders`, `paths`, `tags`, `grep`, `search`, future: `sync`) so that `GET /v1/vaults/:slug` (vault metadata) and `GET /v1/vaults/:slug/files/*path` (a file inside the vault) never collide.
- Resource families split by what an operation applies to, mirroring the [MCP tool design rules](../mcp-server/index.md#tool-design-rules): `paths` carries every operation that applies to files and folders alike (list, delete, move, copy); `files` carries operations that only make sense for file content (read, write, patch, append); `folders` carries the one folder-only operation (create).
- An operation that is not a plain CRUD verb on a resource is addressed as a `POST` to the resource path with a `:verb` suffix (`*path:append`, `*path:move`, `*path:copy`). The suffix is unambiguous because Obsidian does not allow `:` in file or folder names.
- File paths MUST appear as wildcard segments: `/v1/vaults/:slug/files/*path` where `*path` is the relative path inside the vault, slash-separated, no leading slash. Any extension is allowed.
- An unknown vault slug MUST return `404` with body `{ "error": { "code": "vault_not_found", "message": "..." } }`.

### Health endpoints

`GET /healthz` is the liveness probe and `GET /readyz` is both the readiness probe and the aggregate status surface for every critical long-lived component. The split, and the rule that liveness reflects only persistent sync failure, are owned by [Architecture › Observability](../architecture/index.md#observability).

- `GET /healthz` MUST return `200 {"ok":true}` once the process has bound the port, unless a vault's sync is down. A vault's sync is down when, with `OB_HEALTHZ_SYNC_FAILURE_THRESHOLD` (default `3`) greater than 0, either:
  - its supervisor state is `failed` (reason `failed`) — an opt-in restart ceiling, a permanent `sync-setup` / `sync-config` failure, or a failure to create its directory; or
  - its `consecutiveFailures` is at least the threshold (reason `failed_attempts`) — that many supervised attempts in a row ended without one recovering in between. `consecutiveFailures` is owned by [Obsidian Sync › Sync supervision](../obsidian-sync/index.md#sync-supervision).

  `failed` wins when both apply. `OB_HEALTHZ_SYNC_FAILURE_THRESHOLD=0` takes sync out of liveness entirely, and `/healthz` then never returns anything but `200 {"ok":true}`.
- When any vault's sync is down, `GET /healthz` MUST return `503` with this body, listing only the vaults whose sync is down, in configuration order:

  ```jsonc
  {
    "ok": false,
    "unhealthy": [
      { "slug": string, "reason": "failed" | "failed_attempts",
        "state": VaultState, "consecutiveFailures": number, "lastError": string | null }
    ]
  }
  ```

- The 200 body MUST stay exactly `{"ok":true}`. `/healthz` MUST NOT read indexer state, MUST NOT read state that can block — it reads the supervisor's synchronous in-memory `list()`, the same input as `/readyz` — and MUST return 200 when no supervisor is wired: unlike readiness, liveness MUST NOT fail before a supervisor exists.
- A vault starting up, or retrying below the threshold, MUST NOT fail `/healthz`. Only persistent failure does: liveness restarts the whole process, API and healthy vaults included, so it is the backstop for a sync that in-process retries have not brought back, not a reaction to a single reconnect.
- Sync health MUST NOT gate request handling. Every REST route and MCP call MUST keep serving reads and writes for a vault whose sync is down, whatever `/healthz` reports.
- `GET /readyz` MUST return the following body on both the 200 and the 503 path:

  ```jsonc
  {
    "ok": boolean,             // true iff the response status is 200
    "vaults": VaultStatus[],   // exactly one per configured vault, in configuration order
    "indexers": IndexerStatus[] // exactly one per configured vault, synthesized as
                                // state "starting" when the indexer has not registered it
  }
  ```

- `VaultStatus` is the supervisor's public shape, owned by [Obsidian Sync › Public surface](../obsidian-sync/index.md#public-surface-to-the-rest-of-the-app) — including `lastSyncActivityAt` and the `watchdog` sub-object. `IndexerStatus` is owned by [Vault Indexer](../vault-indexer/). Neither is restated here.
- `GET /readyz` MUST return `200` only when **all** of the following hold; otherwise it MUST return `503`:
  - at least one vault is configured;
  - every configured vault's supervisor state is `running`;
  - every configured vault has an entry in `indexers` whose state is `ready`.
- `vaults` and `indexers` MUST each carry exactly one entry per configured vault, both in configuration order. The two arrays are therefore positionally correlatable — index `i` of each describes the same vault — and clients MAY rely on that. Stating it is not optional: consumers will correlate positionally whether or not the contract blesses it, so leaving `indexers` unordered would make a property people depend on an accident of implementation. Each entry also carries its own `slug`, so a client MAY match on that instead. A configured vault the indexer service has not registered yet MUST appear as a synthesized entry in state `starting`, never be omitted — an omitted component is one that cannot hold the response at 503 when it is unhealthy, which is the failure mode this contract exists to prevent. This mirrors the synthesis `GET /v1/vaults` already performs for the same startup race.
- `ok` MUST equal `status === 200`. It exists so an alerting rule can key on one boolean instead of re-deriving the aggregate from the arrays.
- The body MUST be identical in shape on 200 and 503 — the 503 path MUST NOT truncate, omit, or reorder the arrays. An operator diagnosing a 503 needs the per-component detail in the same place they found it when things were healthy.
- Every critical long-lived component MUST appear in the body. A component that is not represented MUST NOT be able to keep `/readyz` at 200 while it is unhealthy.
- `watchdog.state` MUST NOT affect the status code. A vault whose stall watchdog is `resolving` (never armed) or `disabled` is not thereby unready: readiness means the child is running and the index is built, and an unarmed watchdog is a loss of protection rather than a loss of service. Failing readiness on it would let one upstream layout change take every vault out of service at once. The condition is carried in the body — that is what an operator alerts on. See [Obsidian Sync › Sync activity log](../obsidian-sync/index.md#sync-activity-log).

#### Scenario: Stalled vault reported through readiness

- **GIVEN** vault `v` whose `ob sync` child has been killed by the stall watchdog and is awaiting restart
- **WHEN** the client calls `GET /readyz`
- **THEN** the response is `503` with `ok: false`
- **AND** the entry for `v` in `vaults` carries `state` `starting`, a `lastError` naming the stall, and a `lastSyncActivityAt` pinned to the last upstream sync-log write
- **AND** `GET /healthz` still returns `200 {"ok":true}` (first stall kill; below the threshold)

#### Scenario: Persistent sync failure fails liveness

- **GIVEN** `OB_HEALTHZ_SYNC_FAILURE_THRESHOLD` unset
- **AND** vault `v` whose last three supervised attempts all failed with no recovery in between
- **WHEN** the client calls `GET /healthz`
- **THEN** the response is `503` with `ok: false` and one `unhealthy` entry for `v` with reason `failed_attempts` and `consecutiveFailures` 3
- **AND** `PUT` and `GET` on `/v1/vaults/v/files/*` and MCP `read_file` still succeed

#### Scenario: Failed vault fails liveness

- **GIVEN** vault `v` in state `failed`
- **WHEN** the client calls `GET /healthz`
- **THEN** the response is `503` with one `unhealthy` entry for `v` with reason `failed`
- **AND** with `OB_HEALTHZ_SYNC_FAILURE_THRESHOLD=0` the same call returns `200 {"ok":true}`

#### Scenario: Everything healthy

- **GIVEN** every configured vault is `running` and every indexer is `ready`
- **WHEN** the client calls `GET /readyz`
- **THEN** the response is `200` with `ok: true` and both arrays fully populated

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

For all routes below, `:slug` is the vault slug and `*path` is the file path inside the vault. Any file type is supported (Markdown, images, PDFs, attachments). Only [indexable](../vault-indexer/index.md#indexable-paths) Markdown files (`.md` / `.markdown`, outside hidden and `node_modules` folders, not reached through a symlink) are indexed for search; binaries are stored on disk and round-tripped through `ob sync` but not embedded in v1.

Listing and deleting files are [Path operations](#path-operations), shared with folders: there is no `GET /v1/vaults/:slug/files` list route and no `DELETE /v1/vaults/:slug/files/*path` route. Both were removed by [Change 0019](../../changes/0019-unified-list-and-delete.md).

#### `GET /v1/vaults/:slug/files/*path`

- Returns the raw file bytes.
- For the raw-bytes (non-JSON) variant, the response `Content-Type` header MUST be the detected MIME type by extension (`text/markdown; charset=utf-8` for `.md`/`.markdown`, `image/png` for `.png`, `application/pdf` for `.pdf`, etc.); fallback `application/octet-stream`. The JSON variants below respond with `Content-Type: application/json`; the original file's detected MIME type appears in the body's `contentType` field where the shape includes one.
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
- Response MUST be `200 { path, mtimeMs, size, sha256, contentType, created: boolean, indexed: boolean }`. `indexed` is `true` iff the reindex in the same request succeeded and reported the path [indexable](../vault-indexer/index.md#indexable-paths) (and so indexed).
- The handler MUST `mkdir -p` the parent directory inside the vault, write the file atomically (temp file + rename).
- The handler MUST then `await indexer.reindex(slug, path)` for the path it wrote, whatever its type, before responding and still holding the path's write lock. For an indexable path the reindex indexes it; for any other path — a binary, a note under `node_modules`, a path a scoped session sees as `note.md` but that is not indexable vault-wide — it drops any rows the path still holds and reports it not indexed, so the response has `indexed: false` and no stale rows survive until the next startup sweep.
- A rejected reindex MUST NOT fail the request: the write has already happened, so the handler logs the failure and returns the successful write with `indexed: false`, never a 5xx; the watcher reconciles. `PATCH` and `:append` follow the same rule.
- The handler MUST refuse to write outside the vault root (Path validation).

#### `PATCH /v1/vaults/:slug/files/*path`

- Surgical text edits via find-and-replace pairs. Designed to let an LLM modify a long note without re-sending the whole file.
- Request body MUST be `application/json`: `{ edits: Edit[] }` where `Edit = { old: string, new: string, replaceAll?: boolean }`. `edits` MUST be non-empty.
- The handler MUST refuse non-text files. A file is "text" if its extension maps to a `text/*` MIME type, `application/json`, `application/yaml`, or any `+xml` / `+json` variant — practically: `.md`, `.markdown`, `.txt`, `.json`, `.yaml`, `.yml`, `.csv`, `.toml`, `.html`, `.xml`. Otherwise `415 unsupported_media_type`.
- The handler MUST refuse empty files (`404 not_found`) — PATCH is for editing, use PUT to create.
- Each `Edit` is applied in order against the running buffer. For each edit:
  - If `replaceAll` is `true`, every occurrence of `old` MUST be replaced with `new`. Zero occurrences MUST yield `409 patch_no_match` with `details: { editIndex }`.
  - If `replaceAll` is omitted/false, exactly one occurrence of `old` MUST exist. Zero occurrences MUST yield `409 patch_no_match`. Two or more MUST yield `409 patch_ambiguous` with `details: { editIndex, occurrences }`.
- The patch is atomic: any failed edit MUST abort the whole patch with no write to disk.
- After all edits succeed, the handler writes atomically (temp + rename), reindexes the path whatever its type (as `PUT` does, `indexed` meaning the same), and returns `200 { path, mtimeMs, size, sha256, contentType, indexed, edits: number }` matching the `PUT` response shape plus `edits` (count applied).
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
- After append, the handler MUST reindex the path whatever its type, as `PUT` does, with `indexed` meaning the same.
- Response shape mirrors `PUT` (`200 { path, mtimeMs, size, sha256, contentType, indexed, created: false }`).

#### Scenario: Append to daily note

- **GIVEN** vault `v` containing `daily/2026-05-03.md` with body `# Today\n`
- **WHEN** the client `POST`s `/v1/vaults/v/files/daily/2026-05-03.md:append` with body `- 14:30 had coffee\n`
- **THEN** the response is `200`
- **AND** the file body is `# Today\n- 14:30 had coffee\n`

### Folder CRUD

Creating a folder is the one folder-only operation. Listing, deleting, moving, and copying folders are [Path operations](#path-operations), shared with files. Obsidian Sync preserves empty folders (no upstream toggle exists per [Sync settings](https://obsidian.md/help/sync/settings)), so the API exposes them; an empty folder is visible through `GET /v1/vaults/:slug/paths`.

#### `PUT /v1/vaults/:slug/folders/*path`

- Creates the folder (and any missing ancestors); `mkdir -p` semantics.
- Request body MUST be ignored (folders carry no content). Senders SHOULD send `Content-Length: 0`.
- Response MUST be `200 { path, mtimeMs, created: boolean }`. `created` is `true` on first creation and `false` on idempotent no-op against an existing folder.
- If the path already exists as a file (not a directory), the response MUST be `400` with `error.code = "invalid_path"`.

#### Scenario: Idempotent create

- **GIVEN** vault `v` with no `archive/2026/` folder
- **WHEN** the client `PUT`s `/v1/vaults/v/folders/archive/2026`
- **THEN** the response is `200` with `created: true`
- **AND** a replay of the same `PUT` returns `200` with `created: false` and the same `mtimeMs`

### Path operations

> Move and copy are specified by draft change [0020](../../changes/0020-move-and-copy.md) and not yet implemented; list and delete landed with [0019](../../changes/0019-unified-list-and-delete.md).

Operations that apply to files and folders alike live under one type-agnostic resource family, `/v1/vaults/:slug/paths`, with the semantics of the matching unix tool: list (`ls`), delete (`rm` / `rm -r`), move (`mv -T`), copy (`cp` / `cp -r -T`). `*path` names a file or a folder; the operation determines which it is from the filesystem, never from the request.

Rules shared by every path operation:

- Every path an operation addresses — the source and, for move and copy, the destination — MUST pass [Path validation](#path-validation), including the symlink check on the path and its whole parent chain, before the operation does anything. A failure in this up-front validation rejects the whole request with a 4xx and no change on disk. A containment failure found later, by the check that precedes each filesystem call, follows the [containment precondition](#path-operations) and the post-publication rule: a 4xx with nothing changed before publication, `500 internal` with both paths left as they are after it.
- A trailing `/` on a path MUST be tolerated and stripped, and empty and `.` segments are dropped (`./a.md` and `notes//b.md` name `a.md` and `notes/b.md`); [Path validation](#path-validation) already rejects `..`. Every equality check (source equals destination), descendant check (destination inside a folder source), and response path MUST use this canonical form (no leading or trailing `/`, no empty or `.` segments). The vault root itself is never a valid target (`400 invalid_path`), and the empty path does not match the `*path` routes.
- Every reindex a move, copy, or link rewrite makes of a path it published or wrote MUST run while holding that path's write lock, so a concurrent `PUT` / `PATCH` / `:append` either finishes before it (and is what gets indexed) or starts after it (and reindexes its own content); stale content never overwrites newer rows.
- Concurrent mutating calls that address the same file MUST be serialized against each other and against `PUT` / `PATCH` / `:append` on that file, and concurrent calls MUST NOT deadlock, whatever pair of paths each addresses. Serialization is per file: a write to a file inside a folder that is being moved, copied, or deleted is not serialized against the folder operation, and lands at whichever path it addressed.
- Errors are checked before anything changes, and a 4xx is only ever returned before the operation has published anything. After a move has published its destination, only its remaining filesystem steps can fail the request — confirming the source is still the same file as the destination, the containment check before removing the source, and the removal itself. A failure in one of those is never a 4xx: the move fails with `500 internal` and leaves both paths as they are, the same end state as a crash between the two steps. Everything after them — index drops and reindexes, and link rewriting — never fails the request: the response is `200`, and such failures are reported through `indexed` and `links.failed`. A 500 does not by itself mean the two paths now hold the same file (a cooperating writer replacing the source is one of its causes), so a caller MUST inspect both paths, for example by comparing their `sha256` in `GET /paths`, before retrying; see [Completing a half-finished move](#post-v1vaultsslugpathspathmove). A copy's only step after publishing is removing its own hidden temp file, so a failure there leaves that file behind and does not fail the copy. A request rejected with a 4xx leaves the index exactly as it was and the vault as it was, with one documented exception: a parent folder the call created for its destination is removed again, but only while it is still empty, so a folder that something else has meanwhile put content into stays.

**Threat model for outside writers.** Writers outside ob are *cooperating*: Obsidian Sync and the user's own edits and tools. A party with direct write access to the vault directory who acts adversarially is outside the threat model: it can already delete or replace anything in the vault without going through ob, and ob is not an authorization boundary (see [Constraints](#constraints)). The guarantees below are stated against cooperating outside writers; vault containment — no operation reads or writes outside the vault root — is the one property ob also re-checks immediately before acting, as the containment rule below states. That re-check covers ob's own concurrent operations and cooperating writers; a parent swapped for a symlink in the instant between a check and its system call is outside the threat model, for reads exactly as for writes.

**Concurrency and failure guarantees.** The guarantees differ by who the other party is, and every move, copy, and delete conforms to all three:

1. **Against ob's own operations — strict.** For `:move` and `:copy`, the destination checks (exists, is a file or a folder) and publishing the destination MUST be one indivisible step with respect to every other ob operation: concurrent calls that target the same destination, whatever mix of move and copy, file and folder, MUST be serialized, each seeing the destination exactly as the previous one left it, with no data lost. So two calls without `overwrite: true` aimed at one absent destination end with exactly one success and `409 already_exists` for the other. Calls with `overwrite: true` (files only) can all succeed: each replaces the destination in one atomic step, in turn, and the last to run wins. A call without `overwrite` that runs after another has published gets `already_exists`. A check made earlier, for example to answer quickly, never licenses the publish.
2. **Against writers outside ob (Obsidian Sync, a shell) — as strong as the filesystem allows.**
   - Without `overwrite: true`, a file is published with a no-replace primitive (a hard link) wherever the vault's filesystem supports one, and then MUST fail with `already_exists` rather than replace a file that an outside writer put at the destination. On a filesystem without hard links, ob checks the destination under its lock and renames, logging a warning once per vault; a file an outside writer creates at the destination in the instant between that check and the rename can then be replaced. Moves and copies keep working on such filesystems.
   - A folder is always published by a rename onto a destination ob has just confirmed absent under its lock, and a rename replaces an existing *empty* directory. So an outside writer that creates an empty folder at the destination in that instant can have it replaced; a folder holding anything cannot be (the rename fails with `already_exists`), so no file content is lost this way.
   - With `overwrite: true` (files only), the destination file is replaced by one atomic rename, so a reader sees the old content or the new, never neither.
   - A file move without `overwrite` removes its source only after confirming, immediately before, that the source and the destination are still the same file (same device and inode). If a cooperating writer replaced the source after the link was made, the move leaves both paths as they are and fails with `500 internal`. The instant between that confirmation and the removal is a known limit: a source replaced in exactly that instant is removed.
3. **On failure — never delete what this call did not create.** A cleanup, rollback, or fallback path MUST NOT delete or replace any path the operation cannot prove it created in this call; leaving something behind is always preferred to losing something. A call proves creation only for its own uniquely named hidden temp files and staging folders, created exclusively, and for parent folders it created itself and recorded. Parent folders are removed deepest first, only with a directory removal that refuses a non-empty folder. A recorded folder that is already gone counts as removed and the cleanup continues with its recorded ancestors; any other refusal stops the cleanup, leaving that folder and everything above it. Anything else the call has already published stays where it is, and the error says so (see `:move`). "Created by this call" is a sufficient proof of ownership under the threat model: the temp and staging names are hidden and carry a fresh random UUID, ob refuses hidden segments on every API path, so no ob call can address them, and cooperating outside writers do not create, delete, or replace such names.

**Containment precondition.** Every filesystem call a move, copy, or link rewrite makes that creates, writes, links, renames, or removes a path MUST be immediately preceded by the [Path validation](#path-validation) symlink check over the full parent chain of every path that call touches (for a link or rename, both the old and the new path). A parent component that exists but is not a real directory (a symlink or a file) is `400 invalid_path` when it is found before the operation has published anything, and `500 internal` with both paths left as they are when it is found after a move has published its destination — see the post-publication rule above. The precondition covers every such call: each parent folder created, each temp file created, written, published, or removed, each link and rename, each source removed, the creation, final rename, and removal of a staging folder, and each note write.

It covers content reads too: every read of a file's bytes that `GET /paths` (hashing), `:copy` (the source), the link rewriter (each referring note), and grep make MUST be immediately preceded by the same parent-chain check, MUST open the file without following a symlink, and MUST confirm the opened file is a regular file. On a mismatch a listing or grep skips the entry, a copy returns `400 invalid_path` (its source reads all happen before it publishes anything), and the rewriter reports the note in `links.failed` with `invalid_path`.

There is exactly one exemption: calls whose target lies strictly inside a staging folder this call has just created under a hidden, UUID-unique name. No ob API path can address such a name, because hidden segments are refused everywhere, and cooperating outside writers do not touch it, so under the threat model nothing can plant a symlink there. The staging folder itself is not exempt: its creation, its final rename onto the destination, and its removal are each checked.

The remaining window between a check and its call is the same one `PUT` has between its single check and its write; closing it would only matter against an adversarial writer, which is outside the threat model.

A concurrent ob operation that writes into a parent folder another call is just removing again can fail and is safe to retry. Move and copy each retry once when they find a parent missing: the missing parents are created again and the failed step (a copy's temp-file or staging-folder creation, or any publish) is repeated. A second missing parent fails the call with `500 internal`, with only the call's own temp file or staging folder removed and nothing published.

#### `GET /v1/vaults/:slug/paths`

- Lists files and folders in one walk. Query params: `prefix` (string, ≤ 1024 bytes, matched literally against the leading bytes of each path), `limit` (int, 1–1000, default 100), `cursor` (opaque string), `type` (`file` | `folder`; omitted means both), `recursive` (`true` | `false`, default `true`). Any other parameter or value MUST yield `400 invalid_query`.
- MUST return `200 { items: PathEntry[], nextCursor: string | null }` where

  ```ts
  type PathEntry =
    | { type: "file"; path: string; mtimeMs: number; size: number; sha256: string; contentType: string }
    | { type: "folder"; path: string; mtimeMs: number };
  ```

  `contentType` is the detected MIME type by extension and `sha256` the hash of the file bytes, exactly as the file read reports them. Folder entries carry no size, hash, or content type.
- Entries MUST be ordered by comparing their paths segment by segment (split on `/`), each segment by raw code point, a path sorting before every path it is a proper segment-prefix of. This is pre-order: a folder is immediately followed by its descendants, so `a`, `a/x.md`, `a-b.md` is the order of a folder `a`, its file `x.md`, and a sibling file `a-b.md`.
- `nextCursor` MUST be `null` on the last page. A cursor MUST resume strictly after the last entry of the page that produced it, in the order above, so paging visits every entry that exists for the whole paging sequence exactly once.
- With `recursive=false`, only entries one level below the prefix's folder are returned: let `base` be `prefix` up to and including its last `/` (empty when it has none); an entry is returned iff it starts with `prefix` and the part after `base` contains no `/`. So `prefix=notes/` lists the direct children of `notes`, and an empty prefix lists the top level of the vault.
- `type` filters before `limit` is applied: a page holds up to `limit` entries of the requested type.
- MUST include every file type, MUST NOT emit the vault root, and MUST omit any entry whose path contains a hidden segment (a segment starting with `.`, which covers `.obsidian/` and `.trash/`) and any symlink. Symlinks are detected without being followed, and nothing below a hidden folder or a symlink is listed.
- An entry that vanishes, or stops being a regular file or directory, while the walk is reading it MUST be skipped rather than failing the page.

#### Scenario: Files and folders in one ordered listing

- **GIVEN** vault `v` containing the folder `a/` with file `a/x.md`, the empty folder `a/empty/`, and the file `a-b.md`
- **WHEN** the client calls `GET /v1/vaults/v/paths`
- **THEN** `items` is, in order: folder `a`, folder `a/empty`, file `a/x.md`, file `a-b.md`
- **AND** each file entry carries `size`, `sha256`, and `contentType`, and each folder entry only `type`, `path`, and `mtimeMs`

#### Scenario: Pagination does not skip a sibling that sorts between a folder's descendants

- **GIVEN** the vault from the previous scenario
- **WHEN** the client pages with `limit=3` and follows `nextCursor`
- **THEN** the first page ends at `a/x.md` and the second page is exactly `a-b.md` with `nextCursor: null`

#### Scenario: Empty-folder visibility

- **GIVEN** vault `v` containing only the empty folder `notes/scratchpad/`
- **WHEN** the client calls `GET /v1/vaults/v/paths`
- **THEN** `items` is folders `notes` and `notes/scratchpad`
- **AND** `GET /v1/vaults/v/paths?type=file` returns `{ items: [], nextCursor: null }`

#### Scenario: Non-recursive listing

- **GIVEN** vault `v` containing `notes/a.md`, `notes/sub/b.md`, and `top.md`
- **WHEN** the client calls `GET /v1/vaults/v/paths?prefix=notes/&recursive=false`
- **THEN** `items` is file `notes/a.md` and folder `notes/sub`, and does not contain `notes/sub/b.md`

#### `DELETE /v1/vaults/:slug/paths/*path`

- Deletes a file or a folder. Optional query string `recursive` (`true` | `false`, default `false`); any other parameter or value MUST yield `400 invalid_query`.
- A file MUST be removed whatever `recursive` says (`rm -r` on a file removes the file).
- An empty folder MUST be removed. A non-empty folder without `recursive=true` MUST yield `409 folder_not_empty` and stay unchanged, including when a child appears between the emptiness check and the removal. With `recursive=true` the folder and everything under it MUST be removed.
- After the removal from disk succeeded, and before the response is sent, the index rows of every removed path MUST be dropped — the file itself, or, for a removed folder, every indexed path under the folder's path followed by `/`, including a note written into the folder after the delete began but before the removal — following the [drop guard](../vault-indexer/index.md#indexable-paths): a path's rows are kept only if an indexable note exists at that path when the drop runs, so an indexable note recreated under the folder after the removal keeps its rows and anything else there (a symlink, a folder) does not. A drop failure MUST NOT fail the request (it is logged; the watcher reconciles); a removal failure leaves every index entry in place.
- A path that does not exist MUST yield `404 not_found`. On success the response is `204` with no body.

#### Scenario: Delete a file

- **GIVEN** vault `v` containing the indexed note `notes/x.md`
- **WHEN** the client `DELETE`s `/v1/vaults/v/paths/notes/x.md`
- **THEN** the response is `204`, the file is gone, and the index has no rows for `notes/x.md`

#### Scenario: Non-empty folder refused without recursive

- **GIVEN** vault `v` containing `projects/alpha/intro.md`
- **WHEN** the client `DELETE`s `/v1/vaults/v/paths/projects/alpha`
- **THEN** the response is `409` with `error.code = "folder_not_empty"`
- **AND** `projects/alpha/intro.md` is unchanged and no index entry was dropped

#### Scenario: Recursive delete drops Markdown index entries

- **GIVEN** vault `v` containing the indexed notes `archive/2024/jan.md` and `archive/2024-old.md`, and `archive/2024/cover.png`
- **WHEN** the client `DELETE`s `/v1/vaults/v/paths/archive/2024?recursive=true`
- **THEN** the response is `204` and `archive/2024/` no longer exists on disk
- **AND** after the folder was removed, the indexer listed the indexed paths under `archive/2024/` and dropped each one, none of them existing any more
- **AND** the index has no rows whose path starts with `archive/2024/`, while the rows for `archive/2024-old.md` are intact

#### Scenario: Delete a missing path

- **GIVEN** vault `v` with no `notes/missing.md`
- **WHEN** the client `DELETE`s `/v1/vaults/v/paths/notes/missing.md`
- **THEN** the response is `404` with `error.code = "not_found"`

#### `POST /v1/vaults/:slug/paths/*path:move`

- Moves (renames) a file or a folder to an exact destination path, like `mv -T`: the destination names the new path itself, never a folder to move into.
- Request body MUST be `application/json` `{ destination: string, overwrite?: boolean, updateLinks?: boolean }`. `overwrite` defaults to `false`, `updateLinks` to `true`. Unknown keys MUST yield `400 invalid_input`.
- A folder move, and a file move with `overwrite: true`, MUST be a single atomic rename on disk: the source disappears and the destination appears in one step. A file move without `overwrite` publishes the destination with a no-replace link and then removes the source, so for an instant the file is visible at both paths, never at neither. If removing the source fails, the source is no longer the same file as the destination (a cooperating writer replaced it), or the process dies in between, both paths keep their files, nothing is lost, and the call fails with `500 internal` without touching either path; the watcher indexes the new path. The caller inspects both paths before retrying, as the post-publication rule above states. A folder moves with its whole subtree (hidden entries and symlinks inside it included — they travel with the folder, they are not separately addressed). Modification times are preserved (a moved note whose own links are then rewritten gets a new one). Missing parent folders of the destination MUST be created (`mkdir -p`).
- With `overwrite: true` and both paths files, an existing destination file MUST be replaced atomically. A folder never replaces or merges into a path that the under-lock destination check finds existing, and a file never replaces a folder, whatever `overwrite` says. The one stated exception is guarantee 2's outside-writer race: an *empty* directory an outside writer creates at the destination after that check can be replaced by the folder's rename.
- **Completing a half-finished move.** If the source and the destination are already the same file (same device and inode — the state a file move leaves when it fails between publishing the destination and removing the source), a move with `overwrite: true` completes it: it runs as any move does, except that instead of publishing it removes the source, after re-confirming the two are still the same file. Links to the old path are seen before the source goes and are rewritten as for any move, and the response reports `overwritten: false` because nothing was replaced. This applies only when the two really are the same file: after a `500` the source may have been replaced by a cooperating writer, and then `overwrite: true` replaces the destination with the new source like any overwrite. Callers retrying after a `500` therefore compare both paths (their `sha256` in `GET /paths`) and use `overwrite: true` only when the two match or replacing the destination is intended. Without `overwrite` the destination exists, so the move is `409 already_exists`, as for any existing destination. This is detected before publishing, so a plain rename onto the same file (which succeeds while leaving the source in place) never happens.
- The index follows the [indexable-path rule](../vault-indexer/index.md#indexable-paths): Markdown files with no hidden or `node_modules` segment, regular and not reached through a symlink. Hidden entries and symlinks may travel with a moved folder, but they are not among the moved paths `GET /paths` would list, so they are not reindexed and do not affect `indexed`. Every other arriving path is reindexed. An indexable one is indexed. A non-indexable one, such as a file under `node_modules` or a non-Markdown file, has any rows it holds dropped and counts as not indexed. Before responding, the index rows of every path the move removed MUST have been dropped, without consulting the indexable-path rule but subject to the [drop guard](../vault-indexer/index.md#indexable-paths). For a folder move, that means every indexed path under the old folder's path followed by `/`, found from the index the way a recursive delete finds them, not only the moved paths `GET /paths` would list, so rows held under a hidden entry or a symlink that travelled with the folder are dropped too. Under the drop guard, an old path recreated as an indexable note by the time of the drop keeps its rows, and any other path's rows are dropped (a drop failure is logged and the watcher reconciles), and every path that arrived MUST have been reindexed — an indexable one is indexed, any other has its rows dropped — (a moved note is re-embedded under its new path — see [Vault Indexer › Public surface](../vault-indexer/index.md#public-surface)). When `overwrite: true` replaced a destination file, its old rows (if it had any) MUST have been dropped before the response whether or not the reindex of the new content succeeds, so search does not serve the replaced content under that path — unless that drop itself fails, in which case `indexed` is `false` and the stale rows are reconciled by the watcher or the path's next reindex. `indexed` covers the moved paths only: it is `true` iff the reindex of at least one moved path reported it indexed and every required drop and reindex of moved paths succeeded; a move of only non-indexable files (binaries, an empty folder) reports `false`, as `PUT` does for a binary. A moved note that link maintenance also rewrote is one of the moved paths: its reindex counts toward the top-level `indexed` (and it appears in `links.updated` with its own `indexed` too). Rewritten notes that did not move report only through their own `links.updated[].indexed`. A failed drop or reindex is logged and the watcher reconciles.
- With `updateLinks: true`, internal links in Markdown notes that pointed at a moved file MUST be rewritten to keep pointing at it, as [Link rewriting](link-rewriting.md) defines. Link rewriting happens after the move has succeeded. A note that cannot be rewritten MUST be reported in `links.failed` and left unchanged; it MUST NOT undo the move or any other note's rewrite, and the response is still `200`.
- Response MUST be:

  ```ts
  200 {
    path: string;              // the source path
    destination: string;
    type: "file" | "folder";
    overwritten: boolean;      // true iff an existing destination file was replaced
    indexed: boolean;
    links: {
      updated: { path: string; links: number; indexed: boolean }[];   // post-move paths, in path order; links = occurrences rewritten; indexed = its reindex succeeded
      failed: { path: string; code: string; message: string }[];
    } | null;                  // null iff updateLinks was false
  }
  ```

- Errors, all checked before anything is published, the destination checks atomically with the publish as [Path operations](#path-operations) requires:

  | Condition | Status | `error.code` |
  |---|---|---|
  | Source does not exist | 404 | `not_found` |
  | Destination equals the source, or a folder's destination lies inside it | 400 | `invalid_path` |
  | A parent of the destination exists as a file | 400 | `invalid_path` |
  | Destination exists and `overwrite` is not `true` | 409 | `already_exists` |
  | Destination exists, `overwrite: true`, and either path is a folder | 409 | `already_exists` |
  | Destination is the same file as the source and `overwrite` is not `true` | 409 | `already_exists` |

#### Scenario: Rename a note and update links to it

- **GIVEN** vault `v` containing `notes/old.md` and `daily/today.md` whose body contains `see [[old]]`
- **WHEN** the client `POST`s `/v1/vaults/v/paths/notes/old.md:move` with `{ "destination": "notes/new.md" }`
- **THEN** the response is `200` with `type: "file"`, `overwritten: false`, and `links.updated` = `[{ "path": "daily/today.md", "links": 1, "indexed": true }]` and top-level `indexed: true`
- **AND** `notes/new.md` exists with the old bytes and `notes/old.md` does not
- **AND** `daily/today.md` now contains `see [[new]]`
- **AND** the index has rows for `notes/new.md` and none for `notes/old.md`

#### Scenario: Clobber refused without overwrite

- **GIVEN** vault `v` containing `a.md` and `b.md`
- **WHEN** the client `POST`s `/v1/vaults/v/paths/a.md:move` with `{ "destination": "b.md" }`
- **THEN** the response is `409` with `error.code = "already_exists"`
- **AND** both files are unchanged

#### Scenario: Concurrent moves to the same destination

- **GIVEN** vault `v` containing `a.md` and `b.md` with different content, and no `c.md`
- **WHEN** the client sends `POST /v1/vaults/v/paths/a.md:move` and `POST /v1/vaults/v/paths/b.md:move`, both with `{ "destination": "c.md" }`, concurrently
- **THEN** exactly one returns `200` and the other `409` with `error.code = "already_exists"`
- **AND** `c.md` holds the winner's content and the loser's source file is unchanged at its original path

#### Scenario: Move does not clobber a file written by an outside writer

- **GIVEN** vault `v` on a filesystem with hard links, containing `a.md`, and a writer outside ob that creates `c.md` after ob's destination check but before ob publishes
- **WHEN** the move `a.md` → `c.md` without `overwrite` publishes
- **THEN** it returns `409` with `error.code = "already_exists"`, the outside writer's `c.md` is intact, and `a.md` is unchanged

#### Scenario: Source replaced between link and removal

- **GIVEN** vault `v` containing `a.md`, and a cooperating writer that replaces `a.md` with new content after ob has linked `c.md` to it but before ob removes `a.md`
- **WHEN** the move `a.md` → `c.md` without `overwrite` reaches the removal of its source
- **THEN** it returns `500` with `error.code = "internal"`, `a.md` holds the writer's new content, and `c.md` holds the moved content

#### Scenario: Containment failure after publication is a server error, not a 4xx

- **GIVEN** vault `v` containing `notes/a.md`, and a parent of the source that is replaced by a symlink to outside the vault after ob has linked `c.md` to the source but before it removes the source
- **WHEN** the move `notes/a.md` → `c.md` reaches the removal of its source
- **THEN** it returns `500` with `error.code = "internal"`, `c.md` holds the moved content, and nothing outside the vault is removed

#### Scenario: Retry after a half-finished move

- **GIVEN** vault `v` where an earlier move `a.md` → `c.md` returned `500` after publishing, so `a.md` and `c.md` are the same file
- **WHEN** the client retries `POST /v1/vaults/v/paths/a.md:move` with `{ "destination": "c.md", "overwrite": true }`
- **THEN** the response is `200` with `overwritten: false`, `a.md` no longer exists, `c.md` holds the content, and links to `a.md` are rewritten as for any move
- **AND** the same retry without `overwrite` returns `409` with `error.code = "already_exists"` and changes nothing

#### Scenario: Move a folder into a new parent

- **GIVEN** vault `v` containing `inbox/2026/a.md` and `inbox/2026/img.png`, and no `archive/` folder
- **WHEN** the client `POST`s `/v1/vaults/v/paths/inbox/2026:move` with `{ "destination": "archive/2026", "updateLinks": false }`
- **THEN** the response is `200` with `type: "folder"` and `links: null`
- **AND** `archive/2026/a.md` and `archive/2026/img.png` exist and `inbox/2026/` does not

#### Scenario: Folder moved into itself

- **GIVEN** vault `v` containing the folder `projects/`
- **WHEN** the client `POST`s `/v1/vaults/v/paths/projects:move` with `{ "destination": "projects/old" }`
- **THEN** the response is `400` with `error.code = "invalid_path"` and nothing changed

#### `POST /v1/vaults/:slug/paths/*path:copy`

- Copies a file, or with `recursive: true` a folder, to an exact destination path, like `cp -T` / `cp -r -T`.
- Request body MUST be `application/json` `{ destination: string, overwrite?: boolean, recursive?: boolean }`, both flags defaulting to `false`. Unknown keys MUST yield `400 invalid_input`.
- A file copy MUST write the source bytes to the destination atomically, creating missing parent folders: the destination appears complete or not at all, and without `overwrite` it is published under the same rules as a move, including the no-hard-link fallback. With `overwrite: true` an existing destination file MUST be replaced by one atomic rename. `recursive` has no effect on a file.
- A folder copy without `recursive: true` MUST yield `400 invalid_path`. With it, the destination MUST NOT exist when the under-lock destination check runs (a folder copy never merges, whatever `overwrite` says; guarantee 2's empty-directory race is the one stated exception) and MUST NOT lie inside the source. The copy contains every folder (empty ones included) and regular file that [`GET /paths`](#get-v1vaultsslugpaths) would list under the source; hidden entries and symlinks are not copied and are counted in `skipped`. The destination MUST appear complete or not at all: a concurrent reader never sees a partial copy, and a failed copy leaves no destination behind and removes only its own staging folder.
- Copies get fresh modification times. Content is copied byte for byte; links are never rewritten, so a relative link inside a copied note may resolve differently from its new location.
- Every file the copy wrote MUST be reindexed before responding (an [indexable](../vault-indexer/index.md#indexable-paths) one is indexed, any other has any rows at its path dropped); `indexed` is `true` iff at least one indexable file was reindexed and every required drop and reindex succeeded, so a copy of only binaries or of an empty folder reports `false`. A copy never writes hidden entries or symlinks. A Markdown file it writes under a `node_modules` segment is copied but not indexed, the same index set as a move's. An overwritten destination follows the move's rule: its old rows, if any, have been dropped before the response even if the reindex fails, unless the drop itself fails, which makes `indexed` `false` and is reconciled by the watcher or the next reindex.
- Response MUST be `200 { path, destination, type: "file" | "folder", overwritten: boolean, indexed: boolean, files: number, skipped: number }`, where `files` counts the files written.
- Errors are those of `:move` (same conditions, statuses, and codes), plus the `recursive` rule above.

#### Scenario: Copy a folder recursively

- **GIVEN** vault `v` containing `templates/weekly.md`, `templates/empty/`, and `templates/.hidden`
- **WHEN** the client `POST`s `/v1/vaults/v/paths/templates:copy` with `{ "destination": "templates-copy", "recursive": true }`
- **THEN** the response is `200` with `type: "folder"`, `files: 1`, and `skipped: 1`
- **AND** `templates-copy/weekly.md` and the empty folder `templates-copy/empty/` exist, `templates-copy/.hidden` does not, and the source is unchanged
- **AND** the index has rows for `templates-copy/weekly.md`

#### Scenario: Folder copy requires recursive

- **GIVEN** vault `v` containing the folder `templates/`
- **WHEN** the client `POST`s `/v1/vaults/v/paths/templates:copy` with `{ "destination": "t2" }`
- **THEN** the response is `400` with `error.code = "invalid_path"` and `t2` does not exist

### Tags

#### `GET /v1/vaults/:slug/tags`

- Lists the tags present in the vault's index with the number of documents carrying each. Query params: `prefix` (string, ≤ 1024 bytes; only documents whose path starts with it are counted), `limit` (int, 1–1000, default 100). Any other parameter or value MUST yield `400 invalid_query`.
- Response `200 { items: { tag: string; count: number }[], total: number }`. Which tags are reported, how documents are counted, the order, and `total` are defined in [Vault Indexer › Tag listing](../vault-indexer/index.md#tag-listing); REST is a thin pass-through.

### Grep

#### `POST /v1/vaults/:slug/grep`

- Searches the bytes on disk — not the index — for an exact substring or a regular expression, line by line, and returns where it matched. It complements `search`: `search` ranks Markdown by meaning; `grep` finds exact text in any text file.
- Request body MUST be `application/json`:

  ```ts
  {
    pattern: string;        // 1–1024 characters
    regex?: boolean;        // default false: pattern is a literal substring
    ignoreCase?: boolean;   // default false
    prefix?: string;        // ≤ 1024 bytes; only paths starting with it are searched
    limit?: number;         // max matches returned, 1–1000, default 100
    context?: number;       // lines of context before and after each match, 0–5, default 0
  }
  ```

  Unknown keys or out-of-range values MUST yield `400 invalid_input`. With `regex: true` the pattern uses ECMAScript regular-expression syntax in Unicode mode, with no user-supplied flags; a pattern that does not compile MUST yield `400 invalid_input`. `ignoreCase` applies Unicode case-insensitive matching in both modes.
- Response MUST be:

  ```ts
  200 {
    matches: {
      path: string;
      line: number;          // 1-based
      column: number;        // 1-based, in Unicode code points, of the first match on the line
      text: string;          // the line, without its terminator, possibly windowed (see below)
      textStart: number;     // 1-based code-point column of the line at which `text` starts; 1 when not windowed
      before?: string[];     // present iff context > 0
      after?: string[];      // present iff context > 0
    }[];
    truncated: boolean;
    reason: "limit" | "bytes" | "time" | null;   // null iff truncated is false
    filesScanned: number;
    filesSkipped: number;
  }
  ```

- Files searched: every file [`GET /paths`](#get-v1vaultsslugpaths) would list under `prefix` (so no hidden files and no symlinks) and that is still a regular file reached without a symlink when grep opens it — each read follows the [containment precondition](#path-operations) for reads, so neither ob's own concurrent operations nor a cooperating writer can make grep read outside the vault (a parent swapped in the instant between the check and the open is outside the threat model); a file that fails the check is skipped and counted in `filesSkipped` — that is a text file by the same rule `PATCH` uses — Markdown and other text formats, never PDFs or other binaries — in that listing's order. A text file larger than 1 MiB, or containing a NUL byte, MUST be skipped and counted in `filesSkipped` rather than searched. The size is measured on the opened file, and the read fetches at most 1 MiB plus one byte — the extra byte only detects growth: a file that grows past 1 MiB while it is being read is skipped too, and no more than 1 MiB of any file's content is ever searched.
- Files are decoded as UTF-8 (invalid sequences replaced) and split into lines on `\n`, a trailing `\r` being dropped. Matching is per line; a pattern never matches across a line break. A line that matches produces exactly one entry, however many times it matches, with `column` the 1-based code-point position where the first match starts. A line matches iff the pattern finds a match in it under ECMAScript semantics (the line, without its terminator, is the whole input, so `^` and `$` anchor to its start and end). A zero-length match counts as a match wherever the pattern actually produces one: `a*` matches every line, at column 1 when the line does not start with `a`; `^$` matches only empty lines; `$` matches every line at the column just past its last character.
- `text` and each context line MUST be at most 1000 characters. A longer matching line is cut to a 1000-character window that contains the start of its first match, and `textStart` says where in the line that window begins, so `column - textStart` is the match's offset inside `text`. A longer context line, which has no match, is cut to its first 1000 characters, so a context line always starts at column 1 and needs no start field. Context lines are taken from the same file, never across files, and overlapping contexts of nearby matches are not merged.
- `filesScanned` counts the files whose search finished: every line was searched, or the search stopped in that file because `limit` was reached. `filesSkipped` counts the files skipped by the size, NUL-byte, and containment rules above. A `"bytes"` cut-off happens before a file would take the total past 64 MiB, and that file is not counted. On a `"time"` cut-off the search is interrupted from outside, so the response reflects the last *checkpoint* the server had received before the cut-off. The search reports a checkpoint after every batch of matches and after every file it finishes or skips. Each checkpoint carries the matches found since the previous one and the cumulative counters. The response's `matches` are all the matches carried by every checkpoint received up to and including that last one — a counters-only last checkpoint does not discard earlier matches — and `filesScanned` and `filesSkipped` are that last checkpoint's counters. They all come from the same moment of the search: the counters count exactly the files that had finished or been skipped when that checkpoint was posted, and the matches are every match reported up to then — which can include complete matches from the file still being searched at that moment, a file neither counter counts yet. Both may lag the work the search had actually done when it was cut off. A match is *complete* once its `after` context has been read, or its file has ended before `context` more lines; with `context: 0` every match is complete as soon as it is found. Only complete matches are ever returned: on a `"time"` cut-off, a match that no received checkpoint carried — because it was not yet complete, or not yet reported — is left out. A `limit` stop completes the matches it returns before stopping.
- Every request is bounded. The search stops, returning the complete matches it has with `truncated: true`, when it has `limit` matches and finds one more (`reason: "limit"`; that extra match only proves more exist — it is never returned, and the file it was found in counts as scanned because the search stopped in it on `limit`), when it has read 64 MiB of file content (`"bytes"`), or when 5 seconds have passed since the request arrived (`"time"`). At most two greps run at once process-wide; time spent waiting for a free slot counts against the same 5 seconds, and a request whose budget runs out while it waits returns `matches: []` with `truncated: true` and `reason: "time"`. A request whose client disconnects or cancels stops waiting or running. Because files and lines are searched in a fixed order, `matches` is always a prefix of the untruncated result, and the matches kept by a cut-off are exact: a `"limit"` or `"bytes"` stop keeps every complete match found before it, and a `"time"` cut-off keeps every complete match carried by any checkpoint received up to the last one before it — including complete matches earlier in the file being searched, if a received checkpoint carried them. A match the search had found but not yet reported in a received checkpoint is not returned.
- A grep MUST NOT stall the server: other requests are served normally while it runs, including while a pathological regular expression is being evaluated, and such an evaluation is abandoned at the time limit.

> **Known limit.** Bun's regex engine (JavaScriptCore) aborts a runaway backtracking evaluation after roughly 0.7 seconds and reports no match. A line whose evaluation hits that limit is therefore silently not matched, and grep cannot tell it apart from a genuine non-match. `worker.terminate()` does not interrupt a running evaluation, so a terminated worker can outlive the deadline by up to that limit. The response is still sent at the deadline.

#### Scenario: Literal grep finds exact text with line numbers

- **GIVEN** vault `v` containing `notes/a.md` whose third line is `TODO: call the plumber` and `img/logo.png`
- **WHEN** the client `POST`s `/v1/vaults/v/grep` with `{ "pattern": "TODO:" }`
- **THEN** the response is `200` with one match `{ path: "notes/a.md", line: 3, column: 1, text: "TODO: call the plumber" }`
- **AND** `truncated` is `false` and `img/logo.png` was not searched

#### Scenario: Regex special characters are literal by default

- **GIVEN** vault `v` containing `a.md` with the line `cost (est.) $5`
- **WHEN** the client greps `{ "pattern": "(est.) $5" }`
- **THEN** the line is matched at column 6

#### Scenario: Catastrophic regex is cut off without stalling the server

- **GIVEN** vault `v` containing a text file of 50 lines, each 10 000 characters of `a` followed by `!` — each line's evaluation runs until the engine's backtracking limit (see the Known limit above), so together they take far longer than the 5-second budget
- **WHEN** the client greps `{ "pattern": "(a+)+$", "regex": true }`
- **THEN** the response is sent at the 5-second deadline with `matches: []`, `truncated: true`, and `reason: "time"`
- **AND** a `GET /healthz` sent while the grep runs is answered promptly

#### Scenario: Invalid regex rejected

- **WHEN** the client greps `{ "pattern": "([", "regex": true }`
- **THEN** the response is `400` with `error.code = "invalid_input"`

### Path validation

- A path MUST NOT contain `..` segments, MUST NOT start with `/`, MUST NOT contain a NUL byte, MUST NOT exceed 1024 bytes.
- Resolution MUST be performed via `path.resolve(vaultRoot, path)` followed by a `startsWith(vaultRoot + sep)` check. Any failure MUST return `400 { error: { code: "invalid_path", ... } }`.
- Any extension is permitted on read, write, delete, move, and copy. Reserved/hidden segments (`/.obsidian/`, `/.trash/`, dotfiles at any depth) MUST return `400` with code `invalid_path` to keep callers from corrupting `ob`'s own state.

#### Scenario: Path traversal blocked

- **GIVEN** a request `PUT /v1/vaults/v/files/../../etc/passwd`
- **WHEN** the server handles it
- **THEN** response is `400` with `error.code = "invalid_path"`
- **AND** no file is created

#### Scenario: Traversal in a move destination blocked

- **GIVEN** vault `v` containing `notes/x.md`
- **WHEN** the client `POST`s `/v1/vaults/v/paths/notes/x.md:move` with `{ "destination": "../outside.md" }`
- **THEN** the response is `400` with `error.code = "invalid_path"`
- **AND** `notes/x.md` is unchanged and nothing was written outside the vault root

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
- `code` MUST come from a closed set: `vault_not_found`, `not_found`, `invalid_input`, `invalid_path`, `invalid_body`, `invalid_query`, `unsupported_media_type`, `patch_no_match`, `patch_ambiguous`, `folder_not_empty`, `already_exists`, `extraction_failed`, `embedder_failed`, `internal`. `invalid_input` is the canonical code for any Zod schema-validation failure and is shared with the MCP adapter; `invalid_body` and `invalid_query` are HTTP-specific codes for malformed request envelopes (e.g. unparseable JSON body or unknown query string); `folder_not_empty` is the 409 response from `DELETE /v1/vaults/:slug/paths/*path` without `?recursive=true` against a non-empty folder; `already_exists` is the 409 response when a move or copy would replace or merge into an existing path it is not allowed to (see [Path operations](#path-operations)); `extraction_failed` is the 422 response when a PDF requested as text cannot be parsed (corrupt or password-protected).
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
- Writers outside ob are assumed to cooperate (Obsidian Sync, the user's own edits and tools); a party with direct, adversarial write access to the vault directory is outside the threat model, as the [Path operations](#path-operations) threat model states. The guarantees of every file and path operation are stated against cooperating writers.
- The API MUST NOT spawn additional `ob` invocations on writes. It writes to disk; the supervisor's running `ob sync --continuous` picks up the change.
- Internal links are maintained only by `:move` (see [Link rewriting](link-rewriting.md)). A `PUT` to a new path is a new document, a copy is a byte-for-byte copy, and a delete leaves links to the deleted path dangling, exactly as in Obsidian.

## Open Questions

- **Grep pagination.** A truncated grep returns a deterministic prefix of the full result but no cursor; callers narrow with `prefix`. **Default**: no cursor until a workflow needs to page through more than 1000 matches.
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
| 2026-08-21 | Health endpoints section rewritten: `/healthz` is pinned as a dependency-free liveness probe, and `/readyz` gains an explicit body contract (`{ ok, vaults, indexers }`, identical in shape on 200 and 503) plus the exact three-part 200 rule. The `vaults` entries inherit the supervisor's new `lastSyncActivityAt` and `watchdog` fields, which also surface unchanged through `GET /v1/vaults` and `GET /v1/vaults/:slug`. One status-code change: `indexers` must now carry an entry for every configured vault, synthesized as `starting` when the indexer has not registered it, so a vault missing from that array can no longer leave `/readyz` at 200 — it returns 503 until the indexer registers and reaches `ready`. No route additions and no change to `/healthz`. | [Change 0015](../../changes/0015-sync-stall-watchdog.md) |
| 2026-10-15 | `/healthz` now reflects persistent sync failure: `503 {ok:false, unhealthy:[…]}` when any vault is `failed` or has `consecutiveFailures` at or above `OB_HEALTHZ_SYNC_FAILURE_THRESHOLD` (default 3, `0` disables). The 200 body is unchanged, `/readyz` is unchanged, and sync health is pinned as never gating request handling. Reverses 0015's "`/healthz` never varies with vault state". | [Change 0017](../../changes/0017-sync-liveness.md) |
| 2026-11-09 | Path operations: new type-agnostic `/v1/vaults/:slug/paths` family. `GET /paths` lists files and folders in one walk with a `type` discriminator, a `type` filter, and `recursive`; its order is segment-wise (pre-order), which also fixes cursor resumption skipping a sibling such as `a-b.md` that sorts between a folder's descendants. `DELETE /paths/*path[?recursive=true]` deletes files and folders and drops index entries only after the removal succeeded. **Breaking:** `GET /files`, `DELETE /files/*path`, `GET /folders`, and `DELETE /folders/*path` are removed. | [Change 0019](../../changes/0019-unified-list-and-delete.md) |
| 2026-11-09 | Path operations gain `:move` (to an exact destination: one atomic rename for folders and with `overwrite`, otherwise a no-replace publish followed by removing the source; no clobber without `overwrite`; internal links rewritten by default per the new [Link rewriting](link-rewriting.md) document, moved notes re-embedded) and `:copy` (files, and folders with `recursive`, appearing atomically). New error code `already_exists` (409). The "wikilink rewriting is out of scope" constraint and the move/rename open question are retired. | [Change 0020](../../changes/0020-move-and-copy.md) |
| 2026-11-09 | New `GET /v1/vaults/:slug/tags`: tags in the index with distinct-document counts, a thin pass-through over the indexer's tag listing. | [Change 0021](../../changes/0021-list-tags.md) |
| 2026-11-09 | New `POST /v1/vaults/:slug/grep`: literal or regex line search over text files on disk, with hard limits on pattern length, file size, bytes read, and time, a `truncated` flag, and a guarantee that a pathological regex cannot stall the server. | [Change 0022](../../changes/0022-grep.md) |
| 2026-11-09 | Move and copy index sets follow the vault indexer's new indexable-path rule (so `node_modules` and symlinked notes are never indexed), and `indexed` on every write, patch, append, move, and copy now turns `false` when the index update failed rather than only when the reindex call threw. Grep matches gain `textStart` for windowed lines. | [Change 0020](../../changes/0020-move-and-copy.md), [Change 0022](../../changes/0022-grep.md) |
| 2026-11-10 | Grep records the regex engine's backtracking limit as a known limit (a line whose evaluation hits it is silently unmatched, and a terminated worker can outlive the deadline by up to that limit), and the catastrophic-regex scenario uses enough such lines to exceed the 5-second budget. | [Change 0022](../../changes/0022-grep.md) |

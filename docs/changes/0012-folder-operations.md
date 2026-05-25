# 0012: Folder Operations

## Summary

Add a sibling surface to file CRUD for folders: `list_folders`, `create_folder`, `delete_folder` on both REST (`/v1/vaults/:slug/folders/*path`) and MCP (`list_folders` / `create_folder` / `delete_folder` tools), backed by three new service-core functions in `src/vault/folders.ts`. Implements the Folder CRUD section newly added to the [REST API spec](../specs/rest-api/index.md#folder-crud) and the matching tool rows in the [MCP Server spec](../specs/mcp-server/index.md#tool-surface).

**Spec:** [REST API](../specs/rest-api/)
**Status:** draft
**Depends On:** 0004, 0005

## Motivation

`listFiles` (and therefore `list_files` on both adapters) walks the vault tree and yields only `Dirent.isFile()` entries (see `src/vault/files.ts:243-247`). Folders are recursed into but never emitted — there is no `type` discriminator and no concept of a folder in the response. As a consequence, **a folder with no descendant files is invisible to every API consumer.**

On the live production vault this is not a corner case:

```
$ kubectl -n ob exec deploy/ob -- sh -c 'find /data/vaults/v/social-graphs/people -mindepth 1 -maxdepth 1 -type d \
  -exec sh -c "[ -z \$(ls -A \"\$0\") ] && echo empty: \$0" {} \;' | wc -l
20
$ kubectl -n ob exec deploy/ob -- sh -c 'find /data/vaults/v/social-graphs/people -mindepth 1 -maxdepth 1 -type d | wc -l'
34
```

20 of 34 first-level folders under `social-graphs/people/` are empty leaves (e.g. `peter-thiel/`, `andrew-ng/`, `daniel-gross/`) that survive sync from desktop Obsidian but are entirely hidden from `list_files`. Two operator workflows are blocked today:

1. **Discovery.** An LLM agent inspecting the social-graph taxonomy via `list_files` sees ~40% of the structure missing. It can't reason about the shape of the graph without listing folders directly.
2. **Targeted writes.** Code that wants to write into `social-graphs/people/peter-thiel/` cannot first verify the folder exists; `list_files` returns nothing for that prefix whether the folder is empty or genuinely absent.

A relevant non-fix was investigated and ruled out: there is no Obsidian Sync setting that purges empty folders. The sync-side rules expose only `Excluded folders` and a hidden-file convention (see [Sync settings](https://obsidian.md/help/sync/settings)). The forum thread [Empty folders are automatically deleted](https://forum.obsidian.md/t/empty-folders-are-automatically-deleted/102852) describes a *different* desktop-only quirk; sync itself preserves empty folders by design, confirmed against the operator's desktop vault (`social-graphs/` folders persisted after the only file in each was removed and synced). Adding a knob upstream is out of our control; exposing folders in our API is.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint)). CI enforces these as merge gates:

- The standing 100% line + branch coverage gate on `src/` MUST hold. CI runs `bun run test:cov` (which invokes `bun test --coverage` and `test/check-coverage.ts`). New code without tests is a defect.
- Service-core tests under `test/vault/` MUST drive `listFolders` / `createFolder` / `deleteFolder` against real on-disk tmpdirs (no `fs` mocking), exactly as `test/vault/files.test.ts` exercises the file service. The fake supervisor + fake indexer pattern from 0003/0004 is reused unchanged.
- Route tests under `test/http/` MUST go through the real Hono app (`app.fetch`), real `safeJoin`, and a tmpdir vault. Path-traversal scenarios MUST each have an explicit test asserting the response code AND that the folder was never created/removed.
- MCP tool tests under `test/mcp/` MUST register the new tools against the real registry and assert error-envelope parity with REST for the same inputs.
- Biome MUST pass with the project config; `bunx tsc --noEmit` MUST pass.
- `// @ts-expect-error`, `// biome-ignore`, and `// eslint-disable*` MUST carry a one-line same-comment justification.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Service core

A new module `src/vault/folders.ts` MUST expose three pure-by-deps functions analogous to `src/vault/files.ts`:

- `listFolders(deps, slug, opts?: ListFoldersOptions): Promise<ListFoldersResult>`
- `createFolder(deps, slug, path: string): Promise<CreateFolderResult>`
- `deleteFolder(deps, slug, path: string, opts?: { recursive?: boolean }): Promise<void>`

Shapes:

```ts
interface FolderEntry {
  readonly path: string;       // vault-relative, no leading / and no trailing /
  readonly mtimeMs: number;    // mtime of the directory entry itself
}

interface ListFoldersOptions {
  readonly prefix?: string;    // same semantics as ListFilesOptions.prefix
  readonly limit?: number;     // default 100, max 1000 — same as list_files
  readonly cursor?: string;    // opaque base64 of the last-seen path
}

interface ListFoldersResult {
  readonly items: FolderEntry[];
  readonly nextCursor: string | null;
}

interface CreateFolderResult {
  readonly path: string;
  readonly mtimeMs: number;
  readonly created: boolean;   // true on first creation, false on idempotent no-op
}
```

#### `listFolders`

- MUST walk the vault tree the same way `walkVault` does (lexicographic order, hidden-segment + symlink rejection by `Dirent` inspection — never followed), but MUST yield `Dirent.isDirectory()` entries instead of `Dirent.isFile()` entries.
- MUST NOT emit the vault root itself (the empty path).
- MUST apply the same `prefix` / `limit` / `cursor` rules as `listFiles`. The cursor encoding (`base64(lastPath)`) is identical so adapter code is shared.
- MUST be tolerant of concurrent `ob sync` rewrites: if a directory vanishes between `readdir` and `stat`, skip it (mirroring `listFiles`'s ENOENT handling on line 285).

#### `createFolder`

- MUST resolve `path` via `safeJoin(root, path)` and call `assertNotSymlinkEscape` for the leaf and the entire parent chain.
- MUST be idempotent: `fs.mkdir(abs, { recursive: true })`. If the path already exists as a directory, `created: false` MUST be returned with the existing mtime. If the path already exists as a file (not a directory), MUST throw `InvalidPathError` with the message naming the conflict.
- MUST NOT touch the indexer. Folders are not indexed.
- Empty / "." / "/" paths MUST be rejected at the path-validation step (already enforced by `assertSafeRelativePath`).

#### `deleteFolder`

- MUST resolve `path` via `safeJoin` + `assertNotSymlinkEscape`.
- If the path does not exist, MUST throw `DocNotFoundError` (parity with `deleteFile`).
- If the path exists but is a file, MUST throw `InvalidPathError` naming the type mismatch — callers should use `deleteFile` for files.
- If the folder is non-empty and `recursive !== true`, MUST throw `FolderNotEmptyError` (a new typed error with code `folder_not_empty` → HTTP 409).
- If `recursive === true`, the implementation MUST:
  1. Walk the folder collecting every Markdown descendant path (using the same hidden / symlink rules as `walkVault`).
  2. Best-effort `indexer.drop` for each Markdown path, in the same try/log-and-continue pattern as `tryDrop` (`src/vault/files.ts:203-213`). A drop failure MUST NOT abort the delete; the chokidar `unlink` event will reconcile.
  3. `fs.rm(abs, { recursive: true, force: false })` — `force: false` so a permission error or unexpected race surfaces rather than being swallowed.
- MUST NOT delete anything outside `v.root`. `safeJoin` already guarantees this; the test suite MUST assert it explicitly.

### REST routes

The HTTP adapter MUST mount three new routes under `/v1/vaults/:slug/folders`, registered in the same `mountFileRoutes` style as the file routes (one screen of parse → call → respond, no behavior of its own).

| Method | Path | Body | Response | Mirrors core call |
|---|---|---|---|---|
| `GET` | `/v1/vaults/:slug/folders` | — | `200 { items: FolderEntry[], nextCursor: string \| null }` | `listFolders` |
| `PUT` | `/v1/vaults/:slug/folders/*path` | — (any body ignored) | `200 { path, mtimeMs, created: boolean }` | `createFolder` |
| `DELETE` | `/v1/vaults/:slug/folders/*path` | optional `?recursive=true` query param | `204` on success; `409 folder_not_empty` if non-empty without `recursive=true` | `deleteFolder` |

Rules:

- The `GET` list endpoint MUST share the `ListFoldersQuery` zod schema (mirroring `ListFilesQuery`); validation errors MUST surface as `invalid_query`.
- The `PUT` endpoint MUST NOT require a body. Senders SHOULD send `Content-Length: 0`; any body MUST be silently ignored (folders have no content). A non-empty body MUST NOT be parsed.
- The `DELETE` endpoint's `recursive` flag MUST be a query string (`?recursive=true`), not a body, so the route stays consistent with REST conventions for idempotent operations and so clients can call it with `fetch(url, { method: "DELETE" })` without a body.
- The new `folder_not_empty` code MUST be added to the closed `ErrorCode` set in `src/errors.ts` and to the HTTP status mapping table:

| Error class | HTTP | code |
|---|---|---|
| `FolderNotEmptyError` | 409 | `folder_not_empty` |

The existing `InvalidPathError` → 400 / `invalid_path` mapping covers all path-type mismatches; no further code additions are required.

#### Scenario: List folders under a prefix

- **GIVEN** vault `v` with `social-graphs/people/peter-thiel/` (empty), `social-graphs/people/sam-altman/note.md`, and `social-graphs/places/` (empty)
- **WHEN** the client calls `GET /v1/vaults/v/folders?prefix=social-graphs/people/`
- **THEN** the response is `200`
- **AND** `items` contains `social-graphs/people/peter-thiel` and `social-graphs/people/sam-altman` (in lexicographic order)
- **AND** `items` does NOT contain `social-graphs/places`

#### Scenario: Empty-folder visibility — primary motivation

- **GIVEN** a vault containing only the empty folder `notes/scratchpad/`
- **WHEN** the client calls `GET /v1/vaults/v/folders`
- **AND** then calls `GET /v1/vaults/v/files`
- **THEN** the folders response includes `notes/scratchpad`
- **AND** the files response is `{ items: [], nextCursor: null }`

#### Scenario: Create folder is idempotent

- **GIVEN** vault `v` with no `archive/2026/` folder
- **WHEN** the client `PUT`s `/v1/vaults/v/folders/archive/2026`
- **THEN** the response is `200` with `created: true`
- **AND** when the same `PUT` is replayed, the response is `200` with `created: false`
- **AND** the second response's `mtimeMs` equals the first response's `mtimeMs` (folder is not touched)

#### Scenario: Create folder conflicts with an existing file

- **GIVEN** vault `v` containing `notes/x.md`
- **WHEN** the client `PUT`s `/v1/vaults/v/folders/notes/x.md`
- **THEN** the response is `400` with `error.code = "invalid_path"`
- **AND** the file `notes/x.md` is unchanged

#### Scenario: Delete non-empty folder without recursive flag

- **GIVEN** vault `v` containing `social-graphs/people/peter-thiel/intro.md`
- **WHEN** the client `DELETE`s `/v1/vaults/v/folders/social-graphs/people/peter-thiel`
- **THEN** the response is `409` with `error.code = "folder_not_empty"`
- **AND** the file `social-graphs/people/peter-thiel/intro.md` is unchanged
- **AND** no indexer `drop` calls were made

#### Scenario: Recursive delete drops Markdown index entries

- **GIVEN** vault `v` containing `archive/2024/jan.md` (Markdown) and `archive/2024/cover.png` (binary)
- **AND** an indexer that records every `drop(slug, path)` call
- **WHEN** the client `DELETE`s `/v1/vaults/v/folders/archive/2024?recursive=true`
- **THEN** the response is `204`
- **AND** the indexer recorded exactly one `drop` call for `archive/2024/jan.md`
- **AND** the indexer recorded zero `drop` calls for `archive/2024/cover.png`
- **AND** the folder `archive/2024/` no longer exists on disk

#### Scenario: Delete is type-aware

- **GIVEN** vault `v` containing `notes/x.md` (a file, not a folder)
- **WHEN** the client `DELETE`s `/v1/vaults/v/folders/notes/x.md`
- **THEN** the response is `400` with `error.code = "invalid_path"`
- **AND** the file `notes/x.md` is unchanged

#### Scenario: Path traversal blocked on folder routes

- **GIVEN** a request `PUT /v1/vaults/v/folders/../../etc/passwd`
- **WHEN** the server handles it
- **THEN** the response is `400` with `error.code = "invalid_path"`
- **AND** no directory is created outside the vault root

### MCP tools

The MCP adapter MUST register three new tools using the existing `tool()` registry helper (`src/mcp/tool.ts`) and the existing per-tool file layout under `src/mcp/tools/`. Each tool MUST be a thin shell calling the same service-core function as the matching REST route.

| Tool | Input | Output | Mirrors |
|---|---|---|---|
| `list_folders` | `{ vault, prefix?, limit?, cursor? }` | `{ items: FolderEntry[], nextCursor }` | `GET /v1/vaults/:slug/folders` |
| `create_folder` | `{ vault, path }` | `{ path, mtimeMs, created }` | `PUT /v1/vaults/:slug/folders/*path` |
| `delete_folder` | `{ vault, path, recursive? }` | `{ deleted: boolean }` (always `true` on success — kept as a boolean for type parity with `delete_file`) | `DELETE /v1/vaults/:slug/folders/*path` |

Rules:

- Tool descriptions MUST be specific. `list_folders` MUST state that it complements `list_files` and is the only way to see folders that contain no files; `create_folder` MUST state that it is idempotent (mkdir -p); `delete_folder` MUST state that the default refuses non-empty folders and `recursive: true` is required to opt into recursive removal.
- Input schemas MUST be defined in `src/schemas/folders.ts` (mirroring `src/schemas/files.ts`) and reused by both the REST handlers and the MCP tools — no duplicated zod definitions.
- Error translation MUST go through the existing MCP error path: `FolderNotEmptyError` MUST surface as `isError: true` with `code: "folder_not_empty"`. Parity tests MUST assert the MCP and REST error envelopes carry the same `code` for the same input.

#### Scenario: MCP list_folders matches REST

- **GIVEN** an arbitrary vault snapshot fixture
- **WHEN** the MCP tool `list_folders` is invoked with `{ vault: "v" }` and the REST endpoint `GET /v1/vaults/v/folders` is called
- **THEN** the `items` arrays are structurally identical (path, mtimeMs equal)
- **AND** `nextCursor` is identical

### Path validation

- All three operations MUST go through `safeJoin` (and therefore `assertSafeRelativePath`) and `assertNotSymlinkEscape`. No new path-validation code is introduced.
- A trailing slash on a request path MUST be tolerated by the route layer and stripped before the service-core call so `path` is the canonical no-trailing-slash form. The empty path (`/v1/vaults/:slug/folders/`) MUST NOT match the PUT/DELETE routes — only `GET /v1/vaults/:slug/folders` (the list endpoint) handles a path-less request.

### Resource surface (MCP)

- The MCP resource surface (`obvault://<slug>/<path>` from `src/mcp/resources.ts`) is OUT OF SCOPE for this change. Folders are not resources; the resource model is document-oriented and unchanged. Adding folder URIs would conflate two concepts and is deferred behind explicit user demand.

## Design

### Approach

`src/vault/folders.ts` mirrors `src/vault/files.ts` line for line where it can, and diverges only where folders genuinely behave differently:

```ts
// Pseudo: walkVaultFolders is `walkVault` with the file/dir branches swapped.
async function* walkVaultFolders(root: string, sub = ""): AsyncIterable<string> {
  const dir = sub === "" ? root : join(root, sub);
  let entries: Dirent[];
  try { entries = await fs.readdir(dir, { withFileTypes: true }); }
  catch (e) { if (errno(e) === "ENOENT") return; throw e; }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue;
    if (ent.isSymbolicLink()) continue;
    if (!ent.isDirectory()) continue;
    const rel = sub === "" ? ent.name : `${sub}/${ent.name}`;
    yield rel;
    yield* walkVaultFolders(root, rel);   // descend AFTER yielding so a parent
                                          // appears before its children in
                                          // the lexicographic stream
  }
}
```

The walk yields a parent *before* its children so the cursor pagination behaves predictably: clients see folders top-down, and resuming with a cursor at `social-graphs/people` will resume just inside that subtree. (This is the only behavioral difference from `walkVault`, which yields only leaves and therefore has no parent/child ordering question.)

`createFolder` is a thin wrapper over `fs.mkdir(abs, { recursive: true })` plus an `existed`/`stat` probe to compute `created`. The `existed-but-is-a-file` branch issues `fs.lstat` and translates `!stat.isDirectory()` into `InvalidPathError`.

`deleteFolder` performs the Markdown enumeration via `walkVault` (the existing file-walker, not the folder one) under the target path, calls `tryDrop` per Markdown path with the same try/log-and-continue contract as `deleteFile`, then `fs.rm(abs, { recursive: true, force: false })`. The pre-check for "is a file" uses `fs.lstat` and rejects with `InvalidPathError` to keep the surface symmetric with `createFolder`.

### Decisions

- **Decision:** Keep folders a separate surface, not a flag on `list_files`.
  - **Why:** A `includeFolders: true` boolean on `list_files` would force every existing consumer to read a polymorphic union (`FileEntry | FolderEntry`) and discriminate by an added `type` field. The two operations also diverge in supported actions (read/write/patch/append apply only to files; create/delete recursive applies only to folders). A separate surface keeps the types clean and the tool descriptions actionable.
  - **Alternatives considered:**
    - **`includeFolders: true` on `list_files`** — Rejected for the reasons above. Would also require renaming the tool (it's no longer just "files") or accepting a misleading name forever.
    - **A single `list_entries` tool** — Cleaner long-term but a larger break: every existing caller of `list_files` would need to migrate. Defer until/unless there is a second motivating use case.
- **Decision:** Idempotent create (`mkdir -p` semantics), file conflict rejected.
  - **Why:** Matches the file `PUT` semantic, which silently `mkdir -p`s parent directories. Operators using `create_folder` in scripts can call it unconditionally without a "does it exist?" pre-check.
  - **Alternatives considered:** 201/409 split (201 on create, 409 if already exists). Rejected — every caller would have to swallow 409, which is just an idempotent-friendly API written in a hostile dialect.
- **Decision:** Recursive delete requires explicit `recursive: true`.
  - **Why:** This is the destructive operation in the new surface. Default-recursive would mean a single typo in a folder path could nuke a large subtree. The opt-in mirrors `rm` vs `rm -r`.
  - **Alternatives considered:** Always recursive. Rejected — the cost of an extra opt-in flag is negligible; the cost of an accidental subtree wipe is catastrophic.
- **Decision:** New error code `folder_not_empty`, no other code additions.
  - **Why:** The closed-set `ErrorCode` rule (see `src/errors.ts` header) means every distinct error condition needs its own code. `folder_not_empty` is actionable (the caller can retry with `recursive: true`), distinct from `invalid_path` (which is structural), and distinct from `not_found` (the folder exists, it just isn't empty).
  - **Alternatives considered:** Reuse `invalid_input`. Rejected — `invalid_input` is for schema-shape failures; this is a state failure that says nothing about the input.
- **Decision:** Folder paths are canonical without trailing slashes.
  - **Why:** Avoids `notes/` vs `notes` ambiguity in cursor decoding and prefix matching. Matches the on-disk reality (filesystem path APIs strip trailing slashes too).
  - **Alternatives considered:** Always include trailing slash. Rejected — it makes prefix matching `notes/foo/` vs `notes/foo` ambiguous in adapter code.
- **Decision:** `list_folders` does NOT emit the vault root.
  - **Why:** The root is implicit — every consumer already addresses it as `vault: <slug>` with no path. Emitting an empty-string path would force every client to special-case the head of the list.
  - **Alternatives considered:** Emit `""` for the root. Rejected on the special-case grounds above.
- **Decision:** `delete_folder { recursive: true }` returns as soon as `fs.rm` resolves, not after chokidar reconciles.
  - **Why:** The pre-delete Markdown drop loop covers the index. Any drop that slips through is reconciled by the chokidar `unlink` event later — exactly the same eventual-consistency story `deleteFile` already relies on. Blocking on chokidar would couple API latency to filesystem-event timing for no observable correctness gain.
  - **Alternatives considered:** Await a chokidar-reconciled signal before returning. Rejected — adds latency and a new synchronization primitive for zero behavioral difference.

### Non-Goals

- **Move / rename folders.** A `MOVE` or `:move` endpoint on folders is a much hairier operation (concurrent watcher events, wikilink rewriting, large-tree atomicity) and is deferred for v1. The REST spec already lists move/rename as an open question for files; folders would inherit any future decision on that surface.
- **Folder metadata beyond `mtimeMs`.** No counts of descendants, no recursive size, no `hasChildren` flag. Computing any of those requires per-entry I/O that defeats the point of a cheap list operation.
- **Bulk folder operations.** No multi-path create or delete in one request.
- **MCP resource URIs for folders.** Folders are not resources; the existing `obvault://` URI space stays document-only.
- **Per-folder permissions.** v1 has no auth; this change does not introduce one.

## Tasks

- [ ] **Service core: `src/vault/folders.ts`**
  - [ ] `walkVaultFolders(root, sub?)` async-generator yielding directory paths in pre-order lexicographic walk; skips hidden + symlink entries by `Dirent` inspection
  - [ ] `listFolders(deps, slug, opts)` with prefix/limit/cursor parity to `listFiles`, ENOENT tolerance, no root emission
  - [ ] `createFolder(deps, slug, path)` — idempotent mkdir -p; rejects file-conflict with `InvalidPathError`; returns `{path, mtimeMs, created}`
  - [ ] `deleteFolder(deps, slug, path, {recursive})` — pre-check via `lstat`, file-conflict rejection, `FolderNotEmptyError` when non-recursive and non-empty, recursive Markdown-drop + `fs.rm`
  - [ ] Unit tests in `test/vault/folders.test.ts` covering: empty-vault list (returns `[]`), prefix filtering, cursor pagination, hidden segment exclusion, symlink exclusion, idempotent create, file-conflict on create, recursive delete with Markdown drop, non-recursive delete on non-empty folder, type-mismatch on delete-against-file, traversal rejection
- [ ] **Schemas: `src/schemas/folders.ts`**
  - [ ] `ListFoldersQuery`, `FolderEntry`, `ListFoldersResponse`, `CreateFolderResponse`, `DeleteFolderQuery`, `MCP` input schemas for the three tools
  - [ ] Re-exported from `src/schemas/index.ts`
  - [ ] Schema tests in `test/schemas/folders.test.ts`
- [ ] **Errors: extend `src/errors.ts`**
  - [ ] Add `"folder_not_empty"` to `ErrorCode` and `ERROR_CODES`
  - [ ] Define `FolderNotEmptyError extends OBError` with `code = "folder_not_empty"`
  - [ ] Update the closed-set assertion test in `test/errors.test.ts`
- [ ] **HTTP routes: extend `src/http/routes/files.ts` (or a sibling `folders.ts`)**
  - [ ] `GET /v1/vaults/:slug/folders` — query parse via `ListFoldersQuery`, delegate to `listFolders`
  - [ ] `PUT /v1/vaults/:slug/folders/:path{.+}` — ignore body, delegate to `createFolder`
  - [ ] `DELETE /v1/vaults/:slug/folders/:path{.+}` — parse `?recursive=true`, delegate to `deleteFolder`
  - [ ] Map `FolderNotEmptyError → 409` in `src/http/errors.ts`
  - [ ] Integration tests in `test/http/folders.test.ts` covering every scenario in the Requirements section
- [ ] **MCP tools: `src/mcp/tools/list_folders.ts`, `create_folder.ts`, `delete_folder.ts`**
  - [ ] Register all three in `src/mcp/index.ts`
  - [ ] Each tool description verbatim per the Tool surface section
  - [ ] Tests in `test/mcp/folders.test.ts` asserting tool invocation, error envelope parity with REST for `folder_not_empty` and `invalid_path`
- [x] **Spec changelog rows**
  - [x] Append a row to `docs/specs/rest-api/index.md` Changelog table referencing this change
  - [x] Append a row to `docs/specs/mcp-server/index.md` Changelog table referencing this change
- [x] **Docs index updates**
  - [x] Add this change to `docs/index.yml` (`status: draft`)
  - [x] Add a row to `docs/index.md` Changes table
- [ ] **README**
  - [ ] Document the three new tools / routes in the README's API surface section if such a table exists (verify during implementation; if absent, skip)

## References

- Spec: [REST API › Folder CRUD](../specs/rest-api/index.md#folder-crud)
- Spec: [MCP Server › Tool surface](../specs/mcp-server/index.md#tool-surface)
- Related changes: [0004 — REST API](./0004-rest-api.md) (introduced the file CRUD pattern this change mirrors), [0005 — MCP server](./0005-mcp-server.md) (introduced the MCP adapter and `ToolDefinition` pattern)
- External:
  - [Obsidian Sync settings](https://obsidian.md/help/sync/settings) — confirms no upstream toggle for empty-folder behavior
  - [Empty folders are automatically deleted (Obsidian Forum)](https://forum.obsidian.md/t/empty-folders-are-automatically-deleted/102852) — desktop-only behavior; sync itself preserves empty folders

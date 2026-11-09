# 0019: Unified List and Delete

## Summary

Replace the per-type list and delete operations with one type-agnostic operation each: REST `GET /v1/vaults/:slug/paths` and `DELETE /v1/vaults/:slug/paths/*path`, MCP `list` and `delete`. Remove `list_files`, `list_folders`, `delete_file`, `delete_folder` and their REST routes. Implements [REST API › Path operations](../specs/rest-api/index.md#path-operations) (list and delete) and the [MCP Tool design rules](../specs/mcp-server/index.md#tool-design-rules).

**Spec:** [REST API](../specs/rest-api/), [MCP Server](../specs/mcp-server/)
**Status:** draft
**Depends On:** 0012, 0014, 0018

## Motivation

The user asked to keep one MCP tool per operation — client permissions and `readOnlyHint` are per tool, so a combined multi-operation tool is ruled out — and instead to unify every operation that makes sense for both files and folders into one tool named after its unix counterpart, now and for future tools. Two such pairs exist today: `list_files` / `list_folders` and `delete_file` / `delete_folder`. An agent has to call both list tools to see a folder's contents, and must know a path's type before it can delete it.

Folding the two list walks into one also fixes a pre-existing pagination bug. `walkVault` and `walkVaultFolders` sort each directory by name, but the cursor (`src/vault/files.ts` `listFiles`) compares whole path strings. Those orders disagree whenever a name sorts between a folder and its descendants: with a folder `a/` holding `x.md` and a sibling file `a-b.md`, the walk yields `a/x.md` before `a-b.md`, but `"a-b.md" < "a/x.md"` as strings, so a page ending at `a/x.md` resumes past `a-b.md` and never returns it. The spec now defines the order segment by segment, which is the walk order, and the cursor must compare the same way.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint)). CI enforces these as merge gates:

- The 100% line + branch coverage gate on `src/` MUST hold (`bun run test:cov`, which runs `bun test --coverage` and `test/check-coverage.ts`). New code without tests is a defect. Codecov does not report on this repo; the in-CI coverage check is the gate.
- Service-core tests under `test/vault/` MUST drive `list` and `delete` against real on-disk tmpdir vaults (no `fs` mocking), with the fake indexer recording `drop` calls and their timing relative to the removal.
- Route tests under `test/http/` MUST go through the real Hono app (`app.fetch`) and real `safeJoin`. Every path-traversal case (`..`, absolute path, hidden segment, NUL, over-length, symlink in the chain, the vault root) MUST have an explicit test asserting the response code AND that nothing was removed.
- A parity test under `test/parity/` MUST drive `list` and `delete` through both adapters against the same fixture vault and assert identical payloads and identical error `code`s, per [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint).
- `test/mcp/server.test.ts` MUST assert the exact registered tool set and the exact `readOnlyHint` set, scoped sessions included.
- Biome and `bunx tsc --noEmit` MUST pass; `// @ts-expect-error`, `// biome-ignore`, and `// eslint-disable*` MUST carry a same-comment justification. No `.skip` / `.only`.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Behavior owned by the specs

[REST API › Path operations](../specs/rest-api/index.md#path-operations) owns the list and delete contracts — entry shape, ordering, cursor, `recursive`, `type`, omissions, the delete rules and their errors — and their scenarios are this change's acceptance criteria. [MCP Server › Tool design rules](../specs/mcp-server/index.md#tool-design-rules) and [› Tool surface](../specs/mcp-server/index.md#tool-surface) own the tool names, inputs, descriptions, and the `readOnlyHint` set. Not restated here.

### What this change owns

- **Removal, no aliases.** `list_files`, `list_folders`, `delete_file`, and `delete_folder` MUST be unregistered, and `GET /v1/vaults/:slug/files`, `GET /v1/vaults/:slug/folders`, `DELETE /v1/vaults/:slug/files/*path`, and `DELETE /v1/vaults/:slug/folders/*path` MUST be unmounted (they fall through to the JSON 404). No deprecated alias is kept: MCP clients rediscover tools through `tools/list`.
- **Breaking-change marker.** The commit that removes the old tools and routes MUST be a `!` conventional commit (e.g. `feat(api)!: …`) carrying a `BREAKING CHANGE:` footer that names the four removed tools, the four removed routes, and their replacements, so release-please cuts a major version.
- **File delete ordering.** Deleting a file now removes it from disk first and drops its index entry afterwards (it used to drop first). This matches the folder delete and keeps the index consistent when the removal fails.
- **MCP resources unchanged.** `resources/list` keeps paging Markdown documents with its own cursor; it may switch to the unified walk internally, but its URIs, cursor shape, and paging behavior MUST NOT change.
- **README.** The README's tool list and REST route list MUST be updated to the new names in the same PR.

## Design

### Approach

A new service-core module `src/vault/paths.ts` holds the type-agnostic operations; `listPaths` and `deletePath` land here, and 0020's `movePath` / `copyPath` join them.

- **One walk.** `walkVaultEntries(root, sub?)` yields `{ type, rel }` for every directory and regular file in pre-order with each directory's entries sorted by raw code point, skipping hidden names and symlinks by `Dirent` inspection exactly as `walkVault` does today. With `recursive: false` it does not descend below the prefix's base folder, so a non-recursive listing of a large vault does not walk it.
- **Order and cursor.** `comparePaths(a, b)` compares segment arrays by code point. The cursor stays `base64(lastPath)`, but "strictly after" is decided by `comparePaths`, not by `>` on whole strings. Existing cursors from `list_files` / `list_folders` are not accepted by name anyway (the tools are gone); a decoded cursor that is not a real path still just positions the walk.
- **Entries.** Files keep today's `stat` + read + `sha256`; folders use `lstat` and are skipped if the entry is no longer a directory (the TOCTOU guard `listFolders` already has). The `type` filter and the prefix test run before an entry counts toward `limit`.
- **Delete.** `deletePath(deps, slug, path, { recursive })` resolves through `safeJoin` + `assertNotSymlinkEscape`, takes the path's lock, `lstat`s the target under it (so the type it acts on is the type it checked), and dispatches: a file is unlinked under `withPathLock` and then `tryDrop`ped if Markdown; a folder reuses today's `deleteFolder` logic (`rmdir` for the empty case so a racing child surfaces as `folder_not_empty`; collect Markdown descendants, `fs.rm`, then drop). The trailing-slash canonicalization `folders.ts` has moves into the shared helper.
- **What stays.** `createFolder` stays in `src/vault/folders.ts`; `listFiles`, `listFolders`, `deleteFile`, and `deleteFolder` are deleted once nothing calls them (resources may keep a private Markdown walk).
- **Schemas.** `src/schemas/paths.ts` defines `ListPathsQuery` / `ListPathsInput`, `PathEntry`, `ListPathsResponse`, `DeletePathQuery` / `DeletePathInput`; the folder and file list/delete schemas are removed from `src/schemas/folders.ts` and `src/schemas/files.ts`.
- **Adapters.** `src/http/routes/paths.ts` mounts the two routes, in the parse → call → respond shape of the existing route modules; `src/mcp/tools/list.ts` and `delete.ts` replace the four tool files, `list` passing `{ readOnlyHint: true }`.

### Decisions

- **Decision:** File entries keep `size`, `sha256`, and `contentType`.
  - **Why:** They are exactly what `list_files` returned; dropping them in the same breaking change would remove information callers use for change detection, with no replacement.
  - **Alternatives considered:** `size` only (cheaper — no per-file read). Rejected: the hashing cost is today's cost, and a cheaper listing can be added later as an opt-out flag without another break.
- **Decision:** `recursive: false` is defined against the prefix's base folder, keeping `prefix` a literal string prefix.
  - **Why:** One `prefix` meaning for both modes; `prefix=notes/` behaves like `ls notes/`, and `prefix=notes/da` like `ls notes/da*`.
  - **Alternatives considered:** A separate `path` argument for the folder to list. Rejected: two overlapping filters with different semantics.
- **Decision:** MCP `delete` returns `{ deleted: true }` with no `type`.
  - **Why:** Keeps the old tools' result shape; the caller named the path, and REST answers `204` with no body to compare against.
- **Decision:** Remove file from disk before dropping its index entry.
  - **Why:** Same ordering 0012 chose for recursive folder deletes, for the same reason: a failed removal must leave the index matching the files still on disk.

### Non-Goals

- Move and copy (0020), tag listing (0021), grep (0022).
- Any change to `read_file`, `write_file`, `patch_file`, `append_file`, `create_folder`, `search`, or the resource surface's observable behavior.
- Deprecated aliases for the removed names.
- The landing site's tool list (`site/`), which is out of this change's scope.

## Tasks

- [ ] **Service core: `src/vault/paths.ts`**
  - [ ] `comparePaths` (segment-wise code-point order) and the cursor helpers using it
  - [ ] `walkVaultEntries` (pre-order, hidden/symlink skip, depth-bounded for `recursive: false`)
  - [ ] `listPaths(deps, slug, { prefix, limit, cursor, type, recursive })` with ENOENT / type-change skipping
  - [ ] `deletePath(deps, slug, path, { recursive })` — file: unlink then drop; folder: `rmdir` / `folder_not_empty` / recursive collect → `fs.rm` → drop
  - [ ] Tests in `test/vault/paths.test.ts`: every list and delete scenario in the spec, the `a/` vs `a-b.md` pagination regression, `type` filter with `limit`, `recursive: false` at root and under a prefix, hidden and symlink omission, racing removal during a walk, drop-after-remove ordering, removal failure leaving the index untouched, `rm -r` on a file
- [ ] **Remove the per-type operations**
  - [ ] Delete `listFiles` / `deleteFile` from `src/vault/files.ts` and `listFolders` / `deleteFolder` from `src/vault/folders.ts` (keep `createFolder`); move `src/mcp/resources.ts` onto the unified walk or a private Markdown walk without changing its behavior
  - [ ] Delete `src/mcp/tools/list_files.ts`, `list_folders.ts`, `delete_file.ts`, `delete_folder.ts` and their tests, and `test/parity/list_files.test.ts` / `delete_file.test.ts`
  - [ ] Unmount the four REST routes; add tests asserting each now returns the JSON 404
  - [ ] Commit with `!` and a `BREAKING CHANGE:` footer naming removed tools/routes and their replacements
- [ ] **Schemas: `src/schemas/paths.ts`** (re-exported from `src/schemas/index.ts`) with tests in `test/schemas/paths.test.ts`
- [ ] **HTTP: `src/http/routes/paths.ts`** — `GET /v1/vaults/:slug/paths`, `DELETE /v1/vaults/:slug/paths/:path{.+}`; tests in `test/http/paths.test.ts` including the traversal matrix
- [ ] **MCP: `src/mcp/tools/list.ts`, `delete.ts`** registered in `src/mcp/index.ts`; descriptions per the spec; `list` read-only; tests in `test/mcp/tools/`
- [ ] **Parity: `test/parity/list.test.ts`, `test/parity/delete.test.ts`**
- [ ] **Registry assertions** in `test/mcp/server.test.ts`: exact tool set and exact `readOnlyHint` set, unscoped and scoped
- [ ] **Scoped sessions**: tests that `list` and `delete` in a `/mcp/:slug/:prefix` session see and touch only the scope, with scope-relative paths and cursors
- [ ] **README** tool and route lists updated
- [ ] **Tracking**: tick this list, set Status to complete, sync `docs/index.yml` / `docs/index.md`

## References

- Spec: [REST API › Path operations](../specs/rest-api/index.md#path-operations), [MCP Server › Tool design rules](../specs/mcp-server/index.md#tool-design-rules)
- Related changes: [0012 — Folder operations](0012-folder-operations.md) (introduced the per-type folder tools this replaces), [0014 — MCP folder scoping](0014-mcp-folder-scoping.md), [0018 — MCP read-only annotations](0018-mcp-read-only-annotations.md)

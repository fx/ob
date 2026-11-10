# 0019: Unified List and Delete

## Summary

Replace the per-type list and delete operations with one type-agnostic operation each: REST `GET /v1/vaults/:slug/paths` and `DELETE /v1/vaults/:slug/paths/*path`, MCP `list` and `delete`. Remove `list_files`, `list_folders`, `delete_file`, `delete_folder` and their REST routes. Implements [REST API › Path operations](../specs/rest-api/index.md#path-operations) (list and delete) and the [MCP Tool design rules](../specs/mcp-server/index.md#tool-design-rules).

**Spec:** [REST API](../specs/rest-api/), [MCP Server](../specs/mcp-server/)
**Status:** complete
**Depends On:** 0012, 0014, 0018

## Motivation

The user asked to keep one MCP tool per operation — client permissions and `readOnlyHint` are per tool, so a combined multi-operation tool is ruled out — and instead to unify every operation that makes sense for both files and folders into one tool named after its unix counterpart, now and for future tools. Two such pairs exist today: `list_files` / `list_folders` and `delete_file` / `delete_folder`. An agent has to call both list tools to see a folder's contents, and must know a path's type before it can delete it.

Folding the two list walks into one also fixes a pre-existing pagination bug. `walkVault` and `walkVaultFolders` sort each directory by name, but the cursor (`src/vault/files.ts` `listFiles`) compares whole path strings. Those orders disagree whenever a name sorts between a folder and its descendants: with a folder `a/` holding `x.md` and a sibling file `a-b.md`, the walk yields `a/x.md` before `a-b.md`, but `"a-b.md" < "a/x.md"` as strings, so a page ending at `a/x.md` resumes past `a-b.md` and never returns it. The spec now defines the order segment by segment, which is the walk order, and the cursor must compare the same way.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint)). CI enforces these as merge gates:

- The 100% line + branch coverage gate on `src/` MUST hold (`bun run test:cov`, which runs `bun test --coverage` and `test/check-coverage.ts`). New code without tests is a defect. Codecov does not report on this repo; the in-CI coverage check is the gate.
- Service-core tests under `test/vault/` MUST drive `list` and `delete` against real on-disk tmpdir vaults (no `fs` mocking), with the fake indexer recording `drop` and `indexedPaths` calls and their timing relative to the removal. A recursive delete is asserted by the resulting index state (no row under the folder, rows of a sibling such as `folder-x/` intact) and by the drop guard: a note written into the folder after the delete collected its contents but before the removal is dropped, while an indexable note recreated at a path under the folder after the removal keeps its rows, and a symlink recreated at such a path loses them.
- Route tests under `test/http/` MUST go through the real Hono app (`app.fetch`) and real `safeJoin`. Every path-traversal case (`..`, absolute path, hidden segment, NUL, over-length, symlink in the chain, the vault root) MUST have an explicit test asserting the response code AND that nothing was removed.
- A parity test under `test/parity/` MUST drive `list` and `delete` through both adapters against the same fixture vault and assert identical `list` payloads, an equivalent `delete` outcome (REST `204` with no body, MCP `{ deleted: true }`, and the same on-disk and index result), and identical error `code`s for every service-core failure (`not_found`, `invalid_path`, `folder_not_empty`, …), per [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint). Input-validation failures are adapter-specific and are asserted per adapter, not for parity, matching the existing parity suite: REST reports a bad query string as `invalid_query`, an unparseable body as `invalid_body`, and a schema-invalid body as `invalid_input`, while MCP reports every schema failure as `invalid_input`.
- `test/mcp/server.test.ts` MUST assert the exact registered tool set and the exact `readOnlyHint` set that hold once this change lands, scoped sessions included: the set on the tree it lands on, with `list_files`, `list_folders`, `delete_file`, and `delete_folder` removed and `list` and `delete` added, and `list` replacing `list_files` / `list_folders` in the `readOnlyHint` set. On today's tree that is the tools `list_vaults`, `vault_status`, `list`, `read_file`, `write_file`, `patch_file`, `append_file`, `create_folder`, `delete`, `search`, with `readOnlyHint` on `list_vaults`, `vault_status`, `list`, `read_file`, `search`. Tools from 0020–0022 are asserted by those changes when they land.
- Recursive delete MUST have a test in which a Markdown file is written into the folder (and indexed) after the delete has collected its contents and before the removal, asserting that no index row under the folder survives the delete.
- Biome and `bunx tsc --noEmit` MUST pass; `// @ts-expect-error`, `// biome-ignore`, and `// eslint-disable*` MUST carry a same-comment justification. No `.skip` / `.only`.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Behavior owned by the specs

[REST API › Path operations](../specs/rest-api/index.md#path-operations) owns the list and delete contracts — entry shape, ordering, cursor, `recursive`, `type`, omissions, the delete rules and their errors — and their scenarios are this change's acceptance criteria. [MCP Server › Tool design rules](../specs/mcp-server/index.md#tool-design-rules) and [› Tool surface](../specs/mcp-server/index.md#tool-surface) own the tool names, inputs, descriptions, and the `readOnlyHint` set. Not restated here.

### What this change owns

- **Removal, no aliases.** `list_files`, `list_folders`, `delete_file`, and `delete_folder` MUST be unregistered, and `GET /v1/vaults/:slug/files`, `GET /v1/vaults/:slug/folders`, `DELETE /v1/vaults/:slug/files/*path`, and `DELETE /v1/vaults/:slug/folders/*path` MUST be unmounted (they fall through to the JSON 404). No deprecated alias is kept: MCP clients rediscover tools through `tools/list`.
- **Breaking-change marker.** The commit that removes the old tools and routes MUST be a `!` conventional commit (e.g. `feat(api)!: …`) carrying a `BREAKING CHANGE:` footer that names the four removed tools, the four removed routes, and their replacements, so release-please cuts a major version.
- **File delete ordering.** Deleting a file now removes it from disk first and drops its index entry afterwards (it used to drop first). This matches the folder delete and keeps the index consistent when the removal fails.
- **MCP resources.** `resources/list` today pages `listFiles` over all files with its page limit, keeps only the Markdown entries of each page (so a page can hold fewer resources than the limit, even none, and still carry a cursor), and wraps the inner `listFiles` cursor with the slug. After this change it MUST page `listPaths({ type: "file" })` with the same page limit, apply the same Markdown filter, and wrap the inner cursor the same way: URIs, cursor encoding, page sizes, and the multi-vault hand-off are unchanged. The one deliberate difference is the order fix this change makes everywhere — pages follow the segment order, so the `a/` vs `a-b.md` skip is fixed here too. A cursor issued before the upgrade still decodes and resumes after its path in the new order. Tests MUST cover a page of only non-Markdown files (empty `resources` with a cursor), the multi-vault hand-off, and the skip regression through `resources/list`.
- **Recursive delete index drop.** After a successful recursive `fs.rm`, the service lists the folder's indexed paths with `indexer.indexedPaths(slug, folder + "/")` — every indexed path under it, not only the Markdown paths collected before the removal, so a note written and indexed into the folder in between is found — and drops each under the [drop guard](../specs/vault-indexer/index.md#indexable-paths): under that path's lock, unless an indexable note exists there now. An indexable note recreated under the folder after the removal therefore has its rows kept pending the writer's or the watcher's reindex (eventually consistent), while anything non-indexable at an old path has its rows dropped; the watcher's `unlink` events are the backstop. The store has no prefix query today (`drop` is `path = ?`), so this change adds `VaultStore.indexedPaths` (`SELECT DISTINCT path WHERE starts_with(path, ?)`, using the literal-prefix operator `search` already filters with) and `Indexer.indexedPaths`, with scoped-wrapper translation in `src/mcp/scope.ts`. The translation is symmetric: the wrapper prepends the scope prefix to the input prefix (like `drop` / `reindex` do to their paths), then strips it from every returned path and discards any result that does not start with `<scope>/`, before `deletePath` iterates them — the same treatment `search` gives its hits. The general rule for the wrapper is that every method that takes a path adds the prefix, and every method that returns paths strips it and drops out-of-scope results. A test MUST cover a scoped recursive delete, asserting the drops address the right vault paths and nothing outside the scope.
- **File delete drop.** A deleted file's rows are dropped under the same drop guard, while the delete still holds the file's lock.
- **Indexable predicate and drop guard.** Deletes are the first users of [Vault Indexer › Indexable paths](../specs/vault-indexer/index.md#indexable-paths), so this change introduces both pieces it relies on. First, `isIndexablePath(root, rel)`, exported from `src/indexer/scanner.ts`: the lexical part reuses today's `shouldIgnorePath` + `isMarkdownFile`, and the filesystem part is an `lstat` chain check (regular file, no symlink on it or its parents). It is evaluated only on the real vault root with the vault-relative path, through a new `Indexer.isIndexable(slug, path)`; the scoped wrapper in `src/mcp/scope.ts` prefixes the path as it does for `drop`, so a session scoped to `node_modules/pkg` is judged on `node_modules/pkg/note.md`. Second, one `dropGuarded(deps, slug, path)` helper in `src/vault/` that, holding the path's write lock, drops the path's rows unless `deps.indexer.isIndexable(slug, path)` is true for what exists there now. It never calls `isIndexablePath` with `vault(slug).root`, which in a scoped session is the scope root. This change wires the predicate only into the delete-side drop guard. Adopting it in the scanner, the watcher, the pipeline, and direct reindexes is [0020](0020-move-and-copy.md)'s, as is the startup sweep.
- **Listing reads.** `list` reads each file to hash it through the shared `guardedRead(root, path, { maxBytes? })` helper (parent-chain check, `O_NOFOLLOW` open, `fstat` on the opened descriptor for a regular file and, when `maxBytes` is given, its size; the read itself fetches at most `maxBytes + 1` bytes, the extra sentinel byte only detecting growth, so a file that grows while being read is caught as oversize and reported as such, and the caller never receives more than `maxBytes` of content; per the spec's [containment precondition](../specs/rest-api/index.md#path-operations) for reads); an entry that fails it is skipped like a vanished one.
- **README.** The README's tool list and REST route list MUST be updated to the new names in the same PR.

## Design

### Approach

A new service-core module `src/vault/paths.ts` holds the type-agnostic operations; `listPaths` and `deletePath` land here, and 0020's `movePath` / `copyPath` join them.

- **One walk.** `walkVaultEntries(root, sub?)` yields `{ type, rel }` for every directory and regular file in pre-order with each directory's entries sorted by raw code point, skipping hidden names and symlinks by `Dirent` inspection exactly as `walkVault` does today. With `recursive: false` it does not descend below the prefix's base folder, so a non-recursive listing of a large vault does not walk it.
- **Order and cursor.** `comparePaths(a, b)` compares segment arrays by code point. The cursor stays `base64(lastPath)`, but "strictly after" is decided by `comparePaths`, not by `>` on whole strings. Existing cursors from `list_files` / `list_folders` are not accepted by name anyway (the tools are gone); a decoded cursor that is not a real path still just positions the walk.
- **Entries.** Files keep today's `stat` + read + `sha256`, the read going through `guardedRead` (in `src/vault/guarded.ts`, which 0020 extends with the write helpers); folders use `lstat` and are skipped if the entry is no longer a directory (the TOCTOU guard `listFolders` already has). The `type` filter and the prefix test run before an entry counts toward `limit`.
- **Delete.** `deletePath(deps, slug, path, { recursive })` resolves through `safeJoin` + `assertNotSymlinkEscape`, takes the path's lock, `lstat`s the target under it (so the type it acts on is the type it checked), and dispatches: a file is unlinked under `withPathLock` and then, still under the lock, `tryDrop`ped under the drop guard (no extension check; dropped unless an indexable note exists at the path); a folder reuses today's `deleteFolder` logic (`rmdir` for the empty case so a racing child surfaces as `folder_not_empty`; `fs.rm`, then `indexedPaths(folder + "/")` and a guarded drop of each). The trailing-slash canonicalization `folders.ts` has moves into the shared helper.
- **What stays.** `createFolder` stays in `src/vault/folders.ts`; `listFiles`, `listFolders`, `deleteFile`, and `deleteFolder` are deleted once nothing calls them (`resources/list` is driven by `listPaths({ type: "file" })`, as specified above; it keeps no private walk).
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

- [x] **Service core: `src/vault/paths.ts`**
  - [x] `comparePaths` (segment-wise code-point order) and the cursor helpers using it
  - [x] `walkVaultEntries` (pre-order, hidden/symlink skip, depth-bounded for `recursive: false`)
  - [x] `listPaths(deps, slug, { prefix, limit, cursor, type, recursive })` with ENOENT / type-change skipping
  - [x] `deletePath(deps, slug, path, { recursive })` — file: unlink then drop; folder: `rmdir` / `folder_not_empty` / recursive `fs.rm` → `indexedPaths` → guarded drops
  - [x] Tests in `test/vault/paths.test.ts`: every list and delete scenario in the spec, the `a/` vs `a-b.md` pagination regression, `type` filter with `limit`, `recursive: false` at root and under a prefix, hidden and symlink omission, racing removal during a walk, drop-after-remove ordering, removal failure leaving the index untouched, `rm -r` on a file
- [x] **Remove the per-type operations**
  - [x] Delete `listFiles` / `deleteFile` from `src/vault/files.ts` and `listFolders` / `deleteFolder` from `src/vault/folders.ts` (keep `createFolder`); move `src/mcp/resources.ts` onto `listPaths` as specified above
  - [x] Delete `src/mcp/tools/list_files.ts`, `list_folders.ts`, `delete_file.ts`, `delete_folder.ts` and their tests, and `test/parity/list_files.test.ts` / `delete_file.test.ts`
  - [x] Unmount the four REST routes; add tests asserting each now returns the JSON 404
  - [x] Commit with `!` and a `BREAKING CHANGE:` footer naming removed tools/routes and their replacements
- [x] **Indexable predicate and drop guard**: `isIndexablePath` in `src/indexer/scanner.ts`, `Indexer.isIndexable` (with scoped prefix translation), and `dropGuarded` in `src/vault/` calling it, used by file and recursive delete; a table-driven predicate test (extensions in any case, hidden and `node_modules` segments, a symlinked leaf, a symlinked parent, a folder, a missing path); drop-guard tests where the deleted path is recreated as an indexable note (rows kept), as a symlink (rows dropped), and left absent (rows dropped); and a scoped test with a session scoped to `node_modules/pkg` where a recreated `note.md` is judged non-indexable (rows dropped)
- [x] **Indexed paths under a prefix**: `VaultStore.indexedPaths`, `Indexer.indexedPaths`, symmetric scoped translation (prefix added on input, stripped and out-of-scope results discarded on output); real-LanceDB tests including SQL-wildcard characters in the prefix and a sibling `folder-x/` that must not be returned
- [x] **`guardedRead`** in `src/vault/guarded.ts` (with the optional `maxBytes` cap, checked on the descriptor and enforced by a bounded read; a test grows a file past the cap between `fstat` and the read), used by `list`'s hashing (no cap); a test swapping a listed file's parent for a symlink between the walk and the read (entry skipped, nothing read outside)
- [x] **Resources**: `src/mcp/resources.ts` on `listPaths({ type: "file" })` with the tests named above
- [x] **Schemas: `src/schemas/paths.ts`** (re-exported from `src/schemas/index.ts`) with tests in `test/schemas/paths.test.ts`
- [x] **HTTP: `src/http/routes/paths.ts`** — `GET /v1/vaults/:slug/paths`, `DELETE /v1/vaults/:slug/paths/:path{.+}`; tests in `test/http/paths.test.ts` including the traversal matrix
- [x] **MCP: `src/mcp/tools/list.ts`, `delete.ts`** registered in `src/mcp/index.ts`; descriptions per the spec; `list` read-only; tests in `test/mcp/tools/`
- [x] **Parity: `test/parity/list.test.ts`, `test/parity/delete.test.ts`**
- [x] **Registry assertions** in `test/mcp/server.test.ts`: the exact tool set and exact `readOnlyHint` set as of this change (listed under Testing Requirements), unscoped and scoped
- [x] **Scoped sessions**: tests that `list` and `delete` in a `/mcp/:slug/:prefix` session see and touch only the scope, with scope-relative paths and cursors. `list`'s `prefix` needs no scoped translation: the scoped deps substitute the scope root, so the prefix is matched literally against scope-relative paths, and `prefix: ""` lists the whole scope; a test covers it
- [x] **README** tool and route lists updated
- [x] **Tracking**: tick this list, set Status to complete, sync `docs/index.yml` / `docs/index.md`

## References

- Spec: [REST API › Path operations](../specs/rest-api/index.md#path-operations), [MCP Server › Tool design rules](../specs/mcp-server/index.md#tool-design-rules)
- Related changes: [0012 — Folder operations](0012-folder-operations.md) (introduced the per-type folder tools this replaces), [0014 — MCP folder scoping](0014-mcp-folder-scoping.md), [0018 — MCP read-only annotations](0018-mcp-read-only-annotations.md)

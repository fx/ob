# 0020: Move and Copy

## Summary

Add `move` (mv) and `copy` (cp) for files and folders: REST `POST /v1/vaults/:slug/paths/*path:move` and `:copy`, MCP `move` and `copy`. A move renames atomically to an exact destination, refuses to clobber unless asked, re-embeds moved notes, and by default rewrites the internal links that pointed at what moved. Implements [REST API › Path operations](../specs/rest-api/index.md#path-operations) (move and copy), the whole of [Link rewriting](../specs/rest-api/link-rewriting.md), the move indexing rule in [Vault Indexer › Public surface](../specs/vault-indexer/index.md#public-surface), and the `move` / `copy` rows of [MCP Server › Tool surface](../specs/mcp-server/index.md#tool-surface).

**Spec:** [REST API](../specs/rest-api/), [MCP Server](../specs/mcp-server/), [Vault Indexer](../specs/vault-indexer/)
**Status:** draft
**Depends On:** 0019

## Motivation

There is no way to rename a note or folder through ob. Clients fall back to read + write + delete, which loses modification times, cannot move a folder in one step, leaves the old path searchable until the watcher catches up, and breaks every link to the note — Obsidian desktop rewrites links only for renames it performs itself, never for renames it receives through Sync. Copy has the same read-then-write workaround and no folder form.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint)). CI enforces these as merge gates:

- The 100% line + branch coverage gate on `src/` MUST hold (`bun run test:cov`). New code without tests is a defect. Codecov does not report on this repo; the in-CI coverage check is the gate.
- Service-core tests under `test/vault/` MUST run against real on-disk tmpdir vaults (no `fs` mocking), with the fake indexer recording `drop` / `reindex` calls.
- The link resolver and rewriter MUST have table-driven unit tests covering every row of the spec's recognized-link, resolution, and rewritten-text tables, and every Link rewriting scenario.
- Route tests under `test/http/` MUST go through the real Hono app. Path-traversal cases MUST be tested on the source AND on the destination of both operations, each asserting the response code AND that nothing changed on disk or in the index.
- Parity tests under `test/parity/` MUST drive `move` and `copy` through both adapters on the same fixture vault and assert identical payloads and error `code`s.
- Concurrency tests MUST show that two moves `a → b` and `b → a` started together both settle without deadlock, and that a move and a `PATCH` on the same file are serialized.
- Destination-race tests MUST cover every pair targeting one absent destination — file move + file move, file copy + file move, folder move + folder copy, file move + folder move — each asserting exactly one success, `already_exists` for the other, the loser's source intact, and no content lost.
- Outside-writer tests MUST create the destination between the under-lock check and the publish, using an injected hook at that point, and assert: a file publish without `overwrite` returns `already_exists` and leaves the outside file intact; a folder publish onto a non-empty folder returns `already_exists`. The no-hard-link fallback MUST be tested by injecting `EPERM` from `link`.
- Biome and `bunx tsc --noEmit` MUST pass; suppression comments MUST carry a same-comment justification. No `.skip` / `.only`.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Behavior owned by the specs

The move and copy contracts, their errors, and their scenarios are owned by [REST API › Path operations](../specs/rest-api/index.md#path-operations); link rewriting entirely by [Link rewriting](../specs/rest-api/link-rewriting.md); the re-embedding rule by [Vault Indexer › Public surface](../specs/vault-indexer/index.md#public-surface); tool inputs, descriptions, and scoped-session behavior by [MCP Server](../specs/mcp-server/index.md#tool-surface). Those scenarios are this change's acceptance criteria and are not restated here.

### What this change owns

- **New error code.** `already_exists` MUST be added to `ErrorCode` / `ERROR_CODES` in `src/errors.ts` as `AlreadyExistsError` (carrying the conflicting path), mapped to HTTP 409 in `src/http/errors.ts`, and covered by the closed-set test.
- **Two-path locking.** A helper that takes the per-path lock for several keys at once MUST acquire them in one canonical order (sorted, de-duplicated) so no two operations can each hold a lock the other is waiting for. Lock keys are the canonical paths (no trailing `/`), and a folder operation locks the folder's own path, so any two ob operations targeting the same destination — file or folder, move or copy — contend on the same key. Link rewrites take each referring note's lock individually after the move's own locks are released.
- **Check under the lock, publish without replacing.** Every destination existence and type check MUST be (re)done while holding both locks, immediately before publishing; a check made before the locks are taken is advisory only. File publishes without `overwrite` MUST use a primitive that fails instead of replacing (hard link, below), so a file created at the destination by Obsidian Sync or any other outside writer is never clobbered.
- **Scoped link context.** In a scoped MCP session the service core sees the scope root as the vault root, but link resolution must use vault-relative paths over the whole vault. The scoped deps wrapper (`src/mcp/scope.ts`) MUST therefore hand the move service the real vault root and the scope prefix for link resolution only, and the rewriter MUST refuse to write any note outside the scope. No tool result may carry the prefix (link text inside notes is content and is exempt, per the spec).

## Design

### Move

`movePath(deps, slug, path, { destination, overwrite, updateLinks })` in `src/vault/paths.ts`:

1. Validate both paths (`safeJoin` + `assertNotSymlinkEscape`, trailing `/` stripped); reject `destination === path` and, for a folder, `destination` under `path/`. These are lexical and need no lock.
2. Take the locks for the source and destination keys (canonical order).
3. Under the locks, `lstat` both. Missing source → `not_found`. Existing destination → `already_exists` unless `overwrite` and both are files. Nothing before this point decides the outcome.
4. If links are to be updated, snapshot the vault's visible file set (`F_before`) with the 0019 walk, still under the locks and before anything moves.
5. `mkdir -p` the destination parent, then publish, still under the locks:
   - **File, no `overwrite`:** `fs.link(src, dst)` — atomic and fails with `EEXIST` if anything appeared at `dst`, which maps to `already_exists` with nothing changed — then `fs.unlink(src)`. The hard link keeps the inode, so bytes and modification time are preserved. If `unlink(src)` fails, `unlink(dst)` is attempted and the error is surfaced, so the move did not happen.
   - **File, `overwrite: true`:** `fs.rename(src, dst)`, one atomic replace. If `dst` turned out to be a folder (`EISDIR`), map to `already_exists`.
   - **Folder:** `fs.rename(src, dst)` onto the destination step 3 confirmed absent. `ENOTEMPTY` / `EEXIST` / `ENOTDIR` map to `already_exists`. The empty-directory window against outside writers is the spec's documented known limit; Node and Bun expose no `RENAME_NOREPLACE`.
   - **No hard links.** On a filesystem that refuses hard links (`EPERM`, `ENOTSUP`, `EOPNOTSUPP`), the file publish falls back to `rename` after the under-lock check, logs a warning once per vault, and inherits the same outside-writer window as folders, now for a file. ob's own operations stay fully serialized by the locks. `EXDEV` cannot occur within one vault tree; if it does, it surfaces as `internal` with nothing changed.
6. Build `M` (old → new for every moved file: walk the destination subtree for a folder) and `F_after`, then release the locks. The steps below run without them.
7. Index: `tryDrop` every Markdown old path (and nothing for the overwritten destination, whose path still holds a note and is reindexed below).
8. Links: run the rewriter (below); it reindexes every note it writes.
9. `tryReindex` every Markdown new path the rewriter did not already reindex, with the scanner's bounded concurrency (4). `indexed` is the conjunction.

### Link rewriter

`src/vault/links.ts`, pure apart from its file I/O:

- **Parsing.** Parse each referring note with the remark setup the chunker already uses (`remark` + `remark-gfm` + `remark-frontmatter`) only to obtain the source offsets of `code` and `inlineCode` nodes; scan the raw text outside those ranges with a wikilink regex and a CommonMark inline-link destination scanner. Working on raw offsets, never on a re-serialized AST, is what keeps every untouched byte identical.
- **Resolution.** `resolveLink(link, sourcePath, files)` implements the spec's four steps over an index built once per move: a case-folded `Map` from full path to files and one from `"/" + basename-suffix` to candidates, so each lookup is O(1) and a move costs one pass over the vault's Markdown bytes plus one resolution per link.
- **Rewriting.** For each link compute `t0`, `expected`, `t1`, and the resolution step before and after; build the replacement linkpath per the style table; check it resolves to `T`; splice replacements back-to-front by offset; write the note with the same atomic write + `tryReindex` path `writeFile` uses, under the note's lock. A note whose text changed between scan and write (detected by comparing its bytes under the lock with the bytes scanned) is re-scanned once; if it changed again it is reported in `failed`.
- **Scope.** The rewriter's candidate notes are the Markdown files of `F_after` inside the write root (the scope root in a scoped session, the vault root otherwise); `F_before` / `F_after` always cover the whole vault.

### Copy

`copyPath(deps, slug, path, { destination, overwrite, recursive })`:

- **File.** Take the source and destination locks, then do the existence and type checks under them as for a move. Write the bytes to a temp sibling `<dst>.tmp.<uuid>` (the existing atomic-write naming), then publish: without `overwrite`, `fs.link(tmp, dst)` (`EEXIST` → `already_exists`) and `fs.unlink(tmp)`; with `overwrite`, `fs.rename(tmp, dst)`. The temp file is removed on every failure path. The no-hard-link fallback is the move's. Reindex if Markdown.
- **Folder.** Walk the source with the 0019 walk and recreate it under a hidden staging folder `.<destination-name>.copy.<uuid>` next to the destination (hidden names are invisible to `list`, the watcher, and the indexer), counting the hidden entries and symlinks the walk skipped. Building the staging tree needs no destination lock. Then take the destination lock, re-check that the destination is absent, and `fs.rename` the staging folder onto it (`ENOTEMPTY` / `EEXIST` / `ENOTDIR` → `already_exists`), with the same documented empty-directory window as a folder move. On any failure, including a lost race, remove the staging folder and rethrow, so no destination appears. Then reindex the copied Markdown files with concurrency 4.
- **Note rewrites** are not destination publishes: they replace the note they read under its lock, exactly as `patch_file` does, with the outside-writer window the [Link rewriting](../specs/rest-api/link-rewriting.md#applying-rewrites) spec records.

### Adapters

- **Schemas** in `src/schemas/paths.ts`: `MoveBody` / `MoveInput`, `CopyBody` / `CopyInput`, `MoveResponse`, `CopyResponse`.
- **HTTP** in `src/http/routes/paths.ts`: `POST /v1/vaults/:slug/paths/:path{.+:move}` and `{.+:copy}`, stripping the suffix as the `:append` route does, requiring `application/json`.
- **MCP** `src/mcp/tools/move.ts` and `copy.ts`, not read-only.

### Decisions

- **Decision:** Exact destination (`mv -T`), never "into an existing folder".
  - **Why:** One request shape means one thing. With into-folder magic, `move a.md archive` means two different things depending on whether `archive/` exists, and the client cannot tell which happened without re-listing.
  - **Alternatives considered:** Unix default semantics. Rejected for the ambiguity above.
- **Decision:** Refuse to clobber by default; a folder never replaces or merges, even with `overwrite`.
  - **Why:** Agents retry and guess paths; a default that silently replaces a note destroys data with no undo. Merging folders has no single right answer for conflicting children.
- **Decision:** `updateLinks` defaults to `true`.
  - **Why:** Matches Obsidian desktop's default, and is the only way a rename through ob does not silently break the vault for the person reading it in Obsidian.
- **Decision:** Hard link plus unlink for a no-overwrite file publish, rather than `rename` after a check.
  - **Why:** `rename` replaces an existing file without failing, so check-then-rename loses whatever appeared at the destination after the check — another ob call (closed by the lock) or Obsidian Sync (not closable by any lock). `link` is the only portable no-replace publish Node and Bun expose for files. The cost is an instant where the file is visible at both paths, which loses nothing.
  - **Alternatives considered:** `copyFile` with `COPYFILE_EXCL` then unlink for moves — rejected: it copies the bytes and resets the inode and modification time. Checking under the lock alone — rejected: it closes the race between ob calls but not against outside writers.
- **Decision:** Move first, then rewrite; per-note rewrite failures are reported, not rolled back.
  - **Why:** The rename is the operation asked for and is atomic; link rewrites touch many notes and cannot be made atomic as a group. Rolling the move back after some notes were rewritten would need its own rollback of those rewrites, which can fail too. Reporting exactly which notes failed lets the caller retry them with `patch_file`.
  - **Alternatives considered:** Pre-validate every rewrite before renaming. Rejected: it narrows but cannot close the window, because a note can become unwritable or change between check and write.
- **Decision:** Drop and reindex moved notes rather than renaming rows in place.
  - **Why:** `embed_text` starts with the note's path, so renamed rows would keep vectors and FTS tokens for the old path, and the scanner would never fix them (it short-circuits on an unchanged `sha256`). Re-embedding is the only way the index ends up as a fresh scan would build it.
  - **Alternatives considered:** Rename rows and keep vectors (cheap, silently stale). Rejected for the reason above.
- **Decision:** Scan the disk for links, not the index's `links` column.
  - **Why:** The index stores only normalized wikilink targets — no Markdown links, no offsets, no style — and can lag the disk.
- **Decision:** Rewrite only links whose target moved or whose note moved.
  - **Why:** The scope the user agreed; correcting unrelated links whose resolution a move changed is recorded as an open question in the spec.
- **Decision:** Folder copy is staged and renamed into place.
  - **Why:** A partial copy left by a mid-copy failure is indistinguishable from a complete one to a caller listing the destination.

### Non-Goals

- Moving or copying across vaults.
- Link rewriting on copy or delete, links by alias, links in canvas files.
- Making folder operations atomic with respect to concurrent writes inside the folder (per-file serialization only, as the spec states).

## Tasks

- [ ] **Errors**: `AlreadyExistsError` / `already_exists` in `src/errors.ts`, 409 in `src/http/errors.ts`, MCP mapping, closed-set tests
- [ ] **Locking**: multi-key lock helper in `src/vault/lock.ts` with canonical ordering; tests for deadlock freedom and serialization
- [ ] **Link rewriter: `src/vault/links.ts`**
  - [ ] Code-range extraction from the remark parse; wikilink and Markdown-link scanners over raw text
  - [ ] `resolveLink` with the four steps, case-insensitive matching with exact-case preference, tie-break
  - [ ] Rewrite decision (`t0` / `expected` / `t1` / relative-step rule) and replacement text per style table, extension and percent-encoding rules, resolve-back check
  - [ ] Atomic per-note apply under the note's lock with change detection; `updated` / `failed` reporting
  - [ ] Table-driven tests for every spec table row and every Link rewriting scenario
- [ ] **Move: `movePath` in `src/vault/paths.ts`** — validation and error matrix, checks under the locks, no-replace `link` + `unlink` publish without `overwrite`, atomic `rename` with it, folder `rename` with errno mapping, no-hard-link fallback, `mkdir -p`, `M` construction, drop old / reindex new, rewriter call; tests for every move scenario, overwrite of a Markdown destination, extension change (`a.md` → `a.txt`), moving a folder containing hidden files and symlinks, rename failure leaving everything unchanged
- [ ] **Copy: `copyPath`** — file copy via temp + no-replace `link` (or `rename` with `overwrite`), staged folder copy published under the destination lock after a re-check, `skipped` count, cleanup on every failure including a lost race, reindex; tests for every copy scenario and a failure injected mid-copy
- [ ] **Destination races**: the concurrent-move scenario from the spec (two moves to one absent destination: exactly one succeeds, the other gets `already_exists`, no data lost), the full pair matrix, and the outside-writer and no-hard-link tests from the Testing Requirements
- [ ] **Scoped sessions**: link context passed by `src/mcp/scope.ts`; tests that a scoped move resolves vault-wide, rewrites only in-scope notes, never writes outside the scope, and returns scope-relative paths only
- [ ] **Schemas, HTTP routes, MCP tools** as in Design; route, tool, and parity tests; registry test updated with `move` and `copy` (not read-only)
- [ ] **README** gains `move` / `copy` and the two routes
- [ ] **Tracking**: tick this list, set Status to complete, sync `docs/index.yml` / `docs/index.md`

## References

- Spec: [REST API › Path operations](../specs/rest-api/index.md#path-operations), [Link rewriting](../specs/rest-api/link-rewriting.md), [Vault Indexer › Public surface](../specs/vault-indexer/index.md#public-surface), [MCP Server › Tool surface](../specs/mcp-server/index.md#tool-surface)
- Related changes: [0019 — Unified list and delete](0019-unified-list-and-delete.md) (the `paths` family and walk this builds on), [0007 — Indexer relevance](0007-indexer-relevance.md) (why `embed_text` carries the path), [0014 — MCP folder scoping](0014-mcp-folder-scoping.md)

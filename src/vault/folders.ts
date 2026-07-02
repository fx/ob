/**
 * Service core: folder CRUD operations on a single vault.
 *
 * A sibling of `src/vault/files.ts`. Folders are a separate surface from files
 * (see change 0012): `list_files` only ever yields `Dirent.isFile()` entries,
 * so a folder with no descendant files is invisible to every consumer. These
 * three functions expose folders directly.
 *
 * Every function is pure-by-deps: it takes `(deps, slug, …)`, resolves the
 * path inside the configured vault root via `safeJoin`, calls
 * `assertNotSymlinkEscape`, and performs the on-disk operation. The HTTP and
 * MCP adapters call these unchanged.
 *
 * Folders are NOT indexed — the indexer is document-oriented. `createFolder`
 * never touches it. `deleteFolder` with `recursive: true` best-effort drops
 * the index entry of every Markdown descendant (same log-and-continue contract
 * as `deleteFile`) before removing the tree; any drop that slips through is
 * reconciled by the chokidar `unlink` event later.
 */

import { promises as fs } from "node:fs";
import { join } from "node:path";
import { DocNotFoundError, FolderNotEmptyError, InvalidPathError } from "../errors.ts";
import { isMarkdownPath } from "./contentType.ts";
import {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  type VaultServiceDeps,
  decodeCursor,
  encodeCursor,
  resolveVault,
  tryDrop,
  walkVault,
} from "./files.ts";
import { assertNotSymlinkEscape, safeJoin } from "./path.ts";

export interface FolderEntry {
  /** Vault-relative, no leading `/` and no trailing `/`. */
  readonly path: string;
  /** mtime of the directory entry itself. */
  readonly mtimeMs: number;
}

export interface ListFoldersOptions {
  readonly prefix?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListFoldersResult {
  readonly items: FolderEntry[];
  readonly nextCursor: string | null;
}

export interface CreateFolderResult {
  readonly path: string;
  readonly mtimeMs: number;
  /** `true` on first creation, `false` on an idempotent no-op. */
  readonly created: boolean;
}

/**
 * Walk the vault root recursively, yielding vault-relative *directory* paths
 * in pre-order (a parent is yielded before its children). This is `walkVault`
 * with the file/dir branches swapped: hidden (leading-dot) and symlink entries
 * are skipped by `Dirent` inspection, never followed.
 *
 * Yielding the parent before descending keeps the lexicographic stream
 * predictable for cursor pagination — clients see folders top-down and a
 * cursor at `a/b` resumes just inside that subtree.
 */
export async function* walkVaultFolders(root: string, sub = ""): AsyncIterable<string> {
  const dir = sub === "" ? root : join(root, sub);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    // Vault root might not exist on a fresh install — treat as empty.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  // Codepoint sort so the global walk order matches the strict-`>` cursor
  // comparison below — see the `walkVault` comment in files.ts.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue; // hidden / .obsidian / .trash
    if (ent.isSymbolicLink()) continue; // refuse symlinks (rejected at use time too)
    if (!ent.isDirectory()) continue;
    const rel = sub === "" ? ent.name : `${sub}/${ent.name}`;
    // Yield the parent BEFORE recursing so it precedes its children.
    yield rel;
    yield* walkVaultFolders(root, rel);
  }
}

export async function listFolders(
  deps: VaultServiceDeps,
  slug: string,
  opts: ListFoldersOptions = {},
): Promise<ListFoldersResult> {
  const v = resolveVault(deps, slug);
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const cursor = decodeCursor(opts.cursor);
  const prefix = opts.prefix ?? "";

  const items: FolderEntry[] = [];
  let nextCursor: string | null = null;
  let lastPath: string | null = null;

  for await (const rel of walkVaultFolders(v.root)) {
    // Strict `>` so the cursor advances past the boundary entry exactly once.
    if (cursor !== undefined && !(rel > cursor)) continue;
    if (prefix !== "" && !rel.startsWith(prefix)) continue;
    if (items.length >= limit) {
      nextCursor = lastPath === null ? null : encodeCursor(lastPath);
      return { items, nextCursor };
    }
    const abs = join(v.root, rel);
    // The vault is live (chokidar may race the listing with `ob sync`). If a
    // directory vanishes between readdir and stat, skip it — mirrors
    // listFiles's ENOENT handling.
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    items.push({ path: rel, mtimeMs: stat.mtimeMs });
    lastPath = rel;
  }
  return { items, nextCursor };
}

export async function createFolder(
  deps: VaultServiceDeps,
  slug: string,
  path: string,
): Promise<CreateFolderResult> {
  const v = resolveVault(deps, slug);
  const abs = safeJoin(v.root, path);
  await assertNotSymlinkEscape(abs, v.root);
  // Probe first so we can report `created` accurately: mkdir -p can't tell us
  // whether it made the leaf or found it already there.
  let existing: import("node:fs").Stats | null;
  try {
    existing = await fs.lstat(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") existing = null;
    else throw e;
  }
  if (existing !== null) {
    if (!existing.isDirectory()) {
      throw new InvalidPathError(path, "path already exists as a file, not a directory");
    }
    // Idempotent no-op: leave the folder untouched so mtime is stable.
    return { path, mtimeMs: existing.mtimeMs, created: false };
  }
  await fs.mkdir(abs, { recursive: true });
  const stat = await fs.stat(abs);
  return { path, mtimeMs: stat.mtimeMs, created: true };
}

export async function deleteFolder(
  deps: VaultServiceDeps,
  slug: string,
  path: string,
  opts: { recursive?: boolean } = {},
): Promise<void> {
  const v = resolveVault(deps, slug);
  const abs = safeJoin(v.root, path);
  await assertNotSymlinkEscape(abs, v.root);
  let stat: import("node:fs").Stats;
  try {
    stat = await fs.lstat(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new DocNotFoundError(path);
    throw e;
  }
  if (!stat.isDirectory()) {
    throw new InvalidPathError(path, "path is a file, not a directory; use deleteFile");
  }
  if (opts.recursive !== true) {
    // Non-recursive: refuse a folder that still has children, then remove it
    // with `rmdir` (NOT `rm -r`). `rmdir` deletes only an empty directory, so
    // if a child is added between the readdir probe and the removal the delete
    // fails with ENOTEMPTY rather than silently wiping the new child.
    const children = await fs.readdir(abs);
    if (children.length > 0) throw new FolderNotEmptyError(path);
    await fs.rmdir(abs);
    return;
  }
  // Recursive delete: drop the index entry of every Markdown descendant FIRST
  // (best-effort, log-and-continue) so the index is in the right state once the
  // tree is gone. `walkVault` under `path` yields vault-relative file paths.
  for await (const rel of walkVault(v.root, path)) {
    if (isMarkdownPath(rel)) await tryDrop(deps, slug, rel);
  }
  // `force: false` so a permission error or unexpected race surfaces rather
  // than being swallowed. `safeJoin` already guarantees `abs` is inside the
  // vault root, so this can never remove anything outside it.
  await fs.rm(abs, { recursive: true, force: false });
}

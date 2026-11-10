/**
 * Service core: type-agnostic path operations (REST API › Path operations).
 *
 * Operations that apply to files and folders alike — today `listPaths` (`ls`)
 * and `deletePath` (`rm` / `rm -r`) — live here, beside `createFolder` in
 * `folders.ts` and the file-content operations in `files.ts`. Each is
 * pure-by-deps like the rest of the core: `(deps, slug, …)`, path resolution
 * through `safeJoin` + `assertNotSymlinkEscape`, then the on-disk operation.
 * The REST routes in `src/http/routes/paths.ts` and the MCP `list` / `delete`
 * tools call these unchanged.
 *
 * Order. Entries are ordered by comparing paths segment by segment, each
 * segment by raw code point (`comparePaths`). That is exactly the pre-order of
 * a walk that sorts every directory's entries by the same segment comparison,
 * so the walk's yield order and the cursor's "strictly after" agree. Comparing
 * whole path strings would not: `"a-b.md" < "a/x.md"` as strings, while the
 * walk yields `a/x.md` first, so a page ending at `a/x.md` would resume past
 * `a-b.md` and never return it.
 *
 * Delete. The target is `lstat`ed under its write lock, so the type it acts
 * on is the type it checked, and the parent chain is re-checked for symlinks
 * immediately before each removal call (`unlink`, `rmdir`, `rm`). Index rows are dropped only AFTER the removal
 * succeeded — a failed removal leaves the files on disk and so must leave
 * their rows — and every drop goes through the drop guard (`dropGuarded`).
 * A folder's rows are found by asking the INDEX (`indexedPaths`) after the
 * removal rather than by listing the folder before it, so a note written and
 * indexed into the folder while the delete ran is dropped too.
 */

import { promises as fs, type Dirent } from "node:fs";
import { join } from "node:path";
import { DocNotFoundError, FolderNotEmptyError, InvalidPathError } from "../errors.ts";
import { detectContentType } from "./contentType.ts";
import { type VaultServiceDeps, resolveVault, sha256 } from "./files.ts";
import { dropGuarded, dropUnlessIndexable, guardedRead } from "./guarded.ts";
import { withPathLock } from "./lock.ts";
import { assertNotSymlinkEscape, lstatContainedDirectory, safeJoin } from "./path.ts";

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;

export type PathType = "file" | "folder";

export type PathEntry =
  | {
      readonly type: "file";
      readonly path: string;
      readonly mtimeMs: number;
      readonly size: number;
      readonly sha256: string;
      readonly contentType: string;
    }
  | { readonly type: "folder"; readonly path: string; readonly mtimeMs: number };

export interface ListPathsOptions {
  /** Literal prefix matched against the leading bytes of each path. */
  readonly prefix?: string | undefined;
  readonly limit?: number | undefined;
  /** Opaque cursor from a previous page's `nextCursor`. */
  readonly cursor?: string | undefined;
  /** Only entries of this type; omitted means both. Applied before `limit`. */
  readonly type?: PathType | undefined;
  /** `false`: only entries one level below the prefix's base folder. Default `true`. */
  readonly recursive?: boolean | undefined;
}

export interface ListPathsResult {
  readonly items: PathEntry[];
  readonly nextCursor: string | null;
}

export interface DeletePathOptions {
  /** `rm -r`: remove a non-empty folder and everything under it. Default `false`. */
  readonly recursive?: boolean | undefined;
}

/** The entry vanished, or a parent stopped being a directory: treated as absent. */
function isGone(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * One walked entry and its vault-relative path. A folder carries the `mtimeMs`
 * of the containment-checked `lstat` that admitted it to the walk.
 */
export type WalkEntry =
  | { readonly type: "file"; readonly rel: string }
  | { readonly type: "folder"; readonly rel: string; readonly mtimeMs: number };

/** Compare two strings by raw code point (not UTF-16 code unit). */
function compareSegments(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; ) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(i) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
    // Equal code points have equal UTF-16 width, so one step serves both.
    i += ca > 0xffff ? 2 : 1;
  }
  return Math.sign(a.length - b.length);
}

/**
 * Segment-wise path order: split on `/`, compare segment by segment by raw
 * code point; a path sorts before every path it is a proper segment-prefix of.
 */
export function comparePaths(a: string, b: string): number {
  const sa = a.split("/");
  const sb = b.split("/");
  const n = Math.min(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    const c = compareSegments(sa[i] as string, sb[i] as string);
    if (c !== 0) return c;
  }
  return Math.sign(sa.length - sb.length);
}

export function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined || cursor === "") return undefined;
  // base64 of the last-seen path. `Buffer.from(_, "base64")` is total — a
  // garbage cursor decodes to a string that merely positions the walk. The
  // cursor is not a security boundary: prefix and type filters still apply.
  return Buffer.from(cursor, "base64").toString("utf8");
}

export function encodeCursor(path: string): string {
  return Buffer.from(path, "utf8").toString("base64");
}

/**
 * Walk `root` (from the vault-relative folder `sub`) in pre-order, yielding
 * every directory and regular file with each directory's entries sorted by
 * `compareSegments`. Hidden names and symlinks are skipped by `Dirent`
 * inspection, never followed, and nothing below them is visited.
 *
 * Containment: every directory below the root passes `lstatContainedDirectory`
 * (no symlink on its chain to the vault root, a real directory) immediately
 * before it is read, and its listing metadata comes from that same check; a
 * directory that fails it — swapped for a symlink, turned into a file, or
 * gone since its parent was read — is skipped with everything below it. The
 * check and the `readdir` run back to back, before the directory is yielded,
 * so no caller code runs between them.
 *
 * `descend(rel)` decides whether to read a directory's children; the default
 * reads every one.
 */
export async function* walkVaultEntries(
  root: string,
  sub = "",
  descend: (rel: string) => boolean = () => true,
): AsyncIterable<WalkEntry> {
  if (sub !== "" && (await lstatContainedDirectory(join(root, sub), root)) === null) return;
  const entries = await readDirSorted(root, sub);
  if (entries !== null) yield* walkEntries(root, sub, entries, descend);
}

/** `readdir` + sort; `null` when the directory vanished or stopped being one. */
async function readDirSorted(root: string, sub: string): Promise<Dirent[] | null> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(sub === "" ? root : join(root, sub), { withFileTypes: true });
  } catch (e) {
    // Vault root missing on a fresh install, or a racing removal: empty.
    if (!isGone(e)) throw e;
    return null;
  }
  return entries.sort((a, b) => compareSegments(a.name, b.name));
}

async function* walkEntries(
  root: string,
  sub: string,
  entries: readonly Dirent[],
  descend: (rel: string) => boolean,
): AsyncIterable<WalkEntry> {
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue; // hidden / .obsidian / .trash
    if (ent.isSymbolicLink()) continue;
    const rel = sub === "" ? ent.name : `${sub}/${ent.name}`;
    if (ent.isDirectory()) {
      // Checked, then read, before anything is yielded (see above).
      const st = await lstatContainedDirectory(join(root, rel), root);
      if (st === null) continue;
      const children = descend(rel) ? await readDirSorted(root, rel) : null;
      yield { type: "folder", rel, mtimeMs: st.mtimeMs };
      if (children !== null) yield* walkEntries(root, rel, children, descend);
    } else if (ent.isFile()) {
      yield { type: "file", rel };
    }
  }
}

/** Read one walked entry into its listing shape, or `null` if it must be skipped. */
async function readEntry(
  deps: VaultServiceDeps,
  root: string,
  ent: WalkEntry,
): Promise<PathEntry | null> {
  // A folder's metadata is the walk's containment-checked `lstat`.
  if (ent.type === "folder") return { type: "folder", path: ent.rel, mtimeMs: ent.mtimeMs };
  await deps.hooks?.beforeListRead?.(ent.rel);
  let read: Awaited<ReturnType<typeof guardedRead>>;
  try {
    read = await guardedRead(root, ent.rel);
  } catch (e) {
    // Vanished, or no longer a regular file reached without a symlink:
    // skipped like a vanished entry rather than failing the page.
    if (e instanceof DocNotFoundError || e instanceof InvalidPathError) return null;
    throw e;
  }
  return {
    type: "file",
    path: ent.rel,
    mtimeMs: read.stat.mtimeMs,
    size: read.bytes.byteLength,
    sha256: sha256(read.bytes),
    contentType: detectContentType(ent.rel),
  };
}

export async function listPaths(
  deps: VaultServiceDeps,
  slug: string,
  opts: ListPathsOptions = {},
): Promise<ListPathsResult> {
  const v = resolveVault(deps, slug);
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const cursor = decodeCursor(opts.cursor);
  const prefix = opts.prefix ?? "";
  const recursive = opts.recursive ?? true;
  // `recursive: false` lists the direct children of `base`: the prefix up to
  // and including its last `/` (empty, the vault top level, when it has none).
  const base = prefix.slice(0, prefix.lastIndexOf("/") + 1);

  const matches = (rel: string): boolean =>
    rel.startsWith(prefix) && (recursive || !rel.slice(base.length).includes("/"));
  // Enter a folder only if something below it can still be returned: it lies
  // on the way to (or inside) the prefix, it is above `base` when not
  // recursive, and not all of its descendants sort at or before the cursor.
  const descend = (dir: string): boolean => {
    const d = `${dir}/`;
    if (!recursive) return base.startsWith(d);
    if (!prefix.startsWith(d) && !d.startsWith(prefix)) return false;
    return cursor === undefined || comparePaths(dir, cursor) >= 0 || cursor.startsWith(d);
  };

  const items: PathEntry[] = [];
  for await (const ent of walkVaultEntries(v.root, "", descend)) {
    if (cursor !== undefined && comparePaths(ent.rel, cursor) <= 0) continue;
    if (!matches(ent.rel)) continue;
    if (opts.type !== undefined && ent.type !== opts.type) continue;
    if (items.length >= limit) {
      // Another matching entry exists, so this page is not the last.
      return { items, nextCursor: encodeCursor((items[items.length - 1] as PathEntry).path) };
    }
    const item = await readEntry(deps, v.root, ent);
    if (item !== null) items.push(item);
  }
  return { items, nextCursor: null };
}

/**
 * Canonical path form shared by every path operation: no trailing `/`, empty
 * and `.` segments dropped (`./a.md`, `notes//b.md/`). `..` and a leading `/`
 * are kept so `safeJoin` rejects them; the empty result (the vault root) is
 * rejected by `safeJoin` too.
 */
export function canonicalPath(path: string): string {
  // A leading `/` survives so `safeJoin` still rejects an absolute path
  // rather than this quietly turning it into a relative one.
  const lead = path.startsWith("/") ? "/" : "";
  return (
    lead +
    path
      .split("/")
      .filter((seg) => seg !== "" && seg !== ".")
      .join("/")
  );
}

export async function deletePath(
  deps: VaultServiceDeps,
  slug: string,
  path: string,
  opts: DeletePathOptions = {},
): Promise<void> {
  const v = resolveVault(deps, slug);
  const rel = canonicalPath(path);
  const abs = safeJoin(v.root, rel);
  await assertNotSymlinkEscape(abs, v.root);
  const removedFolder = await withPathLock(`${slug}:${rel}`, async (): Promise<boolean> => {
    let st: import("node:fs").Stats;
    try {
      st = await fs.lstat(abs);
    } catch (e) {
      throw isGone(e) ? new DocNotFoundError(rel) : e;
    }
    if (st.isDirectory()) {
      await removeFolder(deps, v.root, abs, rel, opts.recursive === true);
      return true;
    }
    // A file is removed whatever `recursive` says (`rm -r` on a file).
    await deps.hooks?.beforeRemove?.(rel);
    await assertNotSymlinkEscape(abs, v.root);
    try {
      await fs.unlink(abs);
    } catch (e) {
      // A concurrent outside deleter got there first: the file is gone,
      // which is what was asked. Anything else leaves the file and its rows.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    await deps.hooks?.afterRemove?.(rel);
    // Still under the file's lock: the guard sees what exists there now.
    await dropUnlessIndexable(deps, slug, rel);
    return false;
  });
  if (!removedFolder) return;
  // Every indexed path under the removed folder, each dropped under its own
  // lock (taken after the folder's is released, so no lock is ever held while
  // waiting for another).
  let indexed: string[];
  try {
    indexed = await deps.indexer.indexedPaths(slug, `${rel}/`);
  } catch (e) {
    deps.logger?.warn("indexer.indexedPaths failed; chokidar will reconcile", {
      vault: slug,
      path: rel,
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  for (const p of indexed) await dropGuarded(deps, slug, p);
}

/**
 * Remove the folder at `abs`. Every removal call is immediately preceded by
 * the full parent-chain containment check, so a parent swapped for a symlink
 * after validation is `invalid_path` with nothing removed (REST API › Path
 * operations, containment precondition). Non-recursive: refuse a folder with children,
 * then `rmdir` (never `rm -r`), so a child that appears after the emptiness
 * check makes the removal fail as `folder_not_empty` instead of being wiped.
 * Recursive: `fs.rm` with `force: false`, so a failure surfaces.
 */
async function removeFolder(
  deps: VaultServiceDeps,
  root: string,
  abs: string,
  rel: string,
  recursive: boolean,
): Promise<void> {
  if (!recursive) {
    if ((await fs.readdir(abs)).length > 0) throw new FolderNotEmptyError(rel);
    await deps.hooks?.beforeRemove?.(rel);
    await assertNotSymlinkEscape(abs, root);
    try {
      await fs.rmdir(abs);
    } catch (e) {
      // A child that appeared after the emptiness check (ENOTEMPTY; EEXIST on
      // some platforms) is the documented 409, never a silent wipe.
      const code = (e as NodeJS.ErrnoException).code;
      throw code === "ENOTEMPTY" || code === "EEXIST" ? new FolderNotEmptyError(rel) : e;
    }
  } else {
    await deps.hooks?.beforeRemove?.(rel);
    await assertNotSymlinkEscape(abs, root);
    await fs.rm(abs, { recursive: true, force: false });
  }
  await deps.hooks?.afterRemove?.(rel);
}

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
import {
  AlreadyExistsError,
  DocNotFoundError,
  FolderNotEmptyError,
  InvalidPathError,
} from "../errors.ts";
import { detectContentType } from "./contentType.ts";
import {
  type LinkScope,
  type PathOpHooks,
  type VaultServiceDeps,
  resolveVault,
  sha256,
  tryReindexResult,
} from "./files.ts";
import {
  type GuardContext,
  atStep,
  dropIndexedUnder,
  dropUnlessIndexable,
  guarded,
  guardedRead,
  tryDrop,
} from "./guarded.ts";
import { type LinksReport, type ReindexOutcome, buildFileIndex, rewriteLinks } from "./links.ts";
import { pathLockKey, withMoveMutex, withPathLock, withPathLocks } from "./lock.ts";
import { comparePaths, compareSegments } from "./order.ts";
import { ParentVanishedError, ensureParents, errnoOf, removeCreatedParents } from "./parents.ts";
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
/** Test seam and skip reporting for `walkVaultEntries`. */
export type WalkHooks = Pick<PathOpHooks, "beforeReadDir"> & {
  readonly onSkip?: (rel: string) => void;
  /**
   * When set, a directory whose listing fails (other than by vanishing) is
   * reported here and skipped with everything below it, instead of failing
   * the walk. Without it the failure propagates, as a listing needs.
   */
  readonly onReadError?: (rel: string, error: unknown) => void;
};

export type WalkEntry =
  | { readonly type: "file"; readonly rel: string }
  | { readonly type: "folder"; readonly rel: string; readonly mtimeMs: number };

export { comparePaths } from "./order.ts";

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
 * reads every one. A descended directory is yielded only once its children
 * were read; one that is not descended is yielded on its check alone.
 * `hooks.beforeReadDir` is a test seam between the check and the read;
 * `hooks.onSkip` is told about each hidden entry and symlink passed over
 * (not about anything below them), which is what a folder copy counts.
 */
export async function* walkVaultEntries(
  root: string,
  sub = "",
  descend: (rel: string) => boolean = () => true,
  hooks: WalkHooks = {},
): AsyncIterable<WalkEntry> {
  if (sub !== "" && (await lstatContainedDirectory(join(root, sub), root)) === null) return;
  const entries = await readDirChecked(root, sub, hooks);
  if (entries !== null) yield* walkEntries(root, sub, entries, descend, hooks);
}

/** `readDirSorted`, routing a failure to `hooks.onReadError` when one is set. */
async function readDirChecked(
  root: string,
  sub: string,
  hooks: WalkHooks,
): Promise<Dirent[] | null> {
  try {
    return await readDirSorted(root, sub);
  } catch (e) {
    if (hooks.onReadError === undefined) throw e;
    hooks.onReadError(sub, e);
    return null;
  }
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
  hooks: WalkHooks,
): AsyncIterable<WalkEntry> {
  for (const ent of entries) {
    const rel = sub === "" ? ent.name : `${sub}/${ent.name}`;
    // Hidden (`.obsidian`, `.trash`, dotfiles) and symlinks: never followed.
    if (ent.name.startsWith(".") || ent.isSymbolicLink()) {
      hooks.onSkip?.(rel);
      continue;
    }
    if (ent.isDirectory()) {
      // Checked, then read, before anything is yielded (see above).
      const st = await lstatContainedDirectory(join(root, rel), root);
      if (st === null) continue;
      const folder: WalkEntry = { type: "folder", rel, mtimeMs: st.mtimeMs };
      if (!descend(rel)) {
        yield folder;
        continue;
      }
      await hooks.beforeReadDir?.(rel);
      // A directory that vanished or became a file since its check is not
      // listed from the check's now-stale metadata.
      const children = await readDirChecked(root, rel, hooks);
      if (children === null) continue;
      yield folder;
      yield* walkEntries(root, rel, children, descend, hooks);
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
  for await (const ent of walkVaultEntries(v.root, "", descend, deps.hooks)) {
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
  const g: GuardContext = { root: v.root, hooks: deps.hooks };
  const removedFolder = await withPathLock(pathLockKey(v.root, rel), async (): Promise<boolean> => {
    let st: import("node:fs").Stats;
    try {
      st = await fs.lstat(abs);
    } catch (e) {
      throw isGone(e) ? new DocNotFoundError(rel) : e;
    }
    if (st.isDirectory()) {
      await removeFolder(deps, g, abs, rel, opts.recursive === true);
      return true;
    }
    // A file is removed whatever `recursive` says (`rm -r` on a file).
    await deps.hooks?.beforeRemove?.(rel);
    try {
      await guarded(g, "delete.remove", [abs], () => fs.unlink(abs));
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
  // Every indexed path under the removed folder, each dropped under its own
  // lock (taken after the folder's is released, so no lock is ever held while
  // waiting for another).
  if (removedFolder) await dropIndexedUnder(deps, slug, rel);
}

/**
 * Remove the folder at `abs`. Every removal call goes through `guarded`, so
 * it is immediately preceded by the full parent-chain containment check and a
 * parent swapped for a symlink after validation is `invalid_path` with
 * nothing removed (REST API › Path operations, containment precondition).
 * Non-recursive: refuse a folder with children, then `rmdir` (never `rm -r`),
 * so a child that appears after the emptiness check makes the removal fail
 * as `folder_not_empty` instead of being wiped. Recursive: `fs.rm` with
 * `force: false`, so a failure surfaces.
 */
async function removeFolder(
  deps: VaultServiceDeps,
  g: GuardContext,
  abs: string,
  rel: string,
  recursive: boolean,
): Promise<void> {
  if (!recursive) {
    // The emptiness probe reads the folder, so it is checked like a removal.
    await assertNotSymlinkEscape(abs, g.root);
    if ((await fs.readdir(abs)).length > 0) throw new FolderNotEmptyError(rel);
    await deps.hooks?.beforeRemove?.(rel);
    try {
      await guarded(g, "delete.remove", [abs], () => fs.rmdir(abs));
    } catch (e) {
      // A child that appeared after the emptiness check (ENOTEMPTY; EEXIST on
      // some platforms) is the documented 409, never a silent wipe.
      const code = (e as NodeJS.ErrnoException).code;
      throw code === "ENOTEMPTY" || code === "EEXIST" ? new FolderNotEmptyError(rel) : e;
    }
  } else {
    await deps.hooks?.beforeRemove?.(rel);
    await guarded(g, "delete.remove", [abs], () => fs.rm(abs, { recursive: true, force: false }));
  }
  await deps.hooks?.afterRemove?.(rel);
}

// ---------------------------------------------------------------------------
// Move (`mv -T`) and the publish machinery it shares with copy
// ---------------------------------------------------------------------------

export interface MovePathOptions {
  /** The exact new path (never a folder to move into). */
  readonly destination: string;
  /** Replace an existing destination FILE. Never applies to folders. Default `false`. */
  readonly overwrite?: boolean | undefined;
  /** Rewrite internal links to what moved. Default `true`. */
  readonly updateLinks?: boolean | undefined;
}

export interface MovePathResult {
  readonly path: string;
  readonly destination: string;
  readonly type: PathType;
  readonly overwritten: boolean;
  readonly indexed: boolean;
  readonly links: LinksReport | null;
}

/**
 * A failure after the destination was published: always `internal`, both
 * paths left as they are, no cleanup (REST API › Path operations,
 * post-publication rule). Not an `OBError`, so both adapters report 500.
 */
export class PostPublicationError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
  }
}

const NO_HARD_LINK_CODES = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP"]);

/** `link` failed because the filesystem refuses hard links (not a collision or a fault). */
export function refusesHardLinks(e: unknown): boolean {
  return NO_HARD_LINK_CODES.has(errnoOf(e) as string);
}

/** Real vault roots already warned about refusing hard links. */
const warnedNoHardLinks = new Set<string>();

/** Log, once per vault, that no-replace publishes degrade to check-then-rename. */
export function warnNoHardLinks(deps: VaultServiceDeps, slug: string): void {
  const key = linkScopeOf(deps, slug).root;
  if (warnedNoHardLinks.has(key)) return;
  warnedNoHardLinks.add(key);
  deps.logger?.warn(
    "vault filesystem refuses hard links; move and copy publish with check-then-rename",
    { vault: slug },
  );
}

/** The whole-vault link view: the scoped deps' `linkScope`, else this vault's root. */
export function linkScopeOf(deps: VaultServiceDeps, slug: string): LinkScope {
  return deps.linkScope?.(slug) ?? { root: resolveVault(deps, slug).root, prefix: "" };
}

/** `lstat`, or `null` when nothing is there (or a parent stopped being a folder). */
export async function lstatOrNull(abs: string): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.lstat(abs);
  } catch (e) {
    if (isGone(e)) return null;
    throw e;
  }
}

/** `lstat` of a destination; a parent that is a file is `invalid_path`. */
export async function lstatDestination(
  abs: string,
  rel: string,
): Promise<import("node:fs").Stats | null> {
  try {
    return await fs.lstat(abs);
  } catch (e) {
    if (errnoOf(e) === "ENOENT") return null;
    if (errnoOf(e) === "ENOTDIR")
      throw new InvalidPathError(rel, "a parent of the destination is a file");
    throw e;
  }
}

/** Map a publish's collision errno to `already_exists`; anything else unchanged. */
export function collision(e: unknown, dst: string, codes: readonly string[]): unknown {
  return codes.includes(errnoOf(e) as string) ? new AlreadyExistsError(dst) : e;
}

/**
 * Steps 5–6 of a move or a copy, under its locks: create the destination's
 * missing parents (`ensureParents`, after every check passed), then
 * `publish()`. A failure before publication removes the parents this call
 * created; a `PostPublicationError` leaves everything. A parent removed
 * underneath by another call's cleanup (`ENOENT`) runs both steps once more;
 * a second one is `internal`.
 */
export async function publishWithParents(
  g: GuardContext,
  dstAbs: string,
  dst: string,
  publish: () => Promise<void>,
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    let created: string[];
    try {
      created = await ensureParents(g, dstAbs, dst);
    } catch (e) {
      if (e instanceof ParentVanishedError && attempt === 1) continue;
      throw e;
    }
    try {
      await publish();
      return;
    } catch (e) {
      if (e instanceof PostPublicationError) throw e;
      await removeCreatedParents(g, created);
      if (errnoOf(e) === "ENOENT" && attempt === 1) continue;
      throw e;
    }
  }
}

/**
 * Every file the walk lists under `root` (all types), vault-relative to it.
 * With `onReadError`, a folder that cannot be listed is reported and skipped
 * instead of failing the call.
 */
export async function listFiles(
  root: string,
  sub = "",
  onReadError?: (rel: string, error: unknown) => void,
): Promise<string[]> {
  const out: string[] = [];
  const hooks: WalkHooks = onReadError === undefined ? {} : { onReadError };
  for await (const ent of walkVaultEntries(root, sub, undefined, hooks)) {
    if (ent.type === "file") out.push(ent.rel);
  }
  return out;
}

/** Run `fn` over `items` with at most `limit` in flight; results in input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i] as T);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Bounded reindex concurrency for moves and copies, as the scanner's. */
export const REINDEX_CONCURRENCY = 4;

/** Reindex `path` holding its write lock for the whole reindex. */
export function reindexLocked(
  deps: VaultServiceDeps,
  slug: string,
  root: string,
  path: string,
): Promise<ReindexOutcome> {
  return withPathLock(pathLockKey(root, path), () => tryReindexResult(deps, slug, path));
}

/** Validate a move's or copy's two paths up front (lexical, then the symlink chain). */
export async function validatePair(
  root: string,
  path: string,
  destination: string,
): Promise<{ src: string; dst: string; srcAbs: string; dstAbs: string }> {
  const src = canonicalPath(path);
  const dst = canonicalPath(destination);
  const srcAbs = safeJoin(root, src);
  const dstAbs = safeJoin(root, dst);
  if (src === dst) throw new InvalidPathError(dst, "destination equals the source");
  if (dst.startsWith(`${src}/`))
    throw new InvalidPathError(dst, "destination lies inside the source");
  await assertNotSymlinkEscape(srcAbs, root);
  await assertNotSymlinkEscape(dstAbs, root);
  return { src, dst, srcAbs, dstAbs };
}

/** `lstat` a move's or copy's source under its lock: missing → `not_found`. */
export async function lstatSource(abs: string, rel: string): Promise<import("node:fs").Stats> {
  const st = await lstatOrNull(abs);
  if (st === null) throw new DocNotFoundError(rel);
  if (st.isSymbolicLink() || (!st.isFile() && !st.isDirectory())) {
    throw new InvalidPathError(rel, "not a regular file or folder");
  }
  return st;
}

/** What the under-locks phase of a move hands to the phases after it. */
interface Moved {
  readonly type: PathType;
  readonly overwritten: boolean;
  /** Old → new, scope-relative, for every moved file the walk lists. */
  readonly pairs: readonly (readonly [string, string])[];
  readonly before: readonly string[] | null;
  readonly after: readonly string[] | null;
  /** Every required drop so far succeeded. */
  readonly dropsOk: boolean;
  /** The moved folder was listed completely (always true for a file). */
  readonly pairsComplete: boolean;
  /** `after` covers the whole vault; links are rewritten only then. */
  readonly afterComplete: boolean;
}

/**
 * Move (rename) a file or a folder to an exact destination (REST API ›
 * Path operations, `:move`), as the change document's Design describes:
 * the per-vault move mutex is held throughout; both paths are validated and
 * canonicalized; under both path locks the source and destination are
 * checked, `F_before` is snapshotted, parents are created, and the
 * destination is published (no-replace `link` + `unlink`, or an atomic
 * `rename`); old rows are dropped; then — locks released, mutex still held —
 * a folder's indexed paths are dropped, links are rewritten, and every
 * moved path is reindexed under its own lock.
 */
export async function movePath(
  deps: VaultServiceDeps,
  slug: string,
  path: string,
  opts: MovePathOptions,
): Promise<MovePathResult> {
  const v = resolveVault(deps, slug);
  const g: GuardContext = { root: v.root, hooks: deps.hooks };
  const scope = linkScopeOf(deps, slug);
  const { src, dst, srcAbs, dstAbs } = await validatePair(v.root, path, opts.destination);
  const updateLinks = opts.updateLinks !== false;
  return withMoveMutex(slug, async () => {
    const moved = await withPathLocks(
      [pathLockKey(v.root, src), pathLockKey(v.root, dst)],
      async (): Promise<Moved> => {
        const sst = await lstatSource(srcAbs, src);
        const type: PathType = sst.isDirectory() ? "folder" : "file";
        const dstSt = await lstatDestination(dstAbs, dst);
        let completion = false;
        if (dstSt !== null) {
          if (opts.overwrite !== true || type === "folder" || !dstSt.isFile()) {
            throw new AlreadyExistsError(dst);
          }
          // Same inode: the half-finished state a failed source removal leaves.
          completion = dstSt.dev === sst.dev && dstSt.ino === sst.ino;
        }
        const overwritten = dstSt !== null && !completion;
        const before = updateLinks ? await listFiles(scope.root) : null;
        await publishWithParents(g, dstAbs, dst, async () => {
          if (completion) return removeSourceIfSame(g, srcAbs, dstAbs);
          if (type === "folder" || overwritten || opts.overwrite === true) {
            const codes = type === "folder" ? ["ENOTEMPTY", "EEXIST", "ENOTDIR"] : ["EISDIR"];
            try {
              await guarded(g, "move.rename", [srcAbs, dstAbs], () => fs.rename(srcAbs, dstAbs));
            } catch (e) {
              throw collision(e, dst, codes);
            }
            return;
          }
          try {
            await guarded(g, "move.link", [srcAbs, dstAbs], () => fs.link(srcAbs, dstAbs));
          } catch (e) {
            if (!refusesHardLinks(e)) throw collision(e, dst, ["EEXIST"]);
            // No hard links: re-check the destination under the lock, then rename.
            warnNoHardLinks(deps, slug);
            if ((await lstatDestination(dstAbs, dst)) !== null) throw new AlreadyExistsError(dst);
            await guarded(g, "move.rename", [srcAbs, dstAbs], () => fs.rename(srcAbs, dstAbs));
            return;
          }
          await removeSourceIfSame(g, srcAbs, dstAbs);
        });
        await atStep(g, "move.afterPublish", [srcAbs, dstAbs]);
        // Published: from here on only the source steps above may fail the
        // move. A folder that cannot be listed now is skipped and reported
        // (indexed: false, a links.failed entry, a warning), never a 500.
        let unlisted = 0;
        const skipUnlisted = (rel: string, e: unknown): void => {
          unlisted++;
          deps.logger?.warn("move published but could not list a folder; it was skipped", {
            vault: slug,
            path: rel,
            error: e instanceof Error ? e.message : String(e),
          });
        };
        const pairs: [string, string][] =
          type === "file"
            ? [[src, dst]]
            : (await listFiles(v.root, dst, skipUnlisted)).map((p) => [
                `${src}${p.slice(dst.length)}`,
                p,
              ]);
        const pairsComplete = unlisted === 0;
        // Drops under the locks: the old path (drop guard), and an overwritten
        // destination's old rows (unconditional), so replaced content is never
        // served even if the reindex below fails.
        let dropsOk = true;
        if (type === "file") dropsOk = await dropUnlessIndexable(deps, slug, src);
        if (overwritten) dropsOk = (await tryDrop(deps, slug, dst)) && dropsOk;
        const listedBefore = unlisted;
        const after = updateLinks ? await listFiles(scope.root, "", skipUnlisted) : null;
        const afterComplete = unlisted === listedBefore;
        return { type, overwritten, pairs, before, after, dropsOk, pairsComplete, afterComplete };
      },
    );
    // Folder rows are found from the index, after the folder locks are gone.
    const folderDropsOk = moved.type === "folder" ? await dropIndexedUnder(deps, slug, src) : true;
    let links: LinksReport | null = null;
    let rewritten = new Map<string, ReindexOutcome>();
    if (moved.after !== null && !moved.afterComplete) {
      // Rewriting against a partial file set could point links at the wrong
      // file; leave every note as it is and say so.
      links = {
        updated: [],
        failed: [
          {
            path: dst,
            code: "internal",
            message: "links were not rewritten: the vault could not be fully listed after the move",
          },
        ],
      };
    } else if (moved.before !== null && moved.after !== null) {
      const toVault = (p: string): string => (scope.prefix === "" ? p : `${scope.prefix}/${p}`);
      const out = await rewriteLinks({
        deps,
        slug,
        g,
        scope,
        moves: new Map(moved.pairs.map(([from, to]) => [toVault(from), toVault(to)])),
        before: buildFileIndex(moved.before),
        after: buildFileIndex(moved.after),
        afterFiles: moved.after,
      });
      links = out.report;
      rewritten = out.reindexed;
    }
    const outcomes = await mapLimit(moved.pairs, REINDEX_CONCURRENCY, ([, to]) => {
      const done = rewritten.get(to);
      return done !== undefined ? Promise.resolve(done) : reindexLocked(deps, slug, v.root, to);
    });
    const indexed =
      moved.pairsComplete &&
      moved.dropsOk &&
      folderDropsOk &&
      outcomes.every((o) => o.ok) &&
      outcomes.some((o) => o.indexed);
    return {
      path: src,
      destination: dst,
      type: moved.type,
      overwritten: moved.overwritten,
      indexed,
      links,
    };
  });
}

/**
 * After a file move published `dst` (or found it already published, the
 * completion case): remove `src`, but only once `src` and `dst` are
 * confirmed, immediately before, to be the same file. Every failure here is
 * post-publication — `internal`, both paths left, nothing undone.
 */
async function removeSourceIfSame(g: GuardContext, srcAbs: string, dstAbs: string): Promise<void> {
  try {
    await atStep(g, "move.beforeSourceCheck", [srcAbs, dstAbs]);
    const [a, b] = await Promise.all([fs.lstat(srcAbs), fs.lstat(dstAbs)]);
    if (a.dev !== b.dev || a.ino !== b.ino) throw new Error("source was replaced after the link");
    await guarded(g, "move.unlinkSource", [srcAbs, dstAbs], () => fs.unlink(srcAbs));
  } catch (e) {
    throw new PostPublicationError(
      "move published its destination but could not remove its source",
      e,
    );
  }
}

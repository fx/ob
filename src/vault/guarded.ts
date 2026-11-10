/**
 * Guarded filesystem helpers shared by the path operations.
 *
 * - `guardedRead` is the content read the REST spec's containment precondition
 *   requires (REST API › Path operations): the parent-chain symlink check
 *   immediately before the read, an `O_NOFOLLOW` open, and an `fstat` on the
 *   opened descriptor confirming a regular file (and, with `maxBytes`, its
 *   size). The read itself is bounded to `maxBytes + 1` bytes; the one extra
 *   sentinel byte only detects a file that grew after the `fstat`, which is
 *   then reported as oversize — the caller never receives more than
 *   `maxBytes` of content.
 * - `dropGuarded` / `dropUnlessIndexable` implement the drop guard (Vault
 *   Indexer › Indexable paths): a removed path's rows are dropped unless an
 *   indexable note exists at the path when the drop runs. The check and the
 *   drop are ONE indexer call (`drop(…, { unlessIndexable: true })`), atomic
 *   under the indexer's per-path pipeline lock and evaluated on the real
 *   vault root — never on `vault(slug).root`, which in a scoped MCP session
 *   is the scope root. A drop failure is logged and swallowed: the
 *   removal already happened, and the watcher's `unlink` event reconciles.
 *   Both report whether the guard completed (`false` = the drop failed), so
 *   a move or copy can turn its `indexed` to `false`.
 * - `guarded` and `stagingInterior` are the only way move, copy, and the
 *   link rewriter may call a filesystem function that creates, writes,
 *   links, renames, or removes a path (REST API › Path operations,
 *   containment precondition). `guarded(g, site, paths, op)` runs the full
 *   parent-chain symlink check (`assertNotSymlinkEscape`) for EVERY path the
 *   call touches — both paths of a link or rename — immediately before
 *   `op()`. `stagingInterior(staging, target, op)` is the one exemption,
 *   made explicit and greppable: it skips the chain check only for a target
 *   strictly inside a staging root THIS call created (`createdStagingRoot`)
 *   and still holds. A lint-level test pins that move, copy, and rewrite code
 *   reach the mutating `fs` functions through these two helpers only.
 */

import type { Stats } from "node:fs";
import { constants, promises as fs } from "node:fs";
import { resolve, sep } from "node:path";
import { DocNotFoundError, InvalidPathError, assertSafeRelativePath } from "../errors.ts";
import { type PathOpHooks, type VaultServiceDeps, resolveVault } from "./files.ts";
import { pathLockKey, withPathLock } from "./lock.ts";
import { assertNotSymlinkEscape, safeJoin } from "./path.ts";

/** Thrown by `guardedRead` when the file exceeds `maxBytes` (at `fstat` or while reading). */
export class OversizeReadError extends Error {
  readonly path: string;
  readonly maxBytes: number;
  constructor(path: string, maxBytes: number) {
    super(`file "${path}" exceeds ${maxBytes} bytes`);
    this.name = "OversizeReadError";
    this.path = path;
    this.maxBytes = maxBytes;
  }
}

const NOT_REACHED = "path traverses a symbolic link or non-directory";

export interface GuardedReadOptions {
  /** Refuse files larger than this many bytes (`OversizeReadError`). Omitted: no cap. */
  readonly maxBytes?: number;
  /** Test seam: runs after the parent-chain check, immediately before the open. */
  readonly beforeOpen?: () => Promise<void>;
  /** Test seam: runs after the descriptor's `fstat`, immediately before the read. */
  readonly afterStat?: () => Promise<void>;
  /** Told how many bytes a bounded (`maxBytes`) read fetched, before any oversize throw. */
  readonly onRead?: (bytesRead: number) => void;
  /**
   * With `maxBytes`: called with the opened descriptor's `fstat` — after the
   * regular-file check, before the size check and before any byte is read —
   * and returns how many bytes the read may fetch at most (capped at
   * `maxBytes + 1`). It may throw to refuse the read; the error propagates.
   * A read stopped by a limit below `maxBytes + 1` can be short of the file's
   * content; the caller compares the bytes with the result's `endStat.size`.
   */
  readonly readLimit?: (stat: Stats) => number;
}

export interface GuardedReadResult {
  readonly bytes: Uint8Array;
  /** `fstat` of the opened descriptor — the file that was actually read. */
  readonly stat: Stats;
  /**
   * With `readLimit`: a second `fstat` of the same descriptor, taken after
   * the read, so a caller can tell a read that stopped at its limit from one
   * that reached the end of the file.
   */
  readonly endStat?: Stats;
}

/**
 * Read `rel` (relative to `root`) under the containment precondition.
 *
 * Throws `DocNotFoundError` when the path does not exist, `InvalidPathError`
 * when `rel` is not a safe vault-relative path (`safeJoin`), a component is a
 * symlink or not a directory, or the opened entry is not a regular file, and `OversizeReadError` past `maxBytes`. Anything else
 * propagates unchanged.
 */
export async function guardedRead(
  root: string,
  rel: string,
  opts: GuardedReadOptions = {},
): Promise<GuardedReadResult> {
  // Lexical validation first (`..`, absolute, NUL, hidden, the root itself):
  // the helper is safe by itself, whatever the caller passes.
  const abs = safeJoin(root, rel);
  await assertNotSymlinkEscape(abs, root);
  await opts.beforeOpen?.();
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new DocNotFoundError(rel);
    // ELOOP: the leaf became a symlink after the chain check. ENOTDIR: a
    // parent became a file. Both are containment failures, not faults.
    throw code === "ELOOP" || code === "ENOTDIR" ? new InvalidPathError(rel, NOT_REACHED) : e;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new InvalidPathError(rel, "not a regular file");
    const max = opts.maxBytes;
    if (max === undefined) {
      await opts.afterStat?.();
      return { bytes: await readAll(handle), stat };
    }
    const limit = Math.min(max + 1, opts.readLimit?.(stat) ?? max + 1);
    if (stat.size > max) throw new OversizeReadError(rel, max);
    await opts.afterStat?.();
    const bytes = await readBounded(handle, rel, max, limit, opts.onRead);
    if (opts.readLimit === undefined) return { bytes, stat };
    return { bytes, stat, endStat: await handle.stat() };
  } finally {
    await handle.close();
  }
}

async function readAll(handle: fs.FileHandle): Promise<Uint8Array> {
  const buf = await handle.readFile();
  // Copy into a fresh ArrayBuffer-backed view (see `readFile` in files.ts).
  const view = new Uint8Array(buf.byteLength);
  view.set(buf);
  return view;
}

/**
 * Read at most `limit` (≤ `max + 1`) bytes; reaching `max + 1` — the sentinel
 * byte — means the file grew past `max`.
 */
async function readBounded(
  handle: fs.FileHandle,
  rel: string,
  max: number,
  limit: number,
  onRead: ((bytesRead: number) => void) | undefined,
): Promise<Uint8Array> {
  const buf = new Uint8Array(limit);
  let total = 0;
  while (total < buf.byteLength) {
    const { bytesRead } = await handle.read(buf, total, buf.byteLength - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  onRead?.(total);
  if (total > max) throw new OversizeReadError(rel, max);
  return buf.slice(0, total);
}

/**
 * The drop guard for a caller that ALREADY holds `path`'s write lock: drop
 * the path's rows unless an indexable note exists there now. Never throws;
 * resolves `false` when the drop failed (logged), `true` otherwise.
 */
export async function dropUnlessIndexable(
  deps: VaultServiceDeps,
  slug: string,
  path: string,
): Promise<boolean> {
  try {
    // One indexer call, not a check then a drop: the indexer re-checks the
    // rule under the path's pipeline lock, so a note recreated between an
    // earlier check and the drop (an outside writer, then the watcher's
    // reindex) never loses the rows just written for it.
    await deps.indexer.drop(slug, path, { unlessIndexable: true });
    return true;
  } catch (e) {
    logDropFailure(deps, slug, path, e);
    return false;
  }
}

/**
 * Drop `path`'s rows unconditionally — the overwritten-destination drop
 * (Vault Indexer › Indexable paths), NOT subject to the drop guard: the
 * caller holds the destination's lock and is about to reindex the
 * replacement there. Never throws; `false` when the drop failed (logged).
 */
export async function tryDrop(
  deps: VaultServiceDeps,
  slug: string,
  path: string,
): Promise<boolean> {
  try {
    await deps.indexer.drop(slug, path);
    return true;
  } catch (e) {
    logDropFailure(deps, slug, path, e);
    return false;
  }
}

function logDropFailure(deps: VaultServiceDeps, slug: string, path: string, e: unknown): void {
  deps.logger?.warn("indexer.drop failed; chokidar will reconcile", {
    vault: slug,
    path,
    error: e instanceof Error ? e.message : String(e),
  });
}

/**
 * The drop guard, taking `path`'s write lock for the check and the drop.
 * A path that is not a safe vault-relative path (`..`, absolute, NUL, hidden)
 * is refused before any lock key is formed or the indexer is asked anything —
 * logged, never dropped (the indexer's own `drop` rejects such a path too).
 * Never throws for a configured vault; `false` when the drop failed or was
 * refused.
 */
export async function dropGuarded(
  deps: VaultServiceDeps,
  slug: string,
  path: string,
): Promise<boolean> {
  try {
    assertSafeRelativePath(path);
  } catch (e) {
    deps.logger?.warn("drop guard refused an unsafe path", {
      vault: slug,
      path,
      error: (e as Error).message,
    });
    return false;
  }
  const key = pathLockKey(resolveVault(deps, slug).root, path);
  return withPathLock(key, () => dropUnlessIndexable(deps, slug, path));
}

/** A segment starting with `.` other than `.` and `..`. */
function hasHiddenSegment(path: string): boolean {
  return path.split("/").some((seg) => seg.startsWith(".") && seg !== "." && seg !== "..");
}

/**
 * Drop the rows of every indexed path under `folder/` — the paths a removed
 * or moved-away folder left behind — each under its own write lock and the
 * drop guard. The paths come from the INDEX (`indexedPaths`), not from the
 * folder's listing, so rows under hidden entries or symlinks that travelled
 * with the folder (left by an earlier version or an outside writer) are
 * found too. A path with a hidden segment can never be indexable, so the
 * guard always drops it; `drop` refuses such paths, so it goes through the
 * narrower `dropHidden` instead. Never throws; `false` when listing or any
 * drop failed (logged).
 */
export async function dropIndexedUnder(
  deps: VaultServiceDeps,
  slug: string,
  folder: string,
): Promise<boolean> {
  let paths: string[];
  try {
    paths = await deps.indexer.indexedPaths(slug, `${folder}/`);
  } catch (e) {
    deps.logger?.warn("indexer.indexedPaths failed; chokidar will reconcile", {
      vault: slug,
      path: folder,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
  let ok = true;
  const root = resolveVault(deps, slug).root;
  for (const p of paths) {
    if (!hasHiddenSegment(p)) {
      ok = (await dropGuarded(deps, slug, p)) && ok;
      continue;
    }
    ok =
      (await withPathLock(pathLockKey(root, p), async () => {
        try {
          await deps.indexer.dropHidden(slug, p);
          return true;
        } catch (e) {
          logDropFailure(deps, slug, p, e);
          return false;
        }
      })) && ok;
  }
  return ok;
}

/**
 * Named points of a path operation, for `PathOpHooks.beforeStep`. Every
 * `guarded` call names its site; the non-filesystem sites mark a read or a
 * check a test may need to race.
 */
export type GuardSite =
  | "parents.mkdir"
  | "parents.rmdir"
  | "delete.remove"
  | "move.link"
  | "move.rename"
  | "move.beforeSourceCheck"
  | "move.unlinkSource"
  | "move.afterPublish"
  | "copy.read"
  | "copy.openTmp"
  | "copy.writeTmp"
  | "copy.link"
  | "copy.rename"
  | "copy.unlinkTmp"
  | "copy.mkdirStaging"
  | "copy.entry"
  | "copy.renameStaging"
  | "copy.rmStaging"
  | "rewrite.read"
  | "rewrite.openTmp"
  | "rewrite.writeTmp"
  | "rewrite.rename"
  | "rewrite.unlinkTmp";

/** What `guarded` needs: the containment root and the operation's test hooks. */
export interface GuardContext {
  /** The root every path must stay inside — the (scope) root the call resolved against. */
  readonly root: string;
  readonly hooks?: PathOpHooks | undefined;
}

/** Run the `beforeStep` test seam for `site`, if one is installed. */
export async function atStep(
  g: GuardContext,
  site: GuardSite,
  paths: readonly string[],
): Promise<void> {
  await g.hooks?.beforeStep?.(site, paths);
}

/**
 * The containment precondition for one mutating filesystem call: the
 * parent-chain symlink check over every path in `paths` (absolute paths
 * under `g.root`; each check walks the whole chain), immediately followed by
 * `op()`. A failed check throws `InvalidPathError` and `op` never runs. The
 * `beforeStep` hook runs first, so a test can plant a symlink exactly where
 * the check must catch it.
 */
export async function guarded<T>(
  g: GuardContext,
  site: GuardSite,
  paths: readonly string[],
  op: () => Promise<T>,
): Promise<T> {
  await atStep(g, site, paths);
  for (const p of paths) await assertNotSymlinkEscape(p, g.root);
  return op();
}

/** A staging folder this call created exclusively; see `createdStagingRoot`. */
export interface StagingRoot {
  readonly abs: string;
}

/** Staging roots that were created by a live call and not yet released. */
const liveStaging = new WeakSet<StagingRoot>();

/**
 * Mint the handle for a staging folder the caller has JUST created with an
 * exclusive (non-recursive, uniquely named) `mkdir`. Only a handle minted
 * here and not yet released admits `stagingInterior` calls.
 */
export function createdStagingRoot(abs: string): StagingRoot {
  const root: StagingRoot = Object.freeze({ abs });
  liveStaging.add(root);
  return root;
}

/** Retire a staging handle once its folder was renamed into place or removed. */
export function releaseStagingRoot(root: StagingRoot): void {
  liveStaging.delete(root);
}

/**
 * The containment exemption: `op()` runs WITHOUT the chain check, but only
 * for a `target` strictly inside a live staging root this call created
 * (normalized, so `..` cannot climb out). Anything else is refused with a
 * plain error — a misuse is a bug, never client input.
 */
export async function stagingInterior<T>(
  staging: StagingRoot,
  target: string,
  op: () => Promise<T>,
): Promise<T> {
  if (
    !liveStaging.has(staging) ||
    resolve(target) !== target ||
    !target.startsWith(`${staging.abs}${sep}`)
  ) {
    throw new Error("stagingInterior: target is not strictly inside a live staging root");
  }
  return op();
}

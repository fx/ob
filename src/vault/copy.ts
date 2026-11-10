/**
 * Service core: copy (`cp -T` / `cp -r -T`) a file or, with `recursive`, a
 * folder to an exact destination (REST API › Path operations, `:copy`).
 *
 * File. Under the source and destination locks: the type and existence
 * checks, a guarded read of the source, the destination's parents
 * (`ensureParents`), then the bytes go to an exclusively created hidden temp
 * sibling `.<name>.<uuid>.tmp` and are published from it — a no-replace
 * `link(tmp, dst)` (falling back to check-then-rename where the filesystem
 * refuses hard links) or, with `overwrite`, one atomic `rename(tmp, dst)`.
 * After a successful publish only the call's own temp file is removed; a
 * failure there is logged and the copy still succeeds. The destination is
 * reindexed while its lock is still held.
 *
 * Folder. The destination lock is held just long enough to check the
 * destination is absent and create its parents. The copy is then built in a
 * hidden staging folder `.<name>.<uuid>.copy` this call creates exclusively
 * — the containment precondition's one exemption, reached only through
 * `stagingInterior` — and renamed into place under the destination lock
 * after a re-check, so a reader sees the whole copy or none of it. Any
 * failure removes the staging folder and the parents this call created.
 *
 * Every mutating filesystem call goes through `guarded` or
 * `stagingInterior`; a copy never moves, renames, or removes its source.
 */

import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import { AlreadyExistsError, DocNotFoundError, InvalidPathError } from "../errors.ts";
import { type VaultServiceDeps, resolveVault, tryReindexResult } from "./files.ts";
import {
  type GuardContext,
  atStep,
  createdStagingRoot,
  guarded,
  guardedRead,
  releaseStagingRoot,
  stagingInterior,
  tryDrop,
} from "./guarded.ts";
import { pathLockKey, withPathLock, withPathLocks } from "./lock.ts";
import { ParentVanishedError, ensureParents, errnoOf, removeCreatedParents } from "./parents.ts";
import {
  type PathType,
  REINDEX_CONCURRENCY,
  collision,
  failListing,
  lstatDestination,
  lstatSource,
  mapLimit,
  publishWithParents,
  refusesHardLinks,
  reindexLocked,
  validatePair,
  walkVaultEntries,
  warnNoHardLinks,
} from "./paths.ts";

export interface CopyPathOptions {
  /** The exact new path (never a folder to copy into). */
  readonly destination: string;
  /** Replace an existing destination FILE. Never applies to folders. Default `false`. */
  readonly overwrite?: boolean | undefined;
  /** Required to copy a folder (`cp -r`); no effect on a file. Default `false`. */
  readonly recursive?: boolean | undefined;
}

export interface CopyPathResult {
  readonly path: string;
  readonly destination: string;
  readonly type: PathType;
  readonly overwritten: boolean;
  readonly indexed: boolean;
  /** Files written. */
  readonly files: number;
  /** Hidden entries and symlinks in the source folder that were not copied. */
  readonly skipped: number;
}

interface Pair {
  readonly src: string;
  readonly dst: string;
  readonly srcAbs: string;
  readonly dstAbs: string;
}

export async function copyPath(
  deps: VaultServiceDeps,
  slug: string,
  path: string,
  opts: CopyPathOptions,
): Promise<CopyPathResult> {
  const v = resolveVault(deps, slug);
  const g: GuardContext = { root: v.root, hooks: deps.hooks };
  const pair = await validatePair(v.root, path, opts.destination);
  const { src, dst, srcAbs, dstAbs } = pair;
  const first = await withPathLocks(
    [pathLockKey(v.root, src), pathLockKey(v.root, dst)],
    async (): Promise<CopyPathResult | { readonly created: string[] }> => {
      const sst = await lstatSource(srcAbs, src);
      if (!sst.isDirectory()) return copyFileLocked(deps, slug, g, pair, opts.overwrite === true);
      if (opts.recursive !== true) {
        throw new InvalidPathError(src, "is a folder; copying it needs recursive: true");
      }
      if ((await lstatDestination(dstAbs, dst)) !== null) throw new AlreadyExistsError(dst);
      return { created: await ensureParentsOnce(g, dstAbs, dst) };
    },
  );
  if (!("created" in first)) return first;
  return copyFolder(deps, slug, g, pair, first.created);
}

/** `ensureParents`, run once more when a parent vanished under it. */
async function ensureParentsOnce(g: GuardContext, dstAbs: string, dst: string): Promise<string[]> {
  try {
    return await ensureParents(g, dstAbs, dst);
  } catch (e) {
    if (!(e instanceof ParentVanishedError)) throw e;
    return ensureParents(g, dstAbs, dst);
  }
}

/** A file copy, run while holding both the source and the destination locks. */
async function copyFileLocked(
  deps: VaultServiceDeps,
  slug: string,
  g: GuardContext,
  { src, dst, srcAbs, dstAbs }: Pair,
  overwrite: boolean,
): Promise<CopyPathResult> {
  const dstSt = await lstatDestination(dstAbs, dst);
  if (dstSt !== null && (!overwrite || !dstSt.isFile())) throw new AlreadyExistsError(dst);
  await atStep(g, "copy.read", [srcAbs]);
  const { bytes } = await guardedRead(g.root, src);
  const uuid = deps.randomUUID ?? crypto.randomUUID.bind(crypto);
  await publishWithParents(g, dstAbs, dst, async () => {
    const tmp = join(dirname(dstAbs), `.${basename(dstAbs)}.${uuid()}.tmp`);
    // Ownership: a failed exclusive open (EEXIST: the name is someone
    // else's) throws from here, outside the cleanup below; only once this
    // open has succeeded is the temp file provably this call's own and
    // removable on a failure path.
    const handle = await guarded(g, "copy.openTmp", [tmp], () => fs.open(tmp, "wx"));
    try {
      try {
        await guarded(g, "copy.writeTmp", [tmp], () => handle.writeFile(bytes));
      } finally {
        await handle.close();
      }
      if (overwrite) {
        await guarded(g, "copy.rename", [tmp, dstAbs], () => fs.rename(tmp, dstAbs)).catch((e) => {
          throw collision(e, dst, ["EISDIR"]);
        });
        return;
      }
      try {
        await guarded(g, "copy.link", [tmp, dstAbs], () => fs.link(tmp, dstAbs));
      } catch (e) {
        if (!refusesHardLinks(e)) throw collision(e, dst, ["EEXIST"]);
        // No hard links: re-check under the lock, then rename the OWN temp file.
        warnNoHardLinks(deps, slug);
        if ((await lstatDestination(dstAbs, dst)) !== null) throw new AlreadyExistsError(dst);
        await guarded(g, "copy.rename", [tmp, dstAbs], () => fs.rename(tmp, dstAbs));
        return;
      }
    } catch (e) {
      await removeOwnTemp(g, tmp);
      throw e;
    }
    // Published. Only the call's own hidden temp file is left to remove.
    try {
      await guarded(g, "copy.unlinkTmp", [tmp], () => fs.unlink(tmp));
    } catch (e) {
      deps.logger?.warn("copy published but could not remove its temp file", {
        vault: slug,
        path: dst,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });
  const dropOk = dstSt !== null ? await tryDrop(deps, slug, dst) : true;
  const r = await tryReindexResult(deps, slug, dst);
  return {
    path: src,
    destination: dst,
    type: "file",
    overwritten: dstSt !== null,
    indexed: dropOk && r.ok && r.indexed,
    files: 1,
    skipped: 0,
  };
}

/** Remove this call's own temp file on a failure path; a missing one is fine. */
async function removeOwnTemp(g: GuardContext, tmp: string): Promise<void> {
  await guarded(g, "copy.unlinkTmp", [tmp], () => fs.unlink(tmp)).catch(() => undefined);
}

/** Create the staging folder exclusively, retrying once if its parent vanished. */
async function createStaging(
  g: GuardContext,
  pair: Pair,
  staging: string,
  created: string[],
): Promise<string[]> {
  // Ownership: an exclusive `mkdir` that fails (EEXIST included) leaves
  // whatever is at that name alone; the staging handle that admits removal
  // is minted only after this call's own `mkdir` succeeded.
  try {
    await guarded(g, "copy.mkdirStaging", [staging], () => fs.mkdir(staging));
    return created;
  } catch (e) {
    if (errnoOf(e) !== "ENOENT") throw e;
  }
  // A parent was removed by another call's cleanup: recreate it under the
  // destination lock and try exactly once more.
  return withPathLock(pathLockKey(g.root, pair.dst), async () => {
    const again = await ensureParents(g, pair.dstAbs, pair.dst);
    try {
      await guarded(g, "copy.mkdirStaging", [staging], () => fs.mkdir(staging));
    } catch (e) {
      await removeCreatedParents(g, again);
      throw e;
    }
    // Top-down (an ancestor's path is shorter), so cleanup stays deepest first.
    return [...new Set([...created, ...again])].sort((a, b) => a.length - b.length);
  });
}

async function copyFolder(
  deps: VaultServiceDeps,
  slug: string,
  g: GuardContext,
  pair: Pair,
  createdParents: string[],
): Promise<CopyPathResult> {
  const { src, dst, dstAbs } = pair;
  const uuid = deps.randomUUID ?? crypto.randomUUID.bind(crypto);
  const stagingAbs = join(dirname(dstAbs), `.${basename(dstAbs)}.${uuid()}.copy`);
  let created: string[];
  try {
    created = await createStaging(g, pair, stagingAbs, createdParents);
  } catch (e) {
    await removeCreatedParents(g, createdParents);
    throw e;
  }
  const staging = createdStagingRoot(stagingAbs);
  let skipped = 0;
  const copied: string[] = [];
  try {
    // The copy must be complete or not happen: a source folder (the root
    // included) that cannot be read or is no longer contained fails it
    // here, before anything is published.
    const walk = walkVaultEntries(g.root, src, undefined, {
      onSkip: () => skipped++,
      onReadError: failListing,
    });
    for await (const ent of walk) {
      const target = join(stagingAbs, ent.rel.slice(src.length + 1));
      await atStep(g, "copy.entry", [join(g.root, ent.rel), target]);
      if (ent.type === "folder") {
        await stagingInterior(staging, target, () => fs.mkdir(target));
        continue;
      }
      let bytes: Uint8Array;
      try {
        ({ bytes } = await guardedRead(g.root, ent.rel));
      } catch (e) {
        // Removed while the copy ran (per-file serialization only): not copied.
        if (e instanceof DocNotFoundError) continue;
        throw e;
      }
      await stagingInterior(staging, target, () => fs.writeFile(target, bytes, { flag: "wx" }));
      copied.push(`${dst}${ent.rel.slice(src.length)}`);
    }
    await withPathLock(pathLockKey(g.root, dst), async () => {
      if ((await lstatDestination(dstAbs, dst)) !== null) throw new AlreadyExistsError(dst);
      try {
        await guarded(g, "copy.renameStaging", [stagingAbs, dstAbs], () =>
          fs.rename(stagingAbs, dstAbs),
        );
      } catch (e) {
        throw collision(e, dst, ["ENOTEMPTY", "EEXIST", "ENOTDIR"]);
      }
    });
  } catch (e) {
    // Everything in the staging folder was created by this call.
    await guarded(g, "copy.rmStaging", [stagingAbs], () =>
      fs.rm(stagingAbs, { recursive: true, force: false }),
    ).catch((rmErr) => {
      deps.logger?.warn("folder copy failed and could not remove its staging folder", {
        vault: slug,
        path: dst,
        error: rmErr instanceof Error ? rmErr.message : String(rmErr),
      });
    });
    await removeCreatedParents(g, created);
    throw e;
  } finally {
    releaseStagingRoot(staging);
  }
  const outcomes = await mapLimit(copied, REINDEX_CONCURRENCY, (p) =>
    reindexLocked(deps, slug, g.root, p),
  );
  return {
    path: src,
    destination: dst,
    type: "folder",
    overwritten: false,
    indexed: outcomes.every((o) => o.ok) && outcomes.some((o) => o.indexed),
    files: copied.length,
    skipped,
  };
}

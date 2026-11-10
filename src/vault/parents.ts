/**
 * Owned-only parent folders for a move's or copy's destination (REST API ›
 * Path operations, guarantee 3: never delete what this call did not create).
 *
 * `ensureParents` creates the destination's missing parent folders one level
 * at a time, top-down, each with a NON-recursive `mkdir` through `guarded`,
 * so every level's chain is checked immediately before its own `mkdir`. A
 * level is recorded only when THIS call's `mkdir` created it; one that
 * appeared meanwhile (`EEXIST`) and is a real directory is someone else's and
 * is not recorded, while a symlink or a file there is `invalid_path`.
 * `removeCreatedParents` undoes exactly the recorded levels, deepest first,
 * with `rmdir` only — which refuses a folder that is no longer empty, so a
 * folder an outside writer has put a file into survives. A recorded level
 * that is already gone counts as cleaned; any other refusal stops the walk,
 * leaving that level and everything above it.
 *
 * A level that vanished under `mkdir` (`ENOENT`: its parent was removed by
 * another call's cleanup) surfaces as `ParentVanishedError`, the signal the
 * callers retry on exactly once.
 */

import { promises as fs } from "node:fs";
import { dirname } from "node:path";
import { InvalidPathError } from "../errors.ts";
import { type GuardContext, guarded } from "./guarded.ts";
import { assertNotSymlinkEscape } from "./path.ts";

/** A parent of the destination was removed while this call was creating its parents. */
export class ParentVanishedError extends Error {
  // biome-ignore lint/complexity/noUselessConstructor: explicit ctor needed for Bun coverage tracking.
  constructor(message: string) {
    super(message);
  }
}

/** The errno `code` of a thrown value, if it has one. */
export function errnoOf(e: unknown): string | undefined {
  return (e as NodeJS.ErrnoException | null)?.code;
}

const NOT_A_FOLDER = "a parent of the destination is not a folder";

/**
 * Create the missing parents of `dstAbs` (`dst` is its caller-visible path,
 * for errors) and return the levels this call created, top-down. On failure
 * it removes what it created itself before rethrowing.
 */
export async function ensureParents(
  g: GuardContext,
  dstAbs: string,
  dst: string,
): Promise<string[]> {
  // The deepest existing ancestor; everything below it is missing.
  const missing: string[] = [];
  for (let level = dirname(dstAbs); level.length > g.root.length; level = dirname(level)) {
    let st: import("node:fs").Stats;
    try {
      st = await fs.lstat(level);
    } catch (e) {
      if (errnoOf(e) === "ENOENT") {
        missing.unshift(level);
        continue;
      }
      // ENOTDIR: a component above is a file.
      if (errnoOf(e) === "ENOTDIR") throw new InvalidPathError(dst, NOT_A_FOLDER);
      throw e;
    }
    if (st.isSymbolicLink() || !st.isDirectory()) throw new InvalidPathError(dst, NOT_A_FOLDER);
    break;
  }
  const created: string[] = [];
  try {
    for (const level of missing) {
      try {
        await guarded(g, "parents.mkdir", [level], () => fs.mkdir(level));
        created.push(level);
      } catch (e) {
        if (errnoOf(e) === "ENOENT") throw new ParentVanishedError(dst);
        if (errnoOf(e) !== "EEXIST") throw e;
        // Someone else created it: theirs if a real directory, never recorded.
        const st = await fs.lstat(level);
        if (st.isSymbolicLink() || !st.isDirectory()) throw new InvalidPathError(dst, NOT_A_FOLDER);
      }
    }
    // Final re-check of the whole chain the destination will be published under.
    await assertNotSymlinkEscape(dirname(dstAbs), g.root);
  } catch (e) {
    await removeCreatedParents(g, created);
    throw e;
  }
  return created;
}

/**
 * Remove the levels `ensureParents` recorded, deepest first, `rmdir` only,
 * each through `guarded`. Never throws.
 */
export async function removeCreatedParents(
  g: GuardContext,
  created: readonly string[],
): Promise<void> {
  for (const level of [...created].reverse()) {
    try {
      await guarded(g, "parents.rmdir", [level], () => fs.rmdir(level));
    } catch (e) {
      // Already gone (a concurrent delete): cleaned; carry on upward.
      if (errnoOf(e) === "ENOENT") continue;
      // Not empty, not a directory any more, a containment hit, …: stop.
      return;
    }
  }
}

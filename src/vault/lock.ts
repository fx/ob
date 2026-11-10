/**
 * Per-path mutex for the service core.
 *
 * Two concurrent `patchFile` (or `appendFile`) calls on the same path would
 * otherwise race the read-modify-write sequence: they each read the same
 * original content, both compute their next state, and the second writer
 * silently overwrites the first. The `withPathLock(key, fn)` helper
 * serialises every async section that touches the same key so the
 * read-then-write window is atomic with respect to other API calls.
 *
 * The lock is per resolved absolute path (`pathLockKey`) so different files
 * don't block each other. Cross-process correctness is NOT in scope: `ob sync`
 * runs as a sibling process and uses chokidar to reconcile, so two
 * processes writing the same file would already be a deployment-time bug.
 *
 * Implementation: a chained-promise queue keyed on the lock string. Each
 * call awaits the previous queue tail, runs `fn`, and only then resolves
 * the new tail so the next caller can proceed. Cleanup deletes the entry
 * after the last waiter finishes — important to keep the map from leaking
 * entries for files that are touched once and never again.
 */

import { resolve } from "node:path";

const queues = new Map<string, Promise<void>>();

/**
 * The one canonical lock key for a vault path: the absolute path it resolves
 * to under `root` (the root the caller's `vault(slug)` descriptor carries).
 * Every writer and every delete locks through this key, so aliases of one
 * file — `notes//x.md`, `./notes/x.md`, `notes/x.md/`, and a scoped session's
 * scope-relative path — all contend on the same lock. It only names the lock;
 * containment validation stays with `safeJoin` / `assertNotSymlinkEscape`.
 */
export function pathLockKey(root: string, rel: string): string {
  return resolve(root, rel);
}

export async function withPathLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  // `release` resolves `next`; the next caller awaits this resolution
  // before its `fn` runs.
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Queue tail = previous chain followed by our own slot. When the next
  // caller arrives it will await both the previous chain AND our slot.
  const tail = previous.then(() => next);
  queues.set(key, tail);
  try {
    await previous;
    return await fn();
  } finally {
    release();
    // Only delete the entry if we're still the tail — otherwise a later
    // queued caller has already extended the chain and owns the slot.
    if (queues.get(key) === tail) queues.delete(key);
  }
}

/**
 * Take the per-path lock for every key at once, in ONE canonical order
 * (de-duplicated, sorted), then run `fn`. Two operations that each need two
 * paths — a move `a → b` and a move `b → a`, say — therefore always queue on
 * the same first key instead of each holding the lock the other waits for.
 * A key passed twice (`a.md` and `./a.md` resolve to one) is locked once.
 */
export async function withPathLocks<T>(keys: readonly string[], fn: () => Promise<T>): Promise<T> {
  const ordered = [...new Set(keys)].sort();
  const acquire = (i: number): Promise<T> =>
    i === ordered.length ? fn() : withPathLock(ordered[i] as string, () => acquire(i + 1));
  return acquire(0);
}

/**
 * The per-vault move mutex. Every move holds it from before it takes its
 * path locks until its link-rewrite phase has ended, so each move sees the
 * tree the previous one left (a chained `a → b`, `b → c` never rewrites
 * `[[a]]` to a `b` that is already gone). Nothing else takes it and it is
 * always taken first, so it cannot deadlock with the path locks. The key
 * starts with NUL, which no resolved path can, so it never collides with a
 * path lock; it is per slug, so scoped and unscoped moves share it.
 */
export function withMoveMutex<T>(slug: string, fn: () => Promise<T>): Promise<T> {
  return withPathLock(`\0move:${slug}`, fn);
}

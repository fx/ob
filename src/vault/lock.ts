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
 * The lock is per (vault-slug, relative-path) so different files don't
 * block each other. Cross-process correctness is NOT in scope: `ob sync`
 * runs as a sibling process and uses chokidar to reconcile, so two
 * processes writing the same file would already be a deployment-time bug.
 *
 * Implementation: a chained-promise queue keyed on the lock string. Each
 * call awaits the previous queue tail, runs `fn`, and only then resolves
 * the new tail so the next caller can proceed. Cleanup deletes the entry
 * after the last waiter finishes — important to keep the map from leaking
 * entries for files that are touched once and never again.
 */

const queues = new Map<string, Promise<void>>();

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

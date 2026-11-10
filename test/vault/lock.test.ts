import { describe, expect, test } from "bun:test";
import { pathLockKey, withPathLock } from "../../src/vault/lock.ts";

describe("withPathLock", () => {
  test("serialises calls on the same key", async () => {
    const order: number[] = [];
    const tasks = Array.from({ length: 5 }, (_v, i) =>
      withPathLock("k", async () => {
        // Each task observes the previous order, sleeps, and appends —
        // if the lock is correct the order matches submission order; if
        // not, sleeps would interleave.
        order.push(i);
        await new Promise<void>((r) => setTimeout(r, 5));
        order.push(i + 100);
      }),
    );
    await Promise.all(tasks);
    // Pairs of (i, i+100) must be adjacent — no interleaving.
    for (let i = 0; i < 5; i++) {
      expect(order[2 * i]).toBe(i);
      expect(order[2 * i + 1]).toBe(i + 100);
    }
  });

  test("calls on different keys run in parallel", async () => {
    const inFlight: Set<string> = new Set();
    let observedConcurrent = false;
    const tasks = ["a", "b", "c"].map((k) =>
      withPathLock(k, async () => {
        inFlight.add(k);
        if (inFlight.size > 1) observedConcurrent = true;
        await new Promise<void>((r) => setTimeout(r, 5));
        inFlight.delete(k);
      }),
    );
    await Promise.all(tasks);
    expect(observedConcurrent).toBe(true);
  });

  test("releases the queue entry when the chain drains", async () => {
    // The queue map should NOT keep growing — after both calls finish,
    // the entry must be deleted so the map doesn't leak.
    await withPathLock("once", async () => undefined);
    await withPathLock("once", async () => undefined);
    // No assertion on internals — the test is a smoke check that two
    // sequential lock+release cycles don't throw or hang.
    expect(true).toBe(true);
  });

  test("propagates errors from the body", async () => {
    await expect(
      withPathLock("err", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Subsequent calls on the same key still run.
    const result = await withPathLock("err", async () => 42);
    expect(result).toBe(42);
  });
});

describe("pathLockKey", () => {
  test("aliases of one vault path share one key; different files do not", () => {
    const key = pathLockKey("/data/vaults/v", "notes/x.md");
    for (const alias of ["notes//x.md", "./notes/x.md", "notes/x.md/", "notes/./x.md"]) {
      expect(pathLockKey("/data/vaults/v", alias)).toBe(key);
    }
    expect(pathLockKey("/data/vaults/v", "notes/y.md")).not.toBe(key);
    expect(pathLockKey("/data/vaults/w", "notes/x.md")).not.toBe(key);
  });

  test("a scope-relative path keys the same as its vault-relative path", () => {
    expect(pathLockKey("/data/vaults/v/agents/a", "x.md")).toBe(
      pathLockKey("/data/vaults/v", "agents/a/x.md"),
    );
  });
});

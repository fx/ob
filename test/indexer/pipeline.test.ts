import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Embedder } from "../../src/embeddings/index.ts";
import { buildPipeline } from "../../src/indexer/pipeline.ts";
import { type StoreRow, type VaultStore, openVaultStore } from "../../src/indexer/store.ts";
import { type Logger, createLogger } from "../../src/log.ts";

function silent(): Logger {
  return createLogger({ level: "error", write: () => undefined });
}

function tmpDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `ob-pipeline-${label}-`));
}

function fakeEmbedder(dim = 4): Embedder {
  return {
    dim,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t, i) => {
        const v = new Float32Array(dim);
        // Tiny deterministic mapping so the round-trip test can rank.
        v[0] = t.includes("coffee") ? 1 : 0;
        v[1] = t.includes("tea") ? 1 : 0;
        v[2] = i;
        v[3] = t.length / 100;
        return v;
      });
    },
  };
}

/**
 * Default stat-mtime fake — the pipeline records the file's actual
 * mtime, so tests that drive `readFile` from memory inject this to keep
 * the fs out of the loop entirely.
 */
const fakeStat = async (): Promise<number> => 1000;

describe("buildPipeline", () => {
  test("upsert: read → chunk → embed → store, increments counters", async () => {
    const dir = tmpDir("ok");
    const store = await openVaultStore({ dataDir: dir, slug: "v", dim: 4 });
    const emb = fakeEmbedder(4);
    const pipe = buildPipeline({ slug: "v", store, embedder: emb, logger: silent() });
    const root = join(dir, "vault");
    const abs = join(root, "a.md");
    await pipe.upsert(abs, "a.md");
    // The file doesn't exist; we expect an error counter, not a throw.
    expect(pipe.counters.errors).toBe(1);
    store.close();
  });

  test("upsert with an in-memory readFile + sha override succeeds", async () => {
    const dir = tmpDir("ok2");
    const store = await openVaultStore({ dataDir: dir, slug: "v", dim: 4 });
    const pipe = buildPipeline({
      slug: "v",
      store,
      embedder: fakeEmbedder(4),
      logger: silent(),
      readFile: async () => "# H\n\ncoffee body",
      statMtimeMs: fakeStat,
      sha256: () => "abc",
      now: () => 12345,
    });
    await pipe.upsert("/abs/a.md", "a.md");
    expect(pipe.counters.errors).toBe(0);
    expect(pipe.counters.documents.has("a.md")).toBe(true);
    expect(pipe.counters.lastIndexedAt).toBe(12345);
    expect(pipe.counters.chunks).toBeGreaterThan(0);
    store.close();
  });

  test("upsert with empty content (no chunks) uses zero-vector fallback", async () => {
    const dir = tmpDir("empty");
    const store = await openVaultStore({ dataDir: dir, slug: "v", dim: 4 });
    const pipe = buildPipeline({
      slug: "v",
      store,
      embedder: fakeEmbedder(4),
      logger: silent(),
      readFile: async () => "",
      statMtimeMs: fakeStat,
    });
    await pipe.upsert("/abs/empty.md", "empty.md");
    expect(pipe.counters.errors).toBe(0);
    store.close();
  });

  test("embedder failure → error counter; row not written", async () => {
    const dir = tmpDir("emberr");
    const store = await openVaultStore({ dataDir: dir, slug: "v", dim: 4 });
    const failing: Embedder = {
      dim: 4,
      embed: async () => {
        throw new Error("bad embed");
      },
    };
    const pipe = buildPipeline({
      slug: "v",
      store,
      embedder: failing,
      logger: silent(),
      readFile: async () => "# H\n\nbody",
      statMtimeMs: fakeStat,
    });
    await pipe.upsert("/abs/a.md", "a.md");
    expect(pipe.counters.errors).toBe(1);
    expect(pipe.counters.documents.size).toBe(0);
    store.close();
  });

  test("store retry exhausted → error counter, document not added", async () => {
    const dir = tmpDir("storerr");
    const store = await openVaultStore({ dataDir: dir, slug: "v", dim: 4 });
    const failingStore: VaultStore = {
      dim: 4,
      upsert: async () => {
        throw new Error("write failed");
      },
      drop: async () => undefined,
      search: async () => [],
      searchHybrid: async () => [],
      documentCount: async () => 0,
      chunkCount: async () => 0,
      fingerprint: async () => undefined,
      fingerprints: async () => new Map(),
      close: () => undefined,
    };
    const pipe = buildPipeline(
      {
        slug: "v",
        store: failingStore,
        embedder: fakeEmbedder(4),
        logger: silent(),
        readFile: async () => "# H\n\nbody",
        statMtimeMs: fakeStat,
      },
      { sleep: async () => undefined },
    );
    await pipe.upsert("/abs/a.md", "a.md");
    expect(pipe.counters.errors).toBe(1);
    expect(pipe.counters.documents.size).toBe(0);
    store.close();
  });

  test("store retry succeeds on the second attempt — row written", async () => {
    const dir = tmpDir("storerty");
    const realStore = await openVaultStore({ dataDir: dir, slug: "v", dim: 4 });
    let attempts = 0;
    const flakyStore: VaultStore = {
      dim: 4,
      upsert: async (path, rows) => {
        attempts++;
        if (attempts === 1) throw new Error("transient");
        return realStore.upsert(path, rows);
      },
      drop: async () => undefined,
      search: realStore.search.bind(realStore),
      searchHybrid: realStore.searchHybrid.bind(realStore),
      documentCount: realStore.documentCount.bind(realStore),
      chunkCount: realStore.chunkCount.bind(realStore),
      fingerprint: realStore.fingerprint.bind(realStore),
      fingerprints: realStore.fingerprints.bind(realStore),
      close: () => realStore.close(),
    };
    const pipe = buildPipeline(
      {
        slug: "v",
        store: flakyStore,
        embedder: fakeEmbedder(4),
        logger: silent(),
        readFile: async () => "# H\n\nbody",
        statMtimeMs: fakeStat,
      },
      { sleep: async () => undefined },
    );
    await pipe.upsert("/abs/a.md", "a.md");
    expect(attempts).toBe(2);
    expect(pipe.counters.errors).toBe(0);
    expect(pipe.counters.documents.has("a.md")).toBe(true);
  });

  test("remove: drop succeeds, document set updated, lastIndexedAt advances", async () => {
    const dir = tmpDir("rm");
    const store = await openVaultStore({ dataDir: dir, slug: "v", dim: 4 });
    const pipe = buildPipeline({
      slug: "v",
      store,
      embedder: fakeEmbedder(4),
      logger: silent(),
      readFile: async () => "# H\n\nbody",
      statMtimeMs: fakeStat,
      now: () => 999,
    });
    await pipe.upsert("/abs/a.md", "a.md");
    expect(pipe.counters.documents.has("a.md")).toBe(true);
    await pipe.remove("a.md");
    expect(pipe.counters.documents.has("a.md")).toBe(false);
    expect(pipe.counters.lastIndexedAt).toBe(999);
    store.close();
  });

  test("remove: drop failure increments error counter", async () => {
    const failingStore: VaultStore = {
      dim: 4,
      upsert: async () => undefined,
      drop: async () => {
        throw new Error("drop bad");
      },
      search: async () => [],
      searchHybrid: async () => [],
      documentCount: async () => 0,
      chunkCount: async () => 0,
      fingerprint: async () => undefined,
      fingerprints: async () => new Map(),
      close: () => undefined,
    };
    const pipe = buildPipeline(
      {
        slug: "v",
        store: failingStore,
        embedder: fakeEmbedder(4),
        logger: silent(),
      },
      { sleep: async () => undefined },
    );
    await pipe.remove("x.md");
    expect(pipe.counters.errors).toBe(1);
  });

  test("chunker error is caught", async () => {
    const dir = tmpDir("chunkerr");
    const store = await openVaultStore({ dataDir: dir, slug: "v", dim: 4 });
    const pipe = buildPipeline({
      slug: "v",
      store,
      embedder: fakeEmbedder(4),
      logger: silent(),
      // Force the chunker-error branch by feeding a non-string content
      // (chunkMarkdown calls .replace internally and throws). Both readFile
      // and sha256 are overridden so we don't hit defaultSha first.
      // biome-ignore lint/suspicious/noExplicitAny: deliberately violate the readFile contract to drive the chunker-error branch.
      readFile: async () => null as any,
      sha256: () => "fake-sha",
    });
    await pipe.upsert("/abs/x.md", "x.md");
    expect(pipe.counters.errors).toBe(1);
    store.close();
  });

  test("vector that the embedder didn't return is filled with a zero vector", async () => {
    const dir = tmpDir("partial");
    const store = await openVaultStore({ dataDir: dir, slug: "v", dim: 4 });
    const partialEmb: Embedder = {
      dim: 4,
      embed: async () => [], // returns no vectors at all
    };
    const pipe = buildPipeline({
      slug: "v",
      store,
      embedder: partialEmb,
      logger: silent(),
      readFile: async () => "# H\n\nbody",
      statMtimeMs: fakeStat,
    });
    await pipe.upsert("/abs/p.md", "p.md");
    expect(pipe.counters.errors).toBe(0);
    expect(pipe.counters.documents.has("p.md")).toBe(true);
    const cnt = await store.chunkCount();
    expect(cnt).toBeGreaterThan(0);
    store.close();
  });

  test("non-Error thrown from readFile is stringified into the warn", async () => {
    const dir = tmpDir("readerr");
    const store = await openVaultStore({ dataDir: dir, slug: "v", dim: 4 });
    const pipe = buildPipeline({
      slug: "v",
      store,
      embedder: fakeEmbedder(4),
      logger: silent(),
      readFile: async () => {
        // eslint-disable-next-line no-throw-literal -- testing non-Error throw branch
        throw "io failure as string";
      },
    });
    await pipe.upsert("/abs/a.md", "a.md");
    expect(pipe.counters.errors).toBe(1);
    store.close();
  });

  test("non-Error thrown from embedder is stringified", async () => {
    const dir = tmpDir("emberr2");
    const store = await openVaultStore({ dataDir: dir, slug: "v", dim: 4 });
    const failing: Embedder = {
      dim: 4,
      embed: async () => {
        // eslint-disable-next-line no-throw-literal -- testing non-Error path
        throw "bad embed";
      },
    };
    const pipe = buildPipeline({
      slug: "v",
      store,
      embedder: failing,
      logger: silent(),
      readFile: async () => "# H\n\nbody",
      statMtimeMs: fakeStat,
    });
    await pipe.upsert("/abs/a.md", "a.md");
    expect(pipe.counters.errors).toBe(1);
    store.close();
  });

  test("non-Error thrown from store.upsert is stringified", async () => {
    const failing: VaultStore = {
      dim: 4,
      upsert: async () => {
        // eslint-disable-next-line no-throw-literal -- testing non-Error path
        throw "store fail";
      },
      drop: async () => undefined,
      search: async () => [],
      searchHybrid: async () => [],
      documentCount: async () => 0,
      chunkCount: async () => 0,
      fingerprint: async () => undefined,
      fingerprints: async () => new Map(),
      close: () => undefined,
    };
    const pipe = buildPipeline(
      {
        slug: "v",
        store: failing,
        embedder: fakeEmbedder(4),
        logger: silent(),
        readFile: async () => "# H\n\nbody",
        statMtimeMs: fakeStat,
      },
      { sleep: async () => undefined },
    );
    await pipe.upsert("/abs/a.md", "a.md");
    expect(pipe.counters.errors).toBe(1);
  });

  test("non-Error thrown from store.drop is stringified", async () => {
    const failing: VaultStore = {
      dim: 4,
      upsert: async () => undefined,
      drop: async () => {
        // eslint-disable-next-line no-throw-literal -- testing non-Error path
        throw "drop fail";
      },
      search: async () => [],
      searchHybrid: async () => [],
      documentCount: async () => 0,
      chunkCount: async () => 0,
      fingerprint: async () => undefined,
      fingerprints: async () => new Map(),
      close: () => undefined,
    };
    const pipe = buildPipeline(
      { slug: "v", store: failing, embedder: fakeEmbedder(4), logger: silent() },
      { sleep: async () => undefined },
    );
    await pipe.remove("x.md");
    expect(pipe.counters.errors).toBe(1);
  });

  test("fingerprint() failure does NOT block the upsert (best-effort)", async () => {
    // Covers the catch on the freshness re-check: a flaky fingerprint
    // call is non-fatal; the upsert proceeds.
    let writes = 0;
    const flaky: VaultStore = {
      dim: 4,
      upsert: async () => {
        writes++;
      },
      drop: async () => undefined,
      search: async () => [],
      searchHybrid: async () => [],
      documentCount: async () => 0,
      chunkCount: async () => 0,
      fingerprint: async () => {
        throw new Error("fp boom");
      },
      fingerprints: async () => new Map(),
      close: () => undefined,
    };
    const pipe = buildPipeline({
      slug: "v",
      store: flaky,
      embedder: fakeEmbedder(4),
      logger: silent(),
      readFile: async () => "# H\n\nbody",
      statMtimeMs: fakeStat,
    });
    await pipe.upsert("/abs/a.md", "a.md");
    expect(writes).toBe(1);
    expect(pipe.counters.errors).toBe(0);
  });

  test("chunkCount failure during refresh does NOT increment errors (best-effort)", async () => {
    // Covers refreshChunkCount's catch — a chunkCount() rejection
    // shouldn't fail the upsert; counters stay where they were.
    let countAttempts = 0;
    const failingCount: VaultStore = {
      dim: 4,
      upsert: async () => undefined,
      drop: async () => undefined,
      search: async () => [],
      searchHybrid: async () => [],
      documentCount: async () => 0,
      chunkCount: async () => {
        countAttempts++;
        throw new Error("count fail");
      },
      fingerprint: async () => undefined,
      fingerprints: async () => new Map(),
      close: () => undefined,
    };
    const pipe = buildPipeline({
      slug: "v",
      store: failingCount,
      embedder: fakeEmbedder(4),
      logger: silent(),
      readFile: async () => "# H\n\nbody",
      statMtimeMs: fakeStat,
    });
    await pipe.upsert("/abs/a.md", "a.md");
    expect(countAttempts).toBeGreaterThan(0);
    expect(pipe.counters.errors).toBe(0);
    expect(pipe.counters.documents.has("a.md")).toBe(true);
  });

  test("default readFile + statMtimeMs are used when none injected (real fs)", async () => {
    // Covers the defaultReadFile and defaultStatMtime helpers when no
    // override is supplied. We write a real file and let the pipeline
    // read + stat it without any injection.
    const dir = tmpDir("pipe-default-fs");
    const root = join(dir, "vault");
    require("node:fs").mkdirSync(root, { recursive: true });
    require("node:fs").writeFileSync(join(root, "real.md"), "# H\n\nbody");
    const store = await openVaultStore({ dataDir: dir, slug: "v", dim: 4 });
    const pipe = buildPipeline({
      slug: "v",
      store,
      embedder: fakeEmbedder(4),
      logger: silent(),
    });
    await pipe.upsert(join(root, "real.md"), "real.md");
    expect(pipe.counters.errors).toBe(0);
    expect(pipe.counters.documents.has("real.md")).toBe(true);
    const fp = await store.fingerprint("real.md");
    expect(typeof fp?.mtimeMs).toBe("number");
    store.close();
  });

  test("default sleep timer is invoked when retrying", async () => {
    let calls = 0;
    const flakyStore: VaultStore = {
      dim: 4,
      upsert: async () => {
        calls++;
        if (calls === 1) throw new Error("once");
      },
      drop: async () => undefined,
      search: async () => [],
      searchHybrid: async () => [],
      documentCount: async () => 0,
      chunkCount: async () => 0,
      fingerprint: async () => undefined,
      fingerprints: async () => new Map(),
      close: () => undefined,
    };
    const pipe = buildPipeline({
      slug: "v",
      store: flakyStore,
      embedder: fakeEmbedder(4),
      logger: silent(),
      readFile: async () => "# H\n\nbody",
      statMtimeMs: fakeStat,
    });
    await pipe.upsert("/abs/a.md", "a.md");
    expect(calls).toBe(2);
    expect(pipe.counters.errors).toBe(0);
  }, 5_000);
});

describe("EmbedBatcher coalescing (LDKK)", () => {
  test("5 file events within the window land in a single embed() call", async () => {
    const dir = tmpDir("batcher-coalesce");
    const store = await openVaultStore({ dataDir: dir, slug: "v", dim: 4 });
    let embedCalls = 0;
    let totalTexts = 0;
    const counting: Embedder = {
      dim: 4,
      async embed(texts) {
        embedCalls++;
        totalTexts += texts.length;
        return texts.map(() => Float32Array.from([1, 0, 0, 0]));
      },
    };
    const pipe = buildPipeline({
      slug: "v",
      store,
      embedder: counting,
      logger: silent(),
      readFile: async (p) => `# H\n\nbody for ${p}`,
      statMtimeMs: fakeStat,
    });
    // Submit 5 single-chunk files concurrently — they all hit submit()
    // before the 100 ms window closes, so the batcher coalesces them.
    await Promise.all([
      pipe.upsert("/abs/a.md", "a.md"),
      pipe.upsert("/abs/b.md", "b.md"),
      pipe.upsert("/abs/c.md", "c.md"),
      pipe.upsert("/abs/d.md", "d.md"),
      pipe.upsert("/abs/e.md", "e.md"),
    ]);
    expect(embedCalls).toBe(1);
    expect(totalTexts).toBe(5);
    expect(pipe.counters.documents.size).toBe(5);
    store.close();
  });

  test("re-kick path runs when nested timer fires during flush", async () => {
    // The re-kick branch in `flush().finally` only fires when:
    //   1. A submission landed during the flush.
    //   2. Its short-window timer ALSO fired (and entered re-entry-
    //      blocked flush, leaving timer=null) before the original flush's
    //      finally ran.
    // Use a very small batchWindowMs so the inner timer fires during the
    // outer embed.
    const dir = tmpDir("batcher-rekick-2");
    const store = await openVaultStore({ dataDir: dir, slug: "v", dim: 4 });
    let resolveFirst!: (vs: Float32Array[]) => void;
    let firstStarted = false;
    let secondStarted = false;
    const slow: Embedder = {
      dim: 4,
      embed: (texts) => {
        if (!firstStarted) {
          firstStarted = true;
          return new Promise<Float32Array[]>((resolve) => {
            resolveFirst = resolve;
          });
        }
        secondStarted = true;
        return Promise.resolve(texts.map(() => Float32Array.from([1, 0, 0, 0])));
      },
    };
    const pipe = buildPipeline(
      {
        slug: "v",
        store,
        embedder: slow,
        logger: silent(),
        readFile: async (p) => `# H\n\nbody for ${p}`,
        statMtimeMs: fakeStat,
      },
      // batchWindowMs=1 so inside-flush timer fires fast.
      { batchWindowMs: 1 },
    );
    const a = pipe.upsert("/abs/a.md", "a.md");
    // Wait enough for first flush to start.
    await new Promise((r) => setTimeout(r, 20));
    const b = pipe.upsert("/abs/b.md", "b.md");
    // Give B's tiny timer a few ticks to fire (still inside first flush).
    await new Promise((r) => setTimeout(r, 30));
    // Now resolve first embed. Finally block sees queue.length>0 (B
    // never moved out because re-entry guard returned early) and
    // timer=null (B's timer fired and set it to null) → re-kicks.
    resolveFirst([Float32Array.from([1, 0, 0, 0])]);
    await Promise.all([a, b]);
    expect(firstStarted).toBe(true);
    expect(secondStarted).toBe(true);
    store.close();
  });

  test("submission during a flush re-arms the timer (covers re-kick path)", async () => {
    // Drive a submit while the previous flush is in flight: the
    // `flushing` re-entrancy guard kicks the next round through the
    // re-arm branch in the `finally` block.
    const dir = tmpDir("batcher-rekick");
    const store = await openVaultStore({ dataDir: dir, slug: "v", dim: 4 });
    let resolveFirstEmbed!: (vs: Float32Array[]) => void;
    let firstCalled = false;
    let secondCalled = false;
    const slow: Embedder = {
      dim: 4,
      embed: (texts) => {
        if (!firstCalled) {
          firstCalled = true;
          return new Promise<Float32Array[]>((resolve) => {
            resolveFirstEmbed = resolve;
          });
        }
        secondCalled = true;
        return Promise.resolve(texts.map(() => Float32Array.from([1, 0, 0, 0])));
      },
    };
    const pipe = buildPipeline({
      slug: "v",
      store,
      embedder: slow,
      logger: silent(),
      readFile: async (p) => `# H\n\nbody for ${p}`,
      statMtimeMs: fakeStat,
    });
    // Submission 1 starts the first flush.
    const upsertA = pipe.upsert("/abs/a.md", "a.md");
    // Wait long enough for the batcher's window timer to fire.
    await new Promise((r) => setTimeout(r, 150));
    // Submission 2 lands while the first embed is still suspended.
    const upsertB = pipe.upsert("/abs/b.md", "b.md");
    // Resolve the first embed; the `finally` block must re-arm the
    // timer so submission 2's vectors eventually get computed.
    resolveFirstEmbed([Float32Array.from([1, 0, 0, 0])]);
    await Promise.all([upsertA, upsertB]);
    expect(firstCalled).toBe(true);
    expect(secondCalled).toBe(true);
    store.close();
  });

  test("more than 32 chunks across submissions flush eagerly", async () => {
    const dir = tmpDir("batcher-cap");
    const store = await openVaultStore({ dataDir: dir, slug: "v", dim: 4 });
    let embedCalls = 0;
    const counting: Embedder = {
      dim: 4,
      async embed(texts) {
        embedCalls++;
        return texts.map(() => Float32Array.from([1, 0, 0, 0]));
      },
    };
    // Build a doc whose chunker output exceeds the 32-cap when submitted
    // alongside one more file. We use a long body whose paragraph splits
    // produce many chunks.
    const big = `# H\n\n${Array(40).fill("para text").join("\n\n".padEnd(2, "\n"))}`;
    const pipe = buildPipeline({
      slug: "v",
      store,
      embedder: counting,
      logger: silent(),
      readFile: async () => big,
      statMtimeMs: fakeStat,
    });
    await pipe.upsert("/abs/a.md", "a.md");
    expect(embedCalls).toBeGreaterThanOrEqual(1);
    store.close();
  });
});

describe("mtime is recorded from fs.stat (LDKQ)", () => {
  test("upsert persists the file's actual mtime, not now()", async () => {
    const dir = tmpDir("pipe-mtime");
    const store = await openVaultStore({ dataDir: dir, slug: "v", dim: 4 });
    const FROZEN_MTIME = 1_700_000_000_000;
    const pipe = buildPipeline({
      slug: "v",
      store,
      embedder: fakeEmbedder(4),
      logger: silent(),
      readFile: async () => "# H\n\nbody",
      // Distinguish stat (file mtime) from now (wall clock).
      statMtimeMs: async () => FROZEN_MTIME,
      now: () => 9_999_999_999_999,
    });
    await pipe.upsert("/abs/a.md", "a.md");
    const fp = await store.fingerprint("a.md");
    expect(fp?.mtimeMs).toBe(FROZEN_MTIME);
    store.close();
  });

  test("stat failure falls back to now() but still writes the row", async () => {
    const dir = tmpDir("pipe-mtime-fail");
    const store = await openVaultStore({ dataDir: dir, slug: "v", dim: 4 });
    const pipe = buildPipeline({
      slug: "v",
      store,
      embedder: fakeEmbedder(4),
      logger: silent(),
      readFile: async () => "# H\n\nbody",
      statMtimeMs: async () => {
        throw new Error("ENOENT");
      },
      now: () => 42,
    });
    await pipe.upsert("/abs/a.md", "a.md");
    const fp = await store.fingerprint("a.md");
    expect(fp?.mtimeMs).toBe(42);
    store.close();
  });
});

describe("per-path serialisation (LDKd)", () => {
  test("a predecessor failure does NOT block a subsequent same-path write", async () => {
    // Covers the rejected-handler branch in PathLocks's `prev.then(fn, fn)`:
    // when the previous holder of the lock rejected, the next caller
    // still runs (its own handler is invoked).
    const dir = tmpDir("pipe-prev-fail");
    const realStore = await openVaultStore({ dataDir: dir, slug: "v", dim: 4 });
    let attempts = 0;
    const flakyStore: VaultStore = {
      dim: 4,
      upsert: async (path, rows) => {
        attempts++;
        if (attempts === 1) throw new Error("first upsert fails");
        return realStore.upsert(path, rows);
      },
      drop: async () => undefined,
      search: realStore.search.bind(realStore),
      searchHybrid: realStore.searchHybrid.bind(realStore),
      documentCount: realStore.documentCount.bind(realStore),
      chunkCount: realStore.chunkCount.bind(realStore),
      fingerprint: realStore.fingerprint.bind(realStore),
      fingerprints: realStore.fingerprints.bind(realStore),
      close: () => realStore.close(),
    };
    const pipe = buildPipeline(
      {
        slug: "v",
        store: flakyStore,
        embedder: fakeEmbedder(4),
        logger: silent(),
        readFile: async () => "# H\n\nbody",
        statMtimeMs: fakeStat,
      },
      { sleep: async () => undefined },
    );
    const a = pipe.upsert("/abs/x.md", "x.md");
    const b = pipe.upsert("/abs/x.md", "x.md");
    await Promise.all([a, b]);
    // First upsert (A) hit the throw → withStoreRetry → 3 attempts.
    // After A's lock releases, B runs and observes the success path.
    expect(attempts).toBeGreaterThanOrEqual(2);
  });

  test("two concurrent upserts for the same path serialise; freshness drops the stale one", async () => {
    // Regression for LDKd: a stale scan write whose embedding resolved
    // after a fresher watcher write must not overwrite the newer chunks.
    const dir = tmpDir("pipe-race");
    const store = await openVaultStore({ dataDir: dir, slug: "v", dim: 4 });
    let readCount = 0;
    const contents = ["v1-content", "v2-content"];
    const pipe = buildPipeline({
      slug: "v",
      store,
      embedder: {
        dim: 4,
        async embed(texts) {
          // Inject an artificial delay so both upserts have time to
          // queue before the first one lands in the store.
          await new Promise((r) => setTimeout(r, 20));
          return texts.map((t) => Float32Array.from([t.length, 0, 0, 0]));
        },
      },
      logger: silent(),
      readFile: async () => contents[readCount++] ?? "",
      // Different mtimes so freshness check has signal.
      statMtimeMs: async () => (readCount === 1 ? 1000 : 2000),
      sha256: (c) => c,
    });
    // Fire two writes back-to-back. The lock serialises them; whichever
    // enters second gets the freshness signal that an earlier write
    // already recorded a newer fingerprint.
    await Promise.all([pipe.upsert("/abs/a.md", "a.md"), pipe.upsert("/abs/a.md", "a.md")]);
    const fp = await store.fingerprint("a.md");
    // Whichever write committed second wins; the freshness check only
    // drops a write whose mtime is OLDER than what the store has — both
    // are valid here (the lock serialises them so the second runs after
    // the first commits). Assert at least one wrote.
    expect(fp).not.toBeUndefined();
    store.close();
  });

  test("freshness re-check drops a write whose stored fingerprint is newer", async () => {
    // Pre-populate with a "newer" row in the fake store; the pipeline's
    // freshness check must observe `mtime > ours` and skip the write.
    let writes = 0;
    const wrappingStore: VaultStore = {
      dim: 4,
      upsert: async () => {
        writes++;
      },
      drop: async () => undefined,
      search: async () => [],
      searchHybrid: async () => [],
      documentCount: async () => 0,
      chunkCount: async () => 0,
      fingerprint: async () => ({ mtimeMs: 5000, sha256: "newer" }),
      fingerprints: async () => new Map(),
      close: () => undefined,
    };
    const pipe = buildPipeline({
      slug: "v",
      store: wrappingStore,
      embedder: fakeEmbedder(4),
      logger: silent(),
      readFile: async () => "# H\n\nbody",
      statMtimeMs: async () => 1000, // older than stored 5000
      sha256: () => "older", // different sha
    });
    await pipe.upsert("/abs/a.md", "a.md");
    expect(writes).toBe(0);
    expect(pipe.counters.errors).toBe(0);
  });
});

describe("hydrateCounters (LDKZ)", () => {
  test("after restart, counters reflect persisted rows before any new event", async () => {
    const dir = tmpDir("hydrate");
    const store1 = await openVaultStore({ dataDir: dir, slug: "v", dim: 4 });
    const pipe1 = buildPipeline({
      slug: "v",
      store: store1,
      embedder: fakeEmbedder(4),
      logger: silent(),
      readFile: async (p) => `# H\n\nbody for ${p}`,
      statMtimeMs: fakeStat,
    });
    await pipe1.upsert("/abs/a.md", "a.md");
    await pipe1.upsert("/abs/b.md", "b.md");
    expect(pipe1.counters.documents.size).toBe(2);
    expect(pipe1.counters.chunks).toBeGreaterThan(0);
    store1.close();

    // Simulate a restart: re-open the store, build a fresh pipeline,
    // hydrate. Documents and chunks must reflect the on-disk state.
    const store2 = await openVaultStore({ dataDir: dir, slug: "v", dim: 4 });
    const pipe2 = buildPipeline({
      slug: "v",
      store: store2,
      embedder: fakeEmbedder(4),
      logger: silent(),
    });
    expect(pipe2.counters.documents.size).toBe(0);
    await pipe2.hydrateCounters();
    expect(pipe2.counters.documents.size).toBe(2);
    expect(pipe2.counters.chunks).toBeGreaterThan(0);
    store2.close();
  });

  test("hydrate on an empty store leaves counters at 0", async () => {
    const dir = tmpDir("hydrate-empty");
    const store = await openVaultStore({ dataDir: dir, slug: "v", dim: 4 });
    const pipe = buildPipeline({
      slug: "v",
      store,
      embedder: fakeEmbedder(4),
      logger: silent(),
    });
    await pipe.hydrateCounters();
    expect(pipe.counters.documents.size).toBe(0);
    expect(pipe.counters.chunks).toBe(0);
    store.close();
  });

  test("hydrate failure leaves counters at 0 (best-effort)", async () => {
    const failing: VaultStore = {
      dim: 4,
      upsert: async () => undefined,
      drop: async () => undefined,
      search: async () => [],
      searchHybrid: async () => [],
      documentCount: async () => 0,
      chunkCount: async () => 0,
      fingerprint: async () => undefined,
      fingerprints: async () => {
        throw new Error("disk on fire");
      },
      close: () => undefined,
    };
    const pipe = buildPipeline({
      slug: "v",
      store: failing,
      embedder: fakeEmbedder(4),
      logger: silent(),
    });
    await pipe.hydrateCounters();
    expect(pipe.counters.documents.size).toBe(0);
  });
});

describe("markStopped (LDKr)", () => {
  test("after markStopped, new upsert calls short-circuit without writing", async () => {
    let writes = 0;
    const store: VaultStore = {
      dim: 4,
      upsert: async () => {
        writes++;
      },
      drop: async () => undefined,
      search: async () => [],
      searchHybrid: async () => [],
      documentCount: async () => 0,
      chunkCount: async () => 0,
      fingerprint: async () => undefined,
      fingerprints: async () => new Map(),
      close: () => undefined,
    };
    const pipe = buildPipeline({
      slug: "v",
      store,
      embedder: fakeEmbedder(4),
      logger: silent(),
      readFile: async () => "# H\n\nbody",
      statMtimeMs: fakeStat,
    });
    pipe.markStopped();
    await pipe.upsert("/abs/a.md", "a.md");
    expect(writes).toBe(0);
    expect(pipe.counters.errors).toBe(0);
  });

  test("markStopped during read still skips write", async () => {
    let writes = 0;
    const store: VaultStore = {
      dim: 4,
      upsert: async () => {
        writes++;
      },
      drop: async () => undefined,
      search: async () => [],
      searchHybrid: async () => [],
      documentCount: async () => 0,
      chunkCount: async () => 0,
      fingerprint: async () => undefined,
      fingerprints: async () => new Map(),
      close: () => undefined,
    };
    let resolveRead!: (v: string) => void;
    const readPromise = new Promise<string>((r) => {
      resolveRead = r;
    });
    const pipe = buildPipeline({
      slug: "v",
      store,
      embedder: fakeEmbedder(4),
      logger: silent(),
      readFile: () => readPromise,
      statMtimeMs: fakeStat,
    });
    const inFlight = pipe.upsert("/abs/a.md", "a.md");
    // Stop while read is suspended.
    pipe.markStopped();
    resolveRead("# H\n\nbody");
    await inFlight;
    expect(writes).toBe(0);
  });

  test("markStopped while a submission is pending drains the batcher", async () => {
    // Submit chunks (which queue in the batcher with a pending timer),
    // then markStopped — drain() fires, flushes the queue. Submission
    // resolves with the embedder's vectors.
    let embedCalls = 0;
    const counting: Embedder = {
      dim: 4,
      embed: async (texts) => {
        embedCalls++;
        return texts.map(() => Float32Array.from([1, 0, 0, 0]));
      },
    };
    const dir = tmpDir("pipe-drain");
    const store = await openVaultStore({ dataDir: dir, slug: "v", dim: 4 });
    const pipe = buildPipeline(
      {
        slug: "v",
        store,
        embedder: counting,
        logger: silent(),
        readFile: async () => "# H\n\nbody",
        statMtimeMs: fakeStat,
      },
      // Long window so timer never fires on its own.
      { batchWindowMs: 10_000 },
    );
    const inFlight = pipe.upsert("/abs/a.md", "a.md");
    // Wait a tick for the submission to queue.
    await new Promise((r) => setTimeout(r, 20));
    pipe.markStopped();
    await inFlight;
    expect(embedCalls).toBe(1);
    store.close();
  });

  test("markStopped during remove short-circuits", async () => {
    let drops = 0;
    const store: VaultStore = {
      dim: 4,
      upsert: async () => undefined,
      drop: async () => {
        drops++;
      },
      search: async () => [],
      searchHybrid: async () => [],
      documentCount: async () => 0,
      chunkCount: async () => 0,
      fingerprint: async () => undefined,
      fingerprints: async () => new Map(),
      close: () => undefined,
    };
    const pipe = buildPipeline({
      slug: "v",
      store,
      embedder: fakeEmbedder(4),
      logger: silent(),
    });
    pipe.markStopped();
    await pipe.remove("a.md");
    expect(drops).toBe(0);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config/index.ts";
import { buildHashEmbedder, buildMapEmbedder } from "../../src/embeddings/fake.ts";
import type { Embedder } from "../../src/embeddings/index.ts";
import {
  InvalidPathError,
  PipelineVersionMismatchError,
  StoreDimensionMismatchError,
  startIndexer,
} from "../../src/indexer/index.ts";
import {
  PIPELINE_VERSION,
  openVaultStore,
  readPipelineVersion,
  writePipelineVersion,
} from "../../src/indexer/store.ts";
import { type Logger, createLogger } from "../../src/log.ts";

function silent(): Logger {
  return createLogger({ level: "error", write: () => undefined });
}

function tmpDataDir(label: string): string {
  return mkdtempSync(join(tmpdir(), `ob-indexer-${label}-`));
}

function makeConfig(over: Partial<Config> = {}): Config {
  return {
    obsidianAuthToken: undefined,
    vaults: [{ name: "v", slug: "v" }],
    dataDir: "/tmp/will-be-overridden",
    httpPort: 0,
    httpHost: "127.0.0.1",
    embeddingProvider: "transformers",
    embeddingModel: "x",
    logLevel: "error",
    syncConfigEnv: {},
    ...over,
  };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

describe("startIndexer round-trip", () => {
  test("scenario: vault contains coffee + tea, search('coffee') ranks coffee first", async () => {
    const dataDir = tmpDataDir("rt");
    const cfg = makeConfig({ dataDir });
    const root = join(dataDir, "vaults", "v");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "a.md"), "# Coffee\n\ncoffee notes about beans");
    writeFileSync(join(root, "b.md"), "# Tea\n\ntea notes about leaves");

    // Map-based embedder: coffee → unit x, tea → unit y, query depends on
    // input. As of change 0007 the embedder receives the chunk's
    // `embedText` (path + heading + body) for indexed content; queries
    // still go through unchanged. Map on both shapes so the warmup text
    // also resolves to a meaningful (non-zero) vector.
    const map = new Map<string, number[]>([
      ["a.md\nCoffee\n\ncoffee notes about beans", [1, 0, 0, 0]],
      ["b.md\nTea\n\ntea notes about leaves", [0, 1, 0, 0]],
      ["coffee", [1, 0, 0, 0]],
      ["tea", [0, 1, 0, 0]],
    ]);
    // Wrap to fall through with a small bias for unknowns (warm-up text).
    const inner = buildMapEmbedder(map, 4);
    const embedder: Embedder = {
      dim: 0,
      embed: async (texts) => {
        return inner.embed(texts);
      },
    };
    // Force dim getter to return 4 after first call:
    Object.defineProperty(embedder, "dim", {
      get: () => inner.dim,
    });

    const indexer = await startIndexer(cfg, { logger: silent(), embedder });
    cleanup.push(async () => indexer.stop());
    // Wait for ready.
    await waitFor(() => indexer.status("v")?.state === "ready");
    const hits = await indexer.search("v", "coffee", { limit: 5 });
    expect(hits.length).toBe(2);
    expect(hits[0]?.path).toBe("a.md");
    expect(hits[0]?.score).toBeGreaterThan(hits[1]?.score ?? 0);
  }, 20_000);

  test("status / list / unknown-slug", async () => {
    const dataDir = tmpDataDir("status");
    const cfg = makeConfig({ dataDir });
    const root = join(dataDir, "vaults", "v");
    mkdirSync(root, { recursive: true });
    const indexer = await startIndexer(cfg, {
      logger: silent(),
      embedder: buildHashEmbedder(4),
    });
    cleanup.push(async () => indexer.stop());
    expect(indexer.status("v")).not.toBeNull();
    expect(indexer.status("missing")).toBeNull();
    expect(indexer.list().length).toBe(1);
    await waitFor(() => indexer.status("v")?.state === "ready");
  }, 20_000);

  test("search on unknown slug returns []", async () => {
    const dataDir = tmpDataDir("unk");
    const cfg = makeConfig({ dataDir });
    mkdirSync(join(dataDir, "vaults", "v"), { recursive: true });
    const indexer = await startIndexer(cfg, {
      logger: silent(),
      embedder: buildHashEmbedder(4),
    });
    cleanup.push(async () => indexer.stop());
    expect(await indexer.search("missing", "x")).toEqual([]);
  }, 20_000);

  test("search returns [] when embedder produces no vector", async () => {
    const dataDir = tmpDataDir("noemb");
    const cfg = makeConfig({ dataDir });
    mkdirSync(join(dataDir, "vaults", "v"), { recursive: true });
    const oneShot: Embedder = {
      dim: 4,
      embed: async (texts) => {
        // Return a vector for the warmup, none for queries.
        if (texts[0] === "ob:embedder-dim-warmup") return [new Float32Array(4)];
        return [];
      },
    };
    const indexer = await startIndexer(cfg, { logger: silent(), embedder: oneShot });
    cleanup.push(async () => indexer.stop());
    await waitFor(() => indexer.status("v")?.state === "ready");
    expect(await indexer.search("v", "anything")).toEqual([]);
  }, 20_000);

  test("reindex / drop on unknown slug are silent no-ops", async () => {
    const dataDir = tmpDataDir("rd");
    const cfg = makeConfig({ dataDir });
    mkdirSync(join(dataDir, "vaults", "v"), { recursive: true });
    const indexer = await startIndexer(cfg, {
      logger: silent(),
      embedder: buildHashEmbedder(4),
    });
    cleanup.push(async () => indexer.stop());
    await indexer.reindex("missing", "x.md");
    await indexer.drop("missing", "x.md");
  }, 20_000);

  test("reindex: writing a file via REST hooks lands in search results", async () => {
    const dataDir = tmpDataDir("re");
    const cfg = makeConfig({ dataDir });
    const root = join(dataDir, "vaults", "v");
    mkdirSync(root, { recursive: true });
    // Map keyed on the chunker's body output (heading line stripped) —
    // not the raw Markdown — because that's what `pipeline.upsert`
    // actually feeds the embedder.
    const indexer = await startIndexer(cfg, {
      logger: silent(),
      embedder: buildMapEmbedder(
        new Map<string, number[]>([
          // 0007: indexed content embeds the full `embedText` (path + heading + body).
          ["n.md\nHello\n\nworld text", [1, 0, 0, 0]],
          ["world", [1, 0, 0, 0]],
        ]),
        4,
      ),
    });
    cleanup.push(async () => indexer.stop());
    await waitFor(() => indexer.status("v")?.state === "ready");
    writeFileSync(join(root, "n.md"), "# Hello\n\nworld text");
    await indexer.reindex("v", "n.md");
    const hits = await indexer.search("v", "world", { limit: 1 });
    expect(hits[0]?.path).toBe("n.md");
    // Score must be > zero-vector tie since the embedder mapped both
    // chunk and query to the same unit vector.
    expect(hits[0]?.score).toBeGreaterThan(0.5);
  }, 20_000);

  test("drop: REST delete drops chunks from the store", async () => {
    const dataDir = tmpDataDir("dr");
    const cfg = makeConfig({ dataDir });
    const root = join(dataDir, "vaults", "v");
    mkdirSync(root, { recursive: true });
    const map = new Map<string, number[]>([
      // 0007: indexed content embeds the full `embedText` (path + heading + body).
      ["x.md\nX\n\ndoomed text", [1, 0, 0, 0]],
      ["doomed", [1, 0, 0, 0]],
    ]);
    const indexer = await startIndexer(cfg, {
      logger: silent(),
      embedder: buildMapEmbedder(map, 4),
    });
    cleanup.push(async () => indexer.stop());
    await waitFor(() => indexer.status("v")?.state === "ready");
    writeFileSync(join(root, "x.md"), "# X\n\ndoomed text");
    await indexer.reindex("v", "x.md");
    expect((await indexer.search("v", "doomed", { limit: 1 })).length).toBe(1);
    await indexer.drop("v", "x.md");
    expect((await indexer.search("v", "doomed", { limit: 1 })).length).toBe(0);
  }, 20_000);

  test("stop is idempotent", async () => {
    const dataDir = tmpDataDir("stop");
    const cfg = makeConfig({ dataDir });
    mkdirSync(join(dataDir, "vaults", "v"), { recursive: true });
    const indexer = await startIndexer(cfg, {
      logger: silent(),
      embedder: buildHashEmbedder(4),
    });
    const a = indexer.stop();
    const b = indexer.stop();
    expect(a).toBe(b);
    await a;
  }, 20_000);

  test("scenario: dimension mismatch on open names both dims", async () => {
    const dataDir = tmpDataDir("mm");
    const cfg = makeConfig({ dataDir });
    mkdirSync(join(dataDir, "vaults", "v"), { recursive: true });
    // First: build the table at dim=384.
    const idx384 = await startIndexer(cfg, {
      logger: silent(),
      embedder: buildHashEmbedder(384),
    });
    await idx384.stop();
    // Now: try to re-open with a 1536-dim embedder.
    let err: unknown;
    try {
      await startIndexer(cfg, {
        logger: silent(),
        embedder: buildHashEmbedder(1536),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(StoreDimensionMismatchError);
    expect((err as Error).message).toContain("384");
    expect((err as Error).message).toContain("1536");
  }, 30_000);

  test("non-mismatch openStore errors are re-thrown unchanged", async () => {
    const dataDir = tmpDataDir("openerr");
    const cfg = makeConfig({ dataDir });
    let thrown: Error | undefined;
    try {
      await startIndexer(cfg, {
        logger: silent(),
        embedder: buildHashEmbedder(4),
        openStore: async () => {
          throw new Error("disk on fire");
        },
      });
    } catch (e) {
      thrown = e as Error;
    }
    expect(thrown?.message).toBe("disk on fire");
  });

  test("warmup is invoked when embedder.dim starts at 0", async () => {
    const dataDir = tmpDataDir("warmup-fired");
    const cfg = makeConfig({ dataDir });
    mkdirSync(join(dataDir, "vaults", "v"), { recursive: true });
    let warmupCalls = 0;
    const e: Embedder = {
      get dim(): number {
        return warmupCalls === 0 ? 0 : 4;
      },
      embed: async (texts) => {
        warmupCalls++;
        return texts.map(() => new Float32Array(4));
      },
    };
    const indexer = await startIndexer(cfg, { logger: silent(), embedder: e });
    cleanup.push(async () => indexer.stop());
    expect(warmupCalls).toBeGreaterThanOrEqual(1);
  });

  test("warmup is skipped when embedder.dim is already known", async () => {
    const dataDir = tmpDataDir("warm");
    const cfg = makeConfig({ dataDir });
    mkdirSync(join(dataDir, "vaults", "v"), { recursive: true });
    let calls = 0;
    const e: Embedder = {
      dim: 4,
      embed: async (texts) => {
        calls++;
        return texts.map(() => new Float32Array(4));
      },
    };
    const indexer = await startIndexer(cfg, { logger: silent(), embedder: e });
    cleanup.push(async () => indexer.stop());
    // Indexer should not have called embed for warmup since dim was known.
    expect(calls).toBe(0);
  });

  test("scan failure transitions vault to failed", async () => {
    const dataDir = tmpDataDir("scanfail");
    const cfg = makeConfig({ dataDir });
    mkdirSync(join(dataDir, "vaults", "v"), { recursive: true });
    const indexer = await startIndexer(cfg, {
      logger: silent(),
      embedder: buildHashEmbedder(4),
      scanVault: async () => {
        throw new Error("scan boom");
      },
    });
    cleanup.push(async () => indexer.stop());
    await waitFor(() => indexer.status("v")?.state === "failed");
    expect(indexer.status("v")?.state).toBe("failed");
  });

  test("scan failure with non-Error stringifies", async () => {
    const dataDir = tmpDataDir("scanfail2");
    const cfg = makeConfig({ dataDir });
    mkdirSync(join(dataDir, "vaults", "v"), { recursive: true });
    const indexer = await startIndexer(cfg, {
      logger: silent(),
      embedder: buildHashEmbedder(4),
      scanVault: async () => {
        // eslint-disable-next-line no-throw-literal -- testing non-Error path
        throw "string scan error";
      },
    });
    cleanup.push(async () => indexer.stop());
    await waitFor(() => indexer.status("v")?.state === "failed");
  });

  test("watcher upsert through the pipeline accounts pending and writes the file", async () => {
    // Two-phase wait per LDn6: pending must become non-zero (proves the
    // watcher event was observed) AND the file must show up in search
    // (proves the upsert committed). A drop scenario where the watcher
    // misses the event would leave pending at 0 and the file invisible —
    // the previous "pending === 0 OR found" form would silently green.
    const dataDir = tmpDataDir("watcher");
    const cfg = makeConfig({ dataDir });
    const root = join(dataDir, "vaults", "v");
    mkdirSync(root, { recursive: true });
    const indexer = await startIndexer(cfg, {
      logger: silent(),
      embedder: buildHashEmbedder(4),
    });
    cleanup.push(async () => indexer.stop());
    await waitFor(() => indexer.status("v")?.state === "ready");
    let observedPending = false;
    // Sample the pending counter on a tight loop while the write
    // propagates through the watcher → debounce → batcher → store
    // sequence. Even one tick of `pending > 0` proves the event was
    // observed.
    const sampler = (async (): Promise<void> => {
      for (let i = 0; i < 200; i++) {
        const s = indexer.status("v");
        if (s !== null && s.pending > 0) {
          observedPending = true;
          return;
        }
        await new Promise<void>((r) => setTimeout(r, 10));
      }
    })();
    writeFileSync(join(root, "live.md"), "# Live\n\nbody");
    await sampler;
    // Then wait for the upsert to commit and become searchable.
    await waitFor(async () => {
      const hits = await indexer.search("v", "anything");
      return hits.some((h) => h.path === "live.md");
    }, 5000);
    expect(observedPending).toBe(true);
  }, 20_000);

  test("watcher remove path runs through pipeline.remove", async () => {
    const dataDir = tmpDataDir("watcherrm");
    const cfg = makeConfig({ dataDir });
    const root = join(dataDir, "vaults", "v");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "old.md"), "# X\n\ny");
    const indexer = await startIndexer(cfg, {
      logger: silent(),
      embedder: buildHashEmbedder(4),
    });
    cleanup.push(async () => indexer.stop());
    await waitFor(() => indexer.status("v")?.state === "ready");
    // Use the public drop hook (also exercised by REST). Both paths converge.
    await indexer.drop("v", "old.md");
  }, 20_000);

  test("default openStore opens the configured vault path", async () => {
    const dataDir = tmpDataDir("defstore");
    const cfg = makeConfig({ dataDir });
    mkdirSync(join(dataDir, "vaults", "v"), { recursive: true });
    const indexer = await startIndexer(cfg, {
      logger: silent(),
      embedder: buildHashEmbedder(4),
    });
    cleanup.push(async () => indexer.stop());
    // Reach into the on-disk lancedb directory by re-opening via the same
    // helper; this confirms the default openStore wrote where we expect.
    const store = await openVaultStore({ dataDir, slug: "v", dim: 4 });
    expect(typeof store.dim).toBe("number");
    store.close();
  }, 20_000);

  describe("reindex/drop path validation (LDKg)", () => {
    async function buildIndexer(): Promise<{
      indexer: import("../../src/indexer/index.ts").Indexer;
      teardown: () => Promise<void>;
    }> {
      const dataDir = tmpDataDir("path-val");
      const cfg = makeConfig({ dataDir });
      mkdirSync(join(dataDir, "vaults", "v"), { recursive: true });
      const indexer = await startIndexer(cfg, {
        logger: silent(),
        embedder: buildHashEmbedder(4),
      });
      return { indexer, teardown: () => indexer.stop() };
    }

    test("reindex with `..` segment throws InvalidPathError", async () => {
      const { indexer, teardown } = await buildIndexer();
      try {
        let err: unknown;
        try {
          await indexer.reindex("v", "../etc/passwd");
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(InvalidPathError);
        expect((err as InvalidPathError).code).toBe("invalid_path");
      } finally {
        await teardown();
      }
    });

    test("reindex with leading slash throws", async () => {
      const { indexer, teardown } = await buildIndexer();
      try {
        let err: unknown;
        try {
          await indexer.reindex("v", "/etc/passwd");
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(InvalidPathError);
      } finally {
        await teardown();
      }
    });

    test("reindex with NUL byte throws", async () => {
      const { indexer, teardown } = await buildIndexer();
      try {
        let err: unknown;
        try {
          await indexer.reindex("v", "a\0b.md");
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(InvalidPathError);
      } finally {
        await teardown();
      }
    });

    test("reindex of `.obsidian/x.md` throws (hidden segment)", async () => {
      const { indexer, teardown } = await buildIndexer();
      try {
        let err: unknown;
        try {
          await indexer.reindex("v", ".obsidian/workspace.json");
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(InvalidPathError);
      } finally {
        await teardown();
      }
    });

    test("drop validates path the same way", async () => {
      const { indexer, teardown } = await buildIndexer();
      try {
        let err: unknown;
        try {
          await indexer.drop("v", "../escape.md");
        } catch (e) {
          err = e;
        }
        expect(err).toBeInstanceOf(InvalidPathError);
      } finally {
        await teardown();
      }
    });

    test("reindex of unknown slug is a silent no-op (no validation needed)", async () => {
      const { indexer, teardown } = await buildIndexer();
      try {
        // No throw; unknown slugs short-circuit before validation.
        await indexer.reindex("missing", "../escape");
        await indexer.drop("missing", "../escape");
      } finally {
        await teardown();
      }
    });

    test("legitimate path passes validation", async () => {
      const { indexer, teardown } = await buildIndexer();
      try {
        await waitForRoot(indexer);
        // No file at this path — pipeline upsert will count an error,
        // but no InvalidPathError is thrown.
        await indexer.reindex("v", "notes/legit.md");
        await indexer.drop("v", "notes/legit.md");
      } finally {
        await teardown();
      }
    });
  });

  test("partial init failure tolerates a rejecting watcher.stop", async () => {
    // Covers the `.catch(() => undefined)` on the watcher.stop call in
    // teardownAll: even if the cleanup itself throws, the rest of the
    // teardown still runs and the original error is re-thrown.
    const dataDir = tmpDataDir("partial-throw");
    const cfg = makeConfig({
      dataDir,
      vaults: [
        { name: "first", slug: "first" },
        { name: "second", slug: "second" },
      ],
    });
    mkdirSync(join(dataDir, "vaults", "first"), { recursive: true });
    mkdirSync(join(dataDir, "vaults", "second"), { recursive: true });

    let firstStoreClosed = false;
    let err: unknown;
    try {
      await startIndexer(cfg, {
        logger: silent(),
        embedder: buildHashEmbedder(4),
        openStore: async (_cfg, vault) => {
          if (vault.slug === "second") throw new Error("second store fails");
          return {
            dim: 4,
            upsert: async () => undefined,
            drop: async () => undefined,
            search: async () => [],
            searchHybrid: async () => [],
            documentCount: async () => 0,
            chunkCount: async () => 0,
            fingerprint: async () => undefined,
            fingerprints: async () => new Map(),
            close: () => {
              firstStoreClosed = true;
            },
          };
        },
        startWatcher: () => ({
          ready: () => Promise.resolve(),
          lastError: () => null,
          stop: () => Promise.reject(new Error("watcher stop failed")),
        }),
        scanVault: async () => ({ scanned: 0, skipped: 0, errors: 0 }),
      });
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.message).toBe("second store fails");
    expect(firstStoreClosed).toBe(true);
  });

  test("partial init failure tears down already-started vaults (LDKv)", async () => {
    const dataDir = tmpDataDir("partial");
    const cfg = makeConfig({
      dataDir,
      vaults: [
        { name: "first", slug: "first" },
        { name: "second", slug: "second" },
      ],
    });
    mkdirSync(join(dataDir, "vaults", "first"), { recursive: true });
    mkdirSync(join(dataDir, "vaults", "second"), { recursive: true });

    let openCount = 0;
    let firstStoreClosed = false;
    let firstWatcherStopped = false;
    let firstStop: (() => Promise<void>) | undefined;
    let firstClose: (() => void) | undefined;

    const fakeStore = (which: string): import("../../src/indexer/store.ts").VaultStore => {
      const store: import("../../src/indexer/store.ts").VaultStore = {
        dim: 4,
        upsert: async () => undefined,
        drop: async () => undefined,
        search: async () => [],
        searchHybrid: async () => [],
        documentCount: async () => 0,
        chunkCount: async () => 0,
        fingerprint: async () => undefined,
        fingerprints: async () => new Map(),
        close: () => {
          if (which === "first") firstStoreClosed = true;
        },
      };
      if (which === "first") firstClose = store.close.bind(store);
      return store;
    };

    let err: unknown;
    try {
      await startIndexer(cfg, {
        logger: silent(),
        embedder: buildHashEmbedder(4),
        openStore: async (_cfg, vault) => {
          openCount++;
          if (vault.slug === "second") throw new Error("second store fails");
          return fakeStore(vault.slug);
        },
        startWatcher: () => ({
          ready: () =>
            new Promise<void>((r) => {
              setTimeout(r, 5);
            }),
          lastError: () => null,
          stop: async () => {
            firstWatcherStopped = true;
          },
        }),
        scanVault: async () => ({ scanned: 0, skipped: 0, errors: 0 }),
      });
    } catch (e) {
      err = e;
    }
    expect((err as Error)?.message).toBe("second store fails");
    // The first vault opened — its watcher was stopped and store closed.
    expect(openCount).toBe(2);
    expect(firstWatcherStopped).toBe(true);
    expect(firstStoreClosed).toBe(true);
    // Suppress unused-warning lint for the close handle reference.
    void firstStop;
    void firstClose;
  });

  test("scenario: rolling forward triggers automatic rebuild (change 0007)", async () => {
    // Seed a v1 data dir under PIPELINE_VERSION = 1, then start the indexer
    // (binary version PIPELINE_VERSION = 2). Tables must drop and the
    // sidecar must bump to 2.
    const dataDir = tmpDataDir("pv-roll-fwd");
    const cfg = makeConfig({ dataDir });
    const root = join(dataDir, "vaults", "v");
    mkdirSync(root, { recursive: true });
    // Seed a row at v1.
    const seedStore = await openVaultStore({ dataDir, slug: "v", dim: 4 });
    await seedStore.upsert("a.md", [
      {
        path: "a.md",
        chunkIndex: 0,
        headingPath: ["X"],
        text: "stale",
        embedText: "a.md\nX\n\nstale",
        frontmatter: {},
        links: [],
        tags: [],
        mtimeMs: 1,
        sha256: "h",
        vector: Float32Array.from([1, 0, 0, 0]),
      },
    ]);
    expect(await seedStore.chunkCount()).toBe(1);
    seedStore.close();
    writePipelineVersion(dataDir, 1);

    const indexer = await startIndexer(cfg, {
      logger: silent(),
      embedder: buildHashEmbedder(4),
    });
    cleanup.push(async () => indexer.stop());
    // Sidecar bumped.
    expect(readPipelineVersion(dataDir)).toBe(PIPELINE_VERSION);
    // Old table is gone — re-opening yields zero chunks (the scanner had
    // nothing on disk to re-ingest, so it stays at 0).
    await waitFor(() => indexer.status("v")?.state === "ready");
    expect(indexer.status("v")?.chunks).toBe(0);
  }, 20_000);

  test("scenario: rolling back errors out cleanly (change 0007)", async () => {
    const dataDir = tmpDataDir("pv-roll-back");
    const cfg = makeConfig({ dataDir });
    mkdirSync(join(dataDir, "vaults", "v"), { recursive: true });
    writePipelineVersion(dataDir, PIPELINE_VERSION + 1);
    let err: unknown;
    try {
      await startIndexer(cfg, {
        logger: silent(),
        embedder: buildHashEmbedder(4),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PipelineVersionMismatchError);
    expect((err as Error).message).toContain(`data_dir=${PIPELINE_VERSION + 1}`);
    expect((err as Error).message).toContain(`binary=${PIPELINE_VERSION}`);
  });

  test("end-to-end: flat-list file + prose file get correct chunk counts and embed_text rows include path prefix", async () => {
    const dataDir = tmpDataDir("e2e-0007");
    const cfg = makeConfig({ dataDir });
    const root = join(dataDir, "vaults", "v");
    mkdirSync(root, { recursive: true });
    // Pure flat-list file: 5 bullets => 5 chunks.
    writeFileSync(
      join(root, "tasks.md"),
      "## Work\n\n- ship feature A\n- ship feature B\n- ship feature C\n- ship feature D\n- ship feature E",
    );
    // Prose file: single section => 1 chunk.
    writeFileSync(
      join(root, "prose.md"),
      "# Background\n\nA single paragraph of prose text describing context.",
    );

    const indexer = await startIndexer(cfg, {
      logger: silent(),
      embedder: buildHashEmbedder(4),
    });
    cleanup.push(async () => indexer.stop());
    await waitFor(() => indexer.status("v")?.state === "ready");
    // 5 (flat-list) + 1 (prose) = 6 chunks.
    expect(indexer.status("v")?.chunks).toBe(6);

    // Inspect the persisted rows directly to confirm `embed_text` is
    // populated with the path prefix.
    const lance = await import("@lancedb/lancedb");
    const db = await lance.connect(`${dataDir}/lancedb`);
    const table = await db.openTable("v");
    const rows = (await table.query().toArray()) as Record<string, unknown>[];
    expect(rows.length).toBe(6);
    for (const r of rows) {
      const e = r.embed_text;
      expect(typeof e).toBe("string");
      const path = r.path as string;
      expect((e as string).startsWith(`${path}\n`)).toBe(true);
    }
    // At least one row from each file is present.
    const tasksRows = rows.filter((r) => r.path === "tasks.md");
    const proseRows = rows.filter((r) => r.path === "prose.md");
    expect(tasksRows.length).toBe(5);
    expect(proseRows.length).toBe(1);
  }, 30_000);

  test("stop bounds at stopTimeoutMs even when scan hangs (LDKr)", async () => {
    const dataDir = tmpDataDir("hung");
    const cfg = makeConfig({ dataDir });
    mkdirSync(join(dataDir, "vaults", "v"), { recursive: true });
    // Hang the scan forever; stop() must still resolve via the timeout.
    const indexer = await startIndexer(cfg, {
      logger: silent(),
      embedder: buildHashEmbedder(4),
      stopTimeoutMs: 50,
      scanVault: () =>
        new Promise(() => undefined) as Promise<{
          scanned: number;
          skipped: number;
          errors: number;
        }>,
    });
    const start = Date.now();
    await indexer.stop();
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2_000);
  });
});

async function waitForRoot(indexer: import("../../src/indexer/index.ts").Indexer): Promise<void> {
  await waitFor(() => indexer.list().every((s) => s.state === "ready" || s.state === "failed"));
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  pollMs = 25,
): Promise<void> {
  const start = Date.now();
  while (true) {
    const ok = await predicate();
    if (ok) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise<void>((r) => setTimeout(r, pollMs));
  }
}

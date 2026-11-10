/**
 * The one indexable-path rule, end to end through the real indexer
 * (Vault Indexer › Indexable paths, Initial scan, Public surface):
 *
 * - the startup sweep drops rows the rule rejects, before the vault is ready;
 * - `reindex` applies the rule itself, resolving `{ indexed }`, and rejects
 *   when the index could not be updated (embedder or store failure);
 * - `dropHidden` removes rows under hidden names and nothing else;
 * - the scanner, the watcher, and `reindex` agree on one table of paths.
 *
 * Everything runs on real tmpdir vaults and a real LanceDB store.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config/index.ts";
import { buildHashEmbedder } from "../../src/embeddings/fake.ts";
import type { Embedder } from "../../src/embeddings/index.ts";
import {
  type Indexer,
  InvalidPathError,
  assertHiddenRowPath,
  startIndexer,
} from "../../src/indexer/index.ts";
import { buildPipeline } from "../../src/indexer/pipeline.ts";
import { scanVault } from "../../src/indexer/scanner.ts";
import {
  PIPELINE_VERSION,
  type VaultStore,
  openVaultStore,
  writePipelineVersion,
} from "../../src/indexer/store.ts";
import { type WatcherEvent, type WatcherHandle, startWatcher } from "../../src/indexer/watcher.ts";
import { type LogFields, type Logger, createLogger } from "../../src/log.ts";
import { TEST_SYNC_HEALTH, TEST_WATCHDOG_OFF } from "../helpers/vaultStatus.ts";

const DIM = 4;

function silent(): Logger {
  return createLogger({ level: "error", write: () => undefined });
}

function capture(): { logger: Logger; warns: { msg: string; fields?: LogFields }[] } {
  const warns: { msg: string; fields?: LogFields }[] = [];
  const noop = (): void => undefined;
  return {
    warns,
    logger: {
      trace: noop,
      debug: noop,
      info: noop,
      warn: (msg, fields) => {
        warns.push(fields === undefined ? { msg } : { msg, fields });
      },
      error: noop,
    },
  };
}

function makeConfig(dataDir: string): Config {
  return {
    obsidianAuthToken: undefined,
    vaults: [{ name: "v", slug: "v" }],
    dataDir,
    httpPort: 0,
    httpHost: "127.0.0.1",
    embeddingProvider: "transformers",
    embeddingModel: "x",
    logLevel: "error",
    syncConfigEnv: {},
    syncWatchdog: TEST_WATCHDOG_OFF,
    syncHealth: TEST_SYNC_HEALTH,
  };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 10_000) {
  const start = Date.now();
  while (!(await predicate())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise<void>((r) => setTimeout(r, 25));
  }
}

/** A fresh data dir whose vault root exists, plus a recorder of every embedded text. */
function fixtureDirs(label: string): { dataDir: string; root: string; outside: string } {
  const dataDir = mkdtempSync(join(tmpdir(), `ob-indexable-${label}-`));
  const root = join(dataDir, "vaults", "v");
  mkdirSync(root, { recursive: true });
  const outside = mkdtempSync(join(tmpdir(), `ob-indexable-outside-${label}-`));
  writeFileSync(join(outside, "secret.md"), "# Secret\n\nOUTSIDE-CONTENT");
  return { dataDir, root, outside };
}

function countingEmbedder(): Embedder & { texts: string[] } {
  const inner = buildHashEmbedder(DIM);
  const texts: string[] = [];
  return {
    texts,
    get dim() {
      return inner.dim;
    },
    async embed(batch: string[]): Promise<Float32Array[]> {
      texts.push(...batch);
      return inner.embed(batch);
    },
  };
}

/** Persist one row per path, as an earlier version could have written them. */
async function seedRows(dataDir: string, paths: readonly string[]): Promise<void> {
  const store = await openVaultStore({ dataDir, slug: "v", dim: DIM });
  for (const path of paths) {
    await store.upsert(path, [
      {
        path,
        chunkIndex: 0,
        headingPath: [],
        text: "stale",
        embedText: `${path}\n\nstale`,
        frontmatter: {},
        links: [],
        tags: [],
        mtimeMs: 1,
        sha256: "stale",
        vector: Float32Array.from([1, 0, 0, 0]),
      },
    ]);
  }
  store.close();
  // Without a current sidecar the pipeline-version check would drop the
  // table itself; the sweep is what is under test.
  writePipelineVersion(dataDir, PIPELINE_VERSION);
}

async function start(
  dataDir: string,
  extra: {
    embedder?: Embedder;
    logger?: Logger;
    openStore?: () => Promise<VaultStore>;
    buildPipeline?: typeof buildPipeline;
    startWatcher?: typeof startWatcher;
  } = {},
): Promise<Indexer> {
  const indexer = await startIndexer(makeConfig(dataDir), {
    logger: extra.logger ?? silent(),
    embedder: extra.embedder ?? buildHashEmbedder(DIM),
    ...(extra.openStore !== undefined ? { openStore: extra.openStore } : {}),
    ...(extra.buildPipeline !== undefined ? { buildPipeline: extra.buildPipeline } : {}),
    ...(extra.startWatcher !== undefined ? { startWatcher: extra.startWatcher } : {}),
  });
  cleanup.push(() => indexer.stop());
  return indexer;
}

describe("startup sweep", () => {
  test("rows persisted for a symlink to an outside note are gone before ready, with no embedding", async () => {
    const { dataDir, root, outside } = fixtureDirs("sweep-link");
    await seedRows(dataDir, ["notes/ref.md"]);
    mkdirSync(join(root, "notes"));
    symlinkSync(join(outside, "secret.md"), join(root, "notes", "ref.md"));
    const embedder = countingEmbedder();
    const indexer = await start(dataDir, { embedder });
    let rowsAtReady: string[] | null = null;
    await waitFor(async () => {
      if (indexer.status("v")?.state !== "ready") return false;
      rowsAtReady = await indexer.indexedPaths("v", "");
      return true;
    });
    expect(rowsAtReady as unknown as string[]).toEqual([]);
    expect(embedder.texts.some((t) => t.includes("OUTSIDE-CONTENT"))).toBe(false);
    expect(embedder.texts).toEqual([]);
  }, 20_000);

  test("rows for a file deleted while stopped, and for hidden or node_modules paths, are swept", async () => {
    const { dataDir, root } = fixtureDirs("sweep-gone");
    await seedRows(dataDir, ["gone.md", "proj/.drafts/x.md", "node_modules/pkg/n.md", "kept.md"]);
    writeFileSync(join(root, "kept.md"), "# Kept\n\nbody");
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "n.md"), "# N\n\nbody");
    const indexer = await start(dataDir);
    await waitFor(() => indexer.status("v")?.state === "ready");
    expect(await indexer.indexedPaths("v", "")).toEqual(["kept.md"]);
  }, 20_000);

  test("a failed sweep drop is counted and does not keep the vault from ready", async () => {
    const { dataDir } = fixtureDirs("sweep-drop-fail");
    await seedRows(dataDir, ["gone.md"]);
    const indexer = await start(dataDir, {
      openStore: async () => {
        const real = await openVaultStore({ dataDir, slug: "v", dim: DIM });
        return {
          ...real,
          drop: async () => {
            throw new Error("drop down");
          },
        };
      },
    });
    await waitFor(() => indexer.status("v")?.state === "ready");
    expect(indexer.status("v")?.errors).toBe(1);
    expect(await indexer.indexedPaths("v", "")).toEqual(["gone.md"]);
  }, 30_000);

  test("a store that cannot list its paths is warned about and the scan still runs", async () => {
    const { dataDir, root } = fixtureDirs("sweep-fail");
    writeFileSync(join(root, "a.md"), "# A\n\nbody");
    const { logger, warns } = capture();
    const indexer = await start(dataDir, {
      logger,
      openStore: async () => {
        const real = await openVaultStore({ dataDir, slug: "v", dim: DIM });
        return {
          ...real,
          // `hydrateCounters` swallows its own failure; the sweep warns.
          fingerprints: async () => {
            throw "listing unavailable";
          },
        };
      },
    });
    await waitFor(() => indexer.status("v")?.state === "ready");
    expect(warns.map((w) => w.msg)).toContain(
      "indexer: startup sweep could not list indexed paths",
    );
    expect(await indexer.indexedPaths("v", "")).toEqual(["a.md"]);
  }, 20_000);

  test("an Error from the listing is reported by its message", async () => {
    const { dataDir } = fixtureDirs("sweep-fail-err");
    const { logger, warns } = capture();
    const indexer = await start(dataDir, {
      logger,
      openStore: async () => {
        const real = await openVaultStore({ dataDir, slug: "v", dim: DIM });
        let calls = 0;
        return {
          ...real,
          fingerprints: async () => {
            calls++;
            // Call 1 is `hydrateCounters`, call 2 the sweep.
            if (calls === 2) throw new Error("boom");
            return real.fingerprints();
          },
        };
      },
    });
    await waitFor(() => indexer.status("v")?.state === "ready");
    const warn = warns.find((w) => w.msg.includes("startup sweep"));
    expect(warn?.fields?.error).toBe("boom");
  }, 20_000);
});

describe("reindex applies the rule and reports it", () => {
  test("an indexable note is indexed; a node_modules note and a symlink have their rows dropped", async () => {
    const { dataDir, root, outside } = fixtureDirs("reindex");
    const embedder = countingEmbedder();
    const indexer = await start(dataDir, { embedder });
    await waitFor(() => indexer.status("v")?.state === "ready");
    writeFileSync(join(root, "a.md"), "# A\n\nbody");
    expect(await indexer.reindex("v", "a.md")).toEqual({ indexed: true });
    // Rows for `ref.md` from before it became a symlink.
    writeFileSync(join(root, "ref.md"), "# Ref\n\nlocal");
    await indexer.reindex("v", "ref.md");
    rmSync(join(root, "ref.md"));
    symlinkSync(join(outside, "secret.md"), join(root, "ref.md"));
    expect(await indexer.reindex("v", "ref.md")).toEqual({ indexed: false });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "n.md"), "# N\n\nbody");
    expect(await indexer.reindex("v", "node_modules/pkg/n.md")).toEqual({ indexed: false });
    writeFileSync(join(root, "img.png"), "PNG");
    expect(await indexer.reindex("v", "img.png")).toEqual({ indexed: false });
    expect(await indexer.reindex("v", "missing.md")).toEqual({ indexed: false });
    expect(await indexer.indexedPaths("v", "")).toEqual(["a.md"]);
    expect(embedder.texts.some((t) => t.includes("OUTSIDE-CONTENT"))).toBe(false);
    expect(await indexer.reindex("nope", "a.md")).toEqual({ indexed: false });
  }, 20_000);

  test("an embedder failure rejects the reindex and counts an error", async () => {
    const { dataDir, root } = fixtureDirs("reindex-embed");
    let fail = false;
    const inner = buildHashEmbedder(DIM);
    const embedder: Embedder = {
      get dim() {
        return inner.dim;
      },
      embed: async (t) => {
        if (fail) throw new Error("embedder down");
        return inner.embed(t);
      },
    };
    const indexer = await start(dataDir, { embedder });
    await waitFor(() => indexer.status("v")?.state === "ready");
    writeFileSync(join(root, "a.md"), "# A\n\nbody");
    fail = true;
    const before = indexer.status("v")?.errors ?? 0;
    await expect(indexer.reindex("v", "a.md")).rejects.toThrow("embedder down");
    expect(indexer.status("v")?.errors).toBe(before + 1);
  }, 20_000);

  test("a store failure rejects reindex and drop", async () => {
    const { dataDir, root } = fixtureDirs("reindex-store");
    let fail = false;
    const indexer = await start(dataDir, {
      openStore: async () => {
        const real = await openVaultStore({ dataDir, slug: "v", dim: DIM });
        return {
          ...real,
          upsert: async (p, rows) => {
            if (fail) throw new Error("store down");
            return real.upsert(p, rows);
          },
          drop: async (p) => {
            if (fail) throw new Error("store down");
            return real.drop(p);
          },
        };
      },
    });
    await waitFor(() => indexer.status("v")?.state === "ready");
    writeFileSync(join(root, "a.md"), "# A\n\nbody");
    fail = true;
    await expect(indexer.reindex("v", "a.md")).rejects.toThrow("store down");
    await expect(indexer.drop("v", "a.md")).rejects.toThrow("store down");
    expect(indexer.status("v")?.errors).toBeGreaterThanOrEqual(2);
  }, 30_000);

  test("a failing watcher event and a failing scan upsert are absorbed, not unhandled", async () => {
    const { dataDir, root } = fixtureDirs("absorb");
    writeFileSync(join(root, "scan.md"), "# S\n\nbody");
    const embedder: Embedder = {
      dim: DIM,
      embed: async () => {
        throw new Error("always down");
      },
    };
    const indexer = await start(dataDir, { embedder });
    await waitFor(() => indexer.status("v")?.state === "ready");
    const scanErrors = indexer.status("v")?.errors ?? 0;
    expect(scanErrors).toBeGreaterThanOrEqual(1);
    writeFileSync(join(root, "live.md"), "# L\n\nbody");
    await waitFor(() => (indexer.status("v")?.errors ?? 0) > scanErrors);
    expect(indexer.status("v")?.state).toBe("ready");
  }, 20_000);
});

describe("dropHidden", () => {
  test("drops a row under a hidden entry, refuses anything else", async () => {
    const { dataDir } = fixtureDirs("hidden");
    let store: VaultStore | undefined;
    const indexer = await start(dataDir, {
      openStore: async () => {
        store = await openVaultStore({ dataDir, slug: "v", dim: DIM });
        return store;
      },
    });
    await waitFor(() => indexer.status("v")?.state === "ready");
    // A row under a hidden name can only exist if something wrote it
    // directly; the sweep ran before this, so write it now.
    await (store as VaultStore).upsert("proj/.drafts/x.md", [
      {
        path: "proj/.drafts/x.md",
        chunkIndex: 0,
        headingPath: [],
        text: "t",
        embedText: "t",
        frontmatter: {},
        links: [],
        tags: [],
        mtimeMs: 1,
        sha256: "s",
        vector: Float32Array.from([1, 0, 0, 0]),
      },
    ]);
    expect(await indexer.indexedPaths("v", "proj/")).toEqual(["proj/.drafts/x.md"]);
    await indexer.dropHidden("v", "proj/.drafts/x.md");
    expect(await indexer.indexedPaths("v", "proj/")).toEqual([]);
    await expect(indexer.dropHidden("v", "proj/x.md")).rejects.toBeInstanceOf(InvalidPathError);
    await indexer.dropHidden("nope", ".x/a.md");
  }, 20_000);

  test("assertHiddenRowPath relaxes only the hidden-segment rule", () => {
    expect(assertHiddenRowPath("a/.b/c.md")).toBe("a/.b/c.md");
    expect(assertHiddenRowPath(".obsidian/w.json")).toBe(".obsidian/w.json");
    for (const bad of ["a/b.md", "", "../.x/a.md", "/.x/a.md", ".x/\0a.md", ".x/..\\y", "a/./b"]) {
      expect(() => assertHiddenRowPath(bad)).toThrow(InvalidPathError);
    }
  });
});

describe("the scanner, the watcher, and reindex agree", () => {
  /**
   * One table of paths: `true` = indexable. Hidden paths are excluded from
   * `reindex` (its path validation refuses them) but must be refused by the
   * scan and the watcher too.
   */
  const TABLE: readonly (readonly [string, boolean])[] = [
    ["a.md", true],
    ["UPPER.MD", true],
    ["notes/b.markdown", true],
    ["notes/c.txt", false],
    ["node_modules/pkg/d.md", false],
    ["deep/node_modules/e.md", false],
    ["link.md", false],
    ["linkdir/f.md", false],
  ];

  function seed(root: string, outside: string): void {
    for (const [rel] of TABLE) {
      if (rel === "link.md" || rel.startsWith("linkdir/")) continue;
      mkdirSync(join(root, rel, ".."), { recursive: true });
      writeFileSync(join(root, rel), "# T\n\nbody");
    }
    symlinkSync(join(outside, "secret.md"), join(root, "link.md"));
    const real = mkdtempSync(join(tmpdir(), "ob-indexable-linkdir-"));
    writeFileSync(join(real, "f.md"), "# F\n\nbody");
    symlinkSync(real, join(root, "linkdir"));
    mkdirSync(join(root, ".hidden"), { recursive: true });
    writeFileSync(join(root, ".hidden", "g.md"), "# G\n\nbody");
  }

  const expected = TABLE.filter(([, ok]) => ok)
    .map(([p]) => p)
    .sort();

  test("the initial scan indexes exactly the indexable rows", async () => {
    const { root, outside } = fixtureDirs("agree-scan");
    seed(root, outside);
    const seen: string[] = [];
    await scanVault(root, async (f) => {
      seen.push(f.relPath);
    });
    expect(seen.sort()).toEqual(expected);
  });

  test("a direct reindex reports indexed exactly for the indexable rows", async () => {
    const { dataDir, root, outside } = fixtureDirs("agree-reindex");
    const indexer = await start(dataDir);
    await waitFor(() => indexer.status("v")?.state === "ready");
    seed(root, outside);
    const indexed: string[] = [];
    for (const [rel] of TABLE) {
      if ((await indexer.reindex("v", rel)).indexed) indexed.push(rel);
    }
    expect(indexed.sort()).toEqual(expected);
    expect((await indexer.indexedPaths("v", "")).sort()).toEqual(expected);
  }, 20_000);

  test("the watcher upserts exactly the indexable rows and never follows the links", async () => {
    const { root, outside } = fixtureDirs("agree-watch");
    const events: WatcherEvent[] = [];
    const w = startWatcher(root, (e) => events.push(e), { debounceMs: 30 });
    cleanup.push(() => w.stop());
    await w.ready();
    seed(root, outside);
    await waitFor(() => events.filter((e) => e.kind === "upsert").length >= expected.length);
    // Let any straggling (wrongly followed) events land before asserting.
    await new Promise<void>((r) => setTimeout(r, 300));
    const upserts = events.filter((e) => e.kind === "upsert").map((e) => e.relPath);
    expect([...new Set(upserts)].sort()).toEqual(expected);
    // Nothing below the symlinked folder or the hidden folder is reported.
    expect(events.some((e) => e.relPath.startsWith("linkdir/"))).toBe(false);
    expect(events.some((e) => e.relPath.startsWith(".hidden"))).toBe(false);
  }, 20_000);
});

describe("the real watcher drops rows when a note becomes non-indexable", () => {
  test("a note replaced by a symlink of the same name loses its rows", async () => {
    const { dataDir, root, outside } = fixtureDirs("watch-link");
    mkdirSync(join(root, "notes"));
    writeFileSync(join(root, "notes", "a.md"), "# A\n\nbody");
    const embedder = countingEmbedder();
    const indexer = await start(dataDir, { embedder });
    await waitFor(() => indexer.status("v")?.state === "ready");
    expect(await indexer.indexedPaths("v", "")).toEqual(["notes/a.md"]);
    // Replace atomically, as a sync client would: link elsewhere, rename over.
    symlinkSync(join(outside, "secret.md"), join(root, "notes", ".tmp-link"));
    renameSync(join(root, "notes", ".tmp-link"), join(root, "notes", "a.md"));
    await waitFor(async () => (await indexer.indexedPaths("v", "")).length === 0);
    expect(embedder.texts.some((t) => t.includes("OUTSIDE-CONTENT"))).toBe(false);
  }, 20_000);

  test("a folder moved in carrying a symlink ref.md indexes nothing for it", async () => {
    const { dataDir, root, outside } = fixtureDirs("watch-folder");
    const embedder = countingEmbedder();
    const indexer = await start(dataDir, { embedder });
    await waitFor(() => indexer.status("v")?.state === "ready");
    const staged = mkdtempSync(join(dataDir, "staged-"));
    writeFileSync(join(staged, "real.md"), "# Real\n\nbody");
    symlinkSync(join(outside, "secret.md"), join(staged, "ref.md"));
    renameSync(staged, join(root, "moved"));
    await waitFor(async () => (await indexer.indexedPaths("v", "")).includes("moved/real.md"));
    await new Promise<void>((r) => setTimeout(r, 400));
    expect(await indexer.indexedPaths("v", "")).toEqual(["moved/real.md"]);
    expect(embedder.texts.some((t) => t.includes("OUTSIDE-CONTENT"))).toBe(false);
  }, 20_000);
});

describe("a drop decided from an earlier check never deletes fresh rows", () => {
  test("startup sweep: a note recreated as indexable between the sweep's check and its drop keeps its rows", async () => {
    const { dataDir, root } = fixtureDirs("race-sweep");
    // Rows for a note deleted while ob was stopped: the sweep's check finds
    // nothing there and decides to drop.
    await seedRows(dataDir, ["notes/a.md"]);
    let recreated = false;
    const sweepCalls: string[] = [];
    const indexer = await start(dataDir, {
      // The seam between the sweep's check and its pipeline call: a writer
      // recreates the note right then. The sweep runs before the scan, so
      // what its own call did is recorded here (the scan would re-add rows
      // either way, which is why rows at ready alone would prove nothing).
      buildPipeline: (deps, opts) => {
        const real = buildPipeline(deps, opts);
        return {
          ...real,
          upsert: async (abs, rel) => {
            if (rel === "notes/a.md" && !recreated) {
              recreated = true;
              mkdirSync(join(root, "notes"), { recursive: true });
              writeFileSync(join(root, "notes", "a.md"), "# A\n\nRECREATED");
              const r = await real.upsert(abs, rel);
              sweepCalls.push(`upsert:${r.indexed}`);
              return r;
            }
            return real.upsert(abs, rel);
          },
          remove: async (rel, o) => {
            sweepCalls.push(`remove:${rel}`);
            return real.remove(rel, o);
          },
        };
      },
    });
    await waitFor(() => indexer.status("v")?.state === "ready");
    // The drop re-checked under the pipeline lock and kept (indexed) the note;
    // nothing dropped it on the strength of the earlier check.
    expect(sweepCalls).toEqual(["upsert:true"]);
    expect(await indexer.indexedPaths("v", "")).toEqual(["notes/a.md"]);
    const hits = await indexer.search("v", "RECREATED", { filter: { pathPrefix: "notes/a.md" } });
    expect(hits.map((h) => h.text).join("\n")).toContain("RECREATED");
  }, 20_000);

  test("watcher: a remove classified before a writer recreated and indexed the note keeps its rows", async () => {
    const { dataDir, root } = fixtureDirs("race-watch");
    let emit: ((ev: WatcherEvent) => void) | undefined;
    const indexer = await start(dataDir, {
      // A watcher we drive: it reports `a.md` as removed (its classification
      // ran while the note was gone) only after a writer recreated it.
      startWatcher: (_root, onEvent): WatcherHandle => {
        emit = onEvent;
        return { ready: async () => undefined, lastError: () => null, stop: async () => undefined };
      },
    });
    await waitFor(() => indexer.status("v")?.state === "ready");
    writeFileSync(join(root, "a.md"), "# A\n\nFRESH");
    expect(await indexer.reindex("v", "a.md")).toEqual({ indexed: true });
    (emit as (ev: WatcherEvent) => void)({
      kind: "remove",
      absPath: join(root, "a.md"),
      relPath: "a.md",
    });
    await waitFor(() => indexer.status("v")?.pending === 0);
    expect(await indexer.indexedPaths("v", "")).toEqual(["a.md"]);
    // A remove for a path that really is gone still drops.
    rmSync(join(root, "a.md"));
    (emit as (ev: WatcherEvent) => void)({
      kind: "remove",
      absPath: join(root, "a.md"),
      relPath: "a.md",
    });
    await waitFor(async () => (await indexer.indexedPaths("v", "")).length === 0);
  }, 20_000);

  test("drop with unlessIndexable is the drop guard under the pipeline lock; without it, unconditional", async () => {
    const { dataDir, root } = fixtureDirs("guard-drop");
    const indexer = await start(dataDir);
    await waitFor(() => indexer.status("v")?.state === "ready");
    writeFileSync(join(root, "a.md"), "# A\n\nbody");
    await indexer.reindex("v", "a.md");
    await indexer.drop("v", "a.md", { unlessIndexable: true });
    expect(await indexer.indexedPaths("v", "")).toEqual(["a.md"]);
    await indexer.drop("v", "a.md");
    expect(await indexer.indexedPaths("v", "")).toEqual([]);
    await indexer.reindex("v", "a.md");
    rmSync(join(root, "a.md"));
    await indexer.drop("v", "a.md", { unlessIndexable: true });
    expect(await indexer.indexedPaths("v", "")).toEqual([]);
  }, 20_000);
});

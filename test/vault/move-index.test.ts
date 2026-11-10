/**
 * Move, copy, and the writers against the REAL indexer (LanceDB store, real
 * watcher, a controllable embedder): `reindex` failures reach every
 * response's `indexed`, reindexes run under the path's lock so a concurrent
 * PUT always wins, an outside writer's recreated old path is reconciled by
 * the watcher, and moved notes are re-embedded under their new path.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config/index.ts";
import { buildHashEmbedder } from "../../src/embeddings/fake.ts";
import type { Embedder } from "../../src/embeddings/index.ts";
import { type Indexer, startIndexer } from "../../src/indexer/index.ts";
import { type VaultStore, openVaultStore } from "../../src/indexer/store.ts";
import { createLogger } from "../../src/log.ts";
import { copyPath } from "../../src/vault/copy.ts";
import { type VaultServiceDeps, appendFile, patchFile, writeFile } from "../../src/vault/files.ts";
import { movePath } from "../../src/vault/paths.ts";
import { TEST_SYNC_HEALTH, TEST_WATCHDOG_OFF } from "../helpers/vaultStatus.ts";

const DIM = 4;
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

interface ControlledEmbedder extends Embedder {
  texts: string[];
  fail: boolean;
  /** When set, an embed of a text containing this marker waits for `release()`. */
  holdOn: string | null;
  held: Promise<void>;
  release(): void;
}

function controlledEmbedder(): ControlledEmbedder {
  const inner = buildHashEmbedder(DIM);
  let release!: () => void;
  let reached!: () => void;
  const e: ControlledEmbedder = {
    texts: [],
    fail: false,
    holdOn: null,
    held: new Promise<void>((r) => {
      reached = r;
    }),
    release: () => release(),
    get dim() {
      return inner.dim;
    },
    async embed(batch: string[]): Promise<Float32Array[]> {
      if (e.fail) throw new Error("embedder down");
      e.texts.push(...batch);
      const marker = e.holdOn;
      if (marker !== null && batch.some((t) => t.includes(marker))) {
        e.holdOn = null;
        const gate = new Promise<void>((r) => {
          release = r;
        });
        reached();
        await gate;
      }
      return inner.embed(batch);
    },
  };
  return e;
}

async function fixture(
  label: string,
  extra: { openStore?: (dataDir: string) => Promise<VaultStore> } = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), `ob-move-index-${label}-`));
  const root = join(dataDir, "vaults", "v");
  mkdirSync(root, { recursive: true });
  const cfg: Config = {
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
  const embedder = controlledEmbedder();
  const logger = createLogger({ level: "error", write: () => undefined });
  const openStore = extra.openStore;
  const indexer: Indexer = await startIndexer(cfg, {
    logger,
    embedder,
    ...(openStore !== undefined ? { openStore: () => openStore(dataDir) } : {}),
  });
  cleanup.push(() => indexer.stop());
  await waitFor(() => indexer.status("v")?.state === "ready");
  const deps: VaultServiceDeps = {
    vault: (s) => (s === "v" ? { slug: "v", name: "v", root } : null),
    indexer,
    logger,
  };
  const put = (rel: string, content: string): void => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  /** The indexed text for `path`, from a search filtered to it. */
  const rowText = async (path: string): Promise<string> => {
    const hits = await indexer.search("v", "anything", { filter: { pathPrefix: path }, limit: 20 });
    return hits
      .filter((h) => h.path === path)
      .map((h) => h.text)
      .join("\n");
  };
  return { root, deps, indexer, embedder, put, rowText };
}

describe("reindex failures reach every response's indexed", () => {
  test("an embedder failure: reindex rejects, errors grows, indexed false everywhere", async () => {
    const fx = await fixture("embed-fail");
    fx.put("a.md", "# A\n\nalpha");
    fx.put("b.md", "# B\n\nbeta");
    fx.put("n.md", "# N\n\nnote");
    fx.embedder.fail = true;
    const before = fx.indexer.status("v")?.errors ?? 0;
    await expect(fx.indexer.reindex("v", "a.md")).rejects.toThrow("embedder down");
    const w = await writeFile(fx.deps, "v", "w.md", { kind: "markdown", content: "# W\n\nw" });
    const p = await patchFile(fx.deps, "v", "n.md", { edits: [{ old: "note", new: "NOTE" }] });
    const a = await appendFile(fx.deps, "v", "n.md", new TextEncoder().encode("\nmore"));
    const m = await movePath(fx.deps, "v", "a.md", { destination: "a2.md" });
    const c = await copyPath(fx.deps, "v", "b.md", { destination: "b2.md" });
    expect([w.indexed, p.indexed, a.indexed, m.indexed, c.indexed]).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(fx.indexer.status("v")?.errors).toBeGreaterThanOrEqual(before + 6);
  }, 30_000);

  test("a store failure: the same", async () => {
    let fail = false;
    const fx = await fixture("store-fail", {
      openStore: async (dataDir) => {
        const real = await openVaultStore({ dataDir, slug: "v", dim: DIM });
        return {
          ...real,
          upsert: async (p, rows) => {
            if (fail) throw new Error("store down");
            return real.upsert(p, rows);
          },
        };
      },
    });
    fx.put("a.md", "# A\n\nalpha");
    fx.put("n.md", "# N\n\nnote");
    fail = true;
    await expect(fx.indexer.reindex("v", "a.md")).rejects.toThrow("store down");
    const w = await writeFile(fx.deps, "v", "w.md", { kind: "markdown", content: "# W\n\nw" });
    const p = await patchFile(fx.deps, "v", "n.md", { edits: [{ old: "note", new: "NOTE" }] });
    const a = await appendFile(fx.deps, "v", "n.md", new TextEncoder().encode("\nmore"));
    const m = await movePath(fx.deps, "v", "a.md", { destination: "a2.md" });
    const c = await copyPath(fx.deps, "v", "n.md", { destination: "n2.md" });
    expect([w.indexed, p.indexed, a.indexed, m.indexed, c.indexed]).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
  }, 60_000);
});

describe("reindexes run under the path's lock", () => {
  for (const op of ["move", "copy"] as const) {
    test(`a PUT started while the ${op}'s post-publish reindex runs wins`, async () => {
      const fx = await fixture(`order-${op}`);
      fx.put("a.md", "# A\n\nSTALE-CONTENT");
      fx.embedder.holdOn = "STALE-CONTENT";
      const done =
        op === "move"
          ? movePath(fx.deps, "v", "a.md", { destination: "b.md", updateLinks: false })
          : copyPath(fx.deps, "v", "a.md", { destination: "b.md" });
      await fx.embedder.held;
      // The reindex of `b.md` is mid-embed, holding `b.md`'s lock.
      const putDone = writeFile(fx.deps, "v", "b.md", {
        kind: "markdown",
        content: "# B\n\nFRESH-CONTENT",
      });
      await new Promise((r) => setTimeout(r, 30));
      fx.embedder.release();
      await done;
      expect((await putDone).indexed).toBe(true);
      const text = await fx.rowText("b.md");
      expect(text).toContain("FRESH-CONTENT");
      expect(text).not.toContain("STALE-CONTENT");
    }, 30_000);
  }
});

describe("move indexing against the real index", () => {
  test("scenario: a moved note is re-embedded under its new path", async () => {
    const fx = await fixture("reembed");
    fx.put("inbox/idea.md", "# Idea\n\nbody");
    await fx.indexer.reindex("v", "inbox/idea.md");
    fx.embedder.texts.length = 0;
    await movePath(fx.deps, "v", "inbox/idea.md", { destination: "projects/idea.md" });
    expect(await fx.indexer.indexedPaths("v", "inbox/")).toEqual([]);
    expect(await fx.indexer.indexedPaths("v", "projects/")).toEqual(["projects/idea.md"]);
    expect(fx.embedder.texts.some((t) => t.startsWith("projects/idea.md"))).toBe(true);
  }, 20_000);

  test("an outside writer recreating the old path after the rename is reconciled by the watcher", async () => {
    const fx = await fixture("recreate");
    fx.put("a.md", "# A\n\nOLD-CONTENT");
    await fx.indexer.reindex("v", "a.md");
    const deps: VaultServiceDeps = {
      ...fx.deps,
      hooks: {
        beforeStep: async (site) => {
          // No ob lock: an outside writer, right after the publish.
          if (site === "move.afterPublish") fx.put("a.md", "# A\n\nNEW-CONTENT");
        },
      },
    };
    await movePath(deps, "v", "a.md", { destination: "b.md" });
    // Eventually consistent: once the watcher processed the change, the
    // rows reflect the new content.
    await waitFor(async () => (await fx.rowText("a.md")).includes("NEW-CONTENT"));
    expect(await fx.rowText("a.md")).not.toContain("OLD-CONTENT");
  }, 20_000);

  test("a folder carrying a symlink ref.md to an outside note indexes nothing for it", async () => {
    const fx = await fixture("symlink-folder");
    const out = mkdtempSync(join(tmpdir(), "ob-move-index-out-"));
    writeFileSync(join(out, "secret.md"), "# S\n\nOUTSIDE-SECRET");
    fx.put("f/real.md", "# R\n\nreal");
    symlinkSync(join(out, "secret.md"), join(fx.root, "f", "ref.md"));
    await movePath(fx.deps, "v", "f", { destination: "g" });
    await new Promise((r) => setTimeout(r, 500));
    expect(await fx.indexer.indexedPaths("v", "")).toEqual(["g/real.md"]);
    expect(fx.embedder.texts.some((t) => t.includes("OUTSIDE-SECRET"))).toBe(false);
  }, 20_000);
});

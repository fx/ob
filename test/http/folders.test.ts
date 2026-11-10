/**
 * Folder route (create) through the real Hono app (`app.fetch` via
 * `app.request`), real `safeJoin`, and a tmpdir vault, with the fake
 * supervisor + fake indexer pattern from 0003/0004. Listing and deleting
 * folders are path operations, tested in `./paths.test.ts`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { Config } from "../../src/config/index.ts";
import { buildHttpApp } from "../../src/http/index.ts";
import type { Indexer, IndexerStatus } from "../../src/indexer/index.ts";
import type { Logger } from "../../src/log.ts";
import type { Supervisor, VaultStatus } from "../../src/obsidian/index.ts";
import { TEST_SYNC_HEALTH, TEST_WATCHDOG_OFF, makeVaultStatus } from "../helpers/vaultStatus.ts";

function silent(): Logger {
  return {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

interface FolderHttpFixture {
  readonly app: Hono;
  readonly vaultRoot: string;
  readonly drops: { slug: string; path: string }[];
}

function makeFixture(label: string): FolderHttpFixture {
  const dataDir = mkdtempSync(join(tmpdir(), `ob-${label}-`));
  const slug = "v";
  const vaultRoot = join(dataDir, "vaults", slug);
  mkdirSync(vaultRoot, { recursive: true });

  const cfg: Config = {
    obsidianAuthToken: undefined,
    vaults: [{ name: slug, slug }],
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

  const ready: IndexerStatus = {
    slug,
    state: "ready",
    documents: 0,
    chunks: 0,
    lastIndexedAt: null,
    pending: 0,
    errors: 0,
  };
  const drops: { slug: string; path: string }[] = [];
  const indexer: Indexer = {
    status: () => ready,
    list: () => [ready],
    search: async () => [],
    reindex: async () => undefined,
    drop: async (s, p) => {
      drops.push({ slug: s, path: p });
    },
    tags: async () => ({ items: [], total: 0 }),
    indexedPaths: async () => [],
    isIndexable: async () => false,
    stop: async () => undefined,
  };

  const statuses: VaultStatus[] = [makeVaultStatus({ slug })];
  const supervisor: Supervisor = {
    list: () => statuses.slice(),
    get: (s) => statuses.find((x) => x.slug === s) ?? null,
    stop: async () => undefined,
  };

  const app = buildHttpApp({ supervisor, indexer, config: cfg, logger: silent() });
  return { app, vaultRoot, drops };
}

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) {
    const r = roots.pop();
    // `r` is `<dataDir>/vaults/v`; remove the whole tmp dataDir.
    if (r !== undefined) await fs.rm(join(r, "..", ".."), { recursive: true, force: true });
  }
});

function track(fx: FolderHttpFixture): FolderHttpFixture {
  roots.push(fx.vaultRoot);
  return fx;
}

describe("PUT /v1/vaults/:slug/folders/*path", () => {
  test("create is idempotent and does not touch the folder on replay", async () => {
    const fx = track(makeFixture("folders-idempotent"));
    const first = await fx.app.request("/v1/vaults/v/folders/archive/2026", { method: "PUT" });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { created: boolean; mtimeMs: number };
    expect(firstBody.created).toBe(true);

    const second = await fx.app.request("/v1/vaults/v/folders/archive/2026", { method: "PUT" });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { created: boolean; mtimeMs: number };
    expect(secondBody.created).toBe(false);
    expect(secondBody.mtimeMs).toBe(firstBody.mtimeMs);
  });

  test("a request body is ignored (folders have no content)", async () => {
    const fx = track(makeFixture("folders-put-body"));
    const res = await fx.app.request("/v1/vaults/v/folders/withbody", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anything: "ignored" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { created: boolean }).created).toBe(true);
  });

  test("a trailing slash on the path is tolerated and stripped", async () => {
    const fx = track(makeFixture("folders-trailing"));
    const res = await fx.app.request("/v1/vaults/v/folders/archive/2026/", { method: "PUT" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { path: string }).path).toBe("archive/2026");
  });

  test("empty path does not match PUT (404)", async () => {
    const fx = track(makeFixture("folders-put-empty"));
    const res = await fx.app.request("/v1/vaults/v/folders/", { method: "PUT" });
    expect(res.status).toBe(404);
  });

  test("conflict with an existing file → 400 invalid_path, file unchanged", async () => {
    const fx = track(makeFixture("folders-conflict"));
    await fs.mkdir(join(fx.vaultRoot, "notes"), { recursive: true });
    writeFileSync(join(fx.vaultRoot, "notes/x.md"), "keep");
    const res = await fx.app.request("/v1/vaults/v/folders/notes/x.md", { method: "PUT" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_path");
    expect(await fs.readFile(join(fx.vaultRoot, "notes/x.md"), "utf8")).toBe("keep");
  });

  test("path traversal is blocked (400) and nothing is created outside the vault", async () => {
    const fx = track(makeFixture("folders-traversal"));
    // Encoded slashes keep the `..` inside a single path segment so the URL
    // parser does not normalize the traversal away before routing.
    const res = await fx.app.request("/v1/vaults/v/folders/..%2F..%2Fetc%2Fpasswd", {
      method: "PUT",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_path");
    // Nothing landed outside the vault root.
    expect(await exists(join(fx.vaultRoot, "..", "..", "etc", "passwd"))).toBe(false);
  });
});

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.lstat(abs);
    return true;
  } catch {
    return false;
  }
}

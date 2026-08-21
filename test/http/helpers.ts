/**
 * Test helpers for HTTP route tests. Builds a real Hono app via
 * `buildHttpApp`, backed by a fake supervisor and a real fake-embedder
 * indexer rooted at a `Bun.tmpdirSync()` directory.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { Config } from "../../src/config/index.ts";
import { buildHashEmbedder } from "../../src/embeddings/fake.ts";
import { buildHttpApp } from "../../src/http/index.ts";
import { type Indexer, startIndexer } from "../../src/indexer/index.ts";
import type { Logger } from "../../src/log.ts";
import type { Supervisor, VaultStatus } from "../../src/obsidian/index.ts";
import { TEST_WATCHDOG_OFF, makeVaultStatus } from "../helpers/vaultStatus.ts";

function silent(): Logger {
  return {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

export function fakeSupervisor(statuses: VaultStatus[]): Supervisor {
  return {
    list: () => statuses.slice(),
    get: (slug) => statuses.find((s) => s.slug === slug) ?? null,
    stop: async () => undefined,
  };
}

export interface HttpFixture {
  readonly app: Hono;
  readonly indexer: Indexer;
  readonly dataDir: string;
  readonly slug: string;
  readonly vaultRoot: string;
  readonly stop: () => Promise<void>;
}

export async function makeHttpFixture(label = "http"): Promise<HttpFixture> {
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
  };

  const indexer = await startIndexer(cfg, {
    logger: silent(),
    embedder: buildHashEmbedder(8),
  });

  const supervisor = fakeSupervisor([makeVaultStatus({ slug })]);

  const app = buildHttpApp({ supervisor, indexer, config: cfg, logger: silent() });

  return {
    app,
    indexer,
    dataDir,
    slug,
    vaultRoot,
    stop: async (): Promise<void> => {
      await indexer.stop();
    },
  };
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  pollMs = 25,
): Promise<void> {
  const start = Date.now();
  while (true) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise<void>((r) => setTimeout(r, pollMs));
  }
}

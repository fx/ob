import { describe, expect, test } from "bun:test";
import { buildHttpApp } from "../src/http/index.ts";
import type { Indexer, IndexerStatus } from "../src/indexer/index.ts";
import type { Supervisor, VaultStatus } from "../src/obsidian/index.ts";
import { TEST_WATCHDOG_OFF, makeVaultStatus } from "./helpers/vaultStatus.ts";

interface ReadyzBody {
  readonly ok: boolean;
  readonly vaults: VaultStatus[];
  readonly indexers: IndexerStatus[];
}

function fakeSupervisor(statuses: VaultStatus[] = []): Supervisor {
  return {
    list: () => statuses.slice(),
    get: (slug) => statuses.find((s) => s.slug === slug) ?? null,
    stop: async () => undefined,
  };
}

function readyIndexer(slug: string): IndexerStatus {
  return {
    slug,
    state: "ready",
    documents: 1,
    chunks: 1,
    lastIndexedAt: 100,
    pending: 0,
    errors: 0,
  };
}

/** Minimal `Indexer` whose only meaningful method for `/readyz` is `list()`. */
function fakeIndexer(statuses: IndexerStatus[]): Indexer {
  return {
    list: () => statuses.slice(),
    status: (slug) => statuses.find((s) => s.slug === slug) ?? null,
    search: async () => [],
    reindex: async () => undefined,
    drop: async () => undefined,
    stop: async () => undefined,
  };
}

describe("buildHttpApp", () => {
  test("GET /healthz returns 200 {ok:true}", async () => {
    const app = buildHttpApp();
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body).toEqual({ ok: true });
  });

  test("returns 404 for unknown routes", async () => {
    const app = buildHttpApp();
    const res = await app.request("/unknown");
    expect(res.status).toBe(404);
  });

  test("buildHttpApp can be called with no args (default deps)", () => {
    expect(buildHttpApp()).toBeDefined();
  });

  test("buildHttpApp builds a default silent logger when none is passed", async () => {
    // No-logger path. The default `silentWrite` fires when the access-log
    // middleware tries to emit, but the logger is at error-level so the
    // info call is filtered. We exercise `silentWrite` via a 500 path —
    // mount /v1 routes with a fake indexer that throws.
    const app = buildHttpApp({
      supervisor: {
        list: () => [makeVaultStatus({ slug: "v" })],
        get: (s) => (s === "v" ? makeVaultStatus({ slug: "v" }) : null),
        stop: async () => undefined,
      },
      indexer: {
        list: () => [],
        status: () => null,
        search: async (): Promise<never> => {
          throw new Error("indexer down");
        },
        reindex: async () => undefined,
        drop: async () => undefined,
        stop: async () => undefined,
      },
      config: {
        obsidianAuthToken: undefined,
        vaults: [{ name: "v", slug: "v" }],
        dataDir: "/tmp/no-such-dir",
        httpPort: 0,
        httpHost: "127.0.0.1",
        embeddingProvider: "transformers",
        embeddingModel: "x",
        logLevel: "error",
        syncConfigEnv: {},
        syncWatchdog: TEST_WATCHDOG_OFF,
      },
    });
    const res = await app.request("/v1/vaults/v/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "x" }),
    });
    expect(res.status).toBe(500);
  });

  test("GET /readyz returns 503 when no supervisor is wired (empty vaults)", async () => {
    const app = buildHttpApp();
    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
    const body = (await res.json()) as ReadyzBody;
    expect(body.ok).toBe(false);
    expect(body.vaults).toEqual([]);
    expect(body.indexers).toEqual([]);
  });

  test("GET /readyz returns 200 with ok:true when every vault is running and indexed", async () => {
    const app = buildHttpApp({
      supervisor: fakeSupervisor([makeVaultStatus({ slug: "v" })]),
      indexer: fakeIndexer([readyIndexer("v")]),
    });
    const res = await app.request("/readyz");
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReadyzBody;
    expect(body.ok).toBe(true);
    expect(body.vaults.map((v) => v.slug)).toEqual(["v"]);
    expect(body.indexers.map((i) => i.slug)).toEqual(["v"]);
  });

  test("GET /readyz holds at 503 when a configured vault's indexer has not registered", async () => {
    // The hole this closes: an unregistered indexer used to be simply absent
    // from `indexers`, so it could not hold the response at 503.
    const app = buildHttpApp({
      supervisor: fakeSupervisor([makeVaultStatus({ slug: "v" })]),
      indexer: fakeIndexer([]),
    });
    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
    const body = (await res.json()) as ReadyzBody;
    expect(body.ok).toBe(false);
    expect(body.indexers).toHaveLength(1);
    expect(body.indexers[0]?.slug).toBe("v");
    expect(body.indexers[0]?.state).toBe("starting");
  });

  test("GET /readyz synthesizes an indexer entry when no indexer is wired at all", async () => {
    const app = buildHttpApp({ supervisor: fakeSupervisor([makeVaultStatus({ slug: "v" })]) });
    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
    const body = (await res.json()) as ReadyzBody;
    expect(body.indexers).toHaveLength(1);
    expect(body.indexers[0]?.state).toBe("starting");
  });

  test("GET /readyz returns 503 with vaults payload when any vault is not running", async () => {
    const app = buildHttpApp({
      supervisor: fakeSupervisor([
        makeVaultStatus({ slug: "a" }),
        makeVaultStatus({ slug: "b", state: "failed", pid: null, restarts: 10, lastError: "loop" }),
      ]),
      indexer: fakeIndexer([readyIndexer("a"), readyIndexer("b")]),
    });
    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
    const body = (await res.json()) as ReadyzBody;
    expect(body.ok).toBe(false);
    expect(body.vaults.find((v) => v.slug === "b")?.state).toBe("failed");
  });

  test("GET /readyz returns 503 when a registered indexer is not ready", async () => {
    const app = buildHttpApp({
      supervisor: fakeSupervisor([makeVaultStatus({ slug: "v" })]),
      indexer: fakeIndexer([{ ...readyIndexer("v"), state: "scanning" }]),
    });
    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
  });

  test("GET /readyz arrays are configuration-ordered and positionally correlatable", async () => {
    // The indexer deliberately reports its vaults in the opposite order and
    // omits one; both arrays must still come back in configuration order.
    const app = buildHttpApp({
      supervisor: fakeSupervisor([
        makeVaultStatus({ slug: "alpha" }),
        makeVaultStatus({ slug: "beta" }),
        makeVaultStatus({ slug: "gamma" }),
      ]),
      indexer: fakeIndexer([readyIndexer("gamma"), readyIndexer("alpha")]),
    });
    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
    const body = (await res.json()) as ReadyzBody;
    expect(body.vaults.map((v) => v.slug)).toEqual(["alpha", "beta", "gamma"]);
    expect(body.indexers.map((i) => i.slug)).toEqual(["alpha", "beta", "gamma"]);
    for (let i = 0; i < body.vaults.length; i++) {
      expect(body.indexers[i]?.slug).toBe(body.vaults[i]?.slug ?? "");
    }
    expect(body.indexers[1]?.state).toBe("starting");
  });

  test("GET /readyz carries the watchdog sub-object through untouched", async () => {
    const vault = makeVaultStatus({
      slug: "v",
      lastSyncActivityAt: 1_700_000_000_000,
      watchdog: {
        state: "tailing",
        logPath: "/cfg/obsidian-headless/sync/abc/sync.log",
        thresholdMs: 0,
        pollIntervalMs: 30_000,
        stallKills: 0,
      },
    });
    const app = buildHttpApp({
      supervisor: fakeSupervisor([vault]),
      indexer: fakeIndexer([readyIndexer("v")]),
    });
    const res = await app.request("/readyz");
    const body = (await res.json()) as ReadyzBody;
    expect(body.vaults[0]?.lastSyncActivityAt).toBe(1_700_000_000_000);
    expect(body.vaults[0]?.watchdog).toEqual(vault.watchdog);
  });

  test("GET /healthz stays 200 while /readyz reports 503", async () => {
    const app = buildHttpApp({
      supervisor: fakeSupervisor([makeVaultStatus({ slug: "v", state: "failed", pid: null })]),
      indexer: fakeIndexer([readyIndexer("v")]),
    });
    expect((await app.request("/readyz")).status).toBe(503);
    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
  });
});

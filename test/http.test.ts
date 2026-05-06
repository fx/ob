import { describe, expect, test } from "bun:test";
import { buildHttpApp } from "../src/http/index.ts";
import type { Supervisor, VaultStatus } from "../src/obsidian/index.ts";

function fakeSupervisor(statuses: VaultStatus[] = []): Supervisor {
  return {
    list: () => statuses.slice(),
    get: (slug) => statuses.find((s) => s.slug === slug) ?? null,
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
        list: () => [
          { slug: "v", name: "v", state: "running", pid: 1, restarts: 0, lastError: null },
        ],
        get: (s) =>
          s === "v"
            ? {
                slug: "v",
                name: "v",
                state: "running" as const,
                pid: 1,
                restarts: 0,
                lastError: null,
              }
            : null,
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
    const body = (await res.json()) as { vaults: VaultStatus[] };
    expect(body.vaults).toEqual([]);
  });

  test("GET /readyz returns 200 when every vault is running", async () => {
    const app = buildHttpApp({
      supervisor: fakeSupervisor([
        { slug: "v", name: "v", state: "running", pid: 1, restarts: 0, lastError: null },
      ]),
    });
    const res = await app.request("/readyz");
    expect(res.status).toBe(200);
  });

  test("GET /readyz returns 503 with vaults payload when any vault is not running", async () => {
    const app = buildHttpApp({
      supervisor: fakeSupervisor([
        { slug: "a", name: "a", state: "running", pid: 1, restarts: 0, lastError: null },
        { slug: "b", name: "b", state: "failed", pid: null, restarts: 10, lastError: "loop" },
      ]),
    });
    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { vaults: VaultStatus[] };
    expect(body.vaults.find((v) => v.slug === "b")?.state).toBe("failed");
  });
});

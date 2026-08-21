import { afterEach, expect, test } from "bun:test";
import { callMcp, callRestJson, makeParityFixture, waitFor } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

test("vault_status parity (success)", async () => {
  const fx = await makeParityFixture({ label: "p-vs" });
  cleanup.push(fx.stop);
  await waitFor(() => fx.indexer.status("v")?.state === "ready");
  const mcp = await callMcp(fx, "vault_status", { vault: "v" });
  const rest = await callRestJson(fx, "GET", "/v1/vaults/v");
  // Assert success on both adapters BEFORE comparing bodies — body
  // equality on its own would let two matching error envelopes pass as
  // "parity" on what is supposed to be the happy path.
  expect(mcp.isError).toBe(false);
  expect(rest.status).toBe(200);
  expect(mcp.body).toEqual(rest.body);
});

test("the new sync-status fields reach /readyz, both REST vault routes, and MCP alike", async () => {
  // Spec scenario "Status fields reach every surface": all four surfaces
  // MUST report identical `lastSyncActivityAt` and `watchdog` values.
  const fx = await makeParityFixture({ label: "p-vs-wd" });
  cleanup.push(fx.stop);
  await waitFor(() => fx.indexer.status("v")?.state === "ready");

  const mcp = await callMcp(fx, "vault_status", { vault: "v" });
  const restOne = await callRestJson(fx, "GET", "/v1/vaults/v");
  const restList = await callRestJson(fx, "GET", "/v1/vaults");
  const readyz = await callRestJson(fx, "GET", "/readyz");

  const expected = {
    lastSyncActivityAt: 1_700_000_000_000,
    watchdog: {
      state: "tailing",
      logPath: "/cfg/obsidian-headless/sync/v/sync.log",
      thresholdMs: 300_000,
      pollIntervalMs: 30_000,
      stallKills: 0,
    },
  };
  const pick = (sync: unknown): unknown => {
    const s = sync as { lastSyncActivityAt: unknown; watchdog: unknown };
    return { lastSyncActivityAt: s.lastSyncActivityAt, watchdog: s.watchdog };
  };

  expect(pick((mcp.body as { sync: unknown }).sync)).toEqual(expected);
  expect(pick((restOne.body as { sync: unknown }).sync)).toEqual(expected);
  expect(pick((restList.body as { sync: unknown }[])[0]?.sync)).toEqual(expected);
  expect(pick((readyz.body as { vaults: unknown[] }).vaults[0])).toEqual(expected);
});

test("vault_status parity (vault_not_found)", async () => {
  const fx = await makeParityFixture({ label: "p-vs-404" });
  cleanup.push(fx.stop);
  const mcp = await callMcp(fx, "vault_status", { vault: "ghost" });
  const rest = await callRestJson(fx, "GET", "/v1/vaults/ghost");
  expect(mcp.isError).toBe(true);
  expect(rest.isError).toBe(true);
  expect((mcp.body as { code: string }).code).toBe((rest.body as { code: string }).code);
  expect((mcp.body as { code: string }).code).toBe("vault_not_found");
});

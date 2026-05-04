import { afterEach, expect, test } from "bun:test";
import { callMcp, callRestJson, makeParityFixture, waitFor } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

test("list_vaults parity (success)", async () => {
  const fx = await makeParityFixture({ label: "p-lv" });
  cleanup.push(fx.stop);
  // Indexer transitions starting → scanning → ready asynchronously; pin it
  // to ready so two back-to-back snapshots agree.
  await waitFor(() => fx.indexer.status("v")?.state === "ready");
  const mcp = await callMcp(fx, "list_vaults", {});
  const rest = await callRestJson(fx, "GET", "/v1/vaults");
  expect(mcp.isError).toBe(false);
  expect(rest.isError).toBe(false);
  // Both adapters return the same bare `VaultSummary[]`; deep-equal directly.
  expect(mcp.body).toEqual(rest.body);
});

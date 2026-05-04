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

import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { callMcp, callRestJson, makeParityFixture, waitFor } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

test("search parity (deterministic fake embedder, same hits)", async () => {
  const fx = await makeParityFixture({ label: "p-sr" });
  cleanup.push(fx.stop);
  await waitFor(() => fx.indexer.status("v")?.state === "ready");
  writeFileSync(join(fx.vaultRoot, "coffee.md"), "# Coffee brewing methods");
  writeFileSync(join(fx.vaultRoot, "tea.md"), "# Tea steeping times");
  await fx.indexer.reindex("v", "coffee.md");
  await fx.indexer.reindex("v", "tea.md");
  const args = { query: "how do I make pour over", limit: 5 } as const;
  const mcp = await callMcp(fx, "search", { vault: "v", ...args });
  const rest = await callRestJson(fx, "POST", "/v1/vaults/v/search", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args),
  });
  // Assert success on both adapters BEFORE comparing bodies — body
  // equality on its own would let two matching error envelopes pass as
  // "parity" even though the test is supposed to lock the success case.
  expect(mcp.isError).toBe(false);
  expect(rest.status).toBe(200);
  expect(mcp.body).toEqual(rest.body);
});

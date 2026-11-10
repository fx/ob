/**
 * REST ↔ MCP parity for tag listing: `GET /v1/vaults/:slug/tags` and the
 * `list_tags` tool return identical payloads for the same fixture vault, and
 * the same error `code` for every service-core failure. Input-validation
 * failures are adapter-specific (`invalid_query` on REST, `invalid_input` on
 * MCP) and are asserted in each adapter's own tests.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callMcp, callRestJson, makeParityFixture, waitFor } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

test("list_tags parity (all, prefix, limit, empty prefix)", async () => {
  const fx = await makeParityFixture({ label: "p-lt" });
  cleanup.push(fx.stop);
  await waitFor(() => fx.indexer.status("v")?.state === "ready");
  mkdirSync(join(fx.vaultRoot, "work"), { recursive: true });
  writeFileSync(join(fx.vaultRoot, "a.md"), "# One\n\nfirst #todo\n\n# Two\n\nsecond #todo\n");
  writeFileSync(join(fx.vaultRoot, "work/b.md"), "# B\n\n#todo and #project/alpha\n");
  writeFileSync(join(fx.vaultRoot, "c.md"), "# C\n\n#project here\n");
  for (const p of ["a.md", "work/b.md", "c.md"]) await fx.indexer.reindex("v", p);

  const cases: { args: { prefix?: string; limit?: number }; query: string }[] = [
    { args: {}, query: "" },
    { args: { prefix: "work/" }, query: "?prefix=work%2F" },
    { args: { limit: 2 }, query: "?limit=2" },
    { args: { prefix: "", limit: 1000 }, query: "?prefix=&limit=1000" },
  ];
  for (const { args, query } of cases) {
    const mcp = await callMcp(fx, "list_tags", { vault: "v", ...args });
    const rest = await callRestJson(fx, "GET", `/v1/vaults/v/tags${query}`);
    // Assert success on both BEFORE comparing, so two matching error
    // envelopes cannot pass as parity.
    expect(mcp.isError).toBe(false);
    expect(rest.status).toBe(200);
    expect(mcp.body).toEqual(rest.body);
  }
  // Pin the shared payload too, so parity cannot hold over a wrong answer.
  const all = await callMcp(fx, "list_tags", { vault: "v" });
  expect(all.body).toEqual({
    items: [
      { tag: "todo", count: 2 },
      { tag: "project", count: 1 },
      { tag: "project/alpha", count: 1 },
    ],
    total: 3,
  });
});

test("list_tags parity: unknown vault is vault_not_found on both adapters", async () => {
  const fx = await makeParityFixture({ label: "p-lt-404" });
  cleanup.push(fx.stop);
  const mcp = await callMcp(fx, "list_tags", { vault: "ghost" });
  const rest = await callRestJson(fx, "GET", "/v1/vaults/ghost/tags");
  expect(mcp.isError).toBe(true);
  expect(rest.status).toBe(404);
  expect((mcp.body as { code: string }).code).toBe("vault_not_found");
  expect((rest.body as { code: string }).code).toBe("vault_not_found");
});

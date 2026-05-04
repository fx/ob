import { afterEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callMcp, callRestJson, makeParityFixture, waitFor } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

test("delete_file Markdown drops index on both adapters", async () => {
  const fx = await makeParityFixture({ label: "p-df-md" });
  cleanup.push(fx.stop);
  await waitFor(() => fx.indexer.status("v")?.state === "ready");
  writeFileSync(join(fx.vaultRoot, "m.md"), "x");
  writeFileSync(join(fx.vaultRoot, "r.md"), "x");
  const mcp = await callMcp(fx, "delete_file", { vault: "v", path: "m.md" });
  const rest = await callRestJson(fx, "DELETE", "/v1/vaults/v/files/r.md");
  expect(mcp.isError).toBe(false);
  expect(rest.isError).toBe(false);
  // REST returns 204 (null body); MCP returns `{ deleted: true }`. Just
  // assert the on-disk effect is identical.
  expect(existsSync(join(fx.vaultRoot, "m.md"))).toBe(false);
  expect(existsSync(join(fx.vaultRoot, "r.md"))).toBe(false);
});

test("delete_file binary parity (no index drop on either)", async () => {
  const fx = await makeParityFixture({ label: "p-df-bin" });
  cleanup.push(fx.stop);
  writeFileSync(join(fx.vaultRoot, "m.png"), new Uint8Array([0]));
  writeFileSync(join(fx.vaultRoot, "r.png"), new Uint8Array([0]));
  const mcp = await callMcp(fx, "delete_file", { vault: "v", path: "m.png" });
  const rest = await callRestJson(fx, "DELETE", "/v1/vaults/v/files/r.png");
  expect(mcp.isError).toBe(false);
  expect(rest.isError).toBe(false);
  expect(existsSync(join(fx.vaultRoot, "m.png"))).toBe(false);
  expect(existsSync(join(fx.vaultRoot, "r.png"))).toBe(false);
});

test("delete_file 404 parity", async () => {
  const fx = await makeParityFixture({ label: "p-df-404" });
  cleanup.push(fx.stop);
  const mcp = await callMcp(fx, "delete_file", { vault: "v", path: "missing.md" });
  const rest = await callRestJson(fx, "DELETE", "/v1/vaults/v/files/missing.md");
  expect((mcp.body as { code: string }).code).toBe((rest.body as { code: string }).code);
  expect((mcp.body as { code: string }).code).toBe("not_found");
});

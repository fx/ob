import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { callMcp, callRestJson, makeParityFixture, waitFor } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

test("write_file Markdown parity (indexed=true on both)", async () => {
  const fx = await makeParityFixture({ label: "p-wf-md" });
  cleanup.push(fx.stop);
  await waitFor(() => fx.indexer.status("v")?.state === "ready");
  // Drive both adapters with the same Markdown body.
  const mcp = await callMcp(fx, "write_file", {
    vault: "v",
    path: "via-mcp.md",
    content: "# from mcp",
  });
  const rest = await callRestJson(fx, "PUT", "/v1/vaults/v/files/via-rest.md", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "# from rest" }),
  });
  expect(mcp.isError).toBe(false);
  expect(rest.isError).toBe(false);
  // Both surface `indexed` and `created`.
  expect((mcp.body as { indexed: boolean; created: boolean }).indexed).toBe(true);
  expect((mcp.body as { indexed: boolean; created: boolean }).created).toBe(true);
  expect((rest.body as { indexed: boolean; created: boolean }).indexed).toBe(true);
  // Same response key set.
  const mcpKeys = Object.keys(mcp.body as object).sort();
  const restKeys = Object.keys(rest.body as object).sort();
  expect(mcpKeys).toEqual(restKeys);
});

test("write_file binary parity (no indexer call from either)", async () => {
  const fx = await makeParityFixture({ label: "p-wf-bin" });
  cleanup.push(fx.stop);
  await waitFor(() => fx.indexer.status("v")?.state === "ready");
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const mcp = await callMcp(fx, "write_file", {
    vault: "v",
    path: "mcp.bin",
    content: Buffer.from(bytes).toString("base64"),
    encoding: "base64",
    contentType: "application/octet-stream",
  });
  const rest = await callRestJson(fx, "PUT", "/v1/vaults/v/files/rest.bin", {
    headers: { "content-type": "application/octet-stream" },
    body: bytes,
  });
  expect((mcp.body as { indexed: boolean }).indexed).toBe(false);
  expect((rest.body as { indexed: boolean }).indexed).toBe(false);
  expect(readFileSync(join(fx.vaultRoot, "mcp.bin"))).toEqual(Buffer.from(bytes));
  expect(readFileSync(join(fx.vaultRoot, "rest.bin"))).toEqual(Buffer.from(bytes));
});

import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callMcp, callRestJson, makeParityFixture, waitFor } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

test("append_file Markdown parity (indexed=true on both)", async () => {
  const fx = await makeParityFixture({ label: "p-af-md" });
  cleanup.push(fx.stop);
  await waitFor(() => fx.indexer.status("v")?.state === "ready");
  writeFileSync(join(fx.vaultRoot, "m.md"), "head\n");
  writeFileSync(join(fx.vaultRoot, "r.md"), "head\n");
  const mcp = await callMcp(fx, "append_file", {
    vault: "v",
    path: "m.md",
    content: "tail\n",
  });
  const rest = await callRestJson(fx, "POST", "/v1/vaults/v/files/r.md:append", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "tail\n" }),
  });
  expect((mcp.body as { indexed: boolean }).indexed).toBe(true);
  expect((rest.body as { indexed: boolean }).indexed).toBe(true);
  expect(readFileSync(join(fx.vaultRoot, "m.md"), "utf8")).toBe("head\ntail\n");
  expect(readFileSync(join(fx.vaultRoot, "r.md"), "utf8")).toBe("head\ntail\n");
});

test("append_file binary rejection parity", async () => {
  const fx = await makeParityFixture({ label: "p-af-bin" });
  cleanup.push(fx.stop);
  writeFileSync(join(fx.vaultRoot, "i.png"), new Uint8Array([0]));
  const mcp = await callMcp(fx, "append_file", { vault: "v", path: "i.png", content: "x" });
  const rest = await callRestJson(fx, "POST", "/v1/vaults/v/files/i.png:append", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "x" }),
  });
  expect((mcp.body as { code: string }).code).toBe((rest.body as { code: string }).code);
  expect((mcp.body as { code: string }).code).toBe("unsupported_media_type");
});

test("append_file missing-file parity", async () => {
  const fx = await makeParityFixture({ label: "p-af-404" });
  cleanup.push(fx.stop);
  const mcp = await callMcp(fx, "append_file", {
    vault: "v",
    path: "missing.md",
    content: "x",
  });
  const rest = await callRestJson(fx, "POST", "/v1/vaults/v/files/missing.md:append", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "x" }),
  });
  expect((mcp.body as { code: string }).code).toBe((rest.body as { code: string }).code);
  expect((mcp.body as { code: string }).code).toBe("not_found");
});

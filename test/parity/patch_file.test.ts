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

test("patch_file single-edit parity", async () => {
  const fx = await makeParityFixture({ label: "p-pf-ok" });
  cleanup.push(fx.stop);
  await waitFor(() => fx.indexer.status("v")?.state === "ready");
  writeFileSync(join(fx.vaultRoot, "m.md"), "foo\nbody\n");
  writeFileSync(join(fx.vaultRoot, "r.md"), "foo\nbody\n");
  const mcp = await callMcp(fx, "patch_file", {
    vault: "v",
    path: "m.md",
    edits: [{ old: "foo", new: "bar" }],
  });
  const rest = await callRestJson(fx, "PATCH", "/v1/vaults/v/files/r.md", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ edits: [{ old: "foo", new: "bar" }] }),
  });
  expect(mcp.isError).toBe(false);
  expect(rest.isError).toBe(false);
  // Both report 1 edit applied; both indexed=true.
  expect((mcp.body as { edits: number }).edits).toBe(1);
  expect((rest.body as { edits: number }).edits).toBe(1);
  expect(readFileSync(join(fx.vaultRoot, "m.md"), "utf8")).toBe("bar\nbody\n");
  expect(readFileSync(join(fx.vaultRoot, "r.md"), "utf8")).toBe("bar\nbody\n");
});

test("patch_file ambiguous abort parity", async () => {
  const fx = await makeParityFixture({ label: "p-pf-amb" });
  cleanup.push(fx.stop);
  writeFileSync(join(fx.vaultRoot, "x.md"), "foo\nfoo\n");
  const mcp = await callMcp(fx, "patch_file", {
    vault: "v",
    path: "x.md",
    edits: [{ old: "foo", new: "bar" }],
  });
  const rest = await callRestJson(fx, "PATCH", "/v1/vaults/v/files/x.md", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ edits: [{ old: "foo", new: "bar" }] }),
  });
  expect(mcp.isError).toBe(true);
  expect(rest.isError).toBe(true);
  expect((mcp.body as { code: string }).code).toBe("patch_ambiguous");
  expect((rest.body as { code: string }).code).toBe("patch_ambiguous");
  // Both surface `editIndex` + `occurrences` in details.
  expect((mcp.body as { details: { editIndex: number; occurrences: number } }).details).toEqual({
    editIndex: 0,
    occurrences: 2,
  });
  expect((rest.body as { details: { editIndex: number; occurrences: number } }).details).toEqual({
    editIndex: 0,
    occurrences: 2,
  });
});

test("patch_file binary rejection parity", async () => {
  const fx = await makeParityFixture({ label: "p-pf-bin" });
  cleanup.push(fx.stop);
  writeFileSync(join(fx.vaultRoot, "i.png"), new Uint8Array([0]));
  const mcp = await callMcp(fx, "patch_file", {
    vault: "v",
    path: "i.png",
    edits: [{ old: "x", new: "y" }],
  });
  const rest = await callRestJson(fx, "PATCH", "/v1/vaults/v/files/i.png", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ edits: [{ old: "x", new: "y" }] }),
  });
  expect((mcp.body as { code: string }).code).toBe((rest.body as { code: string }).code);
  expect((mcp.body as { code: string }).code).toBe("unsupported_media_type");
});

test("patch_file missing file parity", async () => {
  const fx = await makeParityFixture({ label: "p-pf-404" });
  cleanup.push(fx.stop);
  const mcp = await callMcp(fx, "patch_file", {
    vault: "v",
    path: "missing.md",
    edits: [{ old: "a", new: "b" }],
  });
  const rest = await callRestJson(fx, "PATCH", "/v1/vaults/v/files/missing.md", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ edits: [{ old: "a", new: "b" }] }),
  });
  expect((mcp.body as { code: string }).code).toBe((rest.body as { code: string }).code);
  expect((mcp.body as { code: string }).code).toBe("not_found");
});

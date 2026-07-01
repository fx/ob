import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callMcp, callRestBytes, callRestJson, makeParityFixture } from "./helpers.ts";

const PDF_FIXTURES = join(import.meta.dir, "../fixtures/pdf");
function pdfFixture(name: string): Uint8Array {
  const buf = readFileSync(join(PDF_FIXTURES, name));
  const view = new Uint8Array(buf.byteLength);
  view.set(buf);
  return view;
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

test("read_file Markdown parity (utf-8, JSON-shape match)", async () => {
  const fx = await makeParityFixture({ label: "p-rf-md" });
  cleanup.push(fx.stop);
  writeFileSync(join(fx.vaultRoot, "x.md"), "---\ntitle: hi\n---\n# body");
  const mcp = await callMcp(fx, "read_file", { vault: "v", path: "x.md" });
  const rest = await callRestJson(fx, "GET", "/v1/vaults/v/files/x.md");
  expect(mcp.isError).toBe(false);
  // REST JSON variant returns `{ path, content, frontmatter, mtimeMs, size,
  // sha256 }`. MCP wraps with `encoding` + `contentType`. Strip those for
  // the equality check.
  const mcpBody = mcp.body as Record<string, unknown>;
  expect(mcpBody.encoding).toBe("utf-8");
  const stripped = { ...mcpBody } as Record<string, unknown>;
  // biome-ignore lint/performance/noDelete: test-only one-off shape normalization
  delete stripped.encoding;
  // biome-ignore lint/performance/noDelete: test-only one-off shape normalization
  delete stripped.contentType;
  expect(stripped).toEqual(rest.body as Record<string, unknown>);
});

test("read_file binary parity (base64 round-trip)", async () => {
  const fx = await makeParityFixture({ label: "p-rf-bin" });
  cleanup.push(fx.stop);
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  writeFileSync(join(fx.vaultRoot, "i.png"), bytes);
  const mcp = await callMcp(fx, "read_file", { vault: "v", path: "i.png" });
  const rest = await callRestBytes(fx, "/v1/vaults/v/files/i.png");
  expect(rest.status).toBe(200);
  const mcpBody = mcp.body as { encoding: string; content: string; contentType: string };
  expect(mcpBody.encoding).toBe("base64");
  expect(mcpBody.contentType).toBe("image/png");
  const decoded = Buffer.from(mcpBody.content, "base64");
  expect(Array.from(decoded)).toEqual(Array.from(rest.bytes));
  expect(rest.res.headers.get("content-type")).toBe("image/png");
});

test("read_file PDF text parity (MCP format:text vs REST JSON)", async () => {
  const fx = await makeParityFixture({ label: "p-rf-pdf" });
  cleanup.push(fx.stop);
  writeFileSync(join(fx.vaultRoot, "paper.pdf"), pdfFixture("text.pdf"));
  const mcp = await callMcp(fx, "read_file", { vault: "v", path: "paper.pdf" });
  const rest = await callRestJson(fx, "GET", "/v1/vaults/v/files/paper.pdf");
  expect(mcp.isError).toBe(false);
  expect(rest.isError).toBe(false);
  const mcpBody = mcp.body as Record<string, unknown>;
  expect(mcpBody.encoding).toBe("utf-8");
  // REST omits the MCP-only `encoding` field; everything else — including the
  // `pdf` metadata and on-disk `size`/`sha256` — must be structurally equal.
  const stripped = { ...mcpBody } as Record<string, unknown>;
  // biome-ignore lint/performance/noDelete: test-only one-off shape normalization
  delete stripped.encoding;
  expect(stripped).toEqual(rest.body as Record<string, unknown>);
});

test("read_file PDF binary parity (MCP format:binary vs REST plain GET)", async () => {
  const fx = await makeParityFixture({ label: "p-rf-pdf-bin" });
  cleanup.push(fx.stop);
  const bytes = pdfFixture("text.pdf");
  writeFileSync(join(fx.vaultRoot, "paper.pdf"), bytes);
  const mcp = await callMcp(fx, "read_file", { vault: "v", path: "paper.pdf", format: "binary" });
  const rest = await callRestBytes(fx, "/v1/vaults/v/files/paper.pdf");
  expect(rest.status).toBe(200);
  const mcpBody = mcp.body as { encoding: string; content: string };
  expect(mcpBody.encoding).toBe("base64");
  const decoded = Buffer.from(mcpBody.content, "base64");
  expect(Array.from(decoded)).toEqual(Array.from(rest.bytes));
});

test("read_file PDF extraction_failed parity", async () => {
  const fx = await makeParityFixture({ label: "p-rf-pdf-broken" });
  cleanup.push(fx.stop);
  writeFileSync(join(fx.vaultRoot, "bad.pdf"), pdfFixture("broken.pdf"));
  const mcp = await callMcp(fx, "read_file", { vault: "v", path: "bad.pdf" });
  const rest = await callRestJson(fx, "GET", "/v1/vaults/v/files/bad.pdf");
  expect(mcp.isError).toBe(true);
  expect(rest.isError).toBe(true);
  expect((mcp.body as { code: string }).code).toBe((rest.body as { code: string }).code);
  expect((mcp.body as { code: string }).code).toBe("extraction_failed");
});

test("read_file 404 parity", async () => {
  const fx = await makeParityFixture({ label: "p-rf-404" });
  cleanup.push(fx.stop);
  const mcp = await callMcp(fx, "read_file", { vault: "v", path: "missing.md" });
  const rest = await callRestJson(fx, "GET", "/v1/vaults/v/files/missing.md");
  expect(mcp.isError).toBe(true);
  expect(rest.isError).toBe(true);
  expect((mcp.body as { code: string }).code).toBe((rest.body as { code: string }).code);
  expect((mcp.body as { code: string }).code).toBe("not_found");
});

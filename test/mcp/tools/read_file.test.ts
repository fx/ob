/**
 * `read_file` tool — utf-8 (Markdown + plain text), base64 (binary),
 * 404 path, validation.
 */

import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPdfFixture } from "../../helpers/loadPdfFixture.ts";
import { makeMcpFixture } from "../helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

test("read_file returns utf-8 + parsed frontmatter for Markdown", async () => {
  const fx = await makeMcpFixture({ label: "tool-rf-md" });
  cleanup.push(fx.stop);
  writeFileSync(join(fx.vaultRoot, "x.md"), "---\ntitle: hi\n---\n# body");
  const r = await fx.callTool("read_file", { vault: "v", path: "x.md" });
  expect(r.isError).toBeUndefined();
  const parsed = r.parsed as {
    encoding: string;
    content: string;
    frontmatter: Record<string, unknown>;
    contentType: string;
  };
  expect(parsed.encoding).toBe("utf-8");
  expect(parsed.contentType).toContain("text/markdown");
  expect(parsed.content).toBe("# body");
  expect(parsed.frontmatter.title).toBe("hi");
});

test("read_file returns utf-8 for plain text without frontmatter wrapper", async () => {
  const fx = await makeMcpFixture({ label: "tool-rf-txt" });
  cleanup.push(fx.stop);
  writeFileSync(join(fx.vaultRoot, "n.txt"), "plain");
  const r = await fx.callTool("read_file", { vault: "v", path: "n.txt" });
  const parsed = r.parsed as { encoding: string; content: string; frontmatter?: unknown };
  expect(parsed.encoding).toBe("utf-8");
  expect(parsed.content).toBe("plain");
  expect(parsed.frontmatter).toBeUndefined();
});

test("read_file returns base64 for binary", async () => {
  const fx = await makeMcpFixture({ label: "tool-rf-bin" });
  cleanup.push(fx.stop);
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  writeFileSync(join(fx.vaultRoot, "i.png"), bytes);
  const r = await fx.callTool("read_file", { vault: "v", path: "i.png" });
  const parsed = r.parsed as { encoding: string; content: string; contentType: string };
  expect(parsed.encoding).toBe("base64");
  expect(parsed.contentType).toBe("image/png");
  const decoded = Buffer.from(parsed.content, "base64");
  expect(Array.from(decoded)).toEqual(Array.from(bytes));
});

test("read_file 404 yields not_found", async () => {
  const fx = await makeMcpFixture({ label: "tool-rf-404" });
  cleanup.push(fx.stop);
  const r = await fx.callTool("read_file", { vault: "v", path: "missing.md" });
  expect(r.isError).toBe(true);
  expect((r.parsed as { code: string }).code).toBe("not_found");
});

test("read_file invalid input (missing path)", async () => {
  const fx = await makeMcpFixture({ label: "tool-rf-bad" });
  cleanup.push(fx.stop);
  const r = await fx.callTool("read_file", { vault: "v" });
  expect(r.isError).toBe(true);
  expect((r.parsed as { code: string }).code).toBe("invalid_input");
});

test("read_file returns extracted text for a PDF by default", async () => {
  const fx = await makeMcpFixture({ label: "tool-rf-pdf" });
  cleanup.push(fx.stop);
  writeFileSync(join(fx.vaultRoot, "paper.pdf"), loadPdfFixture("text.pdf"));
  const r = await fx.callTool("read_file", { vault: "v", path: "paper.pdf" });
  expect(r.isError).toBeUndefined();
  const parsed = r.parsed as {
    encoding: string;
    content: string;
    contentType: string;
    pdf: { pages: number; hasTextLayer: boolean };
    frontmatter?: unknown;
  };
  expect(parsed.encoding).toBe("utf-8");
  expect(parsed.contentType).toBe("application/pdf");
  expect(parsed.content).toBe("alpha\n\n<!-- page 2 -->\n\nbeta");
  expect(parsed.pdf).toEqual({ pages: 2, hasTextLayer: true });
  expect(parsed.frontmatter).toBeUndefined();
});

test("read_file reports hasTextLayer false for a scanned PDF", async () => {
  const fx = await makeMcpFixture({ label: "tool-rf-pdf-scan" });
  cleanup.push(fx.stop);
  writeFileSync(join(fx.vaultRoot, "scan.pdf"), loadPdfFixture("scanned.pdf"));
  const r = await fx.callTool("read_file", { vault: "v", path: "scan.pdf" });
  const parsed = r.parsed as { content: string; pdf: { hasTextLayer: boolean; pages: number } };
  expect(parsed.content).toBe("");
  expect(parsed.pdf.hasTextLayer).toBe(false);
  expect(parsed.pdf.pages).toBeGreaterThanOrEqual(1);
});

test("read_file format:binary returns verbatim base64 for a PDF", async () => {
  const fx = await makeMcpFixture({ label: "tool-rf-pdf-bin" });
  cleanup.push(fx.stop);
  const bytes = loadPdfFixture("text.pdf");
  writeFileSync(join(fx.vaultRoot, "paper.pdf"), bytes);
  const r = await fx.callTool("read_file", { vault: "v", path: "paper.pdf", format: "binary" });
  const parsed = r.parsed as { encoding: string; content: string; pdf?: unknown };
  expect(parsed.encoding).toBe("base64");
  expect(parsed.pdf).toBeUndefined();
  expect(Array.from(Buffer.from(parsed.content, "base64"))).toEqual(Array.from(bytes));
});

test("read_file format:binary returns base64 for Markdown without frontmatter parsing", async () => {
  const fx = await makeMcpFixture({ label: "tool-rf-md-bin" });
  cleanup.push(fx.stop);
  const raw = "---\ntitle: hi\n---\n# body";
  writeFileSync(join(fx.vaultRoot, "x.md"), raw);
  const r = await fx.callTool("read_file", { vault: "v", path: "x.md", format: "binary" });
  const parsed = r.parsed as { encoding: string; content: string; frontmatter?: unknown };
  expect(parsed.encoding).toBe("base64");
  expect(parsed.frontmatter).toBeUndefined();
  expect(Buffer.from(parsed.content, "base64").toString("utf8")).toBe(raw);
});

test("read_file on a corrupt PDF yields extraction_failed with a retry hint", async () => {
  const fx = await makeMcpFixture({ label: "tool-rf-pdf-broken" });
  cleanup.push(fx.stop);
  writeFileSync(join(fx.vaultRoot, "bad.pdf"), loadPdfFixture("broken.pdf"));
  const r = await fx.callTool("read_file", { vault: "v", path: "bad.pdf" });
  expect(r.isError).toBe(true);
  const parsed = r.parsed as { code: string; message: string };
  expect(parsed.code).toBe("extraction_failed");
  expect(parsed.message).toContain('format:"binary"');
  // The MCP message must also carry the underlying parse cause so it stays at
  // parity with the REST body ("failed to parse PDF: <cause>").
  expect(parsed.message).toContain("failed to parse PDF");
});

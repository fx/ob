/**
 * `read_file` tool — utf-8 (Markdown + plain text), base64 (binary),
 * 404 path, validation.
 */

import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

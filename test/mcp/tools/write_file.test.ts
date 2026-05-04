/**
 * `write_file` tool — Markdown utf-8, raw text, base64 binary, validation,
 * frontmatter on non-Markdown rejected by the service core.
 */

import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { makeMcpFixture, waitFor } from "../helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

test("write_file Markdown sets indexed=true (waits for indexer ready)", async () => {
  const fx = await makeMcpFixture({ label: "tool-wf-md" });
  cleanup.push(fx.stop);
  await waitFor(() => fx.indexer.status("v")?.state === "ready");
  const r = await fx.callTool("write_file", {
    vault: "v",
    path: "n.md",
    content: "# hi",
  });
  expect(r.isError).toBeUndefined();
  const parsed = r.parsed as { created: boolean; indexed: boolean };
  expect(parsed.created).toBe(true);
  expect(parsed.indexed).toBe(true);
});

test("write_file binary base64 round-trips", async () => {
  const fx = await makeMcpFixture({ label: "tool-wf-bin" });
  cleanup.push(fx.stop);
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);
  const r = await fx.callTool("write_file", {
    vault: "v",
    path: "x.bin",
    content: Buffer.from(bytes).toString("base64"),
    encoding: "base64",
    contentType: "application/octet-stream",
  });
  expect(r.isError).toBeUndefined();
  const onDisk = readFileSync(join(fx.vaultRoot, "x.bin"));
  expect(Array.from(onDisk)).toEqual([1, 2, 3, 4, 5]);
});

test("write_file rejects unknown encoding via Zod", async () => {
  const fx = await makeMcpFixture({ label: "tool-wf-bad" });
  cleanup.push(fx.stop);
  const r = await fx.callTool("write_file", {
    vault: "v",
    path: "n.md",
    content: "x",
    encoding: "rot13",
  });
  expect(r.isError).toBe(true);
  expect((r.parsed as { code: string }).code).toBe("invalid_input");
});

test("write_file with frontmatter on Markdown", async () => {
  const fx = await makeMcpFixture({ label: "tool-wf-fm" });
  cleanup.push(fx.stop);
  await waitFor(() => fx.indexer.status("v")?.state === "ready");
  const r = await fx.callTool("write_file", {
    vault: "v",
    path: "n.md",
    content: "body",
    frontmatter: { title: "hi" },
  });
  expect(r.isError).toBeUndefined();
  const onDisk = readFileSync(join(fx.vaultRoot, "n.md"), "utf8");
  expect(onDisk).toContain('title: "hi"');
});

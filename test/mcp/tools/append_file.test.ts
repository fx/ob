/**
 * `append_file` tool — text append, binary rejection, missing-file rejection,
 * validation, indexed=true on Markdown append.
 */

import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeMcpFixture, waitFor } from "../helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

test("append_file appends to a Markdown file and indexed=true", async () => {
  const fx = await makeMcpFixture({ label: "tool-af-md" });
  cleanup.push(fx.stop);
  await waitFor(() => fx.indexer.status("v")?.state === "ready");
  writeFileSync(join(fx.vaultRoot, "d.md"), "head\n");
  const r = await fx.callTool("append_file", {
    vault: "v",
    path: "d.md",
    content: "tail\n",
  });
  expect(r.isError).toBeUndefined();
  expect((r.parsed as { indexed: boolean }).indexed).toBe(true);
  expect(readFileSync(join(fx.vaultRoot, "d.md"), "utf8")).toBe("head\ntail\n");
});

test("append_file rejects binary path", async () => {
  const fx = await makeMcpFixture({ label: "tool-af-bin" });
  cleanup.push(fx.stop);
  writeFileSync(join(fx.vaultRoot, "i.png"), new Uint8Array([0]));
  const r = await fx.callTool("append_file", { vault: "v", path: "i.png", content: "x" });
  expect(r.isError).toBe(true);
  expect((r.parsed as { code: string }).code).toBe("unsupported_media_type");
});

test("append_file rejects missing file", async () => {
  const fx = await makeMcpFixture({ label: "tool-af-404" });
  cleanup.push(fx.stop);
  const r = await fx.callTool("append_file", { vault: "v", path: "missing.md", content: "x" });
  expect(r.isError).toBe(true);
  expect((r.parsed as { code: string }).code).toBe("not_found");
});

test("append_file rejects unknown vault arg shape", async () => {
  const fx = await makeMcpFixture({ label: "tool-af-bad" });
  cleanup.push(fx.stop);
  const r = await fx.callTool("append_file", { path: "missing.md", content: "x" });
  expect(r.isError).toBe(true);
  expect((r.parsed as { code: string }).code).toBe("invalid_input");
});

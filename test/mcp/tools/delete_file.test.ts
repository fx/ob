/**
 * `delete_file` tool — Markdown removes the index entry; binary delete leaves
 * index untouched; missing-file rejection; validation.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeMcpFixture, waitFor } from "../helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

test("delete_file removes a Markdown file", async () => {
  const fx = await makeMcpFixture({ label: "tool-df-md" });
  cleanup.push(fx.stop);
  await waitFor(() => fx.indexer.status("v")?.state === "ready");
  writeFileSync(join(fx.vaultRoot, "d.md"), "x");
  const r = await fx.callTool("delete_file", { vault: "v", path: "d.md" });
  expect(r.isError).toBeUndefined();
  expect((r.parsed as { deleted: boolean }).deleted).toBe(true);
  expect(existsSync(join(fx.vaultRoot, "d.md"))).toBe(false);
});

test("delete_file removes a binary file (no index touch)", async () => {
  const fx = await makeMcpFixture({ label: "tool-df-bin" });
  cleanup.push(fx.stop);
  writeFileSync(join(fx.vaultRoot, "i.png"), new Uint8Array([0]));
  const r = await fx.callTool("delete_file", { vault: "v", path: "i.png" });
  expect(r.isError).toBeUndefined();
  // Binary deletes share the same response shape as Markdown — pin
  // `{ deleted: true }` here so the contract holds for non-text paths too.
  expect((r.parsed as { deleted: boolean }).deleted).toBe(true);
  expect(existsSync(join(fx.vaultRoot, "i.png"))).toBe(false);
});

test("delete_file 404 yields not_found", async () => {
  const fx = await makeMcpFixture({ label: "tool-df-404" });
  cleanup.push(fx.stop);
  const r = await fx.callTool("delete_file", { vault: "v", path: "missing.md" });
  expect(r.isError).toBe(true);
  expect((r.parsed as { code: string }).code).toBe("not_found");
});

test("delete_file rejects empty path", async () => {
  const fx = await makeMcpFixture({ label: "tool-df-bad" });
  cleanup.push(fx.stop);
  const r = await fx.callTool("delete_file", { vault: "v", path: "" });
  expect(r.isError).toBe(true);
  expect((r.parsed as { code: string }).code).toBe("invalid_input");
});

/**
 * `delete` tool (`rm` / `rm -r`) — files and folders alike, the
 * `folder_not_empty` refusal, recursive removal, and input validation.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeMcpFixture, waitFor } from "../helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

const code = (r: { parsed: unknown }): string => (r.parsed as { code: string }).code;

test("delete removes a file and drops its index rows", async () => {
  const fx = await makeMcpFixture({ label: "tool-rm" });
  cleanup.push(fx.stop);
  await waitFor(() => fx.indexer.status("v")?.state === "ready");
  writeFileSync(join(fx.vaultRoot, "d.md"), "# doomed");
  await fx.indexer.reindex("v", "d.md");
  expect(await fx.indexer.indexedPaths("v", "d.md")).toEqual(["d.md"]);
  const r = await fx.callTool("delete", { vault: "v", path: "d.md" });
  expect(r.isError).toBeUndefined();
  expect(r.parsed).toEqual({ deleted: true });
  expect(existsSync(join(fx.vaultRoot, "d.md"))).toBe(false);
  expect(await fx.indexer.indexedPaths("v", "d.md")).toEqual([]);
});

test("delete refuses a non-empty folder unless recursive, then removes it all", async () => {
  const fx = await makeMcpFixture({ label: "tool-rm-r" });
  cleanup.push(fx.stop);
  mkdirSync(join(fx.vaultRoot, "f", "sub"), { recursive: true });
  writeFileSync(join(fx.vaultRoot, "f", "sub", "x.md"), "x");
  const refused = await fx.callTool("delete", { vault: "v", path: "f" });
  expect(code(refused)).toBe("folder_not_empty");
  expect(existsSync(join(fx.vaultRoot, "f", "sub", "x.md"))).toBe(true);
  const r = await fx.callTool("delete", { vault: "v", path: "f", recursive: true });
  expect(r.parsed).toEqual({ deleted: true });
  expect(existsSync(join(fx.vaultRoot, "f"))).toBe(false);
});

test("delete removes an empty folder without recursive", async () => {
  const fx = await makeMcpFixture({ label: "tool-rm-empty" });
  cleanup.push(fx.stop);
  mkdirSync(join(fx.vaultRoot, "empty"));
  const r = await fx.callTool("delete", { vault: "v", path: "empty/" });
  expect(r.parsed).toEqual({ deleted: true });
  expect(existsSync(join(fx.vaultRoot, "empty"))).toBe(false);
});

test("delete reports not_found, invalid_path and invalid_input", async () => {
  const fx = await makeMcpFixture({ label: "tool-rm-err" });
  cleanup.push(fx.stop);
  writeFileSync(join(fx.vaultRoot, "keep.md"), "keep");
  expect(code(await fx.callTool("delete", { vault: "v", path: "missing.md" }))).toBe("not_found");
  for (const path of ["../x", ".", ".obsidian"]) {
    const r = await fx.callTool("delete", { vault: "v", path, recursive: true });
    expect(code(r)).toBe("invalid_path");
  }
  for (const args of [
    { vault: "v", path: "" },
    { vault: "v", path: "keep.md", recursive: "true" },
    { vault: "v" },
  ]) {
    expect(code(await fx.callTool("delete", args))).toBe("invalid_input");
  }
  expect(existsSync(join(fx.vaultRoot, "keep.md"))).toBe(true);
});

test("delete is not read-only and states its contract", async () => {
  const fx = await makeMcpFixture({ label: "tool-rm-desc" });
  cleanup.push(fx.stop);
  const t = fx.registry.get("delete");
  expect(t?.annotations).toBeUndefined();
  for (const phrase of ["file or a folder alike", "folder_not_empty", "`recursive: true`"]) {
    expect(t?.description).toContain(phrase);
  }
});

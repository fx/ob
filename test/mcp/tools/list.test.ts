/**
 * `list` tool (`ls`) — files and folders in one listing, the type filter,
 * `recursive: false`, paging, and input validation.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeMcpFixture } from "../helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

interface Page {
  items: { type: string; path: string; contentType?: string }[];
  nextCursor: string | null;
}

test("list returns files and folders alike, including empty folders", async () => {
  const fx = await makeMcpFixture({ label: "tool-ls" });
  cleanup.push(fx.stop);
  writeFileSync(join(fx.vaultRoot, "a.md"), "# a");
  writeFileSync(join(fx.vaultRoot, "b.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  mkdirSync(join(fx.vaultRoot, "empty"));
  const r = await fx.callTool("list", { vault: "v" });
  expect(r.isError).toBeUndefined();
  const page = r.parsed as Page;
  expect(page.items.map((i) => `${i.type}:${i.path}`)).toEqual([
    "file:a.md",
    "file:b.png",
    "folder:empty",
  ]);
  expect(page.items[0]?.contentType).toContain("text/markdown");
  expect(page.items[1]?.contentType).toBe("image/png");
  expect(page.nextCursor).toBeNull();
});

test("list honors type, recursive: false, prefix and cursor", async () => {
  const fx = await makeMcpFixture({ label: "tool-ls-opts" });
  cleanup.push(fx.stop);
  mkdirSync(join(fx.vaultRoot, "notes", "sub"), { recursive: true });
  writeFileSync(join(fx.vaultRoot, "notes", "a.md"), "a");
  writeFileSync(join(fx.vaultRoot, "notes", "sub", "b.md"), "b");
  const folders = await fx.callTool("list", { vault: "v", type: "folder" });
  expect((folders.parsed as Page).items.map((i) => i.path)).toEqual(["notes", "notes/sub"]);
  const shallow = await fx.callTool("list", { vault: "v", prefix: "notes/", recursive: false });
  expect((shallow.parsed as Page).items.map((i) => i.path)).toEqual(["notes/a.md", "notes/sub"]);
  const p1 = await fx.callTool("list", { vault: "v", prefix: "notes/", limit: 1 });
  const page1 = p1.parsed as Page;
  expect(page1.items.map((i) => i.path)).toEqual(["notes/a.md"]);
  const p2 = await fx.callTool("list", {
    vault: "v",
    prefix: "notes/",
    limit: 10,
    cursor: page1.nextCursor as string,
  });
  expect((p2.parsed as Page).items.map((i) => i.path)).toEqual(["notes/sub", "notes/sub/b.md"]);
});

test("list rejects invalid input with invalid_input", async () => {
  const fx = await makeMcpFixture({ label: "tool-ls-bad" });
  cleanup.push(fx.stop);
  for (const args of [
    { vault: "v", limit: 0 },
    { vault: "v", limit: 1001 },
    { vault: "v", type: "symlink" },
    { vault: "v", recursive: "false" },
    { vault: "v", prefix: "é".repeat(600) },
    { vault: "v", unknown: true },
  ]) {
    const r = await fx.callTool("list", args);
    expect(r.isError).toBe(true);
    expect((r.parsed as { code: string }).code).toBe("invalid_input");
  }
});

test("list is advertised read-only and states its contract", async () => {
  const fx = await makeMcpFixture({ label: "tool-ls-desc" });
  cleanup.push(fx.stop);
  const t = fx.registry.get("list");
  expect(t?.annotations).toEqual({ readOnlyHint: true });
  for (const phrase of [
    "files and folders alike",
    '"folder"',
    "Empty folders",
    "recursive: false",
  ]) {
    expect(t?.description).toContain(phrase);
  }
});

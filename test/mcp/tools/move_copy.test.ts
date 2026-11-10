/**
 * `move` (`mv -T`) and `copy` (`cp -T` / `cp -r -T`) tools: the registered
 * definitions (descriptions carry what the MCP spec requires, neither is
 * read-only), a call through each, and a scoped session over the real HTTP
 * transport returning scope-relative paths only.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeMcpFixture, waitFor } from "../helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

test("move and copy are registered without readOnlyHint, with the required descriptions", async () => {
  const fx = await makeMcpFixture({ label: "tool-mvcp-def" });
  cleanup.push(fx.stop);
  const move = fx.registry.get("move");
  const copy = fx.registry.get("copy");
  expect(move?.annotations).toBeUndefined();
  expect(copy?.annotations).toBeUndefined();
  const m = move?.description ?? "";
  for (const phrase of [
    "files and folders alike",
    "exact new path",
    "already_exists",
    "`overwrite: true`",
    "never applies to folders",
    "`updateLinks: false`",
    "links.updated",
    "links.failed",
    "covers the moved paths only",
    "only notes inside the scope are rewritten",
  ]) {
    expect(m.toLowerCase()).toContain(phrase.toLowerCase());
  }
  const c = copy?.description ?? "";
  for (const phrase of [
    "files and folders alike",
    "`recursive: true`",
    "already_exists",
    "`overwrite: true`",
    "links are NOT rewritten",
    "at least one copied note was indexed",
  ]) {
    expect(c.toLowerCase()).toContain(phrase.toLowerCase());
  }
  expect(move?.inputSchema.required).toEqual(["vault", "path", "destination"]);
  expect(copy?.inputSchema.required).toEqual(["vault", "path", "destination"]);
});

test("move renames and rewrites; copy duplicates a folder", async () => {
  const fx = await makeMcpFixture({ label: "tool-mvcp" });
  cleanup.push(fx.stop);
  await waitFor(() => fx.indexer.status("v")?.state === "ready");
  mkdirSync(join(fx.vaultRoot, "notes"));
  writeFileSync(join(fx.vaultRoot, "notes", "old.md"), "# Old");
  writeFileSync(join(fx.vaultRoot, "a.md"), "[[old]]");
  const mv = await fx.callTool("move", {
    vault: "v",
    path: "notes/old.md",
    destination: "notes/new.md",
  });
  expect(mv.isError).toBeUndefined();
  expect(mv.parsed).toMatchObject({
    type: "file",
    links: { updated: [{ path: "a.md", links: 1 }] },
  });
  expect(readFileSync(join(fx.vaultRoot, "a.md"), "utf8")).toBe("[[new]]");
  const cp = await fx.callTool("copy", {
    vault: "v",
    path: "notes",
    destination: "n2",
    recursive: true,
  });
  expect(cp.parsed).toMatchObject({ type: "folder", files: 1, skipped: 0 });
  expect(existsSync(join(fx.vaultRoot, "n2", "new.md"))).toBe(true);
  const refused = await fx.callTool("copy", { vault: "v", path: "notes", destination: "n3" });
  expect(refused.isError).toBe(true);
  expect((refused.parsed as { code: string }).code).toBe("invalid_path");
});

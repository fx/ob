/**
 * Folder MCP tools — list_folders / create_folder / delete_folder. Drives the
 * registered tools in-process and asserts error-envelope + payload parity with
 * the REST routes on the same tmpdir vault.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeMcpFixture } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

describe("list_folders", () => {
  test("returns folders and matches the REST endpoint exactly", async () => {
    const fx = await makeMcpFixture({ label: "tool-lfo" });
    cleanup.push(fx.stop);
    await fs.mkdir(join(fx.vaultRoot, "a/b"), { recursive: true });
    await fs.mkdir(join(fx.vaultRoot, "c"), { recursive: true });

    const tool = await fx.callTool("list_folders", { vault: "v" });
    expect(tool.isError).toBeUndefined();
    const toolBody = tool.parsed as { items: { path: string }[]; nextCursor: string | null };
    expect(toolBody.items.map((i) => i.path)).toEqual(["a", "a/b", "c"]);

    const rest = await fx.app.request("/v1/vaults/v/folders");
    const restBody = (await rest.json()) as { items: unknown[]; nextCursor: string | null };
    expect(toolBody.items).toEqual(restBody.items as { path: string }[]);
    expect(toolBody.nextCursor).toEqual(restBody.nextCursor);
  });

  test("rejects an invalid limit with invalid_input", async () => {
    const fx = await makeMcpFixture({ label: "tool-lfo-bad" });
    cleanup.push(fx.stop);
    const r = await fx.callTool("list_folders", { vault: "v", limit: 0 });
    expect(r.isError).toBe(true);
    expect((r.parsed as { code: string }).code).toBe("invalid_input");
  });
});

describe("create_folder", () => {
  test("creates idempotently", async () => {
    const fx = await makeMcpFixture({ label: "tool-cfo" });
    cleanup.push(fx.stop);
    const first = await fx.callTool("create_folder", { vault: "v", path: "archive/2026" });
    expect((first.parsed as { created: boolean }).created).toBe(true);
    const second = await fx.callTool("create_folder", { vault: "v", path: "archive/2026" });
    expect((second.parsed as { created: boolean }).created).toBe(false);
  });

  test("file conflict surfaces invalid_path with the same code as REST", async () => {
    const fx = await makeMcpFixture({ label: "tool-cfo-conflict" });
    cleanup.push(fx.stop);
    writeFileSync(join(fx.vaultRoot, "x.md"), "keep");

    const tool = await fx.callTool("create_folder", { vault: "v", path: "x.md" });
    expect(tool.isError).toBe(true);
    const toolCode = (tool.parsed as { code: string }).code;
    expect(toolCode).toBe("invalid_path");

    const rest = await fx.app.request("/v1/vaults/v/folders/x.md", { method: "PUT" });
    const restCode = ((await rest.json()) as { error: { code: string } }).error.code;
    expect(toolCode).toBe(restCode);
  });

  test("rejects an empty path with invalid_input", async () => {
    const fx = await makeMcpFixture({ label: "tool-cfo-empty" });
    cleanup.push(fx.stop);
    const r = await fx.callTool("create_folder", { vault: "v", path: "" });
    expect(r.isError).toBe(true);
    expect((r.parsed as { code: string }).code).toBe("invalid_input");
  });

  test("canonicalizes a trailing-slash path to match REST", async () => {
    const fx = await makeMcpFixture({ label: "tool-cfo-slash" });
    cleanup.push(fx.stop);
    const tool = await fx.callTool("create_folder", { vault: "v", path: "archive/2026/" });
    expect((tool.parsed as { path: string }).path).toBe("archive/2026");

    const rest = await fx.app.request("/v1/vaults/v/folders/archive/2026/", { method: "PUT" });
    expect(((await rest.json()) as { path: string }).path).toBe("archive/2026");
  });
});

describe("delete_folder", () => {
  test("recursive delete returns { deleted: true } and removes the tree", async () => {
    const fx = await makeMcpFixture({ label: "tool-dfo" });
    cleanup.push(fx.stop);
    await fs.mkdir(join(fx.vaultRoot, "archive/2024"), { recursive: true });
    writeFileSync(join(fx.vaultRoot, "archive/2024/jan.md"), "# jan");
    const r = await fx.callTool("delete_folder", {
      vault: "v",
      path: "archive/2024",
      recursive: true,
    });
    expect(r.isError).toBeUndefined();
    expect((r.parsed as { deleted: boolean }).deleted).toBe(true);
    await expect(fs.lstat(join(fx.vaultRoot, "archive/2024"))).rejects.toBeDefined();
  });

  test("deletes an empty folder without recursive", async () => {
    const fx = await makeMcpFixture({ label: "tool-dfo-empty" });
    cleanup.push(fx.stop);
    await fs.mkdir(join(fx.vaultRoot, "empty"), { recursive: true });
    const r = await fx.callTool("delete_folder", { vault: "v", path: "empty" });
    expect((r.parsed as { deleted: boolean }).deleted).toBe(true);
  });

  test("folder_not_empty envelope matches REST for the same input", async () => {
    const fx = await makeMcpFixture({ label: "tool-dfo-409" });
    cleanup.push(fx.stop);
    await fs.mkdir(join(fx.vaultRoot, "people/peter-thiel"), { recursive: true });
    writeFileSync(join(fx.vaultRoot, "people/peter-thiel/intro.md"), "hi");

    const tool = await fx.callTool("delete_folder", { vault: "v", path: "people/peter-thiel" });
    expect(tool.isError).toBe(true);
    const toolCode = (tool.parsed as { code: string }).code;
    expect(toolCode).toBe("folder_not_empty");

    const rest = await fx.app.request("/v1/vaults/v/folders/people/peter-thiel", {
      method: "DELETE",
    });
    expect(rest.status).toBe(409);
    const restCode = ((await rest.json()) as { error: { code: string } }).error.code;
    expect(toolCode).toBe(restCode);
  });

  test("missing folder yields not_found", async () => {
    const fx = await makeMcpFixture({ label: "tool-dfo-404" });
    cleanup.push(fx.stop);
    const r = await fx.callTool("delete_folder", { vault: "v", path: "nope" });
    expect(r.isError).toBe(true);
    expect((r.parsed as { code: string }).code).toBe("not_found");
  });

  test("a dot path that resolves to the vault root is rejected, not deleted", async () => {
    const fx = await makeMcpFixture({ label: "tool-dfo-root" });
    cleanup.push(fx.stop);
    writeFileSync(join(fx.vaultRoot, "keep.md"), "x");
    const r = await fx.callTool("delete_folder", { vault: "v", path: ".", recursive: true });
    expect(r.isError).toBe(true);
    expect((r.parsed as { code: string }).code).toBe("invalid_path");
    // Vault root untouched.
    expect(await fs.readFile(join(fx.vaultRoot, "keep.md"), "utf8")).toBe("x");
  });
});

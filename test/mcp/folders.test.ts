/**
 * Folder MCP tool — create_folder. Drives the registered tool in-process and
 * asserts error-envelope + payload parity with the REST route on the same
 * tmpdir vault. Listing and deleting folders are the `list` / `delete` path
 * tools (`test/mcp/tools/list.test.ts`, `delete.test.ts`).
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

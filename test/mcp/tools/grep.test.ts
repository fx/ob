/**
 * `grep` tool — driven through the real registry and the real scan worker:
 * results, validation, unknown vault, cancellation through the call's abort
 * signal, and the advertised surface (description, read-only hint).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "../../../src/mcp/tool.ts";
import { type McpFixture, makeMcpFixture } from "../helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

async function fixture(label: string, files: Record<string, string> = {}): Promise<McpFixture> {
  const fx = await makeMcpFixture({ label });
  cleanup.push(fx.stop);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(fx.vaultRoot, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return fx;
}

function code(parsed: unknown): string {
  return (parsed as { code: string }).code;
}

describe("grep", () => {
  test("returns the REST grep payload", async () => {
    const fx = await fixture("tool-grep", {
      "notes/a.md": "one\nTODO: call the plumber\nthree\n",
      "doc.pdf": "TODO: never searched",
    });
    const r = await fx.callTool("grep", {
      vault: "v",
      pattern: "todo:",
      ignoreCase: true,
      context: 1,
    });
    expect(r.isError).toBeUndefined();
    expect(r.parsed).toEqual({
      matches: [
        {
          path: "notes/a.md",
          line: 2,
          column: 1,
          text: "TODO: call the plumber",
          textStart: 1,
          before: ["one"],
          after: ["three"],
        },
      ],
      truncated: false,
      reason: null,
      filesScanned: 1,
      filesSkipped: 0,
    });
  });

  test("schema failures and an invalid regex are invalid_input; an unknown vault is vault_not_found", async () => {
    const fx = await fixture("tool-grep-err");
    for (const args of [
      { vault: "v" },
      { vault: "v", pattern: "" },
      { vault: "v", pattern: "x", limit: 0 },
      { vault: "v", pattern: "x", context: 6 },
      { vault: "v", pattern: "x", unknown: true },
      { vault: "v", pattern: "([", regex: true },
    ]) {
      const r = await fx.callTool("grep", args);
      expect(r.isError).toBe(true);
      expect(code(r.parsed)).toBe("invalid_input");
    }
    const r = await fx.callTool("grep", { vault: "ghost", pattern: "x" });
    expect(code(r.parsed)).toBe("vault_not_found");
  });

  test("a cancelled call stops its worker instead of running to the budget", async () => {
    const fx = await fixture("tool-grep-cancel", {
      "cat.txt": `${"a".repeat(10_000)}!\n`.repeat(50),
    });
    const t = fx.registry.get("grep") as ToolDefinition;
    const ctl = new AbortController();
    const started = performance.now();
    const pending = t.call({ vault: "v", pattern: "(a+)+$", regex: true }, { signal: ctl.signal });
    await Bun.sleep(100);
    ctl.abort();
    const r = (await pending) as { content: readonly { text: string }[] };
    expect(performance.now() - started).toBeLessThan(2_500);
    expect(JSON.parse(r.content[0]?.text ?? "")).toMatchObject({ truncated: true, reason: "time" });
  });

  test("is read-only and describes what it matches", async () => {
    const fx = await fixture("tool-grep-meta");
    const t = fx.registry.get("grep");
    expect(t?.annotations).toEqual({ readOnlyHint: true });
    const d = t?.description ?? "";
    expect(d).toContain("exact text");
    expect(d).toContain("regex: true");
    expect(d).toContain("line by line");
    expect(d).toContain("on disk");
    expect(d).toContain("PDFs and binary");
    expect(d).toContain("NOT searched");
    expect(d).toContain("truncated");
    expect(d).toContain("`search`");
    expect(d).toContain("by meaning");
    expect(t?.inputSchema).toMatchObject({
      type: "object",
      required: ["vault", "pattern"],
      additionalProperties: false,
    });
    expect(Object.keys((t?.inputSchema as { properties: object }).properties).sort()).toEqual([
      "context",
      "ignoreCase",
      "limit",
      "pattern",
      "prefix",
      "regex",
      "vault",
    ]);
  });
});

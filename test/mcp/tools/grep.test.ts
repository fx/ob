/**
 * `grep` tool — driven through the real registry and the real scan worker:
 * results, validation, unknown vault, cancellation through the call's abort
 * signal, and the advertised surface (description, read-only hint).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ToolDefinition } from "../../../src/mcp/tool.ts";
import { isTextPath } from "../../../src/vault/contentType.ts";
import { GREP_TIME_BUDGET_MS, grepSlots } from "../../../src/vault/grep.ts";
import { type McpFixture, makeMcpFixture } from "../helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
  // A slot is released only once its worker exited: wait for both, so no
  // cancelled evaluation keeps running into later tests.
  const never = new AbortController().signal;
  const held = await Promise.all([grepSlots.acquire(never), grepSlots.acquire(never)]);
  for (const release of held) release();
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

const ACCEPT = "application/json, text/event-stream";

async function rpc(fx: McpFixture, path: string, body: unknown, sid?: string): Promise<Response> {
  return fx.app.request(path, {
    method: "POST",
    headers: {
      accept: ACCEPT,
      "content-type": "application/json",
      ...(sid !== undefined && { "mcp-session-id": sid }),
    },
    body: JSON.stringify(body),
  });
}

async function initialize(fx: McpFixture, path: string): Promise<string> {
  const res = await rpc(fx, path, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "t", version: "0" },
    },
  });
  return res.headers.get("mcp-session-id") ?? "";
}

/** `tools/call grep` over the real HTTP transport; returns the parsed payload. */
async function callOverHttp(
  fx: McpFixture,
  path: string,
  sid: string,
  args: unknown,
): Promise<unknown> {
  const res = await rpc(
    fx,
    path,
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "grep", arguments: args } },
    sid,
  );
  const body = (await res.json()) as { result: { content: { text: string }[] } };
  return JSON.parse(body.result.content[0]?.text ?? "null");
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

  test("the budget runs from the tools/call arrival, scope guard included", async () => {
    // The first clock read is the server's ingress for the call; every later
    // one (inside grep) is past the deadline. Had grep taken its own arrival,
    // it would see no time elapsed and search normally.
    let reads = 0;
    const clock = (): number => (reads++ === 0 ? 0 : GREP_TIME_BUDGET_MS + 1);
    const fx = await makeMcpFixture({ label: "tool-grep-arrival", clock });
    cleanup.push(fx.stop);
    writeFileSync(join(fx.vaultRoot, "a.md"), "NEEDLE\n");
    for (const path of ["/mcp/v", "/mcp"]) {
      reads = 0;
      const sid = await initialize(fx, path);
      const r = await callOverHttp(fx, path, sid, { vault: "v", pattern: "NEEDLE" });
      expect(r).toEqual({
        matches: [],
        truncated: true,
        reason: "time",
        filesScanned: 0,
        filesSkipped: 0,
      });
      expect(reads).toBe(2);
    }
  });

  test("a call extra's arrival time reaches grep", async () => {
    const fx = await fixture("tool-grep-extra", { "a.md": "NEEDLE\n" });
    const t = fx.registry.get("grep") as ToolDefinition;
    const late = (await t.call(
      { vault: "v", pattern: "NEEDLE" },
      { arrivedAt: performance.now() - GREP_TIME_BUDGET_MS },
    )) as { content: readonly { text: string }[] };
    expect(JSON.parse(late.content[0]?.text ?? "")).toMatchObject({ matches: [], reason: "time" });
    const fresh = (await t.call(
      { vault: "v", pattern: "NEEDLE" },
      { arrivedAt: performance.now() },
    )) as { content: readonly { text: string }[] };
    expect(JSON.parse(fresh.content[0]?.text ?? "")).toMatchObject({ truncated: false });
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
    // The extensions it names are exactly the text rule `patch_file` uses.
    const named = [...d.matchAll(/`\.([a-z]+)`/g)].map((m) => m[1] as string);
    expect(named.length).toBeGreaterThan(0);
    for (const ext of named) expect(isTextPath(`x.${ext}`)).toBe(true);
    for (const ext of ["pdf", "png", "jpg", "gif", "webp", "bin"]) {
      expect(isTextPath(`x.${ext}`)).toBe(false);
    }
    expect(d).toContain("64 MiB of file bytes read");
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

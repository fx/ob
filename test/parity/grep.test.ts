/**
 * REST ↔ MCP parity for grep: `POST /v1/vaults/:slug/grep` and the `grep`
 * tool return identical payloads for the same fixture vault, and the same
 * error `code` for every service-core failure (an unknown vault, a regex that
 * does not compile). Input-validation failures are adapter-specific
 * (`invalid_body` / `invalid_input` on REST, `invalid_input` on MCP) and are
 * asserted in each adapter's own tests.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callMcp, callRestJson, makeParityFixture } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

function put(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

const post = (body: unknown): RequestInit => ({
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

test("grep parity across literal, regex, case, prefix, limit, context, and skips", async () => {
  const fx = await makeParityFixture({ label: "p-grep" });
  cleanup.push(fx.stop);
  put(fx.vaultRoot, "notes/a.md", "intro\nTODO: call the plumber\ncost (est.) $5\ntodo later\n");
  put(fx.vaultRoot, "notes/b.txt", "line one\r\nTODO two\r\n");
  put(fx.vaultRoot, "data.json", '{"todo": true}\n');
  put(fx.vaultRoot, "nul.md", "TODO\0\n");
  put(fx.vaultRoot, "long.md", `${"x".repeat(1500)}TODO${"y".repeat(1500)}\n`);
  put(fx.vaultRoot, "doc.pdf", "TODO in a pdf");

  const cases: Record<string, unknown>[] = [
    { pattern: "TODO" },
    { pattern: "(est.) $5" },
    { pattern: "todo", ignoreCase: true },
    { pattern: "^todo\\b", regex: true, ignoreCase: true },
    { pattern: "TODO", prefix: "notes/" },
    { pattern: "TODO", prefix: "" },
    { pattern: "TODO", limit: 1 },
    { pattern: "TODO", context: 2 },
    { pattern: "^$|o$", regex: true },
    { pattern: "absent" },
  ];
  for (const args of cases) {
    const mcp = await callMcp(fx, "grep", { vault: "v", ...args });
    const rest = await callRestJson(fx, "POST", "/v1/vaults/v/grep", post(args));
    // Assert success on both BEFORE comparing, so two matching error
    // envelopes cannot pass as parity.
    expect(mcp.isError).toBe(false);
    expect(rest.status).toBe(200);
    expect(mcp.body).toEqual(rest.body);
  }
  // Pin the shared payload too, so parity cannot hold over a wrong answer.
  const pinned = await callMcp(fx, "grep", { vault: "v", pattern: "TODO", limit: 2 });
  expect(pinned.body).toMatchObject({
    matches: [
      { path: "long.md", line: 1, column: 1501, textStart: 1001 },
      { path: "notes/a.md", line: 2, column: 1, text: "TODO: call the plumber", textStart: 1 },
    ],
    truncated: true,
    reason: "limit",
    // data.json, long.md, notes/a.md, and notes/b.txt (the sentinel's file).
    filesScanned: 4,
    filesSkipped: 0,
  });
});

test("grep parity: service-core failures carry the same code on both adapters", async () => {
  const fx = await makeParityFixture({ label: "p-grep-err" });
  cleanup.push(fx.stop);
  const failures: { slug: string; args: Record<string, unknown>; status: number; code: string }[] =
    [
      { slug: "ghost", args: { pattern: "x" }, status: 404, code: "vault_not_found" },
      { slug: "v", args: { pattern: "([", regex: true }, status: 400, code: "invalid_input" },
      { slug: "v", args: { pattern: "a{2,1}", regex: true }, status: 400, code: "invalid_input" },
    ];
  for (const { slug, args, status, code } of failures) {
    const mcp = await callMcp(fx, "grep", { vault: slug, ...args });
    const rest = await callRestJson(fx, "POST", `/v1/vaults/${slug}/grep`, post(args));
    expect(mcp.isError).toBe(true);
    expect(rest.status).toBe(status);
    expect((mcp.body as { code: string }).code).toBe(code);
    expect((rest.body as { code: string }).code).toBe(code);
  }
});

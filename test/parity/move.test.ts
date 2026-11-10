/**
 * REST ↔ MCP parity for `move` / `POST /v1/vaults/:slug/paths/*path:move`
 * and `copy` / `…:copy`: on one fixture vault, reset to the same state
 * before each adapter's call, the two return identical payloads and leave
 * identical results; every service-core failure carries the same `code`.
 * Input-validation failures are adapter-specific and asserted per adapter.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { McpFixture } from "../mcp/helpers.ts";
import { callMcp, callRestJson, makeParityFixture, waitFor } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

const code = (body: unknown): string => (body as { code: string }).code;

async function fixture(label: string): Promise<McpFixture> {
  const fx = await makeParityFixture({ label });
  cleanup.push(fx.stop);
  await waitFor(() => fx.indexer.status("v")?.state === "ready");
  return fx;
}

/** Reset the vault to exactly `files`, indexing every Markdown file. */
async function reset(fx: McpFixture, files: Record<string, string>): Promise<void> {
  for (const p of await fx.indexer.indexedPaths("v", "")) await fx.indexer.drop("v", p);
  rmSync(fx.vaultRoot, { recursive: true, force: true });
  mkdirSync(fx.vaultRoot, { recursive: true });
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(fx.vaultRoot, p, ".."), { recursive: true });
    writeFileSync(join(fx.vaultRoot, p), content);
    if (p.endsWith(".md")) await fx.indexer.reindex("v", p);
  }
}

const restPost = (fx: McpFixture, url: string, body: unknown) =>
  callRestJson(fx, "POST", url, {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const VAULT = {
  "notes/old.md": "# Old\n\nbody",
  "daily/today.md": "see [[old]]",
  "templates/weekly.md": "# W",
  "templates/.hidden": "h",
  "img.png": "PNG",
};

describe("identical payloads", () => {
  test("move: a note with links rewritten, and a folder", async () => {
    const fx = await fixture("p-mv");
    const cases: [Record<string, unknown>, string, Record<string, unknown>][] = [
      [
        { path: "notes/old.md", destination: "notes/new.md" },
        "notes/old.md:move",
        { destination: "notes/new.md" },
      ],
      [
        { path: "templates", destination: "t2", updateLinks: false },
        "templates:move",
        { destination: "t2", updateLinks: false },
      ],
      [{ path: "img.png", destination: "a/img.png" }, "img.png:move", { destination: "a/img.png" }],
    ];
    for (const [args, tail, body] of cases) {
      await reset(fx, VAULT);
      const mcp = await callMcp(fx, "move", { vault: "v", ...args });
      const afterMcp = readFileSync(join(fx.vaultRoot, "daily/today.md"), "utf8");
      const indexMcp = await fx.indexer.indexedPaths("v", "");
      await reset(fx, VAULT);
      const rest = await restPost(fx, `/v1/vaults/v/paths/${tail}`, body);
      expect(rest.status).toBe(200);
      expect(mcp.isError).toBe(false);
      expect(mcp.body).toEqual(rest.body);
      expect(readFileSync(join(fx.vaultRoot, "daily/today.md"), "utf8")).toBe(afterMcp);
      expect(await fx.indexer.indexedPaths("v", "")).toEqual(indexMcp);
    }
  }, 30_000);

  test("copy: a file with overwrite, and a folder", async () => {
    const fx = await fixture("p-cp");
    const cases: [Record<string, unknown>, string, Record<string, unknown>][] = [
      [
        { path: "notes/old.md", destination: "daily/today.md", overwrite: true },
        "notes/old.md:copy",
        { destination: "daily/today.md", overwrite: true },
      ],
      [
        { path: "templates", destination: "t2", recursive: true },
        "templates:copy",
        { destination: "t2", recursive: true },
      ],
    ];
    for (const [args, tail, body] of cases) {
      await reset(fx, VAULT);
      const mcp = await callMcp(fx, "copy", { vault: "v", ...args });
      await reset(fx, VAULT);
      const rest = await restPost(fx, `/v1/vaults/v/paths/${tail}`, body);
      expect(rest.status).toBe(200);
      expect(mcp.body).toEqual(rest.body);
    }
  }, 30_000);
});

test("identical error codes for every service-core failure", async () => {
  const fx = await fixture("p-mvcp-err");
  await reset(fx, { "a.md": "A", "b.md": "B", "d/x.md": "X" });
  const cases: [
    string,
    "move" | "copy",
    Record<string, unknown>,
    string,
    Record<string, unknown>,
  ][] = [
    [
      "not_found",
      "move",
      { path: "no.md", destination: "c.md" },
      "no.md:move",
      { destination: "c.md" },
    ],
    [
      "not_found",
      "copy",
      { path: "no.md", destination: "c.md" },
      "no.md:copy",
      { destination: "c.md" },
    ],
    [
      "already_exists",
      "move",
      { path: "a.md", destination: "b.md" },
      "a.md:move",
      { destination: "b.md" },
    ],
    [
      "already_exists",
      "copy",
      { path: "a.md", destination: "b.md" },
      "a.md:copy",
      { destination: "b.md" },
    ],
    [
      "already_exists",
      "move",
      { path: "a.md", destination: "d", overwrite: true },
      "a.md:move",
      { destination: "d", overwrite: true },
    ],
    [
      "invalid_path",
      "move",
      { path: "a.md", destination: "a.md" },
      "a.md:move",
      { destination: "a.md" },
    ],
    ["invalid_path", "move", { path: "d", destination: "d/e" }, "d:move", { destination: "d/e" }],
    [
      "invalid_path",
      "move",
      { path: "a.md", destination: "../x.md" },
      "a.md:move",
      { destination: "../x.md" },
    ],
    [
      "invalid_path",
      "copy",
      { path: "a.md", destination: "b.md/x" },
      "a.md:copy",
      { destination: "b.md/x" },
    ],
    ["invalid_path", "copy", { path: "d", destination: "e" }, "d:copy", { destination: "e" }],
    [
      "invalid_path",
      "move",
      { path: "../a.md", destination: "x.md" },
      "..%2Fa.md:move",
      { destination: "x.md" },
    ],
    [
      "invalid_path",
      "copy",
      { path: ".obsidian", destination: "x" },
      ".obsidian:copy",
      { destination: "x" },
    ],
  ];
  for (const [expected, tool, args, tail, body] of cases) {
    const mcp = await callMcp(fx, tool, { vault: "v", ...args });
    const rest = await restPost(fx, `/v1/vaults/v/paths/${tail}`, body);
    expect([tool, tail, mcp.isError, code(mcp.body)]).toEqual([tool, tail, true, expected]);
    expect([tool, tail, code(rest.body)]).toEqual([tool, tail, expected]);
  }
  for (const tool of ["move", "copy"] as const) {
    const mcp = await callMcp(fx, tool, { vault: "nope", path: "a.md", destination: "c.md" });
    const rest = await restPost(fx, `/v1/vaults/nope/paths/a.md:${tool}`, { destination: "c.md" });
    expect(code(mcp.body)).toBe("vault_not_found");
    expect(code(rest.body)).toBe("vault_not_found");
  }
  expect(readFileSync(join(fx.vaultRoot, "a.md"), "utf8")).toBe("A");
});

test("input validation is adapter-specific", async () => {
  const fx = await fixture("p-mvcp-val");
  await reset(fx, { "a.md": "A" });
  for (const tool of ["move", "copy"] as const) {
    // MCP: every schema failure is invalid_input.
    for (const args of [
      { vault: "v", path: "a.md" },
      { vault: "v", path: "a.md", destination: "b.md", extra: true },
      { vault: "v", path: "a.md", destination: "b.md", overwrite: "yes" },
    ]) {
      expect(code((await callMcp(fx, tool, args)).body)).toBe("invalid_input");
    }
    // REST: a schema failure is invalid_input, an unparseable body invalid_body.
    const url = `/v1/vaults/v/paths/a.md:${tool}`;
    expect(code((await restPost(fx, url, { destination: "b.md", extra: true })).body)).toBe(
      "invalid_input",
    );
    const bad = await callRestJson(fx, "POST", url, {
      headers: { "content-type": "application/json" },
      body: "{oops",
    });
    expect(code(bad.body)).toBe("invalid_body");
  }
  expect(readFileSync(join(fx.vaultRoot, "a.md"), "utf8")).toBe("A");
});

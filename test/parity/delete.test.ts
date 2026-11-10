/**
 * REST ↔ MCP parity for `delete` / `DELETE /v1/vaults/:slug/paths/*path`:
 * an equivalent outcome (REST `204` with no body, MCP `{ deleted: true }`,
 * the same on-disk and index result) and identical error codes for every
 * service-core failure. Input-validation failures are adapter-specific.
 */

import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callMcp, callRestJson, makeParityFixture, waitFor } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

const code = (body: unknown): string => (body as { code: string }).code;

test("deleting a file: equivalent outcome on disk and in the index", async () => {
  const fx = await makeParityFixture({ label: "p-rm" });
  cleanup.push(fx.stop);
  await waitFor(() => fx.indexer.status("v")?.state === "ready");
  for (const p of ["m.md", "r.md"]) {
    writeFileSync(join(fx.vaultRoot, p), `# ${p}`);
    await fx.indexer.reindex("v", p);
  }
  const mcp = await callMcp(fx, "delete", { vault: "v", path: "m.md" });
  const rest = await callRestJson(fx, "DELETE", "/v1/vaults/v/paths/r.md");
  expect(mcp).toEqual({ isError: false, body: { deleted: true } });
  expect(rest.status).toBe(204);
  expect(rest.body).toBeNull();
  for (const p of ["m.md", "r.md"]) {
    expect(existsSync(join(fx.vaultRoot, p))).toBe(false);
    expect(await fx.indexer.indexedPaths("v", p)).toEqual([]);
  }
});

test("recursive folder delete: equivalent outcome on disk and in the index", async () => {
  const fx = await makeParityFixture({ label: "p-rm-r" });
  cleanup.push(fx.stop);
  await waitFor(() => fx.indexer.status("v")?.state === "ready");
  for (const d of ["m", "r"]) {
    mkdirSync(join(fx.vaultRoot, d, "sub"), { recursive: true });
    writeFileSync(join(fx.vaultRoot, d, "sub", "n.md"), "# n");
    await fx.indexer.reindex("v", `${d}/sub/n.md`);
  }
  const mcp = await callMcp(fx, "delete", { vault: "v", path: "m", recursive: true });
  const rest = await callRestJson(fx, "DELETE", "/v1/vaults/v/paths/r?recursive=true");
  expect(mcp.body).toEqual({ deleted: true });
  expect(rest.status).toBe(204);
  for (const d of ["m", "r"]) {
    expect(existsSync(join(fx.vaultRoot, d))).toBe(false);
    expect(await fx.indexer.indexedPaths("v", `${d}/`)).toEqual([]);
  }
});

test("identical error codes for every service-core failure", async () => {
  const fx = await makeParityFixture({ label: "p-rm-err" });
  cleanup.push(fx.stop);
  mkdirSync(join(fx.vaultRoot, "full"), { recursive: true });
  writeFileSync(join(fx.vaultRoot, "full", "x.md"), "x");
  const cases: [string, Record<string, unknown>, string][] = [
    ["not_found", { vault: "v", path: "missing.md" }, "/v1/vaults/v/paths/missing.md"],
    ["invalid_path", { vault: "v", path: "../x" }, "/v1/vaults/v/paths/..%2Fx"],
    ["invalid_path", { vault: "v", path: ".obsidian" }, "/v1/vaults/v/paths/.obsidian"],
    ["folder_not_empty", { vault: "v", path: "full" }, "/v1/vaults/v/paths/full"],
    ["vault_not_found", { vault: "nope", path: "x.md" }, "/v1/vaults/nope/paths/x.md"],
  ];
  for (const [expected, args, url] of cases) {
    const mcp = await callMcp(fx, "delete", args);
    const rest = await callRestJson(fx, "DELETE", url);
    expect(mcp.isError).toBe(true);
    expect(code(mcp.body)).toBe(expected);
    expect(code(rest.body)).toBe(expected);
  }
  expect(existsSync(join(fx.vaultRoot, "full", "x.md"))).toBe(true);
});

test("delete input validation is adapter-specific", async () => {
  const fx = await makeParityFixture({ label: "p-rm-val" });
  cleanup.push(fx.stop);
  writeFileSync(join(fx.vaultRoot, "k.md"), "k");
  const mcp = await callMcp(fx, "delete", { vault: "v", path: "k.md", recursive: "yes" });
  const rest = await callRestJson(fx, "DELETE", "/v1/vaults/v/paths/k.md?recursive=yes");
  expect(code(mcp.body)).toBe("invalid_input");
  expect(code(rest.body)).toBe("invalid_query");
  expect(existsSync(join(fx.vaultRoot, "k.md"))).toBe(true);
});

/**
 * REST ↔ MCP parity for `list` / `GET /v1/vaults/:slug/paths`: identical
 * payloads for the same inputs against the same fixture vault, and identical
 * error codes for every service-core failure. Input-validation failures are
 * adapter-specific (REST `invalid_query`, MCP `invalid_input`) and asserted
 * per adapter, as in the rest of the parity suite.
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

const code = (body: unknown): string => (body as { code: string }).code;

test("list parity across type, recursive, prefix and paging", async () => {
  const fx = await makeParityFixture({ label: "p-ls" });
  cleanup.push(fx.stop);
  mkdirSync(join(fx.vaultRoot, "a", "empty"), { recursive: true });
  writeFileSync(join(fx.vaultRoot, "a", "x.md"), "# x");
  writeFileSync(join(fx.vaultRoot, "a-b.md"), "# ab");
  writeFileSync(join(fx.vaultRoot, "c.png"), new Uint8Array([0x89]));

  const cases: [Record<string, unknown>, string][] = [
    [{}, ""],
    [{ type: "file" }, "type=file"],
    [{ type: "folder" }, "type=folder"],
    [{ recursive: false }, "recursive=false"],
    [{ prefix: "a/", recursive: false }, "prefix=a/&recursive=false"],
    [{ prefix: "a", recursive: true }, "prefix=a&recursive=true"],
    [{ limit: 3 }, "limit=3"],
  ];
  for (const [args, query] of cases) {
    const mcp = await callMcp(fx, "list", { vault: "v", ...args });
    const rest = await callRestJson(fx, "GET", `/v1/vaults/v/paths?${query}`);
    expect(mcp.isError).toBe(false);
    expect(rest.status).toBe(200);
    expect(mcp.body).toEqual(rest.body);
  }

  // Follow the cursor of the limit=3 page on both adapters.
  const first = await callMcp(fx, "list", { vault: "v", limit: 3 });
  const cursor = (first.body as { nextCursor: string }).nextCursor;
  const mcp2 = await callMcp(fx, "list", { vault: "v", limit: 3, cursor });
  const rest2 = await callRestJson(
    fx,
    "GET",
    `/v1/vaults/v/paths?limit=3&cursor=${encodeURIComponent(cursor)}`,
  );
  expect(mcp2.body).toEqual(rest2.body);
  expect((mcp2.body as { items: { path: string }[] }).items.map((i) => i.path)).toEqual([
    "a-b.md",
    "c.png",
  ]);
});

test("list parity on service-core errors", async () => {
  const fx = await makeParityFixture({ label: "p-ls-err" });
  cleanup.push(fx.stop);
  const mcp = await callMcp(fx, "list", { vault: "nope" });
  const rest = await callRestJson(fx, "GET", "/v1/vaults/nope/paths");
  expect(code(mcp.body)).toBe("vault_not_found");
  expect(code(rest.body)).toBe(code(mcp.body));
});

test("list input validation is adapter-specific", async () => {
  const fx = await makeParityFixture({ label: "p-ls-val" });
  cleanup.push(fx.stop);
  const mcp = await callMcp(fx, "list", { vault: "v", type: "symlink" });
  const rest = await callRestJson(fx, "GET", "/v1/vaults/v/paths?type=symlink");
  expect(code(mcp.body)).toBe("invalid_input");
  expect(code(rest.body)).toBe("invalid_query");
});

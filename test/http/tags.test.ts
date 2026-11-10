/**
 * `GET /v1/vaults/:slug/tags` through the real Hono app, backed by a real
 * fake-embedder indexer over a real LanceDB store.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { waitFor } from "../mcp/helpers.ts";
import { type HttpFixture, makeHttpFixture } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

/** The Vault Indexer spec's tag-listing fixture, indexed through the real hooks. */
async function seeded(label: string): Promise<HttpFixture> {
  const fx = await makeHttpFixture(label);
  cleanup.push(fx.stop);
  await waitFor(() => fx.indexer.status("v")?.state === "ready");
  mkdirSync(join(fx.vaultRoot, "work"), { recursive: true });
  writeFileSync(join(fx.vaultRoot, "a.md"), "# One\n\nfirst #todo\n\n# Two\n\nsecond #todo\n");
  writeFileSync(join(fx.vaultRoot, "work/b.md"), "# B\n\n#todo and #project/alpha\n");
  writeFileSync(join(fx.vaultRoot, "c.md"), "# C\n\n#project here\n");
  for (const p of ["a.md", "work/b.md", "c.md"]) await fx.indexer.reindex("v", p);
  return fx;
}

async function get(fx: HttpFixture, url: string): Promise<{ status: number; body: unknown }> {
  const res = await fx.app.request(url);
  return { status: res.status, body: await res.json() };
}

function code(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

describe("GET /v1/vaults/:slug/tags", () => {
  test("lists tags with distinct-document counts", async () => {
    const fx = await seeded("tags-list");
    expect(await get(fx, "/v1/vaults/v/tags")).toEqual({
      status: 200,
      body: {
        items: [
          { tag: "todo", count: 2 },
          { tag: "project", count: 1 },
          { tag: "project/alpha", count: 1 },
        ],
        total: 3,
      },
    });
  });

  test("prefix counts only documents under it; limit caps items, not total", async () => {
    const fx = await seeded("tags-prefix");
    expect((await get(fx, "/v1/vaults/v/tags?prefix=work%2F")).body).toEqual({
      items: [
        { tag: "project/alpha", count: 1 },
        { tag: "todo", count: 1 },
      ],
      total: 2,
    });
    expect((await get(fx, "/v1/vaults/v/tags?limit=1")).body).toEqual({
      items: [{ tag: "todo", count: 2 }],
      total: 3,
    });
    // An empty prefix matches every document.
    expect(((await get(fx, "/v1/vaults/v/tags?prefix=")).body as { total: number }).total).toBe(3);
  });

  test("an empty vault lists nothing", async () => {
    const fx = await makeHttpFixture("tags-empty");
    cleanup.push(fx.stop);
    expect(await get(fx, "/v1/vaults/v/tags")).toEqual({
      status: 200,
      body: { items: [], total: 0 },
    });
  });

  test("unknown vault → 404 vault_not_found", async () => {
    const fx = await makeHttpFixture("tags-404");
    cleanup.push(fx.stop);
    const r = await get(fx, "/v1/vaults/ghost/tags");
    expect(r.status).toBe(404);
    expect(code(r.body)).toBe("vault_not_found");
  });

  test("any other parameter or value → 400 invalid_query", async () => {
    const fx = await makeHttpFixture("tags-400");
    cleanup.push(fx.stop);
    const bad = [
      "limit=0",
      "limit=1001",
      "limit=abc",
      "limit=2.5",
      "limit=0x10",
      "limit=1e2",
      "cursor=x",
      "tag=todo",
      `prefix=${"a".repeat(1025)}`,
      `prefix=${encodeURIComponent("€".repeat(400))}`,
    ];
    for (const q of bad) {
      const r = await get(fx, `/v1/vaults/v/tags?${q}`);
      expect({ q, status: r.status, code: code(r.body) }).toEqual({
        q,
        status: 400,
        code: "invalid_query",
      });
    }
  });
});

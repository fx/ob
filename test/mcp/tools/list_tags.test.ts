/**
 * `list_tags` tool — driven through the real registry over a real indexer:
 * listing, prefix + limit, validation, unknown vault, and the advertised
 * surface (description, read-only hint).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type McpFixture, makeMcpFixture, waitFor } from "../helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

async function fixture(label: string): Promise<McpFixture> {
  const fx = await makeMcpFixture({ label });
  cleanup.push(fx.stop);
  await waitFor(() => fx.indexer.status("v")?.state === "ready");
  return fx;
}

async function seed(fx: McpFixture): Promise<void> {
  mkdirSync(join(fx.vaultRoot, "work"), { recursive: true });
  writeFileSync(join(fx.vaultRoot, "a.md"), "# One\n\nfirst #todo\n\n# Two\n\nsecond #todo\n");
  writeFileSync(join(fx.vaultRoot, "work/b.md"), "# B\n\n#todo and #project/alpha\n");
  writeFileSync(join(fx.vaultRoot, "c.md"), "# C\n\n#project here\n");
  for (const p of ["a.md", "work/b.md", "c.md"]) await fx.indexer.reindex("v", p);
}

function code(parsed: unknown): string {
  return (parsed as { code: string }).code;
}

describe("list_tags", () => {
  test("lists tags with distinct-document counts", async () => {
    const fx = await fixture("tool-lt");
    await seed(fx);
    const r = await fx.callTool("list_tags", { vault: "v" });
    expect(r.isError).toBeUndefined();
    expect(r.parsed).toEqual({
      items: [
        { tag: "todo", count: 2 },
        { tag: "project", count: 1 },
        { tag: "project/alpha", count: 1 },
      ],
      total: 3,
    });
  });

  test("prefix and limit", async () => {
    const fx = await fixture("tool-lt-opts");
    await seed(fx);
    const under = await fx.callTool("list_tags", { vault: "v", prefix: "work/" });
    expect(under.parsed).toEqual({
      items: [
        { tag: "project/alpha", count: 1 },
        { tag: "todo", count: 1 },
      ],
      total: 2,
    });
    const capped = await fx.callTool("list_tags", { vault: "v", limit: 1 });
    expect(capped.parsed).toEqual({ items: [{ tag: "todo", count: 2 }], total: 3 });
    const empty = await fx.callTool("list_tags", { vault: "v", prefix: "" });
    expect((empty.parsed as { total: number }).total).toBe(3);
  });

  test("schema failures are invalid_input", async () => {
    const fx = await fixture("tool-lt-bad");
    for (const args of [
      {},
      { vault: "v", limit: 0 },
      { vault: "v", limit: 1001 },
      { vault: "v", limit: "5" },
      { vault: "v", limit: 2.5 },
      { vault: "v", prefix: "a".repeat(1025) },
      { vault: "v", cursor: "x" },
    ]) {
      const r = await fx.callTool("list_tags", args);
      expect(r.isError).toBe(true);
      expect(code(r.parsed)).toBe("invalid_input");
    }
  });

  test("unknown vault is vault_not_found", async () => {
    const fx = await fixture("tool-lt-404");
    const r = await fx.callTool("list_tags", { vault: "ghost" });
    expect(r.isError).toBe(true);
    expect(code(r.parsed)).toBe("vault_not_found");
  });

  test("is read-only and describes what it lists", async () => {
    const fx = await fixture("tool-lt-meta");
    const t = fx.registry.get("list_tags");
    expect(t?.annotations).toEqual({ readOnlyHint: true });
    const d = t?.description ?? "";
    expect(d).toContain("inline tags");
    expect(d).toContain("search index");
    expect(d).toContain("number of documents");
    expect(d).toContain("NOT rolled up");
    expect(d).toContain("filter.tag");
    expect(t?.inputSchema).toMatchObject({
      type: "object",
      required: ["vault"],
      additionalProperties: false,
    });
    expect(Object.keys((t?.inputSchema as { properties: object }).properties).sort()).toEqual([
      "limit",
      "prefix",
      "vault",
    ]);
  });
});

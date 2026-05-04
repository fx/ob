/**
 * `search` tool — happy path with the deterministic fake embedder, validation,
 * unknown vault → vault_not_found.
 */

import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeMcpFixture, waitFor } from "../helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

test("search returns hits ranked by the fake embedder", async () => {
  const fx = await makeMcpFixture({ label: "tool-sr" });
  cleanup.push(fx.stop);
  await waitFor(() => fx.indexer.status("v")?.state === "ready");
  writeFileSync(join(fx.vaultRoot, "coffee.md"), "# Coffee brewing methods\n");
  writeFileSync(join(fx.vaultRoot, "tea.md"), "# Tea steeping times\n");
  // Trigger reindex so the embedder picks up the docs.
  await fx.indexer.reindex("v", "coffee.md");
  await fx.indexer.reindex("v", "tea.md");
  const r = await fx.callTool("search", { vault: "v", query: "how do I make pour over" });
  expect(r.isError).toBeUndefined();
  const parsed = r.parsed as { hits: { path: string; score: number }[] };
  expect(parsed.hits.length).toBeGreaterThanOrEqual(1);
});

test("search rejects empty query", async () => {
  const fx = await makeMcpFixture({ label: "tool-sr-bad" });
  cleanup.push(fx.stop);
  const r = await fx.callTool("search", { vault: "v", query: "" });
  expect(r.isError).toBe(true);
  expect((r.parsed as { code: string }).code).toBe("invalid_input");
});

test("search returns vault_not_found for unknown slug", async () => {
  const fx = await makeMcpFixture({ label: "tool-sr-404" });
  cleanup.push(fx.stop);
  const r = await fx.callTool("search", { vault: "ghost", query: "anything" });
  expect(r.isError).toBe(true);
  expect((r.parsed as { code: string }).code).toBe("vault_not_found");
});

test("search accepts filter args", async () => {
  const fx = await makeMcpFixture({ label: "tool-sr-filter" });
  cleanup.push(fx.stop);
  await waitFor(() => fx.indexer.status("v")?.state === "ready");
  writeFileSync(join(fx.vaultRoot, "scoped.md"), "scoped");
  const r = await fx.callTool("search", {
    vault: "v",
    query: "scoped",
    limit: 3,
    filter: { pathPrefix: "scoped" },
  });
  expect(r.isError).toBeUndefined();
});

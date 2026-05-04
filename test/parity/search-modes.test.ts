import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SearchMode } from "../../src/indexer/store.ts";
import { callMcp, callRestJson, makeParityFixture, waitFor } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

interface SearchEnvelope {
  query: string;
  limit?: number;
  mode?: SearchMode;
  threshold?: number;
  mmrLambda?: number;
  maxPerPath?: number;
}

/** Drive REST + MCP with the same envelope and assert structurally identical bodies. */
async function assertParity(
  fixtureLabel: string,
  envelope: SearchEnvelope,
): Promise<{ rest: unknown; mcp: unknown }> {
  const fx = await makeParityFixture({ label: fixtureLabel });
  cleanup.push(fx.stop);
  await waitFor(() => fx.indexer.status("v")?.state === "ready");
  // Seed three documents so MMR + maxPerPath have something to bite on.
  // We use `reindex` (not raw writes) so this completes synchronously
  // before we start searching — a watcher race could otherwise reindex
  // the file mid-test, mutating the row set between the two adapter
  // calls.
  writeFileSync(join(fx.vaultRoot, "alpha.md"), "# Alpha file about coffee brewing methods.");
  writeFileSync(join(fx.vaultRoot, "beta.md"), "# Beta file about tea steeping times.");
  writeFileSync(
    join(fx.vaultRoot, "gamma.md"),
    "# Gamma file about coffee brewing and pour over methods.",
  );
  await fx.indexer.reindex("v", "alpha.md");
  await fx.indexer.reindex("v", "beta.md");
  await fx.indexer.reindex("v", "gamma.md");
  // Wait for any in-flight watcher events to drain so the row set is
  // stable across both adapter calls. The chokidar `add` event arrives
  // shortly after the writeFileSync above, and we don't want to race.
  await waitFor(() => fx.indexer.status("v")?.pending === 0);

  const mcp = await callMcp(fx, "search", { vault: "v", ...envelope });
  const rest = await callRestJson(fx, "POST", "/v1/vaults/v/search", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  expect(mcp.isError).toBe(false);
  expect(rest.status).toBe(200);
  expect(mcp.body).toEqual(rest.body);
  return { rest: rest.body, mcp: mcp.body };
}

test("parity: hybrid mode (default knobs)", async () => {
  await assertParity("p-mode-hybrid", { query: "pour over coffee", limit: 5, mode: "hybrid" });
});

test("parity: vector mode", async () => {
  await assertParity("p-mode-vector", { query: "pour over coffee", limit: 5, mode: "vector" });
});

test("parity: fts mode (lexical only)", async () => {
  await assertParity("p-mode-fts", { query: "coffee brewing", limit: 5, mode: "fts" });
});

test("parity: threshold knob (high floor → empty hits on both surfaces)", async () => {
  // A floor of 0.99 keeps only the single top-1 (rank-normalized to 1).
  const { rest, mcp } = await assertParity("p-knob-thresh", {
    query: "coffee",
    limit: 5,
    threshold: 0.99,
  });
  // Both surfaces converge on the same (small) hit set under the floor.
  const restHits = (rest as { hits: unknown[] }).hits;
  const mcpHits = (mcp as { hits: unknown[] }).hits;
  expect(restHits.length).toBe(mcpHits.length);
});

test("parity: mmrLambda knob (full diversity)", async () => {
  await assertParity("p-knob-lambda", { query: "coffee", limit: 5, mmrLambda: 0 });
});

test("parity: maxPerPath knob (single hit per path)", async () => {
  // A maxPerPath of 1 forces one hit per file; both surfaces must agree.
  await assertParity("p-knob-mpp", { query: "coffee", limit: 5, maxPerPath: 1 });
});

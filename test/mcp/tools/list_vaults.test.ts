/**
 * `list_vaults` tool — happy path + invalid-input.
 */

import { afterEach, expect, test } from "bun:test";
import { makeMcpFixture } from "../helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

test("list_vaults returns the configured vault summaries (bare array)", async () => {
  const fx = await makeMcpFixture({ label: "tool-list-vaults" });
  cleanup.push(fx.stop);
  const r = await fx.callTool("list_vaults", {});
  expect(r.isError).toBeUndefined();
  // Spec: output is the bare `VaultSummary[]`, not a wrapping `{ vaults }`
  // envelope (kept identical to REST `GET /v1/vaults` for parity).
  const parsed = r.parsed as { slug: string; name: string }[];
  expect(Array.isArray(parsed)).toBe(true);
  expect(parsed).toHaveLength(1);
  expect(parsed[0]?.slug).toBe("v");
  expect(parsed[0]?.name).toBe("v");
  // Don't assert on `sync.state` / `indexer.state` — those transition
  // asynchronously after fixture spin-up and pinning a specific value
  // makes the test brittle. The full shape is verified by the parity
  // test, which deep-compares MCP and REST snapshots taken in lock-step.
});

test("list_vaults rejects extra args", async () => {
  const fx = await makeMcpFixture({ label: "tool-list-vaults-bad" });
  cleanup.push(fx.stop);
  const r = await fx.callTool("list_vaults", { extra: 1 });
  expect(r.isError).toBe(true);
  expect((r.parsed as { code: string }).code).toBe("invalid_input");
});

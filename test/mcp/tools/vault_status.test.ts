/**
 * `vault_status` tool — happy path + invalid input + unknown vault.
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

test("vault_status returns the configured vault summary", async () => {
  const fx = await makeMcpFixture({ label: "tool-vs" });
  cleanup.push(fx.stop);
  const r = await fx.callTool("vault_status", { vault: "v" });
  expect(r.isError).toBeUndefined();
  expect((r.parsed as { slug: string }).slug).toBe("v");
});

test("vault_status rejects empty vault arg", async () => {
  const fx = await makeMcpFixture({ label: "tool-vs-bad" });
  cleanup.push(fx.stop);
  const r = await fx.callTool("vault_status", { vault: "" });
  expect(r.isError).toBe(true);
  expect((r.parsed as { code: string }).code).toBe("invalid_input");
});

test("vault_status returns vault_not_found for unknown slug", async () => {
  const fx = await makeMcpFixture({ label: "tool-vs-404" });
  cleanup.push(fx.stop);
  const r = await fx.callTool("vault_status", { vault: "ghost" });
  expect(r.isError).toBe(true);
  expect((r.parsed as { code: string }).code).toBe("vault_not_found");
});

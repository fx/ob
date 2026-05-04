import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { callMcp, callRestJson, makeParityFixture } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

test("list_files parity (mixed text + binary, paginated)", async () => {
  const fx = await makeParityFixture({ label: "p-lf" });
  cleanup.push(fx.stop);
  writeFileSync(join(fx.vaultRoot, "a.md"), "# a");
  writeFileSync(join(fx.vaultRoot, "b.md"), "# b");
  writeFileSync(join(fx.vaultRoot, "c.png"), new Uint8Array([0x89]));

  // Page 1.
  const mcp1 = await callMcp(fx, "list_files", { vault: "v", limit: 2 });
  const rest1 = await callRestJson(fx, "GET", "/v1/vaults/v/files?limit=2");
  expect(mcp1.body).toEqual(rest1.body);

  // Page 2 (pass the cursor from page 1).
  const cur = (mcp1.body as { nextCursor: string | null }).nextCursor;
  expect(cur).not.toBeNull();
  const mcp2 = await callMcp(fx, "list_files", {
    vault: "v",
    limit: 2,
    cursor: cur as string,
  });
  const rest2 = await callRestJson(
    fx,
    "GET",
    `/v1/vaults/v/files?limit=2&cursor=${encodeURIComponent(cur as string)}`,
  );
  expect(mcp2.body).toEqual(rest2.body);
});

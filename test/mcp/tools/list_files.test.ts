/**
 * `list_files` tool — happy path, validation, mixed text/binary entries.
 */

import { afterEach, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeMcpFixture } from "../helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

test("list_files returns mixed text + binary entries", async () => {
  const fx = await makeMcpFixture({ label: "tool-lf" });
  cleanup.push(fx.stop);
  writeFileSync(join(fx.vaultRoot, "a.md"), "# a");
  writeFileSync(join(fx.vaultRoot, "b.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
  const r = await fx.callTool("list_files", { vault: "v" });
  expect(r.isError).toBeUndefined();
  const parsed = r.parsed as {
    items: { path: string; contentType: string }[];
    nextCursor: string | null;
  };
  const paths = parsed.items.map((i) => i.path).sort();
  expect(paths).toEqual(["a.md", "b.png"]);
  const aItem = parsed.items.find((i) => i.path === "a.md");
  expect(aItem?.contentType).toContain("text/markdown");
  const bItem = parsed.items.find((i) => i.path === "b.png");
  expect(bItem?.contentType).toBe("image/png");
});

test("list_files rejects an invalid limit", async () => {
  const fx = await makeMcpFixture({ label: "tool-lf-bad" });
  cleanup.push(fx.stop);
  const r = await fx.callTool("list_files", { vault: "v", limit: 0 });
  expect(r.isError).toBe(true);
  expect((r.parsed as { code: string }).code).toBe("invalid_input");
});

test("list_files honors cursor and prefix", async () => {
  const fx = await makeMcpFixture({ label: "tool-lf-page" });
  cleanup.push(fx.stop);
  writeFileSync(join(fx.vaultRoot, "p1.md"), "1");
  writeFileSync(join(fx.vaultRoot, "p2.md"), "2");
  writeFileSync(join(fx.vaultRoot, "q.md"), "q");
  const r1 = await fx.callTool("list_files", { vault: "v", limit: 1, prefix: "p" });
  const parsed1 = r1.parsed as {
    items: { path: string }[];
    nextCursor: string | null;
  };
  expect(parsed1.items).toHaveLength(1);
  expect(parsed1.nextCursor).not.toBeNull();
  const r2 = await fx.callTool("list_files", {
    vault: "v",
    limit: 10,
    prefix: "p",
    cursor: parsed1.nextCursor as string,
  });
  const parsed2 = r2.parsed as { items: { path: string }[]; nextCursor: string | null };
  expect(parsed2.items.map((i) => i.path)).toEqual(["p2.md"]);
});

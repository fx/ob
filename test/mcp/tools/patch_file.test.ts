/**
 * `patch_file` tool — single edit, ambiguous-edit abort, binary rejection,
 * missing file rejection, validation.
 */

import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeMcpFixture, waitFor } from "../helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

test("patch_file applies a single edit", async () => {
  const fx = await makeMcpFixture({ label: "tool-pf" });
  cleanup.push(fx.stop);
  await waitFor(() => fx.indexer.status("v")?.state === "ready");
  writeFileSync(join(fx.vaultRoot, "n.md"), "# hi\nfoo\n");
  const r = await fx.callTool("patch_file", {
    vault: "v",
    path: "n.md",
    edits: [{ old: "foo", new: "bar" }],
  });
  expect(r.isError).toBeUndefined();
  const onDisk = readFileSync(join(fx.vaultRoot, "n.md"), "utf8");
  expect(onDisk).toBe("# hi\nbar\n");
});

test("patch_file ambiguous edit aborts atomically", async () => {
  const fx = await makeMcpFixture({ label: "tool-pf-amb" });
  cleanup.push(fx.stop);
  writeFileSync(join(fx.vaultRoot, "n.md"), "foo\nfoo\n");
  const r = await fx.callTool("patch_file", {
    vault: "v",
    path: "n.md",
    edits: [{ old: "foo", new: "bar" }],
  });
  expect(r.isError).toBe(true);
  const parsed = r.parsed as { code: string; details: { editIndex: number; occurrences: number } };
  expect(parsed.code).toBe("patch_ambiguous");
  expect(parsed.details.editIndex).toBe(0);
  expect(parsed.details.occurrences).toBe(2);
  // File on disk is untouched (atomicity).
  expect(readFileSync(join(fx.vaultRoot, "n.md"), "utf8")).toBe("foo\nfoo\n");
});

test("patch_file rejects binary path", async () => {
  const fx = await makeMcpFixture({ label: "tool-pf-bin" });
  cleanup.push(fx.stop);
  writeFileSync(join(fx.vaultRoot, "i.png"), new Uint8Array([0, 1]));
  const r = await fx.callTool("patch_file", {
    vault: "v",
    path: "i.png",
    edits: [{ old: "x", new: "y" }],
  });
  expect(r.isError).toBe(true);
  expect((r.parsed as { code: string }).code).toBe("unsupported_media_type");
});

test("patch_file rejects missing file", async () => {
  const fx = await makeMcpFixture({ label: "tool-pf-404" });
  cleanup.push(fx.stop);
  const r = await fx.callTool("patch_file", {
    vault: "v",
    path: "missing.md",
    edits: [{ old: "a", new: "b" }],
  });
  expect(r.isError).toBe(true);
  expect((r.parsed as { code: string }).code).toBe("not_found");
});

test("patch_file rejects empty edits array", async () => {
  const fx = await makeMcpFixture({ label: "tool-pf-empty" });
  cleanup.push(fx.stop);
  const r = await fx.callTool("patch_file", { vault: "v", path: "n.md", edits: [] });
  expect(r.isError).toBe(true);
  expect((r.parsed as { code: string }).code).toBe("invalid_input");
});

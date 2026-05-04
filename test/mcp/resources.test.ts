/**
 * MCP `resources/list` and `resources/read` exercises through the resource
 * handler bound to the fixture's service-core deps. Drives the handler in
 * process — no HTTP — same pattern as the tool tests.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { decodeCursor, parseObVaultUri } from "../../src/mcp/resources.ts";
import { makeMcpFixture, waitFor } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

describe("parseObVaultUri", () => {
  test("splits scheme/slug/path", () => {
    expect(parseObVaultUri("obvault://v/notes/x.md")).toEqual({
      slug: "v",
      path: "notes/x.md",
    });
  });

  test("rejects non-obvault scheme", () => {
    expect(() => parseObVaultUri("file:///etc/passwd")).toThrow(McpError);
  });

  test("rejects missing path", () => {
    expect(() => parseObVaultUri("obvault://v")).toThrow(McpError);
    expect(() => parseObVaultUri("obvault://v/")).toThrow(McpError);
    expect(() => parseObVaultUri("obvault:///x.md")).toThrow(McpError);
  });
});

describe("decodeCursor", () => {
  test("undefined / empty → undefined", () => {
    expect(decodeCursor(undefined)).toBeUndefined();
    expect(decodeCursor("")).toBeUndefined();
  });

  test("slug-only token → no inner cursor", () => {
    const t = Buffer.from("v", "utf8").toString("base64");
    expect(decodeCursor(t)).toEqual({ slug: "v", innerCursor: undefined });
  });

  test("slug + inner cursor", () => {
    const t = Buffer.from("v\0innerToken", "utf8").toString("base64");
    expect(decodeCursor(t)).toEqual({ slug: "v", innerCursor: "innerToken" });
  });

  test("slug + empty inner cursor → undefined inner", () => {
    const t = Buffer.from("v\0", "utf8").toString("base64");
    expect(decodeCursor(t)).toEqual({ slug: "v", innerCursor: undefined });
  });
});

describe("resources/list", () => {
  test("returns Markdown documents under obvault://", async () => {
    const fx = await makeMcpFixture({ label: "res-list" });
    cleanup.push(fx.stop);
    writeFileSync(join(fx.vaultRoot, "a.md"), "# a");
    writeFileSync(join(fx.vaultRoot, "b.md"), "# b");
    writeFileSync(join(fx.vaultRoot, "binary.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const list = await fx.resources.list(undefined);
    const uris = list.resources.map((r) => r.uri);
    expect(uris).toContain("obvault://v/a.md");
    expect(uris).toContain("obvault://v/b.md");
    // Binary is filtered out.
    expect(uris.some((u) => u.endsWith(".png"))).toBe(false);
    for (const r of list.resources) expect(r.mimeType).toBe("text/markdown");
  });

  test("empty when no vaults configured", async () => {
    const fx = await makeMcpFixture({ label: "res-empty", slugs: [] });
    cleanup.push(fx.stop);
    const list = await fx.resources.list(undefined);
    expect(list.resources).toEqual([]);
  });

  test("propagates nextCursor when a vault page is full (within-slug pagination)", async () => {
    const fx = await makeMcpFixture({ label: "res-page-within" });
    cleanup.push(fx.stop);
    // Override the page limit via the lower-level buildResourceHandler so we
    // don't have to write 100+ fixture files.
    const { buildResourceHandler } = await import("../../src/mcp/resources.ts");
    writeFileSync(join(fx.vaultRoot, "a.md"), "1");
    writeFileSync(join(fx.vaultRoot, "b.md"), "2");
    writeFileSync(join(fx.vaultRoot, "c.md"), "3");
    const small = buildResourceHandler(fx.serviceDeps, () => ["v"], 1);
    const page = await small.list(undefined);
    expect(page.resources).toHaveLength(1);
    expect(page.nextCursor).toBeDefined();
    // Decoded cursor names slug "v" with an inner cursor.
    const dec = decodeCursor(page.nextCursor);
    expect(dec?.slug).toBe("v");
    expect(dec?.innerCursor).toBeDefined();
  });

  test("paginates across pages within a vault using a cursor", async () => {
    const fx = await makeMcpFixture({ label: "res-page" });
    cleanup.push(fx.stop);
    // Force two pages by filling more entries than fit in a small page.
    // Drop the page size temporarily by writing many files and using the
    // service core's own list cursor, which we reconstruct by hand.
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(fx.vaultRoot, `note-${i}.md`), `# ${i}`);
    }
    // First page with no cursor, then advance by hand-constructing a cursor
    // pointing at the first entry. The service core's own cursor format is
    // base64(lastSeenPath); we wrap it in our own slug-prefixed cursor.
    const firstSlugCursor = Buffer.from(
      `v\0${Buffer.from("note-0.md", "utf8").toString("base64")}`,
      "utf8",
    ).toString("base64");
    const after = await fx.resources.list(firstSlugCursor);
    // Should list every note after note-0.md.
    expect(after.resources.map((r) => r.name)).toEqual([
      "note-1.md",
      "note-2.md",
      "note-3.md",
      "note-4.md",
    ]);
  });

  test("advances to the next slug when a vault is exhausted", async () => {
    const fx = await makeMcpFixture({ label: "res-multi", slugs: ["a", "b"] });
    cleanup.push(fx.stop);
    writeFileSync(join(fx.dataDir, "vaults", "b", "only.md"), "# only");
    // First call lists vault `a` (empty). nextCursor should advance to `b`.
    const page1 = await fx.resources.list(undefined);
    expect(page1.resources).toEqual([]);
    expect(page1.nextCursor).toBeDefined();
    const page2 = await fx.resources.list(page1.nextCursor);
    expect(page2.resources.map((r) => r.uri)).toEqual(["obvault://b/only.md"]);
  });

  test("stale cursor naming an unknown slug returns empty", async () => {
    const fx = await makeMcpFixture({ label: "res-stale" });
    cleanup.push(fx.stop);
    const stale = Buffer.from("ghost", "utf8").toString("base64");
    const list = await fx.resources.list(stale);
    expect(list.resources).toEqual([]);
  });
});

describe("resources/read", () => {
  test("returns Markdown text with text/markdown mime", async () => {
    const fx = await makeMcpFixture({ label: "res-read" });
    cleanup.push(fx.stop);
    await waitFor(() => fx.indexer.status("v")?.state === "ready");
    writeFileSync(join(fx.vaultRoot, "x.md"), "# hi\nbody");
    const read = await fx.resources.read("obvault://v/x.md");
    expect(read.contents).toHaveLength(1);
    const c = read.contents[0];
    expect(c.uri).toBe("obvault://v/x.md");
    expect(c.mimeType).toBe("text/markdown");
    expect(c.text).toBe("# hi\nbody");
  });

  test("rejects non-Markdown URIs with not_found", async () => {
    const fx = await makeMcpFixture({ label: "res-nonmd" });
    cleanup.push(fx.stop);
    writeFileSync(join(fx.vaultRoot, "data.png"), new Uint8Array([0]));
    let err: unknown;
    try {
      await fx.resources.read("obvault://v/data.png");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(McpError);
    const m = err as McpError;
    expect((m.data as { code: string } | undefined)?.code).toBe("not_found");
  });

  test("unknown vault → not_found", async () => {
    const fx = await makeMcpFixture({ label: "res-unknown" });
    cleanup.push(fx.stop);
    let err: unknown;
    try {
      await fx.resources.read("obvault://ghost/x.md");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(McpError);
    expect(((err as McpError).data as { code: string }).code).toBe("not_found");
  });

  test("unknown URI scheme → not_found", async () => {
    const fx = await makeMcpFixture({ label: "res-bad-uri" });
    cleanup.push(fx.stop);
    let err: unknown;
    try {
      await fx.resources.read("file:///etc/passwd");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(McpError);
    expect(((err as McpError).data as { code: string }).code).toBe("not_found");
  });

  test("missing file → not_found", async () => {
    const fx = await makeMcpFixture({ label: "res-missing" });
    cleanup.push(fx.stop);
    let err: unknown;
    try {
      await fx.resources.read("obvault://v/missing.md");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(McpError);
    // Pin the canonical `not_found` code so a future regression in the
    // resource-error mapper (e.g. surfacing an `internal` for a missing
    // file) gets caught here.
    expect(((err as McpError).data as { code: string }).code).toBe("not_found");
  });
});

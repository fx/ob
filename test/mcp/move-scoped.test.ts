/**
 * Move and copy in a scoped MCP session (MCP Server › Session scoping;
 * Link rewriting › Notes scanned): links resolve over the WHOLE vault, only
 * notes inside the scope are rewritten, nothing outside the scope is written,
 * every reported path is scope-relative, indexability is judged on the
 * vault-relative path, and scoped and unscoped calls share one lock per file.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Indexer } from "../../src/indexer/index.ts";
import type { McpRoutesDeps } from "../../src/mcp/index.ts";
import { scopeDeps } from "../../src/mcp/scope.ts";
import { copyPath } from "../../src/vault/copy.ts";
import { appendFile, patchFile, writeFile } from "../../src/vault/files.ts";
import { pathLockKey, withPathLock } from "../../src/vault/lock.ts";
import { movePath } from "../../src/vault/paths.ts";
import { type VaultFixture, makeVaultFixture } from "../vault/helpers.ts";

function put(root: string, rel: string, content = "x"): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

const read = (root: string, rel: string): string => readFileSync(join(root, rel), "utf8");

function scoped(fx: VaultFixture, prefix: string): McpRoutesDeps {
  const deps: McpRoutesDeps = {
    ...fx.deps,
    indexer: fx.deps.indexer as Indexer,
    supervisor: { list: () => [], get: () => null, stop: async () => undefined },
  };
  return scopeDeps(deps, { slug: fx.slug, prefix });
}

describe("scoped move", () => {
  test("resolves links vault-wide, rewrites only in-scope notes, reports scope-relative paths", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "agents/a/x.md", "# X");
    put(fx.root, "agents/a/n.md", "[[x]]");
    put(fx.root, "b/x.md", "# other X");
    put(fx.root, "other/n3.md", "[[agents/a/x]]");
    const deps = scoped(fx, "agents/a");
    const res = await movePath(deps, fx.slug, "x.md", { destination: "sub/x.md" });
    expect(res).toEqual({
      path: "x.md",
      destination: "sub/x.md",
      type: "file",
      overwritten: false,
      indexed: true,
      links: { updated: [{ path: "n.md", links: 1, indexed: true }], failed: [] },
    });
    // From the scope, `[[x]]` would now find `b/x.md` (fewer segments) — a file
    // outside the scope — so it is qualified with its vault path (content).
    expect(read(fx.root, "agents/a/n.md")).toBe("[[agents/a/sub/x]]");
    // The note outside the scope is neither modified nor reported.
    expect(read(fx.root, "other/n3.md")).toBe("[[agents/a/x]]");
    expect(JSON.stringify(res)).not.toContain("agents");
    expect(fx.indexed.has("agents/a/sub/x.md")).toBe(true);
  });

  test("a scoped folder move drops and reindexes vault-relative rows, reported scope-relative", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "agents/a/f/one.md", "# 1");
    fx.indexed.add("agents/a/f/one.md");
    fx.indexed.add("agents/a/f/.d/h.md");
    const res = await movePath(scoped(fx, "agents/a"), fx.slug, "f", { destination: "g" });
    expect(res).toMatchObject({ path: "f", destination: "g", type: "folder", indexed: true });
    expect([...fx.indexed].sort()).toEqual(["agents/a/g/one.md"]);
  });

  test("neither path can leave the scope", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "agents/a/x.md");
    put(fx.root, "top.md", "TOP");
    const deps = scoped(fx, "agents/a");
    await expect(
      movePath(deps, fx.slug, "x.md", { destination: "../../top2.md" }),
    ).rejects.toThrow();
    await expect(
      copyPath(deps, fx.slug, "../../top.md", { destination: "t.md" }),
    ).rejects.toThrow();
    expect(read(fx.root, "top.md")).toBe("TOP");
  });
});

describe("indexability is judged on the vault-relative path", () => {
  test("in a session scoped to node_modules/pkg every write reports indexed: false and writes no rows", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "node_modules/pkg/src.md", "# S");
    put(fx.root, "node_modules/pkg/ref.md", "[[src]]");
    const deps = scoped(fx, "node_modules/pkg");
    const w = await writeFile(deps, fx.slug, "note.md", { kind: "markdown", content: "# n\n" });
    const p = await patchFile(deps, fx.slug, "note.md", { edits: [{ old: "# n", new: "# m" }] });
    const a = await appendFile(deps, fx.slug, "note.md", new TextEncoder().encode("more\n"));
    const mv = await movePath(deps, fx.slug, "src.md", { destination: "moved.md" });
    const cp = await copyPath(deps, fx.slug, "note.md", { destination: "copy.md" });
    expect([w.indexed, p.indexed, a.indexed, mv.indexed, cp.indexed]).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(mv.links?.updated).toEqual([{ path: "ref.md", links: 1, indexed: false }]);
    expect(read(fx.root, "node_modules/pkg/ref.md")).toBe("[[moved]]");
    expect(fx.indexed.size).toBe(0);
  });
});

describe("one lock per file, scoped or not", () => {
  test("a scoped patch_file of x.md and an unscoped move of agents/a/x.md contend on one lock", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "agents/a/x.md", "alpha");
    const deps = scoped(fx, "agents/a");
    // Unscoped key held → the scoped patch waits.
    let release!: () => void;
    const held = withPathLock(
      pathLockKey(fx.root, "agents/a/x.md"),
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    let patched = false;
    const patch = patchFile(deps, fx.slug, "x.md", { edits: [{ old: "alpha", new: "beta" }] }).then(
      () => {
        patched = true;
      },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(patched).toBe(false);
    release();
    await Promise.all([held, patch]);
    // Scoped key held → the unscoped move waits.
    let release2!: () => void;
    const held2 = withPathLock(
      pathLockKey(join(fx.root, "agents", "a"), "x.md"),
      () =>
        new Promise<void>((r) => {
          release2 = r;
        }),
    );
    let moved = false;
    const mv = movePath(fx.deps, fx.slug, "agents/a/x.md", { destination: "agents/a/y.md" }).then(
      () => {
        moved = true;
      },
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(moved).toBe(false);
    release2();
    await Promise.all([held2, mv]);
    expect(read(fx.root, "agents/a/y.md")).toBe("beta");
  });
});

/**
 * Service-core tests for `movePath` (REST API › Path operations, `:move`;
 * Link rewriting) against REAL on-disk tmpdir vaults — no `fs` mocking. A
 * concurrent ob call, a cooperating outside writer, or a failing filesystem
 * step is played through the `beforeStep` hook at an exact, named step. The
 * fake indexer (`./helpers.ts`) keeps an in-memory index and applies the real
 * indexable-path rule inside `reindex`, so index outcomes are asserted by
 * resulting index state and by its ordered `events` log.
 */

import { describe, expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AlreadyExistsError,
  DocNotFoundError,
  InvalidPathError,
  VaultNotFoundError,
} from "../../src/errors.ts";
import { type VaultServiceDeps, patchFile, writeFile } from "../../src/vault/files.ts";
import type { GuardSite } from "../../src/vault/guarded.ts";
import { pathLockKey, withPathLock } from "../../src/vault/lock.ts";
import { PostPublicationError, movePath } from "../../src/vault/paths.ts";
import { type VaultFixture, makeVaultFixture } from "./helpers.ts";

function put(root: string, rel: string, content = "x"): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

const read = (root: string, rel: string): string => readFileSync(join(root, rel), "utf8");

type Step = (site: GuardSite, paths: readonly string[]) => Promise<void> | void;

/** Deps whose `beforeStep` runs `step`. */
function stepping(fx: VaultFixture, step: Step): VaultServiceDeps {
  return { ...fx.deps, hooks: { beforeStep: async (site, paths) => step(site, paths) } };
}

function outsideDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ob-outside-"));
  writeFileSync(join(dir, "keep.md"), "OUTSIDE");
  return dir;
}

function errno(code: string): Error {
  return Object.assign(new Error(`${code}: injected`), { code });
}

/** Every entry of the vault, hidden ones included, for "nothing changed" assertions. */
function tree(root: string): string[] {
  return (readdirSync(root, { recursive: true }) as string[]).sort();
}

describe("movePath: scenarios", () => {
  test("rename a note and update links to it", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "notes/old.md", "# Old\n\nbody");
    put(fx.root, "daily/today.md", "see [[old]]");
    fx.indexed.add("notes/old.md");
    const before = statSync(join(fx.root, "notes/old.md"));
    const res = await movePath(fx.deps, fx.slug, "notes/old.md", { destination: "notes/new.md" });
    expect(res).toEqual({
      path: "notes/old.md",
      destination: "notes/new.md",
      type: "file",
      overwritten: false,
      indexed: true,
      links: { updated: [{ path: "daily/today.md", links: 1, indexed: true }], failed: [] },
    });
    expect(existsSync(join(fx.root, "notes/old.md"))).toBe(false);
    expect(read(fx.root, "notes/new.md")).toBe("# Old\n\nbody");
    // The hard link keeps the inode: bytes and modification time preserved.
    const after = statSync(join(fx.root, "notes/new.md"));
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(read(fx.root, "daily/today.md")).toBe("see [[new]]");
    expect([...fx.indexed].sort()).toEqual(["daily/today.md", "notes/new.md"]);
    // Old rows go under the source lock before anything is reindexed.
    expect(fx.events.indexOf("drop:notes/old.md")).toBeLessThan(
      fx.events.indexOf("reindex:notes/new.md"),
    );
  });

  test("clobber refused without overwrite", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    put(fx.root, "b.md", "B");
    await expect(
      movePath(fx.deps, fx.slug, "a.md", { destination: "b.md" }),
    ).rejects.toBeInstanceOf(AlreadyExistsError);
    expect(read(fx.root, "a.md")).toBe("A");
    expect(read(fx.root, "b.md")).toBe("B");
    expect(fx.events).toEqual([]);
  });

  test("move a folder into a new parent, links not updated", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "inbox/2026/a.md", "# A");
    put(fx.root, "inbox/2026/img.png", "PNG");
    const res = await movePath(fx.deps, fx.slug, "inbox/2026", {
      destination: "archive/2026",
      updateLinks: false,
    });
    expect(res).toMatchObject({ type: "folder", links: null, indexed: true, overwritten: false });
    expect(read(fx.root, "archive/2026/a.md")).toBe("# A");
    expect(read(fx.root, "archive/2026/img.png")).toBe("PNG");
    expect(existsSync(join(fx.root, "inbox/2026"))).toBe(false);
    expect(fx.calls.reindex.map((c) => c.path).sort()).toEqual([
      "archive/2026/a.md",
      "archive/2026/img.png",
    ]);
  });

  test("a folder moved into itself is invalid_path and nothing changed", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "projects/p.md");
    const snap = tree(fx.root);
    await expect(
      movePath(fx.deps, fx.slug, "projects", { destination: "projects/old" }),
    ).rejects.toBeInstanceOf(InvalidPathError);
    expect(tree(fx.root)).toEqual(snap);
  });

  test("a destination outside the vault is invalid_path and nothing is written", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "notes/x.md", "X");
    for (const destination of ["../outside.md", "/abs.md", ".hidden/x.md", "a/../../x.md", "."]) {
      await expect(
        movePath(fx.deps, fx.slug, "notes/x.md", { destination }),
      ).rejects.toBeInstanceOf(InvalidPathError);
    }
    await expect(
      movePath(fx.deps, fx.slug, "../x.md", { destination: "y.md" }),
    ).rejects.toBeInstanceOf(InvalidPathError);
    expect(read(fx.root, "notes/x.md")).toBe("X");
    expect(existsSync(join(fx.root, "..", "outside.md"))).toBe(false);
  });

  test("the extension can change; overwrite replaces a Markdown destination atomically", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    put(fx.root, "c.md", "C-old");
    fx.indexed.add("a.md");
    fx.indexed.add("c.md");
    const txt = await movePath(fx.deps, fx.slug, "a.md", { destination: "a.txt" });
    expect(txt).toMatchObject({ indexed: false, overwritten: false });
    expect(fx.indexed.has("a.md")).toBe(false);
    put(fx.root, "b.md", "B");
    const over = await movePath(fx.deps, fx.slug, "b.md", { destination: "c.md", overwrite: true });
    expect(over).toMatchObject({ overwritten: true, indexed: true });
    expect(read(fx.root, "c.md")).toBe("B");
    expect(existsSync(join(fx.root, "b.md"))).toBe(false);
    // The replaced content's rows were dropped before the new content was reindexed.
    const i = fx.events.lastIndexOf("drop:c.md");
    expect(i).toBeGreaterThan(-1);
    expect(i).toBeLessThan(fx.events.lastIndexOf("reindex:c.md"));
  });

  test("overwrite onto an absent destination is a plain atomic rename", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    const res = await movePath(fx.deps, fx.slug, "a.md", {
      destination: "n/c.md",
      overwrite: true,
    });
    expect(res).toMatchObject({ overwritten: false, indexed: true });
    expect(read(fx.root, "n/c.md")).toBe("A");
  });

  test("a folder carrying hidden files and symlinks moves whole; only listed files are reindexed", async () => {
    const fx = makeVaultFixture();
    const out = outsideDir();
    put(fx.root, "proj/a.md", "# A");
    put(fx.root, "proj/.drafts/x.md", "# hidden");
    symlinkSync(join(out, "keep.md"), join(fx.root, "proj", "ref.md"));
    // Rows left under a hidden entry (an earlier version, an outside writer).
    fx.indexed.add("proj/.drafts/x.md");
    fx.indexed.add("proj/a.md");
    const res = await movePath(fx.deps, fx.slug, "proj", { destination: "arch" });
    expect(res.type).toBe("folder");
    expect(read(fx.root, "arch/.drafts/x.md")).toBe("# hidden");
    expect(readFileSync(join(fx.root, "arch", "ref.md"), "utf8")).toBe("OUTSIDE");
    // No row remains under the old folder, the hidden one included…
    expect([...fx.indexed].filter((p) => p.startsWith("proj/"))).toEqual([]);
    expect(fx.events).toContain("dropHidden:proj/.drafts/x.md");
    // …and neither the hidden entry nor the symlink was reindexed or rewritten.
    expect(fx.calls.reindex.map((c) => c.path)).toEqual(["arch/a.md"]);
    expect(res.links).toEqual({ updated: [], failed: [] });
    expect([...fx.indexed]).toEqual(["arch/a.md"]);
  });

  test("drops are not filtered by the indexable rule: every old path loses its rows", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "f/a.md");
    put(fx.root, "f/sub/b.md");
    put(fx.root, "f/node_modules/c.md");
    for (const p of ["f/a.md", "f/sub/b.md", "f/node_modules/c.md", "f/gone.md"]) fx.indexed.add(p);
    await movePath(fx.deps, fx.slug, "f", { destination: "g", updateLinks: false });
    expect([...fx.indexed].filter((p) => p.startsWith("f/"))).toEqual([]);
    expect([...fx.indexed].sort()).toEqual(["g/a.md", "g/sub/b.md"]);
  });

  test("canonical paths: ./a.md onto a.md and notes onto ./notes/sub are invalid; notes//x.md is reported as notes/x.md", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md");
    put(fx.root, "notes/x.md", "X");
    await expect(
      movePath(fx.deps, fx.slug, "./a.md", { destination: "a.md" }),
    ).rejects.toBeInstanceOf(InvalidPathError);
    await expect(
      movePath(fx.deps, fx.slug, "notes", { destination: "./notes/sub" }),
    ).rejects.toBeInstanceOf(InvalidPathError);
    const res = await movePath(fx.deps, fx.slug, "notes//x.md", { destination: "y//z.md/" });
    expect(res.path).toBe("notes/x.md");
    expect(res.destination).toBe("y/z.md");
    expect(read(fx.root, "y/z.md")).toBe("X");
  });
});

describe("movePath: error matrix", () => {
  test("source does not exist → not_found", async () => {
    const fx = makeVaultFixture();
    await expect(
      movePath(fx.deps, fx.slug, "nope.md", { destination: "x.md" }),
    ).rejects.toBeInstanceOf(DocNotFoundError);
  });

  test("a parent of the destination exists as a file → invalid_path", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md");
    put(fx.root, "f.md");
    await expect(
      movePath(fx.deps, fx.slug, "a.md", { destination: "f.md/x.md" }),
    ).rejects.toBeInstanceOf(InvalidPathError);
    await expect(
      movePath(fx.deps, fx.slug, "a.md", { destination: "f.md/deeper/x.md" }),
    ).rejects.toBeInstanceOf(InvalidPathError);
    expect(existsSync(join(fx.root, "a.md"))).toBe(true);
  });

  test("an existing destination with overwrite and a folder on either side → already_exists", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "d1/x.md");
    put(fx.root, "d2/y.md");
    put(fx.root, "f.md");
    for (const [src, dst] of [
      ["d1", "d2"],
      ["d1", "f.md"],
      ["f.md", "d2"],
    ] as const) {
      await expect(
        movePath(fx.deps, fx.slug, src, { destination: dst, overwrite: true }),
      ).rejects.toBeInstanceOf(AlreadyExistsError);
    }
    expect(tree(fx.root)).toEqual(["d1", "d1/x.md", "d2", "d2/y.md", "f.md"]);
  });

  test("a symlinked source or destination is invalid_path", async () => {
    const fx = makeVaultFixture();
    const out = outsideDir();
    symlinkSync(join(out, "keep.md"), join(fx.root, "link.md"));
    put(fx.root, "a.md");
    await expect(
      movePath(fx.deps, fx.slug, "link.md", { destination: "b.md" }),
    ).rejects.toBeInstanceOf(InvalidPathError);
    await expect(
      movePath(fx.deps, fx.slug, "a.md", { destination: "link.md", overwrite: true }),
    ).rejects.toBeInstanceOf(InvalidPathError);
    expect(readFileSync(join(out, "keep.md"), "utf8")).toBe("OUTSIDE");
  });

  test("a source that is neither a file nor a folder is invalid_path", async () => {
    const fx = makeVaultFixture();
    // A symlink swapped in after the up-front validation.
    const out = outsideDir();
    put(fx.root, "a.md");
    const deps: VaultServiceDeps = {
      ...fx.deps,
      vault: (s) => fx.deps.vault(s),
      indexer: fx.deps.indexer,
    };
    const p = movePath(
      {
        ...deps,
        hooks: {},
      },
      fx.slug,
      "a.md",
      { destination: "b.md" },
    );
    rmSync(join(fx.root, "a.md"));
    symlinkSync(join(out, "keep.md"), join(fx.root, "a.md"));
    await expect(p).rejects.toBeInstanceOf(InvalidPathError);
  });

  test("an unknown vault is vault_not_found", async () => {
    const fx = makeVaultFixture();
    await expect(movePath(fx.deps, "nope", "a.md", { destination: "b.md" })).rejects.toBeInstanceOf(
      VaultNotFoundError,
    );
  });

  test("an unexpected rename failure propagates and removes the parents it created", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "d/x.md");
    const deps = stepping(fx, (site) => {
      if (site === "move.rename") throw errno("EIO");
    });
    await expect(movePath(deps, fx.slug, "d", { destination: "new/deep/d" })).rejects.toThrow(
      "EIO",
    );
    expect(existsSync(join(fx.root, "new"))).toBe(false);
    expect(existsSync(join(fx.root, "d/x.md"))).toBe(true);
  });
});

describe("movePath: completing a half-finished move", () => {
  function halfFinished(): VaultFixture {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "# moved");
    linkSync(join(fx.root, "a.md"), join(fx.root, "c.md"));
    put(fx.root, "n.md", "[[a]] and [[c]]");
    return fx;
  }

  test("with overwrite it completes: 200, overwritten false, source gone, links rewritten", async () => {
    const fx = halfFinished();
    const res = await movePath(fx.deps, fx.slug, "a.md", { destination: "c.md", overwrite: true });
    expect(res).toMatchObject({ overwritten: false, indexed: true, type: "file" });
    expect(existsSync(join(fx.root, "a.md"))).toBe(false);
    expect(read(fx.root, "c.md")).toBe("# moved");
    // F_before was taken while both names existed, so `[[a]]` resolved to `a.md`.
    expect(read(fx.root, "n.md")).toBe("[[c]] and [[c]]");
    expect(res.links?.updated).toEqual([{ path: "n.md", links: 1, indexed: true }]);
  });

  test("without overwrite it is already_exists and nothing changes", async () => {
    const fx = halfFinished();
    await expect(
      movePath(fx.deps, fx.slug, "a.md", { destination: "c.md" }),
    ).rejects.toBeInstanceOf(AlreadyExistsError);
    expect(existsSync(join(fx.root, "a.md"))).toBe(true);
    expect(read(fx.root, "n.md")).toBe("[[a]] and [[c]]");
  });

  test("a source replaced between the check and the removal is internal, both paths left", async () => {
    const fx = halfFinished();
    const deps = stepping(fx, (site) => {
      if (site !== "move.beforeSourceCheck") return;
      rmSync(join(fx.root, "a.md"));
      writeFileSync(join(fx.root, "a.md"), "writer's new a");
    });
    await expect(
      movePath(deps, fx.slug, "a.md", { destination: "c.md", overwrite: true }),
    ).rejects.toBeInstanceOf(PostPublicationError);
    expect(read(fx.root, "a.md")).toBe("writer's new a");
    expect(read(fx.root, "c.md")).toBe("# moved");
  });
});

describe("movePath: after publication", () => {
  test("source replaced between link and removal: internal, writer's source intact, destination moved", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "moved content");
    const deps = stepping(fx, (site) => {
      if (site !== "move.beforeSourceCheck") return;
      rmSync(join(fx.root, "a.md"));
      writeFileSync(join(fx.root, "a.md"), "writer content");
    });
    const err = await movePath(deps, fx.slug, "a.md", { destination: "c.md" }).catch((e) => e);
    expect(err).toBeInstanceOf(PostPublicationError);
    expect(read(fx.root, "a.md")).toBe("writer content");
    expect(read(fx.root, "c.md")).toBe("moved content");
  });

  test("a containment failure before removing the source is internal, nothing outside removed", async () => {
    const fx = makeVaultFixture();
    const out = outsideDir();
    put(fx.root, "notes/a.md", "moved");
    writeFileSync(join(out, "a.md"), "OUTSIDE A");
    const deps = stepping(fx, (site) => {
      if (site !== "move.unlinkSource") return;
      renameSync(join(fx.root, "notes"), join(fx.root, "notes-real"));
      symlinkSync(out, join(fx.root, "notes"));
    });
    await expect(
      movePath(deps, fx.slug, "notes/a.md", { destination: "c.md" }),
    ).rejects.toBeInstanceOf(PostPublicationError);
    expect(read(fx.root, "c.md")).toBe("moved");
    expect(readFileSync(join(out, "a.md"), "utf8")).toBe("OUTSIDE A");
    expect(read(fx.root, "notes-real/a.md")).toBe("moved");
  });

  test("unlink(src) failing after the link leaves both paths holding the file and is internal", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    const deps = stepping(fx, (site) => {
      if (site === "move.unlinkSource") throw errno("EACCES");
    });
    await expect(movePath(deps, fx.slug, "a.md", { destination: "c.md" })).rejects.toBeInstanceOf(
      PostPublicationError,
    );
    expect(read(fx.root, "a.md")).toBe("A");
    expect(read(fx.root, "c.md")).toBe("A");
    expect(statSync(join(fx.root, "a.md")).ino).toBe(statSync(join(fx.root, "c.md")).ino);
  });

  test("drop, reindex, and rewrite failures after publication are 200 with indexed false / links.failed", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    put(fx.root, "n.md", "[[a]]");
    fx.indexed.add("a.md");
    fx.failNextDrop(new Error("drop down"));
    const dropped = await movePath(fx.deps, fx.slug, "a.md", { destination: "b.md" });
    expect(dropped.indexed).toBe(false);
    expect(fx.logCalls.warn.some((w) => w.msg.includes("indexer.drop failed"))).toBe(true);
    // The rewritten note is reindexed first; then the moved note's reindex fails.
    const deps = stepping(fx, (site) => {
      if (site === "rewrite.openTmp") throw errno("EACCES");
    });
    let reindexes = 0;
    const failing: VaultServiceDeps = {
      ...deps,
      indexer: {
        ...deps.indexer,
        reindex: async (s, p) => {
          if (reindexes++ === 0) throw new Error("reindex down");
          return deps.indexer.reindex(s, p);
        },
      },
    };
    const res = await movePath(failing, fx.slug, "b.md", { destination: "c.md" });
    expect(res.indexed).toBe(false);
    expect(res.links).toEqual({
      updated: [],
      failed: [{ path: "n.md", code: "internal", message: "the note could not be rewritten" }],
    });
    expect(read(fx.root, "n.md")).toBe("[[b]]");
    expect(read(fx.root, "c.md")).toBe("A");
  });
});

describe("movePath: indexed", () => {
  test("only a PNG, or an empty folder, reports indexed false", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "img.png", "PNG");
    mkdirSync(join(fx.root, "empty"));
    expect((await movePath(fx.deps, fx.slug, "img.png", { destination: "i2.png" })).indexed).toBe(
      false,
    );
    expect((await movePath(fx.deps, fx.slug, "empty", { destination: "e2" })).indexed).toBe(false);
    expect(existsSync(join(fx.root, "e2"))).toBe(true);
  });

  test("a failed overwritten-destination drop makes indexed false", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    put(fx.root, "c.md", "C");
    fx.indexed.add("c.md");
    const deps: VaultServiceDeps = {
      ...fx.deps,
      indexer: {
        ...fx.deps.indexer,
        drop: async (s, p) => {
          if (p === "c.md") throw new Error("drop down");
          return fx.deps.indexer.drop(s, p);
        },
      },
    };
    const res = await movePath(deps, fx.slug, "a.md", { destination: "c.md", overwrite: true });
    expect(res).toMatchObject({ overwritten: true, indexed: false });
  });

  test("an overwrite onto an indexed note leaves no old rows even when the reindex fails", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    put(fx.root, "c.md", "C");
    fx.indexed.add("c.md");
    fx.failNextReindex(new Error("embedder down"));
    const res = await movePath(fx.deps, fx.slug, "a.md", {
      destination: "c.md",
      overwrite: true,
      updateLinks: false,
    });
    expect(res.indexed).toBe(false);
    expect(fx.indexed.has("c.md")).toBe(false);
  });

  test("a rewritten note whose reindex fails is indexed false in its entry; the moved note still counts", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    put(fx.root, "n.md", "[[a]]");
    put(fx.root, "node_modules/pkg/m.md", "[[a]]");
    fx.failNextReindex(new Error("embedder down"));
    const res = await movePath(fx.deps, fx.slug, "a.md", { destination: "b.md" });
    expect(res.indexed).toBe(true);
    expect(res.links?.updated).toEqual([
      { path: "n.md", links: 1, indexed: false },
      { path: "node_modules/pkg/m.md", links: 1, indexed: false },
    ]);
    expect(read(fx.root, "node_modules/pkg/m.md")).toBe("[[b]]");
  });

  test("a moved note that was also rewritten and whose reindex fails: entry and top-level false", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "notes/a.md", "![i](img/x.png)");
    put(fx.root, "notes/img/x.png", "PNG");
    fx.failNextReindex(new Error("embedder down"));
    const res = await movePath(fx.deps, fx.slug, "notes/a.md", { destination: "arch/a.md" });
    expect(read(fx.root, "arch/a.md")).toBe("![i](../notes/img/x.png)");
    expect(res.links?.updated).toEqual([{ path: "arch/a.md", links: 1, indexed: false }]);
    expect(res.indexed).toBe(false);
    // The rewriter's reindex was the moved path's reindex: not repeated.
    expect(fx.calls.reindex.map((c) => c.path)).toEqual(["arch/a.md"]);
  });

  test("an indexedPaths failure during a folder move is logged and makes indexed false", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "f/a.md");
    fx.failNextIndexedPaths(new Error("index down"));
    const res = await movePath(fx.deps, fx.slug, "f", { destination: "g" });
    expect(res.indexed).toBe(false);
    expect(read(fx.root, "g/a.md")).toBe("x");
  });

  test("a hidden-row drop failure makes indexed false", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "f/a.md");
    fx.indexed.add("f/.d/x.md");
    const deps: VaultServiceDeps = {
      ...fx.deps,
      indexer: {
        ...fx.deps.indexer,
        dropHidden: async () => {
          throw new Error("drop down");
        },
      },
    };
    const res = await movePath(deps, fx.slug, "f", { destination: "g" });
    expect(res.indexed).toBe(false);
  });

  test("rows of a path that is no longer indexable are dropped when a move lands on it", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    put(fx.root, "b.md", "B");
    fx.indexed.add("node_modules/pkg/note.md");
    fx.indexed.add("img/logo.png");
    const nm = await movePath(fx.deps, fx.slug, "a.md", {
      destination: "node_modules/pkg/note.md",
    });
    const png = await movePath(fx.deps, fx.slug, "b.md", { destination: "img/logo.png" });
    expect(nm.indexed).toBe(false);
    expect(png.indexed).toBe(false);
    expect(fx.indexed.size).toBe(0);
  });

  test("a PUT recreating the old path between the rename and the drop keeps its own rows", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    fx.indexed.add("a.md");
    let put2: Promise<unknown> | undefined;
    const deps = stepping(fx, (site) => {
      // An ob writer: it queues on the old path's lock, which the move holds
      // through its drop, then writes and reindexes under that lock.
      if (site === "move.afterPublish") {
        put2 = writeFile(fx.deps, fx.slug, "a.md", { kind: "markdown", content: "new A" });
      }
    });
    await movePath(deps, fx.slug, "a.md", { destination: "b.md" });
    await put2;
    expect(read(fx.root, "a.md")).toBe("new A");
    expect([...fx.indexed].sort()).toEqual(["a.md", "b.md"]);
    expect(fx.events.indexOf("drop:a.md")).toBeLessThan(fx.events.lastIndexOf("reindex:a.md"));
  });

  test("an outside writer's indexable note at the old path keeps its rows pending reindex; a symlink loses them", async () => {
    const fx = makeVaultFixture();
    const out = outsideDir();
    put(fx.root, "a.md", "A");
    put(fx.root, "b.md", "B");
    fx.indexed.add("a.md");
    fx.indexed.add("b.md");
    const deps = stepping(fx, (site, paths) => {
      if (site !== "move.afterPublish") return;
      const src = paths[0] as string;
      if (src.endsWith("a.md")) writeFileSync(src, "outside rewrite");
      else symlinkSync(join(out, "keep.md"), src);
    });
    await movePath(deps, fx.slug, "a.md", { destination: "a2.md" });
    expect(fx.indexed.has("a.md")).toBe(true);
    await movePath(deps, fx.slug, "b.md", { destination: "b2.md" });
    expect(fx.indexed.has("b.md")).toBe(false);
  });
});

describe("movePath: links", () => {
  test("one failing note does not undo the move", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "notes/old.md", "O");
    put(fx.root, "a.md", "[[old]]");
    put(fx.root, "locked/b.md", "[[old]]");
    const deps = stepping(fx, (site, paths) => {
      if (site === "rewrite.openTmp" && (paths[0] as string).includes("locked")) {
        throw errno("EACCES");
      }
    });
    const res = await movePath(deps, fx.slug, "notes/old.md", { destination: "notes/new.md" });
    expect(read(fx.root, "notes/new.md")).toBe("O");
    expect(read(fx.root, "a.md")).toBe("[[new]]");
    expect(read(fx.root, "locked/b.md")).toBe("[[old]]");
    expect(res.links).toEqual({
      updated: [{ path: "a.md", links: 1, indexed: true }],
      failed: [
        { path: "locked/b.md", code: "internal", message: "the note could not be rewritten" },
      ],
    });
    // A failed write removes only its own temp file.
    expect(readdirSync(join(fx.root, "locked"))).toEqual(["b.md"]);
  });

  test("a failing rename leaves the note and removes the temp file", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    put(fx.root, "n.md", "[[a]]");
    const deps = stepping(fx, (site) => {
      if (site === "rewrite.rename") throw errno("EIO");
    });
    const res = await movePath(deps, fx.slug, "a.md", { destination: "b.md" });
    expect(res.links?.failed.map((f) => f.path)).toEqual(["n.md"]);
    expect(read(fx.root, "n.md")).toBe("[[a]]");
    expect(readdirSync(fx.root).sort()).toEqual(["b.md", "n.md"]);
  });

  test("a note that is unresolvable after the move is failed with invalid_path and unchanged", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    put(fx.root, "x/a", "shadow");
    put(fx.root, "z/a", "shadow");
    put(fx.root, "n.md", "[[a]]");
    const res = await movePath(fx.deps, fx.slug, "a.md", { destination: "x/a.md" });
    expect(res.links?.failed).toEqual([
      { path: "n.md", code: "invalid_path", message: expect.stringContaining("n.md") },
    ]);
    expect(read(fx.root, "n.md")).toBe("[[a]]");
  });

  test("a note that is not valid UTF-8 is left alone and not reported", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    writeFileSync(join(fx.root, "bin.md"), new Uint8Array([0x5b, 0x5b, 0x61, 0x5d, 0x5d, 0xff]));
    const res = await movePath(fx.deps, fx.slug, "a.md", { destination: "b.md" });
    expect(res.links).toEqual({ updated: [], failed: [] });
    expect(readFileSync(join(fx.root, "bin.md"))[5]).toBe(0xff);
  });

  test("every byte but the linkpaths is preserved, BOM and CRLF included", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    const note = "﻿---\r\nup: [[a]]\r\n---\r\nsee [[a|A]] and [l](a.md)\r\n";
    put(fx.root, "n.md", note);
    await movePath(fx.deps, fx.slug, "a.md", { destination: "d/b.md" });
    expect(read(fx.root, "n.md")).toBe(
      "﻿---\r\nup: [[b]]\r\n---\r\nsee [[b|A]] and [l](d/b.md)\r\n",
    );
  });

  test("a note swapped behind a symlinked parent before its read is failed invalid_path; nothing outside read", async () => {
    const fx = makeVaultFixture();
    const out = outsideDir();
    writeFileSync(join(out, "n.md"), "[[a]] OUTSIDE");
    put(fx.root, "a.md", "A");
    put(fx.root, "sub/n.md", "[[a]]");
    const deps = stepping(fx, (site, paths) => {
      if (site === "rewrite.read" && (paths[0] as string).endsWith("sub/n.md")) {
        renameSync(join(fx.root, "sub"), join(fx.root, "sub-real"));
        symlinkSync(out, join(fx.root, "sub"));
      }
    });
    const res = await movePath(deps, fx.slug, "a.md", { destination: "b.md" });
    expect(res.links?.failed).toEqual([
      { path: "sub/n.md", code: "invalid_path", message: expect.any(String) },
    ]);
    expect(readFileSync(join(out, "n.md"), "utf8")).toBe("[[a]] OUTSIDE");
  });

  test("a note that vanished before its read is failed not_found", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    put(fx.root, "n.md", "[[a]]");
    const deps = stepping(fx, (site, paths) => {
      if (site === "rewrite.read" && (paths[0] as string).endsWith("n.md")) {
        rmSync(paths[0] as string);
      }
    });
    const res = await movePath(deps, fx.slug, "a.md", { destination: "b.md" });
    expect(res.links?.failed.map((f) => [f.path, f.code])).toEqual([["n.md", "not_found"]]);
  });

  test("containment: a symlinked parent planted at the temp creation or the rename writes nothing outside", async () => {
    for (const site of ["rewrite.openTmp", "rewrite.rename"] as const) {
      const fx = makeVaultFixture();
      const out = outsideDir();
      put(fx.root, "a.md", "A");
      put(fx.root, "sub/n.md", "[[a]]");
      const deps = stepping(fx, (s, paths) => {
        if (s === site && (paths[0] as string).includes("/sub/")) {
          renameSync(join(fx.root, "sub"), join(fx.root, "sub-real"));
          symlinkSync(out, join(fx.root, "sub"));
        }
      });
      const res = await movePath(deps, fx.slug, "a.md", { destination: "b.md" });
      expect(res.links?.failed.map((f) => [f.path, f.code])).toEqual([
        ["sub/n.md", "invalid_path"],
      ]);
      expect(readdirSync(out)).toEqual(["keep.md"]);
      expect(read(fx.root, "sub-real/n.md")).toBe("[[a]]");
    }
  });
});

describe("movePath: no-replace publish", () => {
  test("an outside writer's destination appearing before the link is already_exists and kept", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    const deps = stepping(fx, (site, paths) => {
      if (site === "move.link") writeFileSync(paths[1] as string, "OUTSIDE C");
    });
    await expect(movePath(deps, fx.slug, "a.md", { destination: "c.md" })).rejects.toBeInstanceOf(
      AlreadyExistsError,
    );
    expect(read(fx.root, "c.md")).toBe("OUTSIDE C");
    expect(read(fx.root, "a.md")).toBe("A");
  });

  test("a non-empty folder appearing before a folder rename is already_exists; parents created are removed", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "d/x.md", "X");
    const deps = stepping(fx, (site, paths) => {
      if (site === "move.rename") put("/", (paths[1] as string).slice(1).concat("/y.md"), "Y");
    });
    await expect(movePath(deps, fx.slug, "d", { destination: "new/d" })).rejects.toBeInstanceOf(
      AlreadyExistsError,
    );
    expect(read(fx.root, "new/d/y.md")).toBe("Y");
    expect(read(fx.root, "d/x.md")).toBe("X");
  });

  test("a folder appearing before an overwrite rename is already_exists", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    put(fx.root, "c.md", "C");
    const deps = stepping(fx, (site, paths) => {
      if (site !== "move.rename") return;
      rmSync(paths[1] as string);
      put("/", (paths[1] as string).slice(1).concat("/inner.md"), "I");
    });
    await expect(
      movePath(deps, fx.slug, "a.md", { destination: "c.md", overwrite: true }),
    ).rejects.toBeInstanceOf(AlreadyExistsError);
    expect(read(fx.root, "a.md")).toBe("A");
  });

  test("no hard links (EPERM from link): the move still works via check-then-rename, warned once per vault", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    put(fx.root, "b.md", "B");
    const deps = stepping(fx, (site) => {
      if (site === "move.link") throw errno("EPERM");
    });
    await movePath(deps, fx.slug, "a.md", { destination: "c.md" });
    await movePath(deps, fx.slug, "b.md", { destination: "d.md" });
    expect(read(fx.root, "c.md")).toBe("A");
    expect(read(fx.root, "d.md")).toBe("B");
    const warns = fx.logCalls.warn.filter((w) => w.msg.includes("refuses hard links"));
    expect(warns.length).toBe(1);
  });

  test("no hard links and a destination that appeared meanwhile is already_exists", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    const deps = stepping(fx, (site, paths) => {
      if (site !== "move.link") return;
      writeFileSync(paths[1] as string, "OUTSIDE");
      throw errno("ENOTSUP");
    });
    await expect(movePath(deps, fx.slug, "a.md", { destination: "c.md" })).rejects.toBeInstanceOf(
      AlreadyExistsError,
    );
    expect(read(fx.root, "c.md")).toBe("OUTSIDE");
  });

  test("an unexpected link failure propagates", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    const deps = stepping(fx, (site) => {
      if (site === "move.link") throw errno("EIO");
    });
    await expect(movePath(deps, fx.slug, "a.md", { destination: "c.md" })).rejects.toThrow("EIO");
    expect(read(fx.root, "a.md")).toBe("A");
  });
});

describe("movePath: owned-only parents and retries", () => {
  test("a 409 removes the parents this call created, but keeps one an outside writer filled", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    const deps = stepping(fx, (site, paths) => {
      if (site !== "move.link") return;
      writeFileSync(paths[1] as string, "OUTSIDE");
      writeFileSync(join(fx.root, "new", "other.md"), "OTHER");
    });
    await expect(
      movePath(deps, fx.slug, "a.md", { destination: "new/deep/x/c.md" }),
    ).rejects.toBeInstanceOf(AlreadyExistsError);
    // `new/deep/x` held the outside file: kept, and so is everything above it.
    expect(read(fx.root, "new/deep/x/c.md")).toBe("OUTSIDE");
    expect(read(fx.root, "new/other.md")).toBe("OTHER");
    // Without an outside file every created level goes.
    const fx2 = makeVaultFixture();
    put(fx2.root, "a.md", "A");
    const deps2 = stepping(fx2, (site) => {
      if (site === "move.link") throw errno("EEXIST");
    });
    await expect(
      movePath(deps2, fx2.slug, "a.md", { destination: "new/deep/c.md" }),
    ).rejects.toBeInstanceOf(AlreadyExistsError);
    expect(existsSync(join(fx2.root, "new"))).toBe(false);
  });

  test("a publish recovers once from a parent removed by another call's cleanup", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    let removed = 0;
    const deps = stepping(fx, (site, paths) => {
      if (site === "move.link" && removed++ === 0) rmdirSync(join(paths[1] as string, ".."));
    });
    const res = await movePath(deps, fx.slug, "a.md", { destination: "new/c.md" });
    expect(res.indexed).toBe(true);
    expect(read(fx.root, "new/c.md")).toBe("A");
    expect(removed).toBe(2);
  });

  test("a parent removed twice is internal and nothing is published", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    const deps = stepping(fx, (site, paths) => {
      if (site === "move.link") rmdirSync(join(paths[1] as string, ".."));
    });
    const err = await movePath(deps, fx.slug, "a.md", { destination: "new/c.md" }).catch((e) => e);
    expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect(existsSync(join(fx.root, "new"))).toBe(false);
    expect(read(fx.root, "a.md")).toBe("A");
  });

  test("a parent level vanishing while parents are created is retried once", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    let n = 0;
    const deps = stepping(fx, (site, paths) => {
      // The second level's mkdir finds its parent (the first level) gone.
      if (site === "parents.mkdir" && (paths[0] as string).endsWith("/b") && n++ === 0) {
        rmdirSync(join(fx.root, "a"));
      }
    });
    await movePath(deps, fx.slug, "a.md", { destination: "a/b/c.md" });
    expect(read(fx.root, "a/b/c.md")).toBe("A");
  });

  test("parents vanishing twice while being created fail the move", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    const deps = stepping(fx, (site, paths) => {
      if (site === "parents.mkdir" && (paths[0] as string).endsWith("/b")) {
        rmdirSync(join(fx.root, "a"));
      }
    });
    await expect(movePath(deps, fx.slug, "a.md", { destination: "a/b/c.md" })).rejects.toThrow();
    expect(existsSync(join(fx.root, "a"))).toBe(false);
    expect(read(fx.root, "a.md")).toBe("A");
  });
});

describe("movePath: containment sites before publication", () => {
  async function expectContained(
    site: GuardSite,
    plant: (fx: VaultFixture, out: string) => void,
    destination = "dst/c.md",
    src = "a.md",
  ): Promise<void> {
    const fx = makeVaultFixture();
    const out = outsideDir();
    put(fx.root, "a.md", "A");
    put(fx.root, "d/x.md", "X");
    mkdirSync(join(fx.root, "dst"));
    let planted = false;
    const deps = stepping(fx, (s) => {
      if (s === site && !planted) {
        planted = true;
        plant(fx, out);
      }
    });
    await expect(movePath(deps, fx.slug, src, { destination })).rejects.toBeInstanceOf(
      InvalidPathError,
    );
    expect(readdirSync(out)).toEqual(["keep.md"]);
    expect(existsSync(join(fx.root, src))).toBe(true);
  }

  const swapDst = (fx: VaultFixture, out: string): void => {
    renameSync(join(fx.root, "dst"), join(fx.root, "dst-real"));
    symlinkSync(out, join(fx.root, "dst"));
  };

  test("the file move's link", async () => {
    await expectContained("move.link", swapDst);
  });

  test("the folder move's rename", async () => {
    await expectContained("move.rename", swapDst, "dst/d", "d");
  });

  test("an EEXIST component inside ensureParents: a symlink there, or a file", async () => {
    await expectContained(
      "parents.mkdir",
      (fx, out) => symlinkSync(out, join(fx.root, "dst", "new")),
      "dst/new/c.md",
    );
    await expectContained(
      "parents.mkdir",
      (fx) => writeFileSync(join(fx.root, "dst", "new"), "a file"),
      "dst/new/c.md",
    );
  });

  test("a parent swapped between two ensureParents levels", async () => {
    const fx = makeVaultFixture();
    const out = outsideDir();
    put(fx.root, "a.md", "A");
    const deps = stepping(fx, (site, paths) => {
      if (site === "parents.mkdir" && (paths[0] as string).endsWith("/l2")) {
        rmdirSync(join(fx.root, "l1"));
        symlinkSync(out, join(fx.root, "l1"));
      }
    });
    await expect(
      movePath(deps, fx.slug, "a.md", { destination: "l1/l2/c.md" }),
    ).rejects.toBeInstanceOf(InvalidPathError);
    // Cleanup refused to `rmdir` through the link: the outside dir is untouched.
    expect(readdirSync(out)).toEqual(["keep.md"]);
    expect(read(fx.root, "a.md")).toBe("A");
  });

  test("a level created by someone else meanwhile is used, not recorded, and kept on failure", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    const deps = stepping(fx, (site, paths) => {
      if (site === "parents.mkdir" && (paths[0] as string).endsWith("/theirs")) {
        mkdirSync(paths[0] as string);
      }
      if (site === "move.link") throw errno("EEXIST");
    });
    await expect(
      movePath(deps, fx.slug, "a.md", { destination: "theirs/mine/c.md" }),
    ).rejects.toBeInstanceOf(AlreadyExistsError);
    expect(existsSync(join(fx.root, "theirs"))).toBe(true);
    expect(existsSync(join(fx.root, "theirs", "mine"))).toBe(false);
  });
});

describe("movePath: concurrency", () => {
  test("two moves to one absent destination: exactly one wins, the loser's source is intact", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    put(fx.root, "b.md", "B");
    const results = await Promise.allSettled([
      movePath(fx.deps, fx.slug, "a.md", { destination: "c.md" }),
      movePath(fx.deps, fx.slug, "b.md", { destination: "c.md" }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const lost = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok.length).toBe(1);
    expect(lost[0]?.reason).toBeInstanceOf(AlreadyExistsError);
    const winner = results[0]?.status === "fulfilled" ? "A" : "B";
    expect(read(fx.root, "c.md")).toBe(winner);
    expect(read(fx.root, winner === "A" ? "b.md" : "a.md")).toBe(winner === "A" ? "B" : "A");
  });

  test("two overwrite moves onto one existing file both succeed in turn; the last wins", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    put(fx.root, "b.md", "B");
    put(fx.root, "c.md", "C");
    await Promise.all([
      movePath(fx.deps, fx.slug, "a.md", { destination: "c.md", overwrite: true }),
      movePath(fx.deps, fx.slug, "b.md", { destination: "c.md", overwrite: true }),
    ]);
    expect(read(fx.root, "c.md")).toBe("B");
    expect(existsSync(join(fx.root, "a.md"))).toBe(false);
    expect(existsSync(join(fx.root, "b.md"))).toBe(false);
  });

  test("a → b and b → a started together both settle without deadlock", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    const settled = await Promise.allSettled([
      movePath(fx.deps, fx.slug, "a.md", { destination: "b.md" }),
      movePath(fx.deps, fx.slug, "b.md", { destination: "a.md" }),
    ]);
    expect(settled.map((s) => s.status)).toEqual(["fulfilled", "fulfilled"]);
    expect(read(fx.root, "a.md")).toBe("A");
  });

  test("a move and a PATCH on the same file are serialized", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "alpha");
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const order: string[] = [];
    let patch: Promise<unknown> | undefined;
    const deps = stepping(fx, async (site) => {
      if (site !== "move.link") return;
      patch = patchFile(fx.deps, fx.slug, "a.md", { edits: [{ old: "alpha", new: "beta" }] }).then(
        () => order.push("patch"),
        (e: unknown) => order.push(`patch:${(e as Error).name}`),
      );
      await new Promise((r) => setTimeout(r, 20));
      order.push("move-publishing");
      release();
    });
    await movePath(deps, fx.slug, "a.md", { destination: "b.md" });
    order.push("move-done");
    await gate;
    await patch;
    // The patch waited for the move's lock (held through the publish), then
    // found the file gone — it never edited the file in mid-move.
    expect(order[0]).toBe("move-publishing");
    expect(order).toContain("patch:DocNotFoundError");
    expect(read(fx.root, "b.md")).toBe("alpha");
  });

  test("chained moves run one after the other; the link follows to where the file ended up", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    put(fx.root, "n.md", "[[a]]");
    const order: string[] = [];
    const deps = stepping(fx, (site, paths) => {
      if (site === "move.link") order.push(`link:${(paths[1] as string).slice(-4)}`);
      if (site === "rewrite.read") order.push("rewrite");
    });
    await Promise.all([
      movePath(deps, fx.slug, "a.md", { destination: "b.md" }),
      movePath(deps, fx.slug, "b.md", { destination: "c.md" }),
    ]);
    expect(read(fx.root, "n.md")).toBe("[[c]]");
    expect(read(fx.root, "c.md")).toBe("A");
    // The second move's publish comes only after the first move's rewrite phase.
    expect(order.indexOf("link:b.md")).toBeLessThan(order.indexOf("rewrite"));
    expect(order.lastIndexOf("rewrite")).toBeGreaterThan(order.indexOf("link:c.md"));
    expect(order.indexOf("rewrite")).toBeLessThan(order.indexOf("link:c.md"));
  });

  test("a held lock on either path blocks the move: one canonical key for aliases", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    let release!: () => void;
    const held = withPathLock(
      pathLockKey(fx.root, "a.md"),
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    let done = false;
    const mv = movePath(fx.deps, fx.slug, "./a.md", { destination: "b.md" }).then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(done).toBe(false);
    release();
    await Promise.all([held, mv]);
    expect(done).toBe(true);
  });
});

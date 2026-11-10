/**
 * Service-core tests for the type-agnostic path operations (`listPaths`,
 * `deletePath`) against REAL on-disk tmpdir vaults — no `fs` mocking. A
 * concurrent writer is played through the `hooks` test seams at an exact
 * point of each operation. The fake indexer (see `./helpers.ts`) keeps an
 * in-memory index and answers `isIndexable` with the real predicate, so the
 * drop guard is asserted by resulting index state, and its `events` log
 * orders indexer calls against the hooks' own events.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DocNotFoundError,
  FolderNotEmptyError,
  InvalidPathError,
  VaultNotFoundError,
} from "../../src/errors.ts";
import type { PathOpHooks, VaultServiceDeps } from "../../src/vault/files.ts";
import {
  type PathEntry,
  canonicalPath,
  comparePaths,
  decodeCursor,
  deletePath,
  encodeCursor,
  listPaths,
  walkVaultEntries,
} from "../../src/vault/paths.ts";
import { type VaultFixture, makeVaultFixture } from "./helpers.ts";

function put(root: string, rel: string, content = "x"): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function withHooks(fx: VaultFixture, hooks: PathOpHooks): VaultServiceDeps {
  return { ...fx.deps, hooks };
}

const tags = (items: readonly PathEntry[]): string[] => items.map((i) => `${i.type}:${i.path}`);

function outsideDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "ob-outside-"));
  writeFileSync(join(dir, "x.md"), "SECRET OUTSIDE");
  return dir;
}

// ---------------------------------------------------------------------------
// Ordering primitives
// ---------------------------------------------------------------------------

describe("comparePaths", () => {
  test("is segment-wise: a folder precedes its descendants, which precede a-b.md", () => {
    const sorted = ["a-b.md", "a/x.md", "a"].sort(comparePaths);
    expect(sorted).toEqual(["a", "a/x.md", "a-b.md"]);
  });

  test("equal paths compare equal; a proper segment-prefix sorts first", () => {
    expect(comparePaths("a/b", "a/b")).toBe(0);
    expect(comparePaths("a", "a/b")).toBe(-1);
    expect(comparePaths("a/b", "a")).toBe(1);
    expect(comparePaths("ab", "a")).toBe(1);
  });

  test("compares segments by raw code point, not UTF-16 code unit", () => {
    // U+FFFD < U+1F600 by code point, but its UTF-16 form (0xFFFD) is above
    // the emoji's leading surrogate (0xD83D).
    expect(comparePaths("�", "\u{1F600}")).toBe(-1);
    expect(comparePaths("\u{1F600}x", "\u{1F600}y")).toBe(-1);
    expect(comparePaths("A", "a")).toBe(-1);
  });
});

describe("cursor encoding", () => {
  test("round-trips a path; empty and missing cursors mean none", () => {
    expect(decodeCursor(encodeCursor("a/x.md"))).toBe("a/x.md");
    expect(decodeCursor("")).toBeUndefined();
    expect(decodeCursor(undefined)).toBeUndefined();
  });
});

describe("canonicalPath", () => {
  test("strips trailing slashes and drops empty and dot segments", () => {
    expect(canonicalPath("notes/")).toBe("notes");
    expect(canonicalPath("./a.md")).toBe("a.md");
    expect(canonicalPath("notes//b.md/")).toBe("notes/b.md");
    expect(canonicalPath("./")).toBe("");
  });

  test("keeps a leading slash and `..` so validation still rejects them", () => {
    expect(canonicalPath("/etc/passwd")).toBe("/etc/passwd");
    expect(canonicalPath("a/../b")).toBe("a/../b");
  });
});

describe("walkVaultEntries", () => {
  test("walks a subfolder in pre-order with the default descend", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a/b/c.md");
    put(fx.root, "a/z.md");
    const seen: string[] = [];
    for await (const e of walkVaultEntries(fx.root, "a")) seen.push(`${e.type}:${e.rel}`);
    expect(seen).toEqual(["folder:a/b", "file:a/b/c.md", "file:a/z.md"]);
  });
});

// ---------------------------------------------------------------------------
// listPaths
// ---------------------------------------------------------------------------

/** The vault from the spec's "Files and folders in one ordered listing" scenario. */
function orderedVault(): VaultFixture {
  const fx = makeVaultFixture();
  put(fx.root, "a/x.md", "# x");
  mkdirSync(join(fx.root, "a", "empty"));
  put(fx.root, "a-b.md", "# ab");
  return fx;
}

describe("listPaths", () => {
  test("files and folders in one segment-ordered listing", async () => {
    const fx = orderedVault();
    const page = await listPaths(fx.deps, fx.slug);
    expect(tags(page.items)).toEqual(["folder:a", "folder:a/empty", "file:a/x.md", "file:a-b.md"]);
    expect(page.nextCursor).toBeNull();
    for (const item of page.items) {
      if (item.type === "file") {
        expect(Object.keys(item).sort()).toEqual(
          ["contentType", "mtimeMs", "path", "sha256", "size", "type"].sort(),
        );
      } else {
        expect(Object.keys(item).sort()).toEqual(["mtimeMs", "path", "type"]);
      }
    }
    const x = page.items.find((i) => i.path === "a/x.md");
    expect(x).toMatchObject({
      size: 3,
      contentType: "text/markdown; charset=utf-8",
      sha256: new Bun.CryptoHasher("sha256").update("# x").digest("hex"),
    });
  });

  test("pagination does not skip a sibling that sorts between a folder's descendants", async () => {
    const fx = orderedVault();
    const first = await listPaths(fx.deps, fx.slug, { limit: 3 });
    expect(first.items.at(-1)?.path).toBe("a/x.md");
    expect(first.nextCursor).not.toBeNull();
    const second = await listPaths(fx.deps, fx.slug, {
      limit: 3,
      cursor: first.nextCursor as string,
    });
    expect(tags(second.items)).toEqual(["file:a-b.md"]);
    expect(second.nextCursor).toBeNull();
  });

  test("paging visits every entry exactly once at every page size", async () => {
    const fx = orderedVault();
    put(fx.root, "a/sub/deep.md");
    put(fx.root, "a.md");
    put(fx.root, "b/c.md");
    const all = tags((await listPaths(fx.deps, fx.slug)).items);
    for (let limit = 1; limit <= all.length; limit++) {
      const seen: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await listPaths(fx.deps, fx.slug, { limit, cursor });
        seen.push(...tags(page.items));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      expect(seen).toEqual(all);
    }
  });

  test("empty folders are visible; a type=file listing of them is empty", async () => {
    const fx = makeVaultFixture();
    mkdirSync(join(fx.root, "notes", "scratchpad"), { recursive: true });
    expect(tags((await listPaths(fx.deps, fx.slug)).items)).toEqual([
      "folder:notes",
      "folder:notes/scratchpad",
    ]);
    expect(await listPaths(fx.deps, fx.slug, { type: "file" })).toEqual({
      items: [],
      nextCursor: null,
    });
  });

  test("recursive=false lists the direct children of the prefix's folder", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "notes/a.md");
    put(fx.root, "notes/sub/b.md");
    put(fx.root, "top.md");
    const page = await listPaths(fx.deps, fx.slug, { prefix: "notes/", recursive: false });
    expect(tags(page.items)).toEqual(["file:notes/a.md", "folder:notes/sub"]);
  });

  test("recursive=false at the root lists the top level only", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "notes/a.md");
    put(fx.root, "notes/sub/b.md");
    put(fx.root, "top.md");
    const page = await listPaths(fx.deps, fx.slug, { recursive: false });
    expect(tags(page.items)).toEqual(["folder:notes", "file:top.md"]);
  });

  test("recursive=false with a partial last segment behaves like `ls notes/s*`", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "notes/a.md");
    put(fx.root, "notes/sub/b.md");
    put(fx.root, "notes/sx.md");
    const page = await listPaths(fx.deps, fx.slug, { prefix: "notes/s", recursive: false });
    expect(tags(page.items)).toEqual(["folder:notes/sub", "file:notes/sx.md"]);
  });

  test("a recursive prefix is literal and excludes the prefix folder itself", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "notes/a.md");
    put(fx.root, "notes/sub/b.md");
    put(fx.root, "notes-old/c.md");
    put(fx.root, "other/d.md");
    const page = await listPaths(fx.deps, fx.slug, { prefix: "notes/" });
    expect(tags(page.items)).toEqual([
      "file:notes/a.md",
      "folder:notes/sub",
      "file:notes/sub/b.md",
    ]);
    const loose = await listPaths(fx.deps, fx.slug, { prefix: "notes" });
    expect(loose.items.map((i) => i.path)).toEqual([
      "notes",
      "notes/a.md",
      "notes/sub",
      "notes/sub/b.md",
      "notes-old",
      "notes-old/c.md",
    ]);
  });

  test("the type filter applies before limit", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a/1.md");
    put(fx.root, "b/2.md");
    put(fx.root, "c/3.md");
    const first = await listPaths(fx.deps, fx.slug, { type: "folder", limit: 2 });
    expect(tags(first.items)).toEqual(["folder:a", "folder:b"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await listPaths(fx.deps, fx.slug, {
      type: "folder",
      limit: 2,
      cursor: first.nextCursor as string,
    });
    expect(tags(second.items)).toEqual(["folder:c"]);
    expect(second.nextCursor).toBeNull();
    const files = await listPaths(fx.deps, fx.slug, { type: "file", limit: 2 });
    expect(tags(files.items)).toEqual(["file:a/1.md", "file:b/2.md"]);
  });

  test("a cursor resumes strictly after it, even past folders sorted before it", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a/x.md");
    put(fx.root, "b.md");
    put(fx.root, "c/y.md");
    const page = await listPaths(fx.deps, fx.slug, { cursor: encodeCursor("b.md") });
    expect(tags(page.items)).toEqual(["folder:c", "file:c/y.md"]);
    // A cursor inside a folder resumes inside it.
    const inside = await listPaths(fx.deps, fx.slug, { cursor: encodeCursor("a") });
    expect(inside.items[0]?.path).toBe("a/x.md");
    // An empty cursor is no cursor; a garbage cursor only positions the walk.
    expect((await listPaths(fx.deps, fx.slug, { cursor: "" })).items).toHaveLength(5);
    const garbage = await listPaths(fx.deps, fx.slug, { cursor: "!!!not base64" });
    expect(garbage.items.length).toBeLessThanOrEqual(5);
  });

  test("orders mixed-case and astral names by raw code point", async () => {
    const fx = makeVaultFixture();
    for (const n of ["a.md", "Z.md", "A.md", "\u{1F600}.md", "�.md"]) put(fx.root, n);
    const page = await listPaths(fx.deps, fx.slug);
    expect(page.items.map((i) => i.path)).toEqual(["A.md", "Z.md", "a.md", "�.md", "\u{1F600}.md"]);
  });

  test("includes every file type; omits hidden entries, symlinks, and all below them", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "real.md");
    put(fx.root, "img.png");
    put(fx.root, ".obsidian/app.json");
    put(fx.root, ".hidden.md");
    put(fx.root, "a/.trash/old.md");
    put(fx.root, "real-dir/inner.md");
    symlinkSync(join(fx.root, "real.md"), join(fx.root, "link.md"));
    symlinkSync(join(fx.root, "real-dir"), join(fx.root, "link-dir"));
    const page = await listPaths(fx.deps, fx.slug);
    expect(tags(page.items)).toEqual([
      "folder:a",
      "file:img.png",
      "folder:real-dir",
      "file:real-dir/inner.md",
      "file:real.md",
    ]);
    expect(page.items.find((i) => i.path === "img.png")).toMatchObject({
      contentType: "image/png",
    });
  });

  test("never emits the vault root, and a missing root lists as empty", async () => {
    const fx = makeVaultFixture();
    expect(await listPaths(fx.deps, fx.slug)).toEqual({ items: [], nextCursor: null });
    rmSync(fx.root, { recursive: true });
    expect(await listPaths(fx.deps, fx.slug)).toEqual({ items: [], nextCursor: null });
    // A root that is a file (ENOTDIR) is likewise empty, not a failure.
    writeFileSync(fx.root, "not a dir");
    expect(await listPaths(fx.deps, fx.slug)).toEqual({ items: [], nextCursor: null });
  });

  test("throws VaultNotFoundError for an unknown slug", async () => {
    const fx = makeVaultFixture();
    await expect(listPaths(fx.deps, "missing")).rejects.toBeInstanceOf(VaultNotFoundError);
  });

  test("a file removed while the walk reads it is skipped", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md");
    put(fx.root, "ghost.md");
    put(fx.root, "z.md");
    const deps = withHooks(fx, {
      beforeListRead: async (p) => {
        if (p === "ghost.md") rmSync(join(fx.root, "ghost.md"));
      },
    });
    expect((await listPaths(deps, fx.slug)).items.map((i) => i.path)).toEqual(["a.md", "z.md"]);
  });

  test("a folder removed or turned into a file mid-walk is skipped", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md");
    put(fx.root, "gone/x.md");
    put(fx.root, "swapped/y.md");
    put(fx.root, "z.md");
    const deps = withHooks(fx, {
      // `a.md` is read after the root was listed but before either folder is
      // examined: remove one, and replace the other by a regular file.
      beforeListRead: async (p) => {
        if (p !== "a.md") return;
        rmSync(join(fx.root, "gone"), { recursive: true });
        rmSync(join(fx.root, "swapped"), { recursive: true });
        writeFileSync(join(fx.root, "swapped"), "now a file");
      },
    });
    expect((await listPaths(deps, fx.slug)).items.map((i) => i.path)).toEqual(["a.md", "z.md"]);
  });

  test("a file that stopped being a regular file is skipped", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "f.md");
    put(fx.root, "z.md");
    const deps = withHooks(fx, {
      beforeListRead: async (p) => {
        if (p !== "f.md") return;
        rmSync(join(fx.root, "f.md"));
        mkdirSync(join(fx.root, "f.md"));
      },
    });
    expect((await listPaths(deps, fx.slug)).items.map((i) => i.path)).toEqual(["z.md"]);
  });

  test("a parent swapped for a symlink before the read is skipped and nothing outside is read", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a/x.md", "inside");
    put(fx.root, "b.md");
    const outside = outsideDir();
    const deps = withHooks(fx, {
      beforeListRead: async (p) => {
        if (p !== "a/x.md") return;
        renameSync(join(fx.root, "a"), join(fx.root, "a-moved"));
        symlinkSync(outside, join(fx.root, "a"));
      },
    });
    const page = await listPaths(deps, fx.slug);
    expect(page.items.map((i) => i.path)).toEqual(["a", "b.md"]);
    expect(JSON.stringify(page)).not.toContain(
      new Bun.CryptoHasher("sha256").update("SECRET OUTSIDE").digest("hex"),
    );
  });
});

// ---------------------------------------------------------------------------
// deletePath — files
// ---------------------------------------------------------------------------

describe("deletePath on a file", () => {
  test("removes the file first, then drops its rows under the drop guard", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "notes/x.md", "# x");
    fx.indexed.add("notes/x.md");
    const deps = withHooks(fx, {
      beforeRemove: async (p) => {
        fx.events.push(`beforeRemove:${p}`);
      },
      afterRemove: async (p) => {
        fx.events.push(`afterRemove:${p}`);
        expect(existsSync(join(fx.root, "notes/x.md"))).toBe(false);
      },
    });
    await deletePath(deps, fx.slug, "notes/x.md");
    expect(existsSync(join(fx.root, "notes/x.md"))).toBe(false);
    expect(fx.events).toEqual([
      "beforeRemove:notes/x.md",
      "afterRemove:notes/x.md",
      "isIndexable:notes/x.md",
      "drop:notes/x.md",
    ]);
    expect(fx.indexed.has("notes/x.md")).toBe(false);
  });

  test("drops a non-Markdown file's rows too (no extension check)", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "img.png");
    await deletePath(fx.deps, fx.slug, "img.png");
    expect(fx.calls.drop).toEqual([{ slug: fx.slug, path: "img.png" }]);
  });

  test("rm -r on a file removes the file", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "x.md");
    await deletePath(fx.deps, fx.slug, "x.md", { recursive: true });
    expect(existsSync(join(fx.root, "x.md"))).toBe(false);
  });

  test("a note recreated after the removal keeps its rows", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "x.md", "old");
    fx.indexed.add("x.md");
    const deps = withHooks(fx, {
      afterRemove: async () => writeFileSync(join(fx.root, "x.md"), "recreated"),
    });
    await deletePath(deps, fx.slug, "x.md");
    expect(fx.calls.drop).toEqual([]);
    expect(fx.indexed.has("x.md")).toBe(true);
  });

  test("a symlink recreated after the removal loses the rows", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "x.md", "old");
    fx.indexed.add("x.md");
    const outside = outsideDir();
    const deps = withHooks(fx, {
      afterRemove: async () => symlinkSync(join(outside, "x.md"), join(fx.root, "x.md")),
    });
    await deletePath(deps, fx.slug, "x.md");
    expect(fx.indexed.has("x.md")).toBe(false);
  });

  test("a removal failure leaves the file and every index entry in place", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "x.md");
    fx.indexed.add("x.md");
    const deps = withHooks(fx, {
      // A cooperating writer replaces the file by a non-empty folder; `unlink`
      // then fails (EISDIR) and nothing may be dropped.
      beforeRemove: async () => {
        rmSync(join(fx.root, "x.md"));
        put(fx.root, "x.md/child.md");
      },
    });
    await expect(deletePath(deps, fx.slug, "x.md")).rejects.toThrow();
    expect(existsSync(join(fx.root, "x.md/child.md"))).toBe(true);
    expect(fx.calls.drop).toEqual([]);
    expect(fx.indexed.has("x.md")).toBe(true);
  });

  test("a file removed by an outside deleter first still counts as deleted", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "x.md");
    fx.indexed.add("x.md");
    const deps = withHooks(fx, { beforeRemove: async () => rmSync(join(fx.root, "x.md")) });
    await deletePath(deps, fx.slug, "x.md");
    expect(fx.indexed.has("x.md")).toBe(false);
  });

  test("a drop failure is logged and does not fail the delete", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md");
    fx.failNextDrop(new Error("dropfail"));
    await deletePath(fx.deps, fx.slug, "a.md");
    expect(existsSync(join(fx.root, "a.md"))).toBe(false);
    expect(fx.logCalls.warn.find((c) => c.fields?.error === "dropfail")?.fields).toMatchObject({
      vault: fx.slug,
      path: "a.md",
    });
    put(fx.root, "b.md");
    // biome-ignore lint/suspicious/noExplicitAny: deliberate non-Error rejection to exercise coercion.
    fx.failNextDrop("string-drop" as any);
    await deletePath(fx.deps, fx.slug, "b.md");
    expect(fx.logCalls.warn.find((c) => c.fields?.error === "string-drop")).toBeDefined();
  });

  test("tolerates a trailing slash and non-canonical segments", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "notes/b.md");
    put(fx.root, "a.md");
    await deletePath(fx.deps, fx.slug, "notes//b.md/");
    await deletePath(fx.deps, fx.slug, "./a.md");
    expect(fx.calls.drop.map((d) => d.path)).toEqual(["notes/b.md", "a.md"]);
  });
});

// ---------------------------------------------------------------------------
// deletePath — folders
// ---------------------------------------------------------------------------

describe("deletePath on a folder", () => {
  test("removes an empty folder without recursive", async () => {
    const fx = makeVaultFixture();
    mkdirSync(join(fx.root, "empty"));
    await deletePath(fx.deps, fx.slug, "empty/");
    expect(existsSync(join(fx.root, "empty"))).toBe(false);
    expect(fx.calls.indexedPaths).toEqual([{ slug: fx.slug, prefix: "empty/" }]);
  });

  test("refuses a non-empty folder without recursive and changes nothing", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "projects/alpha/intro.md", "intro");
    fx.indexed.add("projects/alpha/intro.md");
    await expect(deletePath(fx.deps, fx.slug, "projects/alpha")).rejects.toBeInstanceOf(
      FolderNotEmptyError,
    );
    expect(Bun.file(join(fx.root, "projects/alpha/intro.md")).size).toBe(5);
    expect(fx.calls.drop).toEqual([]);
    expect(fx.calls.indexedPaths).toEqual([]);
  });

  test("a child that appears after the emptiness check is folder_not_empty and survives", async () => {
    const fx = makeVaultFixture();
    mkdirSync(join(fx.root, "racy"));
    const deps = withHooks(fx, {
      beforeRemove: async () => writeFileSync(join(fx.root, "racy", "child.md"), "new"),
    });
    await expect(deletePath(deps, fx.slug, "racy")).rejects.toBeInstanceOf(FolderNotEmptyError);
    expect(existsSync(join(fx.root, "racy", "child.md"))).toBe(true);
  });

  test("any other rmdir failure propagates unchanged", async () => {
    const fx = makeVaultFixture();
    mkdirSync(join(fx.root, "empty"));
    const deps = withHooks(fx, { beforeRemove: async () => rmSync(join(fx.root, "empty")) });
    const err = await deletePath(deps, fx.slug, "empty").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(FolderNotEmptyError);
    expect(err).not.toBeInstanceOf(DocNotFoundError);
  });

  test("recursive delete drops every indexed path under the folder after removing it", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "archive/2024/jan.md", "# jan");
    put(fx.root, "archive/2024-old.md", "# old");
    put(fx.root, "archive/2024/cover.png");
    put(fx.root, "archive/2024-x/keep.md");
    for (const p of ["archive/2024/jan.md", "archive/2024-old.md", "archive/2024-x/keep.md"]) {
      fx.indexed.add(p);
    }
    const existedAtDrop: boolean[] = [];
    const deps: VaultServiceDeps = {
      ...fx.deps,
      indexer: {
        ...fx.deps.indexer,
        drop: async (s, p) => {
          existedAtDrop.push(existsSync(join(fx.root, p)));
          await fx.deps.indexer.drop(s, p);
        },
      },
      hooks: { afterRemove: async (p) => void fx.events.push(`afterRemove:${p}`) },
    };
    await deletePath(deps, fx.slug, "archive/2024", { recursive: true });
    expect(existsSync(join(fx.root, "archive/2024"))).toBe(false);
    // Listed only after the removal, with the folder's path plus `/`.
    expect(fx.events.indexOf("afterRemove:archive/2024")).toBeLessThan(
      fx.events.indexOf("indexedPaths:archive/2024/"),
    );
    expect(fx.calls.drop.map((d) => d.path)).toEqual(["archive/2024/jan.md"]);
    expect(existedAtDrop).toEqual([false]);
    expect([...fx.indexed].filter((p) => p.startsWith("archive/2024/"))).toEqual([]);
    expect(fx.indexed.has("archive/2024-old.md")).toBe(true);
    expect(fx.indexed.has("archive/2024-x/keep.md")).toBe(true);
  });

  test("a note written and indexed into the folder before the removal is dropped", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "folder/a.md");
    fx.indexed.add("folder/a.md");
    put(fx.root, "folder-x/b.md");
    fx.indexed.add("folder-x/b.md");
    const deps = withHooks(fx, {
      // The delete has begun (type checked) but not removed anything yet.
      beforeRemove: async () => {
        put(fx.root, "folder/late.md", "# late");
        fx.indexed.add("folder/late.md");
      },
    });
    await deletePath(deps, fx.slug, "folder", { recursive: true });
    expect([...fx.indexed].filter((p) => p.startsWith("folder/"))).toEqual([]);
    expect(fx.calls.drop.map((d) => d.path).sort()).toEqual(["folder/a.md", "folder/late.md"]);
    expect(fx.indexed.has("folder-x/b.md")).toBe(true);
  });

  test("an indexable note recreated under the folder after the removal keeps its rows", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "folder/a.md");
    put(fx.root, "folder/b.md");
    fx.indexed.add("folder/a.md");
    fx.indexed.add("folder/b.md");
    const deps = withHooks(fx, { afterRemove: async () => put(fx.root, "folder/a.md", "back") });
    await deletePath(deps, fx.slug, "folder", { recursive: true });
    expect(fx.indexed.has("folder/a.md")).toBe(true);
    expect(fx.indexed.has("folder/b.md")).toBe(false);
  });

  test("a symlink recreated at a path under the folder loses its rows", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "folder/a.md");
    fx.indexed.add("folder/a.md");
    const outside = outsideDir();
    const deps = withHooks(fx, {
      afterRemove: async () => {
        mkdirSync(join(fx.root, "folder"));
        symlinkSync(join(outside, "x.md"), join(fx.root, "folder/a.md"));
      },
    });
    await deletePath(deps, fx.slug, "folder", { recursive: true });
    expect(fx.indexed.has("folder/a.md")).toBe(false);
  });

  test("a failed recursive removal leaves every index entry in place", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "d/n.md");
    fx.indexed.add("d/n.md");
    // The folder disappears under the delete: `rm` with `force: false` fails.
    const deps = withHooks(fx, {
      beforeRemove: async () => rmSync(join(fx.root, "d"), { recursive: true }),
    });
    await expect(deletePath(deps, fx.slug, "d", { recursive: true })).rejects.toThrow();
    expect(fx.calls.indexedPaths).toEqual([]);
    expect(fx.calls.drop).toEqual([]);
    expect(fx.indexed.has("d/n.md")).toBe(true);
  });

  test("an indexedPaths failure is logged and does not fail the delete", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "d/n.md");
    fx.failNextIndexedPaths(new Error("index down"));
    await deletePath(fx.deps, fx.slug, "d", { recursive: true });
    expect(existsSync(join(fx.root, "d"))).toBe(false);
    expect(fx.logCalls.warn.find((c) => c.fields?.error === "index down")?.fields).toMatchObject({
      vault: fx.slug,
      path: "d",
    });
    put(fx.root, "e/n.md");
    // biome-ignore lint/suspicious/noExplicitAny: deliberate non-Error rejection to exercise coercion.
    fx.failNextIndexedPaths("string-fail" as any);
    await deletePath(fx.deps, fx.slug, "e", { recursive: true });
    expect(fx.logCalls.warn.find((c) => c.fields?.error === "string-fail")).toBeDefined();
  });

  test("a drop failure during a recursive delete is logged, the rest still dropped", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "d/a.md");
    put(fx.root, "d/b.md");
    fx.indexed.add("d/a.md");
    fx.indexed.add("d/b.md");
    fx.failNextDrop(new Error("indexer down"));
    await deletePath(fx.deps, fx.slug, "d", { recursive: true });
    expect(fx.logCalls.warn.find((c) => c.fields?.error === "indexer down")).toBeDefined();
    expect(fx.indexed.has("d/b.md")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deletePath — validation
// ---------------------------------------------------------------------------

describe("deletePath validation", () => {
  test("a missing path is not_found", async () => {
    const fx = makeVaultFixture();
    await expect(deletePath(fx.deps, fx.slug, "notes/missing.md")).rejects.toBeInstanceOf(
      DocNotFoundError,
    );
  });

  test("a path under an existing file is invalid_path", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "notes", "a file");
    await expect(deletePath(fx.deps, fx.slug, "notes/sub")).rejects.toBeInstanceOf(
      InvalidPathError,
    );
  });

  test("refuses symlinked targets and leaves what they point at alone", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "real/keep.md");
    symlinkSync(join(fx.root, "real"), join(fx.root, "linked"));
    symlinkSync(join(fx.root, "real/keep.md"), join(fx.root, "shadow.md"));
    await expect(
      deletePath(fx.deps, fx.slug, "linked", { recursive: true }),
    ).rejects.toBeInstanceOf(InvalidPathError);
    await expect(deletePath(fx.deps, fx.slug, "linked/keep.md")).rejects.toBeInstanceOf(
      InvalidPathError,
    );
    await expect(deletePath(fx.deps, fx.slug, "shadow.md")).rejects.toBeInstanceOf(
      InvalidPathError,
    );
    expect(existsSync(join(fx.root, "real/keep.md"))).toBe(true);
    expect(fx.calls.drop).toEqual([]);
  });

  test("never addresses the vault root, a traversal, an absolute or a hidden path", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "keep.md");
    for (const p of [".", "./", "", "/", "../escape", "/etc/passwd", ".obsidian", "a/.trash"]) {
      await expect(deletePath(fx.deps, fx.slug, p, { recursive: true })).rejects.toBeInstanceOf(
        InvalidPathError,
      );
    }
    expect(existsSync(join(fx.root, "keep.md"))).toBe(true);
    expect(fx.calls.drop).toEqual([]);
  });

  test("throws VaultNotFoundError for an unknown slug", async () => {
    const fx = makeVaultFixture();
    await expect(deletePath(fx.deps, "missing", "x.md")).rejects.toBeInstanceOf(VaultNotFoundError);
  });
});

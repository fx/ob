import { describe, expect, test } from "bun:test";
import { promises as fs, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DocNotFoundError,
  FolderNotEmptyError,
  InvalidPathError,
  VaultNotFoundError,
} from "../../src/errors.ts";
import { createFolder, deleteFolder, listFolders } from "../../src/vault/folders.ts";
import { makeVaultFixture } from "./helpers.ts";

describe("listFolders", () => {
  test("yields directories pre-order, skipping hidden + non-dirs", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "top.md"), "x");
    await fs.mkdir(join(fx.root, "a", "b"), { recursive: true });
    await fs.mkdir(join(fx.root, "c"), { recursive: true });
    await fs.mkdir(join(fx.root, ".obsidian"), { recursive: true });
    writeFileSync(join(fx.root, "a", "note.md"), "n");

    const result = await listFolders(fx.deps, fx.slug);
    expect(result.items.map((i) => i.path)).toEqual(["a", "a/b", "c"]);
    expect(result.items[0]?.mtimeMs).toBeGreaterThan(0);
    expect(result.nextCursor).toBeNull();
  });

  test("empty vault returns []", async () => {
    const fx = makeVaultFixture();
    const result = await listFolders(fx.deps, fx.slug);
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  test("returns [] when the root does not exist", async () => {
    const fx = makeVaultFixture();
    await fs.rm(fx.root, { recursive: true });
    const result = await listFolders(fx.deps, fx.slug);
    expect(result.items).toEqual([]);
  });

  test("filters by prefix (folder names, trailing slash excludes the prefix dir itself)", async () => {
    const fx = makeVaultFixture();
    await fs.mkdir(join(fx.root, "social-graphs", "people", "peter-thiel"), { recursive: true });
    await fs.mkdir(join(fx.root, "social-graphs", "people", "sam-altman"), { recursive: true });
    await fs.mkdir(join(fx.root, "social-graphs", "places"), { recursive: true });
    writeFileSync(join(fx.root, "social-graphs", "people", "sam-altman", "note.md"), "n");

    const result = await listFolders(fx.deps, fx.slug, { prefix: "social-graphs/people/" });
    expect(result.items.map((i) => i.path)).toEqual([
      "social-graphs/people/peter-thiel",
      "social-graphs/people/sam-altman",
    ]);
  });

  test("paginates via cursor", async () => {
    const fx = makeVaultFixture();
    for (const n of ["a", "b", "c", "d"]) await fs.mkdir(join(fx.root, n), { recursive: true });
    const first = await listFolders(fx.deps, fx.slug, { limit: 2 });
    expect(first.items.map((i) => i.path)).toEqual(["a", "b"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await listFolders(fx.deps, fx.slug, {
      limit: 2,
      cursor: first.nextCursor as string,
    });
    expect(second.items.map((i) => i.path)).toEqual(["c", "d"]);
    expect(second.nextCursor).toBeNull();
  });

  test("limit 0 yields no items and a null cursor (no lastPath)", async () => {
    const fx = makeVaultFixture();
    await fs.mkdir(join(fx.root, "a"), { recursive: true });
    const result = await listFolders(fx.deps, fx.slug, { limit: 0 });
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  test("empty cursor behaves like none", async () => {
    const fx = makeVaultFixture();
    await fs.mkdir(join(fx.root, "a"), { recursive: true });
    const result = await listFolders(fx.deps, fx.slug, { cursor: "" });
    expect(result.items.map((i) => i.path)).toEqual(["a"]);
  });

  test("skips symlinked directory entries", async () => {
    const fx = makeVaultFixture();
    await fs.mkdir(join(fx.root, "real"), { recursive: true });
    symlinkSync(join(fx.root, "real"), join(fx.root, "linked"));
    const result = await listFolders(fx.deps, fx.slug);
    expect(result.items.map((i) => i.path)).toEqual(["real"]);
  });

  test("skips a directory that vanishes between readdir and stat", async () => {
    const fx = makeVaultFixture();
    await fs.mkdir(join(fx.root, "a"), { recursive: true });
    await fs.mkdir(join(fx.root, "ghost"), { recursive: true });
    await fs.mkdir(join(fx.root, "z"), { recursive: true });
    const realStat = fs.stat;
    const ghostAbs = join(fx.root, "ghost");
    const stub = ((p: string, ...rest: unknown[]) => {
      if (p === ghostAbs) {
        const err = new Error("ENOENT (stubbed)") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      // biome-ignore lint/suspicious/noExplicitAny: forwarding rest args to the original fs.stat overloads.
      return realStat(p as any, ...(rest as []));
    }) as typeof fs.stat;
    (fs as unknown as { stat: typeof fs.stat }).stat = stub;
    try {
      const result = await listFolders(fx.deps, fx.slug);
      expect(result.items.map((i) => i.path)).toEqual(["a", "z"]);
    } finally {
      (fs as unknown as { stat: typeof fs.stat }).stat = realStat;
    }
  });

  test("non-ENOENT stat error during listing propagates", async () => {
    const fx = makeVaultFixture();
    await fs.mkdir(join(fx.root, "boom"), { recursive: true });
    const realStat = fs.stat;
    const stub = ((p: string, ...rest: unknown[]) => {
      if (p === join(fx.root, "boom")) throw new Error("EACCES (stubbed)");
      // biome-ignore lint/suspicious/noExplicitAny: forwarding rest args to the original fs.stat overloads.
      return realStat(p as any, ...(rest as []));
    }) as typeof fs.stat;
    (fs as unknown as { stat: typeof fs.stat }).stat = stub;
    try {
      await expect(listFolders(fx.deps, fx.slug)).rejects.toThrow("EACCES");
    } finally {
      (fs as unknown as { stat: typeof fs.stat }).stat = realStat;
    }
  });

  test("non-ENOENT readdir error propagates", async () => {
    const fx = makeVaultFixture();
    await fs.rm(fx.root, { recursive: true });
    writeFileSync(fx.root, "not-a-dir");
    let err: unknown;
    try {
      await listFolders(fx.deps, fx.slug);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
  });

  test("throws VaultNotFoundError for unknown slug", async () => {
    const fx = makeVaultFixture();
    await expect(listFolders(fx.deps, "missing")).rejects.toBeInstanceOf(VaultNotFoundError);
  });
});

describe("createFolder", () => {
  test("creates a nested folder and reports created: true", async () => {
    const fx = makeVaultFixture();
    const result = await createFolder(fx.deps, fx.slug, "archive/2026");
    expect(result.created).toBe(true);
    expect(result.path).toBe("archive/2026");
    expect(result.mtimeMs).toBeGreaterThan(0);
    expect((await fs.stat(join(fx.root, "archive/2026"))).isDirectory()).toBe(true);
    // Folders are never indexed.
    expect(fx.calls.reindex).toEqual([]);
  });

  test("is idempotent: second create is a no-op with the same mtime", async () => {
    const fx = makeVaultFixture();
    const first = await createFolder(fx.deps, fx.slug, "archive/2026");
    const second = await createFolder(fx.deps, fx.slug, "archive/2026");
    expect(second.created).toBe(false);
    expect(second.mtimeMs).toBe(first.mtimeMs);
  });

  test("rejects when the path already exists as a file", async () => {
    const fx = makeVaultFixture();
    await fs.mkdir(join(fx.root, "notes"), { recursive: true });
    writeFileSync(join(fx.root, "notes", "x.md"), "content");
    await expect(createFolder(fx.deps, fx.slug, "notes/x.md")).rejects.toBeInstanceOf(
      InvalidPathError,
    );
    // File is unchanged.
    expect(await fs.readFile(join(fx.root, "notes", "x.md"), "utf8")).toBe("content");
  });

  test("rejects a symlinked target", async () => {
    const fx = makeVaultFixture();
    await fs.mkdir(join(fx.root, "real"), { recursive: true });
    symlinkSync(join(fx.root, "real"), join(fx.root, "linked"));
    await expect(createFolder(fx.deps, fx.slug, "linked")).rejects.toBeInstanceOf(InvalidPathError);
  });

  test("rejects a traversal path without creating anything outside the root", async () => {
    const fx = makeVaultFixture();
    await expect(createFolder(fx.deps, fx.slug, "../escape")).rejects.toBeInstanceOf(
      InvalidPathError,
    );
  });

  test("non-ENOENT lstat error on the probe propagates", async () => {
    const fx = makeVaultFixture();
    // The first lstat(target) is assertNotSymlinkEscape's leaf probe (ENOENT
    // naturally for a fresh path); the second is createFolder's own probe.
    await withLstatFailingOnSecondCall(join(fx.root, "probe"), async () => {
      await expect(createFolder(fx.deps, fx.slug, "probe")).rejects.toThrow("EACCES");
    });
  });
});

describe("deleteFolder", () => {
  test("deletes an empty folder without recursive", async () => {
    const fx = makeVaultFixture();
    await fs.mkdir(join(fx.root, "empty"), { recursive: true });
    await deleteFolder(fx.deps, fx.slug, "empty");
    expect(await folderExists(join(fx.root, "empty"))).toBe(false);
    expect(fx.calls.drop).toEqual([]);
  });

  test("refuses a non-empty folder without recursive (folder_not_empty)", async () => {
    const fx = makeVaultFixture();
    await fs.mkdir(join(fx.root, "social-graphs/people/peter-thiel"), { recursive: true });
    writeFileSync(join(fx.root, "social-graphs/people/peter-thiel/intro.md"), "hi");
    await expect(
      deleteFolder(fx.deps, fx.slug, "social-graphs/people/peter-thiel"),
    ).rejects.toBeInstanceOf(FolderNotEmptyError);
    // Nothing removed, no drops.
    expect(await folderExists(join(fx.root, "social-graphs/people/peter-thiel/intro.md"))).toBe(
      true,
    );
    expect(fx.calls.drop).toEqual([]);
  });

  test("recursive delete drops Markdown descendants only, then removes the tree", async () => {
    const fx = makeVaultFixture();
    await fs.mkdir(join(fx.root, "archive/2024"), { recursive: true });
    writeFileSync(join(fx.root, "archive/2024/jan.md"), "# jan");
    writeFileSync(join(fx.root, "archive/2024/cover.png"), new Uint8Array([0x89]));
    await deleteFolder(fx.deps, fx.slug, "archive/2024", { recursive: true });
    expect(fx.calls.drop).toEqual([{ slug: fx.slug, path: "archive/2024/jan.md" }]);
    expect(await folderExists(join(fx.root, "archive/2024"))).toBe(false);
  });

  test("recursive delete tolerates an indexer drop failure", async () => {
    const fx = makeVaultFixture();
    await fs.mkdir(join(fx.root, "d"), { recursive: true });
    writeFileSync(join(fx.root, "d/n.md"), "# n");
    fx.failNextDrop(new Error("indexer down"));
    await deleteFolder(fx.deps, fx.slug, "d", { recursive: true });
    expect(await folderExists(join(fx.root, "d"))).toBe(false);
    expect(fx.logCalls.warn.find((c) => c.fields?.error === "indexer down")).toBeDefined();
  });

  test("missing folder → DocNotFoundError", async () => {
    const fx = makeVaultFixture();
    await expect(deleteFolder(fx.deps, fx.slug, "nope")).rejects.toBeInstanceOf(DocNotFoundError);
  });

  test("type-aware: refuses a file with InvalidPathError", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "x.md"), "content");
    await expect(deleteFolder(fx.deps, fx.slug, "x.md")).rejects.toBeInstanceOf(InvalidPathError);
    expect(await fs.readFile(join(fx.root, "x.md"), "utf8")).toBe("content");
  });

  test("rejects a symlinked target", async () => {
    const fx = makeVaultFixture();
    await fs.mkdir(join(fx.root, "real"), { recursive: true });
    symlinkSync(join(fx.root, "real"), join(fx.root, "linked"));
    await expect(deleteFolder(fx.deps, fx.slug, "linked")).rejects.toBeInstanceOf(InvalidPathError);
    // Real folder untouched.
    expect(await folderExists(join(fx.root, "real"))).toBe(true);
  });

  test("rejects a traversal path", async () => {
    const fx = makeVaultFixture();
    await expect(deleteFolder(fx.deps, fx.slug, "../escape")).rejects.toBeInstanceOf(
      InvalidPathError,
    );
  });

  test("non-ENOENT lstat error on the pre-check propagates", async () => {
    const fx = makeVaultFixture();
    await fs.mkdir(join(fx.root, "probe"), { recursive: true });
    // First lstat(target) is assertNotSymlinkEscape's leaf probe (real dir);
    // the second is deleteFolder's own pre-check.
    await withLstatFailingOnSecondCall(join(fx.root, "probe"), async () => {
      await expect(deleteFolder(fx.deps, fx.slug, "probe")).rejects.toThrow("EACCES");
    });
  });
});

async function folderExists(abs: string): Promise<boolean> {
  try {
    await fs.lstat(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `fn` with `fs.lstat` stubbed to throw EACCES on the SECOND call for
 * `target` (all other paths and the first call pass through). The service core
 * calls `lstat(target)` once via `assertNotSymlinkEscape` and once for its own
 * probe/pre-check, so this exercises the probe's non-ENOENT error branch.
 * Restores the original `fs.lstat` on every exit path.
 */
async function withLstatFailingOnSecondCall(target: string, fn: () => Promise<void>): Promise<void> {
  const realLstat = fs.lstat;
  let hits = 0;
  const stub = ((p: string, ...rest: unknown[]) => {
    if (p === target) {
      hits++;
      if (hits >= 2) throw new Error("EACCES (stubbed)");
    }
    // biome-ignore lint/suspicious/noExplicitAny: forwarding rest args to the original fs.lstat overloads.
    return realLstat(p as any, ...(rest as []));
  }) as typeof fs.lstat;
  (fs as unknown as { lstat: typeof fs.lstat }).lstat = stub;
  try {
    await fn();
  } finally {
    (fs as unknown as { lstat: typeof fs.lstat }).lstat = realLstat;
  }
}

/**
 * Tests for `src/vault/guarded.ts` against real tmpdir trees (no `fs`
 * mocking): the containment-checked `guardedRead`, and the drop guard
 * (`dropGuarded` / `dropUnlessIndexable`) over the fake indexer, whose
 * `isIndexable` is the real predicate on the vault root.
 */

import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocNotFoundError, InvalidPathError } from "../../src/errors.ts";
import {
  OversizeReadError,
  dropGuarded,
  dropUnlessIndexable,
  guardedRead,
} from "../../src/vault/guarded.ts";
import { withPathLock } from "../../src/vault/lock.ts";
import { makeVaultFixture } from "./helpers.ts";

function tree(): string {
  const root = mkdtempSync(join(tmpdir(), "ob-guarded-"));
  mkdirSync(join(root, "a"));
  writeFileSync(join(root, "a", "x.md"), "hello");
  return root;
}

function outside(): string {
  const dir = mkdtempSync(join(tmpdir(), "ob-guarded-out-"));
  writeFileSync(join(dir, "x.md"), "SECRET");
  return dir;
}

describe("guardedRead", () => {
  test("reads the bytes and the opened descriptor's stat", async () => {
    const root = tree();
    const r = await guardedRead(root, "a/x.md");
    expect(new TextDecoder().decode(r.bytes)).toBe("hello");
    expect(r.stat.isFile()).toBe(true);
    expect(r.stat.size).toBe(5);
  });

  test("a missing file is DocNotFoundError", async () => {
    await expect(guardedRead(tree(), "a/none.md")).rejects.toBeInstanceOf(DocNotFoundError);
  });

  test("a symlinked leaf or parent is refused before anything is read", async () => {
    const root = tree();
    const out = outside();
    symlinkSync(join(out, "x.md"), join(root, "leaf.md"));
    symlinkSync(out, join(root, "dir"));
    await expect(guardedRead(root, "leaf.md")).rejects.toBeInstanceOf(InvalidPathError);
    await expect(guardedRead(root, "dir/x.md")).rejects.toBeInstanceOf(InvalidPathError);
  });

  test("a directory is not a regular file", async () => {
    await expect(guardedRead(tree(), "a")).rejects.toBeInstanceOf(InvalidPathError);
  });

  test("a leaf swapped for a symlink after the chain check is not followed (O_NOFOLLOW)", async () => {
    const root = tree();
    const out = outside();
    const err = await guardedRead(root, "a/x.md", {
      beforeOpen: async () => {
        rmSync(join(root, "a", "x.md"));
        symlinkSync(join(out, "x.md"), join(root, "a", "x.md"));
      },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InvalidPathError);
  });

  test("a parent turned into a file after the chain check is invalid_path", async () => {
    const root = tree();
    const err = await guardedRead(root, "a/x.md", {
      beforeOpen: async () => {
        rmSync(join(root, "a"), { recursive: true });
        writeFileSync(join(root, "a"), "file now");
      },
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InvalidPathError);
  });

  test("a parent swapped for a symlink is caught by the chain check", async () => {
    const root = tree();
    const out = outside();
    renameSync(join(root, "a"), join(root, "a-real"));
    symlinkSync(out, join(root, "a"));
    await expect(guardedRead(root, "a/x.md")).rejects.toBeInstanceOf(InvalidPathError);
  });

  test("maxBytes: a file at the cap is read, one over it is refused at fstat", async () => {
    const root = tree();
    expect((await guardedRead(root, "a/x.md", { maxBytes: 5 })).bytes.byteLength).toBe(5);
    const err = await guardedRead(root, "a/x.md", { maxBytes: 4 }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OversizeReadError);
    expect(err).toMatchObject({ path: "a/x.md", maxBytes: 4 });
  });

  test("maxBytes: a file that grows past the cap between fstat and the read is oversize", async () => {
    const root = tree();
    const err = await guardedRead(root, "a/x.md", {
      maxBytes: 8,
      afterStat: async () => appendFileSync(join(root, "a", "x.md"), " world, much longer"),
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(OversizeReadError);
  });

  test("maxBytes: growth that stays within the cap is returned, never beyond it", async () => {
    const root = tree();
    const r = await guardedRead(root, "a/x.md", {
      maxBytes: 8,
      afterStat: async () => appendFileSync(join(root, "a", "x.md"), "!!!"),
    });
    expect(new TextDecoder().decode(r.bytes)).toBe("hello!!!");
  });
});

describe("drop guard", () => {
  test("drops a path with nothing at it", async () => {
    const fx = makeVaultFixture();
    fx.indexed.add("gone.md");
    await dropGuarded(fx.deps, fx.slug, "gone.md");
    expect(fx.indexed.has("gone.md")).toBe(false);
  });

  test("keeps the rows of an indexable note that exists at the path", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "note.md"), "x");
    fx.indexed.add("note.md");
    await dropGuarded(fx.deps, fx.slug, "note.md");
    expect(fx.calls.drop).toEqual([]);
    expect(fx.indexed.has("note.md")).toBe(true);
  });

  test("drops the rows of a symlink, a folder, or a non-indexable file at the path", async () => {
    const fx = makeVaultFixture();
    const out = outside();
    symlinkSync(join(out, "x.md"), join(fx.root, "link.md"));
    mkdirSync(join(fx.root, "dir.md"));
    mkdirSync(join(fx.root, "node_modules"));
    writeFileSync(join(fx.root, "node_modules", "n.md"), "x");
    for (const p of ["link.md", "dir.md", "node_modules/n.md"]) {
      fx.indexed.add(p);
      await dropGuarded(fx.deps, fx.slug, p);
    }
    expect([...fx.indexed]).toEqual([]);
  });

  test("runs the check and the drop under the path's write lock", async () => {
    const fx = makeVaultFixture();
    let release!: () => void;
    const held = withPathLock(
      `${fx.slug}:x.md`,
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    const guarded = dropGuarded(fx.deps, fx.slug, "x.md");
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 5));
    expect(fx.calls.isIndexable).toEqual([]);
    release();
    await Promise.all([held, guarded]);
    expect(fx.calls.drop).toEqual([{ slug: fx.slug, path: "x.md" }]);
  });

  test("dropUnlessIndexable never throws: a failing drop is logged", async () => {
    const fx = makeVaultFixture();
    fx.failNextDrop(new Error("boom"));
    await dropUnlessIndexable(fx.deps, fx.slug, "x.md");
    expect(fx.logCalls.warn.find((c) => c.fields?.error === "boom")).toBeDefined();
  });
});

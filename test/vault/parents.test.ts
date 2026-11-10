/**
 * `ensureParents` / `removeCreatedParents` (owned-only parent folders) and
 * the `guarded` / `stagingInterior` containment helpers, on real tmpdir
 * trees.
 */

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidPathError } from "../../src/errors.ts";
import {
  type GuardContext,
  createdStagingRoot,
  guarded,
  releaseStagingRoot,
  stagingInterior,
} from "../../src/vault/guarded.ts";
import { ensureParents, errnoOf, removeCreatedParents } from "../../src/vault/parents.ts";

function root(): string {
  return mkdtempSync(join(tmpdir(), "ob-parents-"));
}

describe("ensureParents", () => {
  test("creates the missing levels top-down and records only those", async () => {
    const r = root();
    mkdirSync(join(r, "a"));
    const created = await ensureParents({ root: r }, join(r, "a", "b", "c", "x.md"), "a/b/c/x.md");
    expect(created).toEqual([join(r, "a", "b"), join(r, "a", "b", "c")]);
    expect(await ensureParents({ root: r }, join(r, "top.md"), "top.md")).toEqual([]);
  });

  test("a parent that is a file, or a component above one, is invalid_path", async () => {
    const r = root();
    writeFileSync(join(r, "f.md"), "file");
    await expect(
      ensureParents({ root: r }, join(r, "f.md", "x.md"), "f.md/x.md"),
    ).rejects.toBeInstanceOf(InvalidPathError);
    await expect(
      ensureParents({ root: r }, join(r, "f.md", "y", "x.md"), "f.md/y/x.md"),
    ).rejects.toBeInstanceOf(InvalidPathError);
    const out = mkdtempSync(join(tmpdir(), "ob-parents-out-"));
    symlinkSync(out, join(r, "link"));
    await expect(
      ensureParents({ root: r }, join(r, "link", "x.md"), "link/x.md"),
    ).rejects.toBeInstanceOf(InvalidPathError);
    expect(readdirSync(out)).toEqual([]);
  });

  test("an lstat fault other than a missing level propagates", async () => {
    const r = root();
    mkdirSync(join(r, "locked"));
    chmodSync(join(r, "locked"), 0o000);
    try {
      const err = await ensureParents(
        { root: r },
        join(r, "locked", "a", "x.md"),
        "locked/a/x.md",
      ).catch((e) => e);
      expect(errnoOf(err)).toBe("EACCES");
    } finally {
      chmodSync(join(r, "locked"), 0o755);
    }
  });

  test("a mkdir fault removes the levels this call already created", async () => {
    const r = root();
    const g: GuardContext = {
      root: r,
      hooks: {
        beforeStep: async (site, paths) => {
          if (site === "parents.mkdir" && (paths[0] as string).endsWith("/c")) {
            throw Object.assign(new Error("EIO"), { code: "EIO" });
          }
        },
      },
    };
    await expect(ensureParents(g, join(r, "a", "b", "c", "x.md"), "a/b/c/x.md")).rejects.toThrow(
      "EIO",
    );
    expect(readdirSync(r)).toEqual([]);
  });
});

describe("removeCreatedParents", () => {
  test("a deepest recorded level removed by a concurrent delete counts as cleaned; empty ancestors still go", async () => {
    const r = root();
    const created = await ensureParents({ root: r }, join(r, "a", "b", "c", "x.md"), "a/b/c/x.md");
    rmdirSync(join(r, "a", "b", "c"));
    await removeCreatedParents({ root: r }, created);
    expect(existsSync(join(r, "a"))).toBe(false);
  });

  test("a middle level made non-empty stops the walk, keeping it and everything above", async () => {
    const r = root();
    const created = await ensureParents({ root: r }, join(r, "a", "b", "c", "x.md"), "a/b/c/x.md");
    writeFileSync(join(r, "a", "b", "theirs.md"), "outside writer");
    await removeCreatedParents({ root: r }, created);
    expect(existsSync(join(r, "a", "b", "c"))).toBe(false);
    expect(readdirSync(join(r, "a", "b"))).toEqual(["theirs.md"]);
    expect(existsSync(join(r, "a"))).toBe(true);
  });
});

describe("guarded", () => {
  test("checks every path's chain immediately before the call", async () => {
    const r = root();
    const out = mkdtempSync(join(tmpdir(), "ob-parents-out-"));
    mkdirSync(join(r, "ok"));
    symlinkSync(out, join(r, "bad"));
    let ran = false;
    await expect(
      guarded({ root: r }, "move.rename", [join(r, "ok", "a"), join(r, "bad", "b")], async () => {
        ran = true;
      }),
    ).rejects.toBeInstanceOf(InvalidPathError);
    expect(ran).toBe(false);
    expect(await guarded({ root: r }, "move.rename", [join(r, "ok", "a")], async () => 7)).toBe(7);
  });
});

describe("stagingInterior", () => {
  test("rejects any target not strictly inside a live staging root this call created", async () => {
    const r = root();
    const stagingAbs = join(r, ".x.uuid.copy");
    mkdirSync(stagingAbs);
    const staging = createdStagingRoot(stagingAbs);
    const op = async (): Promise<string> => "ran";
    expect(await stagingInterior(staging, join(stagingAbs, "a", "b.md"), op)).toBe("ran");
    for (const target of [
      stagingAbs,
      join(r, "elsewhere.md"),
      `${stagingAbs}-sibling/a.md`,
      `${stagingAbs}/../escape.md`,
      `${stagingAbs}/./a.md`,
    ]) {
      await expect(stagingInterior(staging, target, op)).rejects.toThrow("staging root");
    }
    // A handle that was not minted by `createdStagingRoot`, or was released.
    await expect(
      stagingInterior({ abs: stagingAbs }, join(stagingAbs, "a.md"), op),
    ).rejects.toThrow("staging root");
    releaseStagingRoot(staging);
    await expect(stagingInterior(staging, join(stagingAbs, "a.md"), op)).rejects.toThrow(
      "staging root",
    );
  });
});

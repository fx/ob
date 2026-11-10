/**
 * Service-core tests for `copyPath` (REST API › Path operations, `:copy`)
 * against REAL on-disk tmpdir vaults — no `fs` mocking. Races, outside
 * writers, and failing steps are injected through the `beforeStep` hook.
 */

import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
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
import { copyPath } from "../../src/vault/copy.ts";
import type { VaultServiceDeps } from "../../src/vault/files.ts";
import type { GuardSite } from "../../src/vault/guarded.ts";
import { movePath } from "../../src/vault/paths.ts";
import { type VaultFixture, makeVaultFixture } from "./helpers.ts";

function put(root: string, rel: string, content = "x"): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

const read = (root: string, rel: string): string => readFileSync(join(root, rel), "utf8");

type Step = (site: GuardSite, paths: readonly string[]) => Promise<void> | void;

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

/** Every entry, hidden ones included. */
function tree(root: string): string[] {
  return (readdirSync(root, { recursive: true }) as string[]).sort();
}

describe("copyPath: scenarios", () => {
  test("copy a folder recursively: hidden entries skipped, empty folders kept", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "templates/weekly.md", "# Weekly");
    mkdirSync(join(fx.root, "templates/empty"));
    put(fx.root, "templates/.hidden", "h");
    const res = await copyPath(fx.deps, fx.slug, "templates", {
      destination: "templates-copy",
      recursive: true,
    });
    expect(res).toEqual({
      path: "templates",
      destination: "templates-copy",
      type: "folder",
      overwritten: false,
      indexed: true,
      files: 1,
      skipped: 1,
    });
    expect(read(fx.root, "templates-copy/weekly.md")).toBe("# Weekly");
    expect(statSync(join(fx.root, "templates-copy/empty")).isDirectory()).toBe(true);
    expect(existsSync(join(fx.root, "templates-copy/.hidden"))).toBe(false);
    expect(read(fx.root, "templates/weekly.md")).toBe("# Weekly");
    expect(fx.indexed.has("templates-copy/weekly.md")).toBe(true);
    // No staging folder is left next to the destination.
    expect(readdirSync(fx.root).sort()).toEqual(["templates", "templates-copy"]);
  });

  test("a folder copy without recursive is invalid_path and creates nothing", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "templates/t.md");
    await expect(
      copyPath(fx.deps, fx.slug, "templates", { destination: "t2" }),
    ).rejects.toBeInstanceOf(InvalidPathError);
    expect(existsSync(join(fx.root, "t2"))).toBe(false);
  });

  test("a file copy writes the bytes atomically with a fresh mtime and creates parents", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "# A");
    const res = await copyPath(fx.deps, fx.slug, "a.md", {
      destination: "x/y/b.md",
      recursive: true,
    });
    expect(res).toEqual({
      path: "a.md",
      destination: "x/y/b.md",
      type: "file",
      overwritten: false,
      indexed: true,
      files: 1,
      skipped: 0,
    });
    expect(read(fx.root, "x/y/b.md")).toBe("# A");
    expect(statSync(join(fx.root, "x/y/b.md")).ino).not.toBe(statSync(join(fx.root, "a.md")).ino);
    expect(readdirSync(join(fx.root, "x/y"))).toEqual(["b.md"]);
  });

  test("an existing destination is already_exists without overwrite; overwrite replaces a file", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    put(fx.root, "b.md", "B");
    fx.indexed.add("b.md");
    await expect(
      copyPath(fx.deps, fx.slug, "a.md", { destination: "b.md" }),
    ).rejects.toBeInstanceOf(AlreadyExistsError);
    expect(read(fx.root, "b.md")).toBe("B");
    const res = await copyPath(fx.deps, fx.slug, "a.md", { destination: "b.md", overwrite: true });
    expect(res).toMatchObject({ overwritten: true, indexed: true });
    expect(read(fx.root, "b.md")).toBe("A");
    expect(fx.events.lastIndexOf("drop:b.md")).toBeLessThan(fx.events.lastIndexOf("reindex:b.md"));
    const absent = await copyPath(fx.deps, fx.slug, "a.md", {
      destination: "c.md",
      overwrite: true,
    });
    expect(absent.overwritten).toBe(false);
  });

  test("a folder never merges and a file never replaces a folder, whatever overwrite says", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "d1/x.md");
    put(fx.root, "d2/y.md");
    put(fx.root, "f.md");
    await expect(
      copyPath(fx.deps, fx.slug, "d1", { destination: "d2", recursive: true, overwrite: true }),
    ).rejects.toBeInstanceOf(AlreadyExistsError);
    await expect(
      copyPath(fx.deps, fx.slug, "f.md", { destination: "d2", overwrite: true }),
    ).rejects.toBeInstanceOf(AlreadyExistsError);
    expect(tree(fx.root)).toEqual(["d1", "d1/x.md", "d2", "d2/y.md", "f.md"]);
  });

  test("errors match move's: missing source, same path, inside the source, parent a file, unknown vault", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md");
    put(fx.root, "d/x.md");
    await expect(
      copyPath(fx.deps, fx.slug, "no.md", { destination: "b.md" }),
    ).rejects.toBeInstanceOf(DocNotFoundError);
    await expect(
      copyPath(fx.deps, fx.slug, "./a.md", { destination: "a.md" }),
    ).rejects.toBeInstanceOf(InvalidPathError);
    await expect(
      copyPath(fx.deps, fx.slug, "d", { destination: "d/sub", recursive: true }),
    ).rejects.toBeInstanceOf(InvalidPathError);
    await expect(
      copyPath(fx.deps, fx.slug, "d", { destination: "a.md/x", recursive: true }),
    ).rejects.toBeInstanceOf(InvalidPathError);
    await expect(
      copyPath(fx.deps, fx.slug, "a.md", { destination: "../out.md" }),
    ).rejects.toBeInstanceOf(InvalidPathError);
    await expect(copyPath(fx.deps, "nope", "a.md", { destination: "b.md" })).rejects.toBeInstanceOf(
      VaultNotFoundError,
    );
    expect(tree(fx.root)).toEqual(["a.md", "d", "d/x.md"]);
  });

  test("links are never rewritten by a copy", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "[[b]] [x](./b.md)");
    put(fx.root, "b.md", "B");
    await copyPath(fx.deps, fx.slug, "a.md", { destination: "sub/a.md" });
    expect(read(fx.root, "sub/a.md")).toBe("[[b]] [x](./b.md)");
  });
});

describe("copyPath: indexed", () => {
  test("only a PNG, or an empty folder, reports indexed false", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "img.png", "PNG");
    mkdirSync(join(fx.root, "empty"));
    expect((await copyPath(fx.deps, fx.slug, "img.png", { destination: "i2.png" })).indexed).toBe(
      false,
    );
    const empty = await copyPath(fx.deps, fx.slug, "empty", { destination: "e2", recursive: true });
    expect(empty).toMatchObject({ indexed: false, files: 0, skipped: 0 });
  });

  test("a note copied into node_modules is written but not indexed", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "# A");
    const res = await copyPath(fx.deps, fx.slug, "a.md", { destination: "node_modules/pkg/a.md" });
    expect(res.indexed).toBe(false);
    expect(read(fx.root, "node_modules/pkg/a.md")).toBe("# A");
    expect(fx.indexed.size).toBe(0);
  });

  test("rows of a no-longer-indexable destination are dropped by the copy's reindex", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    fx.indexed.add("node_modules/pkg/note.md");
    fx.indexed.add("img/logo.png");
    await copyPath(fx.deps, fx.slug, "a.md", { destination: "node_modules/pkg/note.md" });
    await copyPath(fx.deps, fx.slug, "a.md", { destination: "img/logo.png" });
    expect(fx.indexed.size).toBe(0);
  });

  test("an overwritten destination's failed drop, or a failed reindex, makes indexed false", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    put(fx.root, "b.md", "B");
    fx.indexed.add("b.md");
    fx.failNextDrop(new Error("drop down"));
    const dropped = await copyPath(fx.deps, fx.slug, "a.md", {
      destination: "b.md",
      overwrite: true,
    });
    expect(dropped.indexed).toBe(false);
    fx.failNextReindex(new Error("embedder down"));
    const res = await copyPath(fx.deps, fx.slug, "a.md", { destination: "b.md", overwrite: true });
    expect(res.indexed).toBe(false);
    // The overwritten destination's old rows were dropped even so.
    expect(fx.indexed.has("b.md")).toBe(false);
    put(fx.root, "d/x.md");
    fx.failNextReindex(new Error("embedder down"));
    const folder = await copyPath(fx.deps, fx.slug, "d", { destination: "d2", recursive: true });
    expect(folder.indexed).toBe(false);
  });
});

describe("copyPath: publishing", () => {
  test("no hard links (EPERM from link): the copy succeeds, the source is untouched, no temp file remains", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    const before = statSync(join(fx.root, "a.md"));
    const deps = stepping(fx, (site) => {
      if (site === "copy.link") throw errno("EPERM");
    });
    await copyPath(deps, fx.slug, "a.md", { destination: "b.md" });
    await copyPath(deps, fx.slug, "a.md", { destination: "c.md" });
    expect(read(fx.root, "b.md")).toBe("A");
    expect(statSync(join(fx.root, "a.md")).ino).toBe(before.ino);
    expect(readdirSync(fx.root).sort()).toEqual(["a.md", "b.md", "c.md"]);
    expect(fx.logCalls.warn.filter((w) => w.msg.includes("refuses hard links")).length).toBe(1);
  });

  test("no hard links and a destination that appeared meanwhile is already_exists, temp removed", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    const deps = stepping(fx, (site, paths) => {
      if (site !== "copy.link") return;
      writeFileSync(paths[1] as string, "OUTSIDE");
      throw errno("EOPNOTSUPP");
    });
    await expect(copyPath(deps, fx.slug, "a.md", { destination: "b.md" })).rejects.toBeInstanceOf(
      AlreadyExistsError,
    );
    expect(read(fx.root, "b.md")).toBe("OUTSIDE");
    expect(readdirSync(fx.root).sort()).toEqual(["a.md", "b.md"]);
  });

  test("an outside writer's file appearing before the publish is already_exists and intact", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    const deps = stepping(fx, (site, paths) => {
      if (site === "copy.link") writeFileSync(paths[1] as string, "OUTSIDE");
    });
    await expect(
      copyPath(deps, fx.slug, "a.md", { destination: "new/b.md" }),
    ).rejects.toBeInstanceOf(AlreadyExistsError);
    expect(read(fx.root, "new/b.md")).toBe("OUTSIDE");
    // Its parent holds the outside file, so it is kept; only the temp file went.
    expect(readdirSync(join(fx.root, "new"))).toEqual(["b.md"]);
  });

  test("an outside writer's non-empty folder appearing before a folder publish is already_exists", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "d/x.md", "X");
    const deps = stepping(fx, (site, paths) => {
      if (site === "copy.renameStaging") put("/", `${(paths[1] as string).slice(1)}/o.md`, "O");
    });
    await expect(
      copyPath(deps, fx.slug, "d", { destination: "e", recursive: true }),
    ).rejects.toBeInstanceOf(AlreadyExistsError);
    expect(read(fx.root, "e/o.md")).toBe("O");
    expect(readdirSync(fx.root).sort()).toEqual(["d", "e"]);
  });

  test("a destination that appears before the folder copy's final re-check is already_exists", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "d/x.md", "X");
    const deps = stepping(fx, (site) => {
      if (site === "copy.entry") put(fx.root, "e", "a file now");
    });
    await expect(
      copyPath(deps, fx.slug, "d", { destination: "e", recursive: true }),
    ).rejects.toBeInstanceOf(AlreadyExistsError);
    expect(read(fx.root, "e")).toBe("a file now");
  });

  test("a destination parent turned into a file before the fallback re-check is invalid_path", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    const deps = stepping(fx, (site) => {
      if (site !== "copy.link") return;
      rmSync(join(fx.root, "p"), { recursive: true });
      writeFileSync(join(fx.root, "p"), "outside writer's file");
      throw errno("EPERM");
    });
    await expect(copyPath(deps, fx.slug, "a.md", { destination: "p/b.md" })).rejects.toBeInstanceOf(
      InvalidPathError,
    );
    // The outside writer's file is never removed by the cleanup.
    expect(read(fx.root, "p")).toBe("outside writer's file");
  });

  test("a folder appearing before an overwrite rename is already_exists", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    const deps = stepping(fx, (site, paths) => {
      if (site === "copy.rename") put("/", `${(paths[1] as string).slice(1)}/i.md`, "I");
    });
    await expect(
      copyPath(deps, fx.slug, "a.md", { destination: "b.md", overwrite: true }),
    ).rejects.toBeInstanceOf(AlreadyExistsError);
    expect(readdirSync(fx.root).sort()).toEqual(["a.md", "b.md"]);
  });

  test("a temp-file removal that fails after the publish is logged; the copy still succeeds", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    const deps = stepping(fx, (site) => {
      if (site === "copy.unlinkTmp") throw errno("EBUSY");
    });
    const res = await copyPath(deps, fx.slug, "a.md", { destination: "b.md" });
    expect(res.indexed).toBe(true);
    expect(read(fx.root, "b.md")).toBe("A");
    expect(readdirSync(fx.root).filter((n) => n.endsWith(".tmp")).length).toBe(1);
    expect(fx.logCalls.warn.some((w) => w.msg.includes("temp file"))).toBe(true);
  });

  test("an unexpected link failure propagates and leaves no temp file", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    const deps = stepping(fx, (site) => {
      if (site === "copy.link") throw errno("EIO");
    });
    await expect(copyPath(deps, fx.slug, "a.md", { destination: "b.md" })).rejects.toThrow("EIO");
    expect(readdirSync(fx.root)).toEqual(["a.md"]);
  });
});

describe("copyPath: retries and owned-only cleanup", () => {
  test("a parent removed before the temp file is created is recreated once", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    let n = 0;
    const deps = stepping(fx, (site, paths) => {
      if (site === "copy.openTmp" && n++ === 0) rmdirSync(join(paths[0] as string, ".."));
    });
    await copyPath(deps, fx.slug, "a.md", { destination: "new/b.md" });
    expect(read(fx.root, "new/b.md")).toBe("A");
  });

  test("a parent removed before the publish is recreated once", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    let n = 0;
    const deps = stepping(fx, (site, paths) => {
      // Another call's cleanup can only take an empty folder; play it with
      // the temp file gone too.
      if (site === "copy.link" && n++ === 0) {
        rmSync(join(paths[1] as string, ".."), { recursive: true });
      }
    });
    await copyPath(deps, fx.slug, "a.md", { destination: "new/b.md" });
    expect(readdirSync(join(fx.root, "new"))).toEqual(["b.md"]);
  });

  test("a parent removed twice is internal: no temp file, nothing published", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    const deps = stepping(fx, (site, paths) => {
      if (site === "copy.openTmp") rmdirSync(join(paths[0] as string, ".."));
    });
    const err = await copyPath(deps, fx.slug, "a.md", { destination: "new/b.md" }).catch((e) => e);
    expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect(readdirSync(fx.root)).toEqual(["a.md"]);
  });

  test("a parent vanishing while a folder copy's parents are created is retried once", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "d/x.md", "X");
    let n = 0;
    const deps = stepping(fx, (site, paths) => {
      if (site === "parents.mkdir" && (paths[0] as string).endsWith("/q") && n++ === 0) {
        rmdirSync(join(fx.root, "p"));
      }
    });
    await copyPath(deps, fx.slug, "d", { destination: "p/q/d", recursive: true });
    expect(read(fx.root, "p/q/d/x.md")).toBe("X");
  });

  test("the staging folder's parent removed before its creation is recreated once", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "d/x.md", "X");
    let n = 0;
    const deps = stepping(fx, (site, paths) => {
      if (site === "copy.mkdirStaging" && n++ === 0) rmdirSync(join(paths[0] as string, ".."));
    });
    const res = await copyPath(deps, fx.slug, "d", { destination: "new/deep/d", recursive: true });
    expect(res.files).toBe(1);
    expect(read(fx.root, "new/deep/d/x.md")).toBe("X");
    expect(readdirSync(join(fx.root, "new/deep"))).toEqual(["d"]);
  });

  test("the staging folder's parent removed twice is internal and nothing is created", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "d/x.md", "X");
    const deps = stepping(fx, (site, paths) => {
      if (site === "copy.mkdirStaging") rmdirSync(join(paths[0] as string, ".."));
    });
    const err = await copyPath(deps, fx.slug, "d", { destination: "new/d", recursive: true }).catch(
      (e) => e,
    );
    expect((err as NodeJS.ErrnoException).code).toBe("ENOENT");
    expect(readdirSync(fx.root)).toEqual(["d"]);
  });

  test("a staging creation that fails otherwise removes the created parents", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "d/x.md", "X");
    const deps = stepping(fx, (site) => {
      if (site === "copy.mkdirStaging") throw errno("EACCES");
    });
    await expect(
      copyPath(deps, fx.slug, "d", { destination: "new/deep/d", recursive: true }),
    ).rejects.toThrow("EACCES");
    expect(readdirSync(fx.root)).toEqual(["d"]);
  });

  test("a failure mid-copy leaves no staging folder and no parent this call created", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "d/a.md", "A");
    put(fx.root, "d/sub/b.md", "B");
    const deps = stepping(fx, (site, paths) => {
      if (site === "copy.entry" && (paths[0] as string).endsWith("b.md")) throw errno("EIO");
    });
    await expect(
      copyPath(deps, fx.slug, "d", { destination: "new/deep/d", recursive: true }),
    ).rejects.toThrow("EIO");
    expect(readdirSync(fx.root)).toEqual(["d"]);
  });

  test("a staging folder that cannot be removed after a failure is logged and left", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "d/a.md", "A");
    const deps = stepping(fx, (site) => {
      if (site === "copy.entry") throw errno("EIO");
      if (site === "copy.rmStaging") throw errno("EBUSY");
    });
    await expect(
      copyPath(deps, fx.slug, "d", { destination: "e", recursive: true }),
    ).rejects.toThrow("EIO");
    expect(readdirSync(fx.root).some((n) => n.endsWith(".copy"))).toBe(true);
    expect(fx.logCalls.warn.some((w) => w.msg.includes("staging folder"))).toBe(true);
  });

  test("a source file removed while the folder copy runs is not copied", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "d/a.md", "A");
    put(fx.root, "d/b.md", "B");
    const deps = stepping(fx, (site, paths) => {
      if (site === "copy.entry" && (paths[0] as string).endsWith("b.md"))
        rmSync(paths[0] as string);
    });
    const res = await copyPath(deps, fx.slug, "d", { destination: "e", recursive: true });
    expect(res.files).toBe(1);
    expect(readdirSync(join(fx.root, "e"))).toEqual(["a.md"]);
  });

  test("symlinks inside a copied folder are skipped and counted, never followed", async () => {
    const fx = makeVaultFixture();
    const out = outsideDir();
    put(fx.root, "d/a.md", "A");
    symlinkSync(join(out, "keep.md"), join(fx.root, "d", "ref.md"));
    symlinkSync(out, join(fx.root, "d", "outdir"));
    const res = await copyPath(fx.deps, fx.slug, "d", { destination: "e", recursive: true });
    expect(res).toMatchObject({ files: 1, skipped: 2 });
    expect(readdirSync(join(fx.root, "e"))).toEqual(["a.md"]);
  });
});

describe("copyPath: owned temp and staging names", () => {
  test("a temp name that collides with an existing file fails the copy and never removes that file", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "a.md", "A");
    put(fx.root, ".b.md.fixed.tmp", "THEIRS");
    const deps: VaultServiceDeps = { ...fx.deps, randomUUID: () => "fixed" };
    const err = await copyPath(deps, fx.slug, "a.md", { destination: "b.md" }).catch((e) => e);
    expect((err as NodeJS.ErrnoException).code).toBe("EEXIST");
    expect(read(fx.root, ".b.md.fixed.tmp")).toBe("THEIRS");
    expect(existsSync(join(fx.root, "b.md"))).toBe(false);
  });

  test("a staging name that collides with an existing folder fails the copy and never removes it", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "d/x.md", "X");
    put(fx.root, ".e.fixed.copy/theirs.md", "THEIRS");
    const deps: VaultServiceDeps = { ...fx.deps, randomUUID: () => "fixed" };
    const err = await copyPath(deps, fx.slug, "d", { destination: "e", recursive: true }).catch(
      (e) => e,
    );
    expect((err as NodeJS.ErrnoException).code).toBe("EEXIST");
    expect(read(fx.root, ".e.fixed.copy/theirs.md")).toBe("THEIRS");
    expect(existsSync(join(fx.root, "e"))).toBe(false);
  });
});

describe("copyPath: an unreadable source fails before publishing", () => {
  test("the source root becoming unreadable fails the copy; no empty destination appears", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "p/d/x.md", "X");
    const deps = stepping(fx, (site) => {
      // After the checks, before the walk: `p/d` can no longer be lstat'ed.
      if (site === "copy.mkdirStaging") chmodSync(join(fx.root, "p"), 0o600);
    });
    try {
      const err = await copyPath(deps, fx.slug, "p/d", { destination: "e", recursive: true }).catch(
        (e) => e,
      );
      expect((err as NodeJS.ErrnoException).code).toBe("EACCES");
      expect(readdirSync(fx.root).sort()).toEqual(["p"]);
    } finally {
      chmodSync(join(fx.root, "p"), 0o755);
    }
  });

  test("a subtree becoming unreadable fails the copy; no partial destination appears", async () => {
    const fx = makeVaultFixture();
    // `d/sub` stays listable but not searchable, so only the walk's contained
    // lstat of `d/sub/inner` fails (EACCES); `d/z.md` would still copy fine.
    put(fx.root, "d/sub/inner/b.md", "B");
    put(fx.root, "d/z.md", "Z");
    const deps = stepping(fx, (site) => {
      if (site === "copy.mkdirStaging") chmodSync(join(fx.root, "d", "sub"), 0o600);
    });
    try {
      const err = await copyPath(deps, fx.slug, "d", { destination: "e", recursive: true }).catch(
        (e) => e,
      );
      expect((err as NodeJS.ErrnoException).code).toBe("EACCES");
      expect(readdirSync(fx.root)).toEqual(["d"]);
    } finally {
      chmodSync(join(fx.root, "d", "sub"), 0o755);
    }
  });
});

describe("copyPath: containment", () => {
  test("a parent swapped for a symlink before the source read is invalid_path; nothing read outside", async () => {
    const fx = makeVaultFixture();
    const out = outsideDir();
    writeFileSync(join(out, "a.md"), "OUTSIDE A");
    put(fx.root, "s/a.md", "A");
    const deps = stepping(fx, (site) => {
      if (site !== "copy.read") return;
      renameSync(join(fx.root, "s"), join(fx.root, "s-real"));
      symlinkSync(out, join(fx.root, "s"));
    });
    await expect(copyPath(deps, fx.slug, "s/a.md", { destination: "b.md" })).rejects.toBeInstanceOf(
      InvalidPathError,
    );
    expect(existsSync(join(fx.root, "b.md"))).toBe(false);
  });

  test("a file in a copied folder behind a swapped parent fails the copy with invalid_path", async () => {
    const fx = makeVaultFixture();
    const out = outsideDir();
    put(fx.root, "d/sub/a.md", "A");
    const deps = stepping(fx, (site, paths) => {
      if (site === "copy.entry" && (paths[0] as string).endsWith("a.md")) {
        renameSync(join(fx.root, "d", "sub"), join(fx.root, "d", "sub-real"));
        symlinkSync(out, join(fx.root, "d", "sub"));
      }
    });
    await expect(
      copyPath(deps, fx.slug, "d", { destination: "e", recursive: true }),
    ).rejects.toBeInstanceOf(InvalidPathError);
    expect(readdirSync(fx.root).sort()).toEqual(["d"]);
  });

  async function expectContained(site: GuardSite, recursive: boolean): Promise<void> {
    const fx = makeVaultFixture();
    const out = outsideDir();
    put(fx.root, "a.md", "A");
    put(fx.root, "d/x.md", "X");
    mkdirSync(join(fx.root, "dst"));
    let planted = false;
    const deps = stepping(fx, (s) => {
      if (s !== site || planted) return;
      planted = true;
      renameSync(join(fx.root, "dst"), join(fx.root, "dst-real"));
      symlinkSync(out, join(fx.root, "dst"));
    });
    await expect(
      copyPath(deps, fx.slug, recursive ? "d" : "a.md", { destination: "dst/c", recursive }),
    ).rejects.toBeInstanceOf(InvalidPathError);
    expect(readdirSync(out)).toEqual(["keep.md"]);
  }

  test("the file copy's temp creation, temp write, and publish", async () => {
    await expectContained("copy.openTmp", false);
    await expectContained("copy.writeTmp", false);
    await expectContained("copy.link", false);
  });

  test("the folder copy's staging-root creation and publish", async () => {
    await expectContained("copy.mkdirStaging", true);
    await expectContained("copy.renameStaging", true);
  });

  test("the check before unlink(tmp) after the publish leaves the temp file and still returns 200", async () => {
    const fx = makeVaultFixture();
    const out = outsideDir();
    put(fx.root, "a.md", "A");
    mkdirSync(join(fx.root, "dst"));
    const deps = stepping(fx, (site) => {
      if (site !== "copy.unlinkTmp") return;
      renameSync(join(fx.root, "dst"), join(fx.root, "dst-real"));
      symlinkSync(out, join(fx.root, "dst"));
    });
    const res = await copyPath(deps, fx.slug, "a.md", { destination: "dst/b.md" });
    expect(res.files).toBe(1);
    expect(readdirSync(out)).toEqual(["keep.md"]);
    const left = readdirSync(join(fx.root, "dst-real")).sort();
    expect(left.length).toBe(2);
    expect(left[0]).toMatch(/^\.b\.md\..+\.tmp$/);
    expect(left[1]).toBe("b.md");
  });
});

describe("destination races across operations", () => {
  async function race(
    seed: (fx: VaultFixture) => void,
    a: (fx: VaultFixture) => Promise<unknown>,
    b: (fx: VaultFixture) => Promise<unknown>,
    sources: Record<string, string>,
  ): Promise<void> {
    const fx = makeVaultFixture();
    seed(fx);
    const results = await Promise.allSettled([a(fx), b(fx)]);
    const won = results.filter((r) => r.status === "fulfilled").length;
    const lost = results.flatMap((r) => (r.status === "rejected" ? [r.reason] : []));
    expect(won).toBe(1);
    expect(lost.length).toBe(1);
    expect(lost[0]).toBeInstanceOf(AlreadyExistsError);
    // The loser's source is intact (copies never touch theirs; a losing move keeps its own).
    const loserIndex = results.findIndex((r) => r.status === "rejected");
    const loserSource = Object.keys(sources)[loserIndex] as string;
    expect(read(fx.root, loserSource)).toBe(sources[loserSource] as string);
  }

  test("file move + file move", async () => {
    await race(
      (fx) => {
        put(fx.root, "a.md", "A");
        put(fx.root, "b.md", "B");
      },
      (fx) => movePath(fx.deps, fx.slug, "a.md", { destination: "c.md" }),
      (fx) => movePath(fx.deps, fx.slug, "b.md", { destination: "c.md" }),
      { "a.md": "A", "b.md": "B" },
    );
  });

  test("file copy + file move", async () => {
    await race(
      (fx) => {
        put(fx.root, "a.md", "A");
        put(fx.root, "b.md", "B");
      },
      (fx) => copyPath(fx.deps, fx.slug, "a.md", { destination: "c.md" }),
      (fx) => movePath(fx.deps, fx.slug, "b.md", { destination: "c.md" }),
      { "a.md": "A", "b.md": "B" },
    );
  });

  test("folder move + folder copy", async () => {
    await race(
      (fx) => {
        put(fx.root, "d1/x.md", "X1");
        put(fx.root, "d2/x.md", "X2");
      },
      (fx) => movePath(fx.deps, fx.slug, "d1", { destination: "e" }),
      (fx) => copyPath(fx.deps, fx.slug, "d2", { destination: "e", recursive: true }),
      { "d1/x.md": "X1", "d2/x.md": "X2" },
    );
  });

  test("file move + folder move", async () => {
    await race(
      (fx) => {
        put(fx.root, "a.md", "A");
        put(fx.root, "d/x.md", "X");
      },
      (fx) => movePath(fx.deps, fx.slug, "a.md", { destination: "e" }),
      (fx) => movePath(fx.deps, fx.slug, "d", { destination: "e" }),
      { "a.md": "A", "d/x.md": "X" },
    );
  });

  test("a folder copy that loses to a move published while it staged removes its staging folder", async () => {
    const fx = makeVaultFixture();
    put(fx.root, "d1/x.md", "X1");
    put(fx.root, "d2/y.md", "Y2");
    const deps = stepping(fx, async (site) => {
      if (site === "copy.entry") await movePath(fx.deps, fx.slug, "d1", { destination: "e" });
    });
    await expect(
      copyPath(deps, fx.slug, "d2", { destination: "e", recursive: true }),
    ).rejects.toBeInstanceOf(AlreadyExistsError);
    expect(readdirSync(fx.root).sort()).toEqual(["d2", "e"]);
    expect(readdirSync(join(fx.root, "e"))).toEqual(["x.md"]);
  });
});

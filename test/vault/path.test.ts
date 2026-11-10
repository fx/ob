import { describe, expect, test } from "bun:test";
import * as nodeFs from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { InvalidPathError } from "../../src/errors.ts";
import { assertNotSymlinkEscape, checkContainedDirectory, safeJoin } from "../../src/vault/path.ts";

describe("safeJoin", () => {
  const root = resolve("/tmp/ob-test-root");

  test("resolves a normal relative path beneath the root", () => {
    expect(safeJoin(root, "notes/foo.md")).toBe(join(root, "notes/foo.md"));
  });

  test("rejects `..` segments before resolution", () => {
    expect(() => safeJoin(root, "../etc/passwd")).toThrow(InvalidPathError);
  });

  test("rejects leading slash (absolute path)", () => {
    expect(() => safeJoin(root, "/etc/passwd")).toThrow(InvalidPathError);
  });

  test("rejects NUL byte", () => {
    expect(() => safeJoin(root, "a\0b")).toThrow(InvalidPathError);
  });

  test("rejects paths over 1024 bytes", () => {
    expect(() => safeJoin(root, "x".repeat(2000))).toThrow(InvalidPathError);
  });

  test("rejects hidden segments at any depth", () => {
    expect(() => safeJoin(root, ".obsidian/workspace.json")).toThrow(InvalidPathError);
    expect(() => safeJoin(root, "notes/.git/config")).toThrow(InvalidPathError);
    expect(() => safeJoin(root, ".trash/old.md")).toThrow(InvalidPathError);
    expect(() => safeJoin(root, ".DS_Store")).toThrow(InvalidPathError);
  });

  test("rejects a path that resolves to the vault root itself", () => {
    // Dot-only paths survive `assertSafeRelativePath` but resolve to the root;
    // the root is never a valid target (it would let a recursive delete wipe
    // the whole vault), so `safeJoin` rejects it.
    expect(() => safeJoin(root, "./")).toThrow(InvalidPathError);
    expect(() => safeJoin(root, ".")).toThrow(InvalidPathError);
    expect(() => safeJoin(root, "./.")).toThrow(InvalidPathError);
  });

  test("rejects the empty string", () => {
    expect(() => safeJoin(root, "")).toThrow(InvalidPathError);
  });

  test("normalises a non-absolute root before joining", () => {
    // safeJoin tolerates a relative root by resolving against cwd.
    const rel = "tmp/relative-root";
    const result = safeJoin(rel, "notes/x.md");
    expect(result).toBe(resolve(rel, "notes/x.md"));
  });
});

describe("assertNotSymlinkEscape", () => {
  test("propagates a non-ENOENT / non-ENOTDIR lstat error", async () => {
    const root = resolve("/tmp/ob-ase-root");
    const target = join(root, "child");
    const realLstat = fs.lstat;
    const stub = ((p: string, ...rest: unknown[]) => {
      if (p === target) throw new Error("EACCES (stubbed)");
      // biome-ignore lint/suspicious/noExplicitAny: forwarding rest args to the original fs.lstat overloads.
      return realLstat(p as any, ...(rest as []));
    }) as typeof fs.lstat;
    (fs as unknown as { lstat: typeof fs.lstat }).lstat = stub;
    try {
      await expect(assertNotSymlinkEscape(target, root)).rejects.toThrow("EACCES");
    } finally {
      (fs as unknown as { lstat: typeof fs.lstat }).lstat = realLstat;
    }
  });
});

describe("checkContainedDirectory", () => {
  const tmp = (): string => nodeFs.mkdtempSync(join(tmpdir(), "ob-contained-"));

  test("a contained real directory is `dir`, with its own lstat", async () => {
    const root = tmp();
    nodeFs.mkdirSync(join(root, "a", "b"), { recursive: true });
    const r = await checkContainedDirectory(join(root, "a", "b"), root);
    expect(r.kind).toBe("dir");
    expect(r.kind === "dir" && r.stat.isDirectory()).toBe(true);
  });

  test("vanished, or no longer a directory itself, is a silent `skip`", async () => {
    const root = tmp();
    const out = tmp();
    nodeFs.writeFileSync(join(root, "f"), "x");
    nodeFs.symlinkSync(out, join(root, "link"));
    for (const p of ["gone", "gone/deeper", "f", "f/under", "link"]) {
      expect([p, (await checkContainedDirectory(join(root, p), root)).kind]).toEqual([p, "skip"]);
    }
    expect((await checkContainedDirectory(root, root)).kind).toBe("skip");
  });

  test("a symlink above the directory, a path outside the root, or an lstat fault is an `error`", async () => {
    const root = tmp();
    const out = tmp();
    nodeFs.mkdirSync(join(out, "sub"));
    nodeFs.symlinkSync(out, join(root, "link"));
    const viaLink = await checkContainedDirectory(join(root, "link", "sub"), root);
    expect(viaLink.kind).toBe("error");
    expect(viaLink.kind === "error" && viaLink.error).toBeInstanceOf(InvalidPathError);
    const outside = await checkContainedDirectory(out, root);
    expect(outside.kind === "error" && outside.error).toBeInstanceOf(InvalidPathError);
    nodeFs.mkdirSync(join(root, "locked", "inner"), { recursive: true });
    nodeFs.chmodSync(join(root, "locked"), 0o600);
    try {
      const denied = await checkContainedDirectory(join(root, "locked", "inner"), root);
      expect(denied.kind === "error" && (denied.error as NodeJS.ErrnoException).code).toBe(
        "EACCES",
      );
    } finally {
      nodeFs.chmodSync(join(root, "locked"), 0o755);
    }
  });
});

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { InvalidPathError } from "../../src/errors.ts";
import { safeJoin } from "../../src/vault/path.ts";

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

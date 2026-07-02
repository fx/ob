import { describe, expect, test } from "bun:test";
import {
  DocNotFoundError,
  ERROR_CODES,
  InvalidBodyError,
  InvalidInputError,
  InvalidPathError,
  InvalidQueryError,
  MAX_PATH_BYTES,
  OBError,
  PatchAmbiguousError,
  PatchNoMatchError,
  UnsupportedMediaTypeError,
  VaultNotFoundError,
  assertSafeRelativePath,
} from "../src/errors.ts";

describe("assertSafeRelativePath", () => {
  test("accepts a normal relative path", () => {
    expect(assertSafeRelativePath("notes/foo.md")).toBe("notes/foo.md");
    expect(assertSafeRelativePath("foo.md")).toBe("foo.md");
    expect(assertSafeRelativePath("a/b/c/d.md")).toBe("a/b/c/d.md");
  });

  test("rejects empty string", () => {
    let err: unknown;
    try {
      assertSafeRelativePath("");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidPathError);
  });

  test("rejects non-string", () => {
    let err: unknown;
    try {
      // biome-ignore lint/suspicious/noExplicitAny: deliberate non-string input.
      assertSafeRelativePath(123 as any);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidPathError);
  });

  test("rejects `..` in any segment", () => {
    expect(() => assertSafeRelativePath("../escape")).toThrow(InvalidPathError);
    expect(() => assertSafeRelativePath("a/../b")).toThrow(InvalidPathError);
    expect(() => assertSafeRelativePath("a/b/..")).toThrow(InvalidPathError);
  });

  test("rejects leading slash", () => {
    expect(() => assertSafeRelativePath("/etc/passwd")).toThrow(InvalidPathError);
    expect(() => assertSafeRelativePath("\\windows\\path")).toThrow(InvalidPathError);
  });

  test("rejects NUL byte", () => {
    expect(() => assertSafeRelativePath("a\0b.md")).toThrow(InvalidPathError);
  });

  test("rejects hidden segments", () => {
    expect(() => assertSafeRelativePath(".obsidian/workspace.json")).toThrow(InvalidPathError);
    expect(() => assertSafeRelativePath("notes/.tmp.md")).toThrow(InvalidPathError);
    expect(() => assertSafeRelativePath(".trash/old.md")).toThrow(InvalidPathError);
    expect(() => assertSafeRelativePath(".DS_Store")).toThrow(InvalidPathError);
  });

  test("`.` (current directory) segments are tolerated", () => {
    // Single-dot segments are no-ops in path resolution; rejecting them
    // would be over-strict.
    expect(assertSafeRelativePath("./a.md")).toBe("./a.md");
  });

  test("rejects Windows drive prefixes", () => {
    expect(() => assertSafeRelativePath("C:\\Users\\evil")).toThrow(InvalidPathError);
    expect(() => assertSafeRelativePath("D:/path")).toThrow(InvalidPathError);
  });

  test("rejects backslash-traversal mid-path", () => {
    expect(() => assertSafeRelativePath("notes\\..\\..\\etc")).toThrow(InvalidPathError);
  });

  test("rejects paths exceeding the byte ceiling", () => {
    const tooLong = `${"x".repeat(MAX_PATH_BYTES + 1)}.md`;
    expect(() => assertSafeRelativePath(tooLong)).toThrow(InvalidPathError);
  });

  test("multi-byte chars count toward the byte ceiling", () => {
    // Each '日' is 3 bytes UTF-8. 350 chars = 1050 bytes, just over.
    const tooLong = "日".repeat(350);
    expect(() => assertSafeRelativePath(tooLong)).toThrow(InvalidPathError);
  });

  test("error carries `code: invalid_path` and the offending path", () => {
    let err: InvalidPathError | undefined;
    try {
      assertSafeRelativePath("../bad");
    } catch (e) {
      err = e as InvalidPathError;
    }
    expect(err?.code).toBe("invalid_path");
    expect(err?.path).toBe("../bad");
    expect(err?.reason).toContain("parent");
    expect(err?.message).toContain("../bad");
  });
});

describe("typed error classes", () => {
  test("ERROR_CODES is the canonical closed set with no duplicates", () => {
    const set = new Set(ERROR_CODES);
    expect(set.size).toBe(ERROR_CODES.length);
    // The exact members are the contract — every adapter relies on these.
    expect(set.has("vault_not_found")).toBe(true);
    expect(set.has("not_found")).toBe(true);
    expect(set.has("invalid_input")).toBe(true);
    expect(set.has("invalid_path")).toBe(true);
    expect(set.has("invalid_body")).toBe(true);
    expect(set.has("invalid_query")).toBe(true);
    expect(set.has("unsupported_media_type")).toBe(true);
    expect(set.has("patch_no_match")).toBe(true);
    expect(set.has("patch_ambiguous")).toBe(true);
    expect(set.has("embedder_failed")).toBe(true);
    expect(set.has("extraction_failed")).toBe(true);
    expect(set.has("internal")).toBe(true);
  });

  test("each error class exposes a unique code from the closed set", () => {
    const instances: OBError[] = [
      new VaultNotFoundError("v"),
      new DocNotFoundError("p"),
      new InvalidPathError("p", "r"),
      new InvalidInputError("m"),
      new InvalidBodyError("m"),
      new InvalidQueryError("m"),
      new UnsupportedMediaTypeError("m"),
      new PatchNoMatchError(0),
      new PatchAmbiguousError(0, 2),
    ];
    const codes = instances.map((e) => e.code);
    // Every code is in the closed set.
    for (const c of codes) expect(ERROR_CODES).toContain(c);
    // Every class produces a distinct code (no class shares).
    expect(new Set(codes).size).toBe(codes.length);
  });

  test("VaultNotFoundError surfaces slug in details", () => {
    const e = new VaultNotFoundError("v");
    expect(e.code).toBe("vault_not_found");
    expect(e.slug).toBe("v");
    expect(e.details).toEqual({ slug: "v" });
    expect(e.name).toBe("VaultNotFoundError");
  });

  test("DocNotFoundError surfaces path", () => {
    const e = new DocNotFoundError("notes/x.md");
    expect(e.code).toBe("not_found");
    expect(e.path).toBe("notes/x.md");
    expect(e.details).toEqual({ path: "notes/x.md" });
  });

  test("InvalidInputError carries optional details", () => {
    const e = new InvalidInputError("bad", { field: "x" });
    expect(e.code).toBe("invalid_input");
    expect(e.details).toEqual({ field: "x" });
    const e2 = new InvalidInputError("bad");
    expect(e2.details).toBeUndefined();
  });

  test("InvalidBodyError + InvalidQueryError carry codes", () => {
    expect(new InvalidBodyError("m").code).toBe("invalid_body");
    expect(new InvalidQueryError("m").code).toBe("invalid_query");
  });

  test("UnsupportedMediaTypeError optionally records path", () => {
    const e = new UnsupportedMediaTypeError("m", "x.png");
    expect(e.code).toBe("unsupported_media_type");
    expect(e.path).toBe("x.png");
    expect(e.details).toEqual({ path: "x.png" });
    const e2 = new UnsupportedMediaTypeError("m");
    expect(e2.path).toBeUndefined();
    expect(e2.details).toBeUndefined();
  });

  test("PatchNoMatchError + PatchAmbiguousError carry editIndex / occurrences", () => {
    const a = new PatchNoMatchError(2);
    expect(a.code).toBe("patch_no_match");
    expect(a.editIndex).toBe(2);
    expect(a.details).toEqual({ editIndex: 2 });
    const b = new PatchAmbiguousError(1, 4);
    expect(b.code).toBe("patch_ambiguous");
    expect(b.editIndex).toBe(1);
    expect(b.occurrences).toBe(4);
    expect(b.details).toEqual({ editIndex: 1, occurrences: 4 });
  });

  test("InvalidPathError details include path and reason", () => {
    const e = new InvalidPathError("p", "bad");
    expect(e.details).toEqual({ path: "p", reason: "bad" });
  });

  test("OBError default constructor with no details leaves details undefined", () => {
    const e = new InvalidInputError("hello");
    expect(e.message).toBe("hello");
    expect(e.details).toBeUndefined();
  });

  test("OBError is directly constructible (default code: internal)", () => {
    const e = new OBError("hi");
    expect(e.code).toBe("internal");
    expect(e.details).toBeUndefined();
    const e2 = new OBError("hi", { x: 1 });
    expect(e2.details).toEqual({ x: 1 });
    expect(e2.name).toBe("OBError");
  });

  test("ERROR_CODES contents match every class's `code`", () => {
    // Touch the const array a second time so the static init line is on
    // the hot path even if Bun's coverage instrumenter elides repeated
    // imports.
    const expected = [
      new VaultNotFoundError("v").code,
      new DocNotFoundError("p").code,
      new InvalidInputError("m").code,
      new InvalidPathError("p", "r").code,
      new InvalidBodyError("m").code,
      new InvalidQueryError("m").code,
      new UnsupportedMediaTypeError("m").code,
      new PatchNoMatchError(0).code,
      new PatchAmbiguousError(0, 1).code,
    ];
    for (const c of expected) expect(ERROR_CODES).toContain(c);
  });
});

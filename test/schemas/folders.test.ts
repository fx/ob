import { describe, expect, test } from "bun:test";
import {
  CreateFolderInput,
  CreateFolderResponse,
  DeleteFolderInput,
  DeleteFolderQuery,
  FolderEntry,
  ListFoldersInput,
  ListFoldersQuery,
  ListFoldersResponse,
} from "../../src/schemas/index.ts";

describe("ListFoldersQuery", () => {
  test("applies the default limit", () => {
    expect(ListFoldersQuery.parse({}).limit).toBe(100);
  });
  test("coerces a numeric-string limit", () => {
    expect(ListFoldersQuery.parse({ limit: "5" }).limit).toBe(5);
  });
  test("rejects limits over 1000", () => {
    expect(() => ListFoldersQuery.parse({ limit: 9999 })).toThrow();
  });
  test("accepts prefix + cursor", () => {
    const r = ListFoldersQuery.parse({ prefix: "notes/", cursor: "abc" });
    expect(r.prefix).toBe("notes/");
    expect(r.cursor).toBe("abc");
  });
  test("rejects unknown keys via strict()", () => {
    expect(() => ListFoldersQuery.parse({ junk: "x" })).toThrow();
  });
});

describe("FolderEntry + ListFoldersResponse", () => {
  test("FolderEntry needs path + mtimeMs", () => {
    expect(() => FolderEntry.parse({ path: "a", mtimeMs: 1 })).not.toThrow();
    expect(() => FolderEntry.parse({ path: "a" })).toThrow();
  });
  test("ListFoldersResponse validates a simple response", () => {
    expect(() =>
      ListFoldersResponse.parse({ items: [{ path: "a", mtimeMs: 1 }], nextCursor: null }),
    ).not.toThrow();
  });
});

describe("CreateFolderResponse", () => {
  test("needs path + mtimeMs + created", () => {
    expect(() =>
      CreateFolderResponse.parse({ path: "a", mtimeMs: 1, created: true }),
    ).not.toThrow();
    expect(() => CreateFolderResponse.parse({ path: "a", mtimeMs: 1 })).toThrow();
  });
});

describe("DeleteFolderQuery", () => {
  test("accepts the literal true/false and absence", () => {
    expect(DeleteFolderQuery.parse({ recursive: "true" }).recursive).toBe("true");
    expect(DeleteFolderQuery.parse({ recursive: "false" }).recursive).toBe("false");
    expect(DeleteFolderQuery.parse({}).recursive).toBeUndefined();
  });
  test("rejects a non-boolean recursive value", () => {
    expect(() => DeleteFolderQuery.parse({ recursive: "1" })).toThrow();
  });
  test("rejects unknown keys via strict()", () => {
    expect(() => DeleteFolderQuery.parse({ junk: "x" })).toThrow();
  });
});

describe("MCP input schemas", () => {
  test("ListFoldersInput requires vault; limit is a real number", () => {
    expect(ListFoldersInput.parse({ vault: "v", limit: 3 }).limit).toBe(3);
    expect(() => ListFoldersInput.parse({ vault: "" })).toThrow();
    expect(() => ListFoldersInput.parse({ vault: "v", limit: "3" })).toThrow();
  });
  test("CreateFolderInput requires vault + non-empty path", () => {
    expect(CreateFolderInput.parse({ vault: "v", path: "a" }).path).toBe("a");
    expect(() => CreateFolderInput.parse({ vault: "v", path: "" })).toThrow();
  });
  test("DeleteFolderInput takes a boolean recursive", () => {
    expect(DeleteFolderInput.parse({ vault: "v", path: "a", recursive: true }).recursive).toBe(
      true,
    );
    expect(DeleteFolderInput.parse({ vault: "v", path: "a" }).recursive).toBeUndefined();
    expect(() => DeleteFolderInput.parse({ vault: "v", path: "a", recursive: "yes" })).toThrow();
  });
});

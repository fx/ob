import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  DeletePathInput,
  DeletePathQuery,
  ListPathsInput,
  ListPathsQuery,
  ListPathsResponse,
  MAX_PREFIX_BYTES,
  PathEntry,
} from "../../src/schemas/index.ts";

describe("ListPathsQuery", () => {
  test("applies the default limit and leaves the rest unset", () => {
    expect(ListPathsQuery.parse({})).toEqual({ limit: 100 });
  });
  test("coerces limit and recursive from query strings", () => {
    const r = ListPathsQuery.parse({
      limit: "5",
      recursive: "false",
      type: "folder",
      prefix: "notes/",
      cursor: "abc",
    });
    expect(r).toEqual({
      limit: 5,
      recursive: false,
      type: "folder",
      prefix: "notes/",
      cursor: "abc",
    });
    expect(ListPathsQuery.parse({ recursive: "true" }).recursive).toBe(true);
  });
  test.each([
    { limit: "0" },
    { limit: "1001" },
    { limit: "abc" },
    { limit: "1.5" },
    { type: "symlink" },
    { recursive: "yes" },
    { junk: "x" },
  ])("rejects %j", (q) => {
    expect(ListPathsQuery.safeParse(q).success).toBe(false);
  });
  test("bounds prefix by UTF-8 bytes, not characters", () => {
    expect(ListPathsQuery.safeParse({ prefix: "a".repeat(MAX_PREFIX_BYTES) }).success).toBe(true);
    // 513 two-byte characters: under the character cap, over the byte cap.
    expect(ListPathsQuery.safeParse({ prefix: "é".repeat(513) }).success).toBe(false);
    expect(ListPathsQuery.safeParse({ prefix: "a".repeat(MAX_PREFIX_BYTES + 1) }).success).toBe(
      false,
    );
  });
});

describe("ListPathsInput", () => {
  test("requires vault; takes real JSON numbers and booleans", () => {
    expect(ListPathsInput.parse({ vault: "v", limit: 3, recursive: false })).toEqual({
      vault: "v",
      limit: 3,
      recursive: false,
    });
    expect(ListPathsInput.safeParse({ vault: "" }).success).toBe(false);
    expect(ListPathsInput.safeParse({ vault: "v", limit: "3" }).success).toBe(false);
    expect(ListPathsInput.safeParse({ vault: "v", recursive: "false" }).success).toBe(false);
    expect(ListPathsInput.safeParse({ vault: "v", junk: 1 }).success).toBe(false);
  });
  test("advertises type as an enum and every field but vault as optional", () => {
    const json = z.toJSONSchema(ListPathsInput, { io: "input" }) as {
      required: string[];
      properties: Record<string, { enum?: string[] }>;
    };
    expect(json.required).toEqual(["vault"]);
    expect(json.properties.type?.enum).toEqual(["file", "folder"]);
  });
});

describe("PathEntry + ListPathsResponse", () => {
  test("discriminates file and folder entries", () => {
    const file = {
      type: "file" as const,
      path: "a.md",
      mtimeMs: 1,
      size: 1,
      sha256: "x",
      contentType: "t",
    };
    expect(PathEntry.parse(file)).toEqual(file);
    expect(PathEntry.parse({ type: "folder", path: "a", mtimeMs: 1 })).toEqual({
      type: "folder",
      path: "a",
      mtimeMs: 1,
    });
    expect(PathEntry.safeParse({ type: "file", path: "a.md", mtimeMs: 1 }).success).toBe(false);
    expect(PathEntry.safeParse({ type: "link", path: "a", mtimeMs: 1 }).success).toBe(false);
    expect(
      ListPathsResponse.safeParse({
        items: [{ type: "folder", path: "a", mtimeMs: 1 }],
        nextCursor: null,
      }).success,
    ).toBe(true);
  });
});

describe("DeletePathQuery + DeletePathInput", () => {
  test("query takes only the literal true/false", () => {
    expect(DeletePathQuery.parse({ recursive: "true" })).toEqual({ recursive: true });
    expect(DeletePathQuery.parse({ recursive: "false" })).toEqual({ recursive: false });
    expect(DeletePathQuery.parse({})).toEqual({});
    expect(DeletePathQuery.safeParse({ recursive: "1" }).success).toBe(false);
    expect(DeletePathQuery.safeParse({ junk: "x" }).success).toBe(false);
  });
  test("input requires vault + non-empty path and a boolean recursive", () => {
    expect(DeletePathInput.parse({ vault: "v", path: "a", recursive: true }).recursive).toBe(true);
    expect(DeletePathInput.parse({ vault: "v", path: "a" }).recursive).toBeUndefined();
    expect(DeletePathInput.safeParse({ vault: "v", path: "" }).success).toBe(false);
    expect(DeletePathInput.safeParse({ vault: "v", path: "a", recursive: "yes" }).success).toBe(
      false,
    );
  });
});

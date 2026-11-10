import { describe, expect, test } from "bun:test";
import {
  ListTagsInput,
  ListTagsQuery,
  ListTagsResponse,
  MAX_TAG_PREFIX_BYTES,
  TagCount,
} from "../../src/schemas/index.ts";

describe("ListTagsQuery", () => {
  test("applies the default limit", () => {
    expect(ListTagsQuery.parse({})).toEqual({ limit: 100 });
  });
  test("coerces a numeric-string limit and keeps prefix", () => {
    expect(ListTagsQuery.parse({ limit: "5", prefix: "work/" })).toEqual({
      limit: 5,
      prefix: "work/",
    });
  });
  test("accepts the limit bounds", () => {
    expect(ListTagsQuery.parse({ limit: "1" }).limit).toBe(1);
    expect(ListTagsQuery.parse({ limit: "007" }).limit).toBe(7);
    expect(ListTagsQuery.parse({ limit: "1000" }).limit).toBe(1000);
  });
  test("rejects an out-of-range or non-integer limit", () => {
    for (const limit of ["0", "1001", "1.5", "abc", "-1", "", " 5", "0x10", "1e2", "+5"]) {
      expect(ListTagsQuery.safeParse({ limit }).success).toBe(false);
    }
  });
  test("accepts an empty prefix", () => {
    expect(ListTagsQuery.parse({ prefix: "" }).prefix).toBe("");
  });
  test("bounds prefix in UTF-8 bytes, not characters", () => {
    expect(ListTagsQuery.safeParse({ prefix: "a".repeat(MAX_TAG_PREFIX_BYTES) }).success).toBe(
      true,
    );
    expect(ListTagsQuery.safeParse({ prefix: "a".repeat(MAX_TAG_PREFIX_BYTES + 1) }).success).toBe(
      false,
    );
    // 400 three-byte characters: 400 UTF-16 units but 1200 bytes.
    expect(ListTagsQuery.safeParse({ prefix: "€".repeat(400) }).success).toBe(false);
  });
  test("rejects unknown keys via strict()", () => {
    expect(ListTagsQuery.safeParse({ cursor: "x" }).success).toBe(false);
  });
});

describe("ListTagsInput", () => {
  test("requires vault; prefix and limit are optional with no default", () => {
    expect(ListTagsInput.parse({ vault: "v" })).toEqual({ vault: "v" });
    expect(ListTagsInput.safeParse({}).success).toBe(false);
    expect(ListTagsInput.safeParse({ vault: "" }).success).toBe(false);
  });
  test("takes JSON numbers, not strings, for limit", () => {
    expect(ListTagsInput.parse({ vault: "v", limit: 7 }).limit).toBe(7);
    expect(ListTagsInput.safeParse({ vault: "v", limit: "7" }).success).toBe(false);
    expect(ListTagsInput.safeParse({ vault: "v", limit: 0 }).success).toBe(false);
    expect(ListTagsInput.safeParse({ vault: "v", limit: 1001 }).success).toBe(false);
  });
  test("shares the prefix byte bound and rejects unknown keys", () => {
    expect(
      ListTagsInput.safeParse({ vault: "v", prefix: "a".repeat(MAX_TAG_PREFIX_BYTES + 1) }).success,
    ).toBe(false);
    expect(ListTagsInput.safeParse({ vault: "v", tag: "x" }).success).toBe(false);
  });
});

describe("ListTagsResponse", () => {
  test("validates a listing", () => {
    expect(() =>
      ListTagsResponse.parse({ items: [{ tag: "todo", count: 2 }], total: 3 }),
    ).not.toThrow();
    expect(() => ListTagsResponse.parse({ items: [], total: 0 })).not.toThrow();
  });
  test("a listed tag has a positive integer count", () => {
    expect(TagCount.safeParse({ tag: "t", count: 0 }).success).toBe(false);
    expect(ListTagsResponse.safeParse({ items: [], total: -1 }).success).toBe(false);
  });
});

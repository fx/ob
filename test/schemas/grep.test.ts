import { describe, expect, test } from "bun:test";
import {
  GrepBody,
  GrepInput,
  GrepMatch,
  GrepResponse,
  MAX_GREP_PATTERN_CHARS,
  MAX_GREP_PREFIX_BYTES,
} from "../../src/schemas/index.ts";

const ok = (v: unknown): boolean => GrepBody.safeParse(v).success;

describe("GrepBody", () => {
  test("accepts a bare pattern and every optional field", () => {
    expect(GrepBody.parse({ pattern: "x" })).toEqual({ pattern: "x" });
    const full = {
      pattern: "x",
      regex: true,
      ignoreCase: true,
      prefix: "notes/",
      limit: 1000,
      context: 5,
    };
    expect(GrepBody.parse(full)).toEqual(full);
    expect(GrepBody.parse({ pattern: "x", prefix: "" }).prefix).toBe("");
  });

  test("pattern is 1–1024 characters, counted in code points", () => {
    expect(ok({ pattern: "" })).toBe(false);
    expect(ok({ pattern: "a".repeat(MAX_GREP_PATTERN_CHARS) })).toBe(true);
    expect(ok({ pattern: "a".repeat(MAX_GREP_PATTERN_CHARS + 1) })).toBe(false);
    // 1024 astral characters: 2048 UTF-16 units, still 1024 characters.
    expect(ok({ pattern: "😀".repeat(MAX_GREP_PATTERN_CHARS) })).toBe(true);
    expect(ok({ pattern: "😀".repeat(MAX_GREP_PATTERN_CHARS + 1) })).toBe(false);
    expect(ok({ pattern: 5 })).toBe(false);
    expect(ok({})).toBe(false);
  });

  test("limit is an integer 1–1000; context an integer 0–5", () => {
    for (const limit of [1, 100, 1000]) expect(ok({ pattern: "x", limit })).toBe(true);
    for (const limit of [0, 1001, 1.5, "5", -1]) expect(ok({ pattern: "x", limit })).toBe(false);
    for (const context of [0, 5]) expect(ok({ pattern: "x", context })).toBe(true);
    for (const context of [-1, 6, 2.5, "1"]) expect(ok({ pattern: "x", context })).toBe(false);
  });

  test("regex and ignoreCase are JSON booleans", () => {
    expect(ok({ pattern: "x", regex: "true" })).toBe(false);
    expect(ok({ pattern: "x", ignoreCase: 1 })).toBe(false);
  });

  test("prefix is bounded in UTF-8 bytes", () => {
    expect(ok({ pattern: "x", prefix: "a".repeat(MAX_GREP_PREFIX_BYTES) })).toBe(true);
    expect(ok({ pattern: "x", prefix: "a".repeat(MAX_GREP_PREFIX_BYTES + 1) })).toBe(false);
    // 400 three-byte characters: 1200 bytes.
    expect(ok({ pattern: "x", prefix: "€".repeat(400) })).toBe(false);
  });

  test("unknown keys are rejected, vault included", () => {
    expect(ok({ pattern: "x", flags: "g" })).toBe(false);
    expect(ok({ pattern: "x", vault: "v" })).toBe(false);
  });
});

describe("GrepInput", () => {
  test("is GrepBody plus a required vault", () => {
    expect(GrepInput.parse({ vault: "v", pattern: "x", context: 1 })).toEqual({
      vault: "v",
      pattern: "x",
      context: 1,
    });
    expect(GrepInput.safeParse({ pattern: "x" }).success).toBe(false);
    expect(GrepInput.safeParse({ vault: "", pattern: "x" }).success).toBe(false);
    expect(GrepInput.safeParse({ vault: "v", pattern: "x", extra: 1 }).success).toBe(false);
  });
});

describe("GrepResponse", () => {
  test("accepts a response with and without context arrays", () => {
    const m = { path: "a.md", line: 1, column: 1, text: "x", textStart: 1 };
    expect(GrepMatch.parse(m)).toEqual(m);
    const r = {
      matches: [m, { ...m, before: [], after: ["y"] }],
      truncated: true,
      reason: "limit",
      filesScanned: 1,
      filesSkipped: 0,
    };
    expect(GrepResponse.parse(r)).toEqual(r);
    expect(GrepResponse.safeParse({ ...r, reason: null, truncated: false }).success).toBe(true);
    expect(GrepResponse.safeParse({ ...r, reason: "other" }).success).toBe(false);
    expect(GrepMatch.safeParse({ ...m, line: 0 }).success).toBe(false);
  });
});

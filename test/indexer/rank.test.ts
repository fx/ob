import { describe, expect, test } from "bun:test";
import {
  DEFAULT_LAMBDA,
  DEFAULT_MAX_PER_PATH,
  DEFAULT_THRESHOLD,
  applyMmr,
  applyThreshold,
} from "../../src/indexer/rank.ts";
import type { SearchHit } from "../../src/indexer/store.ts";

function hit(path: string, score: number, chunkIndex = 0): SearchHit {
  return {
    path,
    chunkIndex,
    headingPath: [],
    text: `${path}#${chunkIndex}`,
    score,
    frontmatter: {},
    links: [],
    tags: [],
  };
}

describe("rank: defaults", () => {
  test("module-level defaults match the change spec", () => {
    expect(DEFAULT_LAMBDA).toBe(0.5);
    expect(DEFAULT_MAX_PER_PATH).toBe(3);
    expect(DEFAULT_THRESHOLD).toBe(0);
  });
});

describe("applyMmr — K cap", () => {
  test("only the first topK candidates are considered (deeper ones never appear)", () => {
    const cands = [
      hit("a.md", 0.9),
      hit("b.md", 0.8),
      hit("c.md", 0.7),
      // This is past topK and must NOT be selected.
      hit("d.md", 0.6),
    ];
    const out = applyMmr(cands, { lambda: 0.5, maxPerPath: 3, topK: 3 });
    expect(out.map((h) => h.path)).toEqual(["a.md", "b.md", "c.md"]);
  });
});

describe("applyMmr — λ extremes", () => {
  test("λ = 1 collapses to pure relevance order (diversity term zero)", () => {
    // Even with two same-path chunks bunched at the top, λ=1 keeps them
    // adjacent — there's no diversity penalty to pull them apart.
    const cands = [hit("a.md", 0.9, 0), hit("a.md", 0.85, 1), hit("b.md", 0.8), hit("c.md", 0.7)];
    const out = applyMmr(cands, { lambda: 1, maxPerPath: 5, topK: 60 });
    expect(out.map((h) => `${h.path}#${h.chunkIndex}`)).toEqual([
      "a.md#0",
      "a.md#1",
      "b.md#0",
      "c.md#0",
    ]);
  });

  test("λ = 0 ignores relevance and only spreads across paths", () => {
    // With λ=0, the first selection breaks ties by input order (no
    // already-selected to penalise), then every subsequent candidate
    // sharing a path of an already-selected hit gets penalty -1 while
    // a fresh-path candidate gets penalty 0.
    const cands = [hit("a.md", 0.99, 0), hit("a.md", 0.98, 1), hit("b.md", 0.5), hit("c.md", 0.1)];
    const out = applyMmr(cands, { lambda: 0, maxPerPath: 5, topK: 60 });
    // First pick: a.md (input order under tied 0). Next picks must
    // prefer fresh paths over a.md#1.
    expect(out[0]?.path).toBe("a.md");
    expect(out[1]?.path).toBe("b.md");
    expect(out[2]?.path).toBe("c.md");
    // a.md#1 is appended last (no fresh path remains).
    expect(out[3]?.chunkIndex).toBe(1);
  });
});

describe("applyMmr — maxPerPath cap", () => {
  test("at maxPerPath=3, a path that would dominate the top-10 yields exactly 3 hits from that path", () => {
    // 8 chunks of dominant.md + 2 of other paths.
    const cands: SearchHit[] = [];
    for (let i = 0; i < 8; i++) cands.push(hit("dominant.md", 1 - i * 0.01, i));
    cands.push(hit("alt.md", 0.5, 0));
    cands.push(hit("alt2.md", 0.4, 0));
    const out = applyMmr(cands, { lambda: 0.5, maxPerPath: 3, topK: 60 });
    const dominantCount = out.filter((h) => h.path === "dominant.md").length;
    expect(dominantCount).toBe(3);
    // The other paths fill remaining slots from the candidate pool.
    expect(out.some((h) => h.path === "alt.md")).toBe(true);
    expect(out.some((h) => h.path === "alt2.md")).toBe(true);
  });

  test("maxPerPath=1 forces strict path-uniqueness", () => {
    const cands = [
      hit("a.md", 0.9, 0),
      hit("a.md", 0.85, 1),
      hit("b.md", 0.8),
      hit("a.md", 0.7, 2),
    ];
    const out = applyMmr(cands, { lambda: 0.5, maxPerPath: 1, topK: 60 });
    const paths = out.map((h) => h.path);
    expect(paths).toEqual(["a.md", "b.md"]);
  });
});

describe("applyThreshold", () => {
  test("threshold = 0 is a no-op (returns a copy of the list)", () => {
    const cands = [hit("a.md", 0.42), hit("b.md", 0.05)];
    const out = applyThreshold(cands, 0);
    expect(out).toEqual(cands);
    // Returned array is a defensive copy, not the same reference.
    expect(out).not.toBe(cands as unknown as SearchHit[]);
  });

  test("threshold > 0 drops hits whose score is below the floor", () => {
    const cands = [hit("a.md", 0.42), hit("b.md", 0.4), hit("c.md", 0.38)];
    const out = applyThreshold(cands, 0.4);
    expect(out.map((h) => h.path)).toEqual(["a.md", "b.md"]);
  });

  test("threshold above every score yields [] (NOT an error)", () => {
    const cands = [hit("a.md", 0.4), hit("b.md", 0.3)];
    expect(applyThreshold(cands, 0.5)).toEqual([]);
  });

  test("empty input is the empty array", () => {
    expect(applyThreshold([], 0.5)).toEqual([]);
    expect(applyThreshold([], 0)).toEqual([]);
  });
});

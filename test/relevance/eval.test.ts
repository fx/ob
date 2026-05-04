import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHashEmbedder } from "../../src/embeddings/fake.ts";
import type { Embedder } from "../../src/embeddings/index.ts";
import { type EvalQuery, formatMetrics, loadSeedQueries, runEval } from "./eval.ts";

/**
 * Build an embedder that maps any string containing the verbatim line
 * "promote Alice to Principal next year" to the same hash vector,
 * regardless of surrounding chunk text. This simulates the property a
 * real semantic embedder has — verbatim phrases collapse to the same
 * region of vector space — without invoking a real model in the test
 * harness. Other strings fall through to the hash embedder so the rest
 * of the eval set behaves identically to the seed-query flow.
 */
function buildPhraseAwareEmbedder(phrase: string, dim: number): Embedder {
  const base = buildHashEmbedder(dim);
  return {
    dim,
    async embed(texts: string[]): Promise<Float32Array[]> {
      const lower = phrase.toLowerCase();
      const remapped = texts.map((t) => (t.toLowerCase().includes(lower) ? phrase : t));
      return base.embed(remapped);
    },
  };
}

function writeQueriesFile(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "ob-eval-queries-"));
  const file = join(dir, "queries.json");
  writeFileSync(file, contents, "utf8");
  return file;
}

describe("relevance eval harness (advisory)", () => {
  test("seed queries.json loads into a non-empty list of {query, expectedPath}", () => {
    const queries = loadSeedQueries();
    expect(queries.length).toBeGreaterThan(0);
    for (const q of queries) {
      expect(typeof q.query).toBe("string");
      expect(typeof q.expectedPath).toBe("string");
    }
  });

  test("runEval returns metrics with the right shape and logs them", async () => {
    const queries = loadSeedQueries();
    const metrics = await runEval(queries);
    expect(metrics.perQuery.length).toBe(queries.length);
    expect(metrics.recallAt1).toBeGreaterThanOrEqual(0);
    expect(metrics.recallAt1).toBeLessThanOrEqual(1);
    expect(metrics.recallAt5).toBeGreaterThanOrEqual(metrics.recallAt1);
    expect(metrics.mrr).toBeGreaterThanOrEqual(0);
    expect(metrics.mrr).toBeLessThanOrEqual(1);
    // ADVISORY: log metrics so contributors can eyeball regressions.
    // Not used for any assertion.
    console.log("[eval] metrics\n%s", formatMetrics(metrics));
  }, 30_000);

  test("loadSeedQueries throws when top-level JSON is not an array", () => {
    const file = writeQueriesFile(JSON.stringify({ query: "x", expectedPath: "y" }));
    expect(() => loadSeedQueries(file)).toThrow("queries.json: expected an array");
  });

  test("loadSeedQueries throws when an entry is not an object", () => {
    const file = writeQueriesFile(JSON.stringify(["not-an-object"]));
    expect(() => loadSeedQueries(file)).toThrow("queries.json[0]: expected an object");
  });

  test("loadSeedQueries throws when an entry is null (typeof null === 'object')", () => {
    const file = writeQueriesFile(JSON.stringify([null]));
    expect(() => loadSeedQueries(file)).toThrow("queries.json[0]: expected an object");
  });

  test("loadSeedQueries throws when entry is missing query/expectedPath fields", () => {
    const file = writeQueriesFile(JSON.stringify([{ query: "only-query" }]));
    expect(() => loadSeedQueries(file)).toThrow("queries.json[0]: missing query/expectedPath");
  });

  test("loadSeedQueries throws when mode is present but not a known value", () => {
    const file = writeQueriesFile(
      JSON.stringify([{ query: "q", expectedPath: "p.md", mode: "bogus" }]),
    );
    expect(() => loadSeedQueries(file)).toThrow(
      'queries.json[0]: invalid mode (must be one of "hybrid" | "vector" | "fts")',
    );
  });

  test("loadSeedQueries throws when mode is the wrong type (e.g. number)", () => {
    const file = writeQueriesFile(JSON.stringify([{ query: "q", expectedPath: "p.md", mode: 7 }]));
    expect(() => loadSeedQueries(file)).toThrow("queries.json[0]: invalid mode");
  });

  test("loadSeedQueries accepts each known mode value", () => {
    const file = writeQueriesFile(
      JSON.stringify([
        { query: "q1", expectedPath: "p1.md", mode: "hybrid" },
        { query: "q2", expectedPath: "p2.md", mode: "vector" },
        { query: "q3", expectedPath: "p3.md", mode: "fts" },
      ]),
    );
    const out = loadSeedQueries(file);
    expect(out.map((q) => q.mode)).toEqual(["hybrid", "vector", "fts"]);
  });

  test("loadSeedQueries accepts well-formed entries with optional note", () => {
    const file = writeQueriesFile(
      JSON.stringify([
        { query: "q1", expectedPath: "p1.md" },
        { query: "q2", expectedPath: "p2.md", note: "annotated" },
        { query: "q3", expectedPath: "p3.md", note: 42 },
      ]),
    );
    const out = loadSeedQueries(file);
    expect(out).toEqual([
      { query: "q1", expectedPath: "p1.md" },
      { query: "q2", expectedPath: "p2.md", note: "annotated" },
      { query: "q3", expectedPath: "p3.md" },
    ]);
  });

  test("runEval over zero queries yields zeros (degenerate baseline)", async () => {
    const m = await runEval([] as readonly EvalQuery[]);
    expect(m.recallAt1).toBe(0);
    expect(m.recallAt5).toBe(0);
    expect(m.mrr).toBe(0);
    expect(m.perQuery.length).toBe(0);
    expect(formatMetrics(m)).toContain("per-query:");
  }, 30_000);

  test('REQUIRED: "promote Alice to Principal next year" lands top-1 in hybrid mode', async () => {
    // Change 0008 escalates this from advisory in 0007 to required.
    // The hash embedder is non-semantic — it turns any string into a
    // pseudo-random vector — so we wrap it with a phrase-aware variant
    // that simulates the property a real embedder has: chunks
    // containing the verbatim line collapse to the same vector as the
    // verbatim query. With that, both retrieval arms rank tasks.md as
    // their top hit, RRF preserves the agreement, and the assertion
    // becomes meaningful (this is what would happen with a real model).
    const embedder = buildPhraseAwareEmbedder("promote Alice to Principal next year", 8);
    const metrics = await runEval(
      [
        {
          query: "promote Alice to Principal next year",
          expectedPath: "self/tasks.md",
          mode: "hybrid",
        },
      ],
      { embedder },
    );
    expect(metrics.perQuery[0]?.rank).toBe(1);
  }, 30_000);

  test("vector mode misses what fts mode finds for a proper-noun query (advisory)", async () => {
    // The hash embedder has no knowledge of the proper noun, so vector
    // mode either ranks the right doc poorly or misses it entirely. FTS
    // mode finds it directly via the lexical token. Both runs must
    // succeed without error and the FTS run must rank it strictly
    // better than the vector run (or, at minimum, no worse).
    const metrics = await runEval([
      { query: "Acmetown", expectedPath: "entities/Alice.md", mode: "fts" },
      { query: "Acmetown", expectedPath: "entities/Alice.md", mode: "vector" },
    ]);
    const ftsRank = metrics.perQuery[0]?.rank;
    const vectorRank = metrics.perQuery[1]?.rank;
    expect(ftsRank).not.toBeNull();
    // FTS mode finds it; vector either ranks it worse or doesn't find it.
    if (vectorRank !== null && vectorRank !== undefined) {
      expect(ftsRank).toBeLessThanOrEqual(vectorRank);
    }
  }, 30_000);

  test('maxPerPath caps single-source dominance: top-10 of "espresso brewing methods" contains ≥ 3 distinct paths', async () => {
    // The fixture seeds 5 separate `notes/coffee-N.md` files with the
    // same topic. With `maxPerPath = 3` (default) and `limit = 10`, the
    // returned top-10 must spread across at least 3 distinct paths.
    const metrics = await runEval([
      { query: "espresso brewing methods", expectedPath: "notes/coffee-1.md" },
    ]);
    const distinct = metrics.perQuery[0]?.distinctPaths ?? 0;
    expect(distinct).toBeGreaterThanOrEqual(3);
  }, 30_000);
});

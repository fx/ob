/**
 * Relevance eval harness — change 0007.
 *
 * Runs a fixed set of (query, expected-top-1-path) pairs against a tiny
 * fixture vault and reports recall@1, recall@5, and MRR. Failures are
 * ADVISORY in CI for v1: the eval logs metrics and writes them to a JSON
 * file that the smoke test asserts, but a regression in any single query
 * MUST NOT fail the build. Iteration on the seed set itself would otherwise
 * churn merge gates.
 *
 * To grow the seed set, edit `queries.json` next to this file. The harness
 * doesn't need to change.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config/index.ts";
import { buildHashEmbedder } from "../../src/embeddings/fake.ts";
import type { Embedder } from "../../src/embeddings/index.ts";
import { startIndexer } from "../../src/indexer/index.ts";
import { type Logger, createLogger } from "../../src/log.ts";

export interface EvalQuery {
  readonly query: string;
  readonly expectedPath: string;
  readonly note?: string;
  /** Override the search mode for this query. Defaults to `"hybrid"`. */
  readonly mode?: "hybrid" | "vector" | "fts";
}

export interface EvalResult {
  readonly query: string;
  readonly expectedPath: string;
  readonly rank: number | null;
  readonly distinctPaths: number;
}

export interface EvalMetrics {
  readonly recallAt1: number;
  readonly recallAt5: number;
  readonly mrr: number;
  readonly perQuery: readonly EvalResult[];
}

/**
 * Tiny fixture vault that mirrors the four motivating cases from the change
 * doc. Files are intentionally short so the harness runs in <1s under
 * `bun test`. The hash embedder produces stable rankings — exact rank
 * positions are NOT asserted; only the metrics shape is.
 */
const FIXTURE_FILES: readonly { readonly path: string; readonly content: string }[] = [
  {
    path: "self/tasks.md",
    content: [
      "## Work",
      "",
      "- promote Alice to Principal next year",
      "- ask Alice to organize team outing for core week",
      "- review BFF architecture proposal",
      "- update onboarding docs",
      "- triage flaky tests in CI",
    ].join("\n"),
  },
  {
    path: "entities/Alice Example.md",
    content: [
      "# Alice Example",
      "",
      "## Reviews",
      "",
      "Strong cross-team adoption of the BFF architecture across multiple squads.",
    ].join("\n"),
  },
  {
    path: "self/habits.md",
    content: [
      "# Habits",
      "",
      "## Daily routine",
      "",
      "Morning routine: meditate, journal, then deep work block before standup.",
    ].join("\n"),
  },
  {
    path: "guides/long-form.md",
    content: [
      "# Guide",
      "",
      "## Section A",
      "",
      "### Subsection",
      "",
      "#### Deeply nested heading prose lives here for the splitter sanity test.",
      "",
      "Body text under a deeply nested heading.",
    ].join("\n"),
  },
  // The following files seed the change-0008 assertions:
  // - `entities/Alice.md` contains the proper noun "Acmetown" used to
  //   exercise the `vector` vs `fts` mode contrast (the fake hash embedder
  //   has no notion of word similarity, so a rare proper noun is the
  //   easiest way to prove FTS finds something vector cannot).
  // - `notes/coffee-1.md` … `notes/coffee-5.md` are five chunks of the same
  //   topic in DIFFERENT files so the maxPerPath assertion can verify the
  //   top-10 contains ≥ N distinct paths.
  {
    path: "entities/Alice.md",
    content: [
      "# Alice",
      "",
      "## Background",
      "",
      "Studied at Acmetown College before joining the team.",
    ].join("\n"),
  },
  {
    path: "notes/coffee-1.md",
    content: ["# Coffee 1", "", "Espresso brewing methods notes 1."].join("\n"),
  },
  {
    path: "notes/coffee-2.md",
    content: ["# Coffee 2", "", "Espresso brewing methods notes 2."].join("\n"),
  },
  {
    path: "notes/coffee-3.md",
    content: ["# Coffee 3", "", "Espresso brewing methods notes 3."].join("\n"),
  },
  {
    path: "notes/coffee-4.md",
    content: ["# Coffee 4", "", "Espresso brewing methods notes 4."].join("\n"),
  },
  {
    path: "notes/coffee-5.md",
    content: ["# Coffee 5", "", "Espresso brewing methods notes 5."].join("\n"),
  },
];

function silent(): Logger {
  return createLogger({ level: "error", write: () => undefined });
}

function makeConfig(dataDir: string): Config {
  return {
    obsidianAuthToken: undefined,
    vaults: [{ name: "v", slug: "v" }],
    dataDir,
    httpPort: 0,
    httpHost: "127.0.0.1",
    embeddingProvider: "transformers",
    embeddingModel: "x",
    logLevel: "error",
  };
}

async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise<void>((r) => setTimeout(r, 25));
  }
}

/**
 * Run the eval harness end-to-end. Caller is responsible for stopping the
 * returned indexer (handled internally — the harness is self-contained).
 */
export async function runEval(
  queries: readonly EvalQuery[],
  opts: { embedder?: Embedder } = {},
): Promise<EvalMetrics> {
  const dataDir = mkdtempSync(join(tmpdir(), "ob-eval-"));
  const root = join(dataDir, "vaults", "v");
  mkdirSync(root, { recursive: true });
  for (const f of FIXTURE_FILES) {
    const abs = join(root, f.path);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, f.content, "utf8");
  }
  const indexer = await startIndexer(makeConfig(dataDir), {
    logger: silent(),
    embedder: opts.embedder ?? buildHashEmbedder(8),
  });
  try {
    await waitFor(() => indexer.status("v")?.state === "ready");

    const results: EvalResult[] = [];
    for (const q of queries) {
      const opts: { limit: number; mode?: "hybrid" | "vector" | "fts" } = { limit: 10 };
      if (q.mode !== undefined) opts.mode = q.mode;
      const hits = await indexer.search("v", q.query, opts);
      let rank: number | null = null;
      for (let i = 0; i < hits.length; i++) {
        if (hits[i]?.path === q.expectedPath) {
          rank = i + 1;
          break;
        }
      }
      const seenPaths = new Set<string>();
      for (const h of hits) seenPaths.add(h.path);
      results.push({
        query: q.query,
        expectedPath: q.expectedPath,
        rank,
        distinctPaths: seenPaths.size,
      });
    }

    const recallAt = (k: number): number => {
      let hits = 0;
      for (const r of results) if (r.rank !== null && r.rank <= k) hits++;
      return results.length === 0 ? 0 : hits / results.length;
    };
    let rrSum = 0;
    for (const r of results) if (r.rank !== null) rrSum += 1 / r.rank;
    const mrr = results.length === 0 ? 0 : rrSum / results.length;

    return {
      recallAt1: recallAt(1),
      recallAt5: recallAt(5),
      mrr,
      perQuery: results,
    };
  } finally {
    await indexer.stop();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

/**
 * Load the seed queries from `queries.json` (or another file).
 *
 * `path` is overridable so tests can exercise malformed-input branches with
 * a tmpdir fixture without churning the real seed set. Default behavior is
 * unchanged: callers without an argument still read `queries.json` next to
 * this file.
 */
export function loadSeedQueries(path?: string): EvalQuery[] {
  const file = path ?? join(import.meta.dir, "queries.json");
  const raw = readFileSync(file, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("queries.json: expected an array");
  }
  return parsed.map((entry, i) => {
    if (entry === null || typeof entry !== "object") {
      throw new Error(`queries.json[${i}]: expected an object`);
    }
    const obj = entry as Record<string, unknown>;
    if (typeof obj.query !== "string" || typeof obj.expectedPath !== "string") {
      throw new Error(`queries.json[${i}]: missing query/expectedPath`);
    }
    let out: EvalQuery = { query: obj.query, expectedPath: obj.expectedPath };
    if (typeof obj.note === "string") out = { ...out, note: obj.note };
    if (obj.mode !== undefined) {
      // Fail fast on an unrecognised `mode` rather than silently
      // dropping it: a typo'd seed entry must surface as a loud error,
      // not as a "ran in the wrong mode" mystery in the metrics output.
      if (obj.mode !== "hybrid" && obj.mode !== "vector" && obj.mode !== "fts") {
        throw new Error(
          `queries.json[${i}]: invalid mode (must be one of "hybrid" | "vector" | "fts")`,
        );
      }
      out = { ...out, mode: obj.mode };
    }
    return out;
  });
}

/** Format `EvalMetrics` for console output. */
export function formatMetrics(m: EvalMetrics): string {
  const lines = [
    `recall@1: ${m.recallAt1.toFixed(3)}`,
    `recall@5: ${m.recallAt5.toFixed(3)}`,
    `mrr:      ${m.mrr.toFixed(3)}`,
    "per-query:",
  ];
  for (const r of m.perQuery) {
    const pos = r.rank === null ? "miss" : `#${r.rank}`;
    lines.push(`  [${pos}] "${r.query}" → ${r.expectedPath}`);
  }
  return lines.join("\n");
}

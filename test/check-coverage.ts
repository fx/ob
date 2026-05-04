/**
 * Strict coverage gate, run after `bun test --coverage`.
 *
 * Bun's `coverageThreshold` already fails the test run when line or function
 * coverage drops below 100%, but it operates on the aggregate across `src/`.
 * This script adds a per-file assertion: every file under `src/` MUST have
 * 100% line AND 100% function coverage AND (when Bun emits them) 100% branch
 * coverage.
 *
 * Bun ≤ 1.3 does NOT emit `BRDA` / `BRF` / `BRH` records in its lcov output,
 * so true branch coverage cannot be measured by the runtime today. We use
 * function coverage as the closest available proxy — every function body is
 * one branch boundary, and the codebase is structured so distinct branches
 * land in distinct callable shapes (e.g. error paths returned via early
 * `return undefined`, exit handlers extracted as named consts). When a
 * future Bun release surfaces `BRDA` records, this script will start
 * enforcing them automatically without any code change.
 *
 * Lives under `test/` rather than a new top-level `scripts/` directory
 * because the architecture spec forbids new top-level dirs without a
 * change document amending it. The non-`.test.ts` filename keeps `bun test`
 * from picking it up as a test file.
 *
 * Usage: `bun test/check-coverage.ts [path/to/lcov.info]`
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

interface FileStats {
  readonly file: string;
  readonly linesFound: number;
  readonly linesHit: number;
  readonly fnFound: number;
  readonly fnHit: number;
  readonly brFound: number;
  readonly brHit: number;
  readonly uncoveredLines: readonly number[];
}

function parseLcov(text: string): FileStats[] {
  const stats: FileStats[] = [];
  let cur: {
    file: string;
    lf: number;
    lh: number;
    fnf: number;
    fnh: number;
    brf: number;
    brh: number;
    uncovered: number[];
  } | null = null;

  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      cur = {
        file: line.slice(3),
        lf: 0,
        lh: 0,
        fnf: 0,
        fnh: 0,
        brf: 0,
        brh: 0,
        uncovered: [],
      };
    } else if (cur === null) {
      // Skip preamble lines before any SF: section.
    } else if (line.startsWith("DA:")) {
      const [lnRaw, hitsRaw] = line.slice(3).split(",");
      const ln = Number(lnRaw);
      const hits = Number(hitsRaw);
      if (Number.isFinite(ln) && Number.isFinite(hits) && hits === 0) {
        cur.uncovered.push(ln);
      }
    } else if (line.startsWith("LF:")) {
      cur.lf = Number(line.slice(3));
    } else if (line.startsWith("LH:")) {
      cur.lh = Number(line.slice(3));
    } else if (line.startsWith("FNF:")) {
      cur.fnf = Number(line.slice(4));
    } else if (line.startsWith("FNH:")) {
      cur.fnh = Number(line.slice(4));
    } else if (line.startsWith("BRF:")) {
      cur.brf = Number(line.slice(4));
    } else if (line.startsWith("BRH:")) {
      cur.brh = Number(line.slice(4));
    } else if (line === "end_of_record") {
      stats.push({
        file: cur.file,
        linesFound: cur.lf,
        linesHit: cur.lh,
        fnFound: cur.fnf,
        fnHit: cur.fnh,
        brFound: cur.brf,
        brHit: cur.brh,
        uncoveredLines: cur.uncovered,
      });
      cur = null;
    }
  }
  return stats;
}

function fail(msg: string): never {
  console.error(`[check-coverage] ${msg}`);
  process.exit(1);
}

const lcovPath = resolve(process.argv[2] ?? "coverage/lcov.info");
if (!existsSync(lcovPath)) {
  fail(`lcov report not found at ${lcovPath}; run \`bun test --coverage\` first`);
}

const stats = parseLcov(readFileSync(lcovPath, "utf8"));
const srcStats = stats.filter((s) => s.file.startsWith("src/"));
if (srcStats.length === 0) {
  fail("no src/ files found in lcov report — coverage data missing");
}

const failures: string[] = [];
for (const s of srcStats) {
  if (s.linesFound === 0) {
    failures.push(`${s.file}: no executable lines reported (file empty or not loaded by tests)`);
    continue;
  }
  if (s.linesHit !== s.linesFound) {
    failures.push(
      `${s.file}: line coverage ${s.linesHit}/${s.linesFound} (uncovered: ${s.uncoveredLines.join(", ")})`,
    );
  }
  if (s.fnFound > 0 && s.fnHit !== s.fnFound) {
    failures.push(`${s.file}: function coverage ${s.fnHit}/${s.fnFound}`);
  }
  if (s.brFound > 0 && s.brHit !== s.brFound) {
    failures.push(`${s.file}: branch coverage ${s.brHit}/${s.brFound}`);
  }
}

if (failures.length > 0) {
  for (const f of failures) console.error(`[check-coverage] ${f}`);
  process.exit(1);
}

console.log(`[check-coverage] ${srcStats.length} src/ files at 100% line + function coverage`);

/**
 * LanceDB-backed per-vault store.
 *
 * One database under `<DATA_DIR>/lancedb/`, one table per vault slug. The
 * schema is fixed up front: switching providers (and therefore vector
 * dimension) requires recreating the table — `openVaultStore` enforces this
 * via the dimension-mismatch check on open and the indexer surfaces the
 * resulting `StoreDimensionMismatchError`.
 *
 * Updates to a path go through `upsert(path, chunks)` which uses LanceDB's
 * `mergeInsert(["id"])` API: in a single committed transaction it updates
 * matching ids, inserts new ones, and deletes any old chunks for the path
 * that are no longer in the new set. Search readers therefore never see a
 * partial chunk set — the previous fragment-by-delete / insert sequence
 * exposed a window where a path could disappear if a search ran between
 * the two commits.
 *
 * A vector index is auto-built once the table first reaches ≥ 256 rows.
 * The build runs inline within the upsert that crosses the threshold and
 * its failures propagate to the pipeline's existing retry loop.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import { Field, FixedSizeList, Float32, Int32, Int64, List, Schema, Utf8 } from "apache-arrow";
import type { Logger } from "../log.ts";
import type { Chunk } from "./chunker.ts";

export const VECTOR_INDEX_THRESHOLD = 256;
/**
 * FTS index auto-build threshold. Mirrors `VECTOR_INDEX_THRESHOLD` so the
 * vector and lexical arms become available at the same vault size. Below
 * the threshold both arms still work (LanceDB can do un-indexed FTS too,
 * with a linear scan), but the indexed path is what the latency budget
 * assumes for non-toy vaults.
 */
export const FTS_INDEX_THRESHOLD = 256;

/**
 * Pipeline corpus version — incremented whenever a chunker or `embed_text`
 * composition change invalidates previously-indexed rows. The implicit
 * pre-0007 version was 1; 0007 (flat-list chunker + `embed_text` column)
 * sets this to 2.
 *
 * Sidecar lives at `<DATA_DIR>/lancedb/.pipeline_version` so it travels with
 * the data dir. Mismatch handling on startup:
 *
 *   missing or `< PIPELINE_VERSION` → drop every per-vault table, bump.
 *   `> PIPELINE_VERSION`            → exit non-zero (older binary, newer dir).
 *   equal                           → no-op.
 */
export const PIPELINE_VERSION = 2;

export interface StoreRow {
  readonly path: string;
  readonly chunkIndex: number;
  readonly headingPath: readonly string[];
  readonly text: string;
  /**
   * Concatenated `<path>\n<headingPath>\n\n<text>` payload that was sent to
   * the embedder. Persisted as a column so 0008's FTS index can be built on
   * the same tokens the embedder saw, without re-deriving from `path` +
   * `heading_path` + `text`.
   */
  readonly embedText: string;
  readonly frontmatter: Record<string, unknown>;
  readonly links: readonly string[];
  readonly tags: readonly string[];
  readonly mtimeMs: number;
  readonly sha256: string;
  readonly vector: Float32Array;
}

export interface SearchHit {
  readonly path: string;
  readonly chunkIndex: number;
  readonly headingPath: string[];
  readonly text: string;
  readonly score: number;
  readonly frontmatter: Record<string, unknown>;
  readonly links: string[];
  readonly tags: string[];
}

export interface SearchOpts {
  readonly limit?: number;
  readonly filter?: {
    readonly pathPrefix?: string;
    readonly tag?: string;
  };
}

/**
 * Hooks for tests that want to count or stub specific LanceDB calls
 * (e.g. assert that `mode: "vector"` issues zero FTS queries).
 *
 * `onVectorSearch` / `onFtsSearch` are invoked exactly once per arm of a
 * `searchHybrid` call before the LanceDB query starts. They're optional
 * and have no production caller — the indexer doesn't pass them in.
 */
export interface SearchHybridHooks {
  readonly onVectorSearch?: () => void;
  readonly onFtsSearch?: () => void;
}

/** Modes for `searchHybrid`. */
export type SearchMode = "hybrid" | "vector" | "fts";

export interface SearchHybridOpts {
  readonly limit?: number;
  readonly mode?: SearchMode;
  readonly filter?: {
    readonly pathPrefix?: string;
    readonly tag?: string;
  };
  /** RRF k constant. Defaults to 60 (literature value). */
  readonly rrfK?: number;
  /**
   * Minimum candidate count to fetch per arm. Defaults to
   * `max(60, 3 × limit)` per the change spec.
   */
  readonly perArmCandidates?: number;
  /** Test-only hooks; production code never sets these. */
  readonly hooks?: SearchHybridHooks;
}

export interface PathFingerprint {
  readonly mtimeMs: number;
  readonly sha256: string;
}

export interface VaultStore {
  /** Vector dimension used by the underlying table. */
  readonly dim: number;
  /** Atomically replace every chunk for `path` with the provided new set. */
  upsert(path: string, rows: readonly StoreRow[]): Promise<void>;
  /** Remove all chunks for `path`. No-op if no such rows exist. */
  drop(path: string): Promise<void>;
  /**
   * Vector-search by an already-embedded query vector. Filtering by
   * `pathPrefix` (literal prefix; SQL `LIKE` wildcards in the input are
   * treated as ordinary characters) and `tag` (array contains) is pushed
   * down to LanceDB; result ordering is descending by similarity.
   */
  search(queryVector: Float32Array, opts?: SearchOpts): Promise<SearchHit[]>;
  /**
   * Hybrid (vector + FTS) search. Issues both arms in parallel, fuses
   * via Reciprocal Rank Fusion (`k = 60` by default). `mode: "vector"`
   * runs only the vector arm; `mode: "fts"` only the FTS arm.
   *
   * Score semantics (the `threshold` knob depends on these being absolute,
   * NOT query-relative — a weak top hit must still be filterable):
   *
   *   `vector` — derived from LanceDB's `_distance` via the same
   *     `1 / (1 + distance)` mapping the plain `search()` method uses,
   *     so vector mode here is score-comparable to vector mode there.
   *     Bounded in `(0, 1]`.
   *   `fts`    — passes LanceDB's FTS `_score` through a saturating
   *     `s / (1 + s)` map, bounded in `(0, 1)`. We do NOT normalize by
   *     the max of the current result set: that would force the top hit
   *     of every non-empty query to `1` and make `threshold` meaningless
   *     on weak queries.
   *   `hybrid` — fused RRF score scaled by a fixed bound (`2 / k`, the
   *     theoretical maximum for two arms agreeing at rank 1). Output is
   *     bounded in `(0, 1]`. As with the single-arm modes, no
   *     normalization by query-local max — the threshold semantics are
   *     absolute.
   */
  searchHybrid(
    queryVector: Float32Array,
    queryText: string,
    opts?: SearchHybridOpts,
  ): Promise<SearchHit[]>;
  /** Document count grouped by distinct path. */
  documentCount(): Promise<number>;
  /** Total chunks (rows) in the table. */
  chunkCount(): Promise<number>;
  /**
   * Return the most-recently stored mtime + sha256 fingerprint for `path`,
   * if any. The scanner's restart short-circuit uses `mtime_ms` as a cheap
   * gate before reading + hashing the file.
   */
  fingerprint(path: string): Promise<PathFingerprint | undefined>;
  /**
   * Return all per-path fingerprints in the table. Used at indexer startup
   * to populate `IndexerStatus.documents` / `chunks` from the persisted
   * rows so a fully-indexed vault doesn't report empty after restart.
   */
  fingerprints(): Promise<Map<string, PathFingerprint>>;
  close(): void;
}

export class StoreDimensionMismatchError extends Error {
  readonly tableDim: number;
  readonly providerDim: number;
  constructor(tableDim: number, providerDim: number) {
    super(
      `embedding dimension mismatch: table=${tableDim} provider=${providerDim}; recreate the table or switch back to a ${tableDim}-dim provider`,
    );
    this.name = "StoreDimensionMismatchError";
    this.tableDim = tableDim;
    this.providerDim = providerDim;
  }
}

export interface OpenVaultStoreOptions {
  readonly dataDir: string;
  readonly slug: string;
  readonly dim: number;
  /** Inject a custom connect (tests). Default: `lancedb.connect`. */
  readonly connect?: typeof lancedb.connect;
}

function makeSchema(dim: number): Schema {
  return new Schema([
    new Field("id", new Utf8(), false),
    new Field("path", new Utf8(), false),
    new Field("chunk_index", new Int32(), false),
    new Field("heading_path", new List(new Field("item", new Utf8(), false))),
    new Field("text", new Utf8(), false),
    new Field("embed_text", new Utf8(), false),
    new Field("frontmatter", new Utf8(), false),
    new Field("links", new List(new Field("item", new Utf8(), false))),
    new Field("tags", new List(new Field("item", new Utf8(), false))),
    new Field("mtime_ms", new Int64(), false),
    new Field("sha256", new Utf8(), false),
    new Field("vector", new FixedSizeList(dim, new Field("item", new Float32(), false))),
  ]);
}

/**
 * Read the existing table's vector dimension from its schema. Returns `null`
 * when the schema doesn't match our shape (no `vector` field, or it isn't a
 * FixedSizeList) — that case is treated as a corrupt table by the caller.
 */
function getTableDim(schema: Schema): number | null {
  const field = schema.fields.find((f) => f.name === "vector");
  if (field === undefined) return null;
  // FixedSizeList exposes `listSize` on its DataType. The arrow types are
  // slightly fuzzy here, so we extract via a narrow runtime check.
  const t = field.type as { listSize?: number };
  if (typeof t.listSize !== "number") return null;
  return t.listSize;
}

function rowToInsert(slug: string, row: StoreRow): Record<string, unknown> {
  return {
    id: `${row.path}#${row.chunkIndex}`,
    path: row.path,
    chunk_index: row.chunkIndex,
    heading_path: Array.from(row.headingPath),
    text: row.text,
    embed_text: row.embedText,
    frontmatter: JSON.stringify(row.frontmatter),
    links: Array.from(row.links),
    tags: Array.from(row.tags),
    // `mtimeMs` arrives from `fs.stat` as a float (sub-millisecond
    // precision varies by platform); the LanceDB Int64 column requires
    // an integer, so we floor to the nearest ms.
    mtime_ms: BigInt(Math.floor(row.mtimeMs)),
    sha256: row.sha256,
    vector: Array.from(row.vector),
    // `slug` is captured to keep this function honest about its input —
    // we don't store it in the row because the table itself is per-vault,
    // but accepting it here lets a future merge-into-single-table refactor
    // happen by changing rowToInsert alone.
    ...(slug.length === 0 ? { _slug: "" } : {}),
  };
}

/** Convert a LanceDB row back into the public `SearchHit` shape. */
function hitFromRow(row: Record<string, unknown>): SearchHit {
  // LanceDB returns `_distance` (squared L2). We map distance → similarity
  // score using `1 / (1 + distance)`, monotonic and bounded in (0, 1].
  const distRaw = row._distance;
  const distance = typeof distRaw === "number" ? distRaw : 0;
  const score = vectorDistanceToScore(distance);
  let frontmatter: Record<string, unknown> = {};
  if (typeof row.frontmatter === "string" && row.frontmatter.length > 0) {
    try {
      frontmatter = JSON.parse(row.frontmatter) as Record<string, unknown>;
    } catch {
      frontmatter = {};
    }
  }
  return {
    path: typeof row.path === "string" ? row.path : "",
    chunkIndex: typeof row.chunk_index === "number" ? row.chunk_index : 0,
    headingPath: Array.isArray(row.heading_path) ? (row.heading_path as string[]) : [],
    text: typeof row.text === "string" ? row.text : "",
    score,
    frontmatter,
    links: Array.isArray(row.links) ? (row.links as string[]) : [],
    tags: Array.isArray(row.tags) ? (row.tags as string[]) : [],
  };
}

/** SQL-escape a value for inclusion in a WHERE filter. */
function sqlString(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Internal: arm-level result entry shared between `searchHybrid` arms. */
interface RankedHit {
  readonly rowId: string;
  readonly rank: number;
  readonly row: Record<string, unknown>;
}

/**
 * Stringify a LanceDB `_rowid` (returned as `bigint`) into a stable Map
 * key. Numbers and bigints both stringify cleanly and round-trip without
 * loss for our purposes.
 */
function rowIdOf(r: Record<string, unknown>): string {
  const v = r._rowid;
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return v.toString();
  return String(v);
}

/**
 * Build the `WHERE` clause for `pathPrefix` / `tag` filters used by both
 * `search` and `searchHybrid`. Returns `undefined` when no clause is
 * needed so callers can skip `.where()` entirely (a no-op `where("")`
 * would still cost a parser pass).
 */
function buildFilterClause(filter?: SearchOpts["filter"]): string | undefined {
  if (filter === undefined) return undefined;
  const clauses: string[] = [];
  if (filter.pathPrefix !== undefined) {
    clauses.push(`starts_with(path, ${sqlString(filter.pathPrefix)})`);
  }
  if (filter.tag !== undefined) {
    clauses.push(`array_contains(tags, ${sqlString(filter.tag)})`);
  }
  if (clauses.length === 0) return undefined;
  return clauses.join(" AND ");
}

/**
 * Map a LanceDB vector `_distance` (squared L2) into a similarity in
 * `(0, 1]`, matching the formula used by the plain `search()` method via
 * `hitFromRow`. Kept centralised so the two paths can never drift.
 */
function vectorDistanceToScore(distance: number): number {
  return 1 / (1 + distance);
}

/**
 * Saturating map for an FTS relevance `_score` (≥ 0; LanceDB's BM25-style
 * relevance, unbounded above) into `(0, 1)`. Monotonic. Crucially this
 * is NOT a normalize-by-max-of-current-query: that would force the top
 * hit of every non-empty query to exactly `1` and defeat the `threshold`
 * knob ("score < threshold drops"). The contract is absolute.
 *
 * Returns `null` (not 0) when the input isn't a usable score so the
 * caller can decide on a fallback (e.g., rank-derived) rather than
 * silently dropping the hit.
 */
function ftsScoreToNormalized(score: unknown): number | null {
  if (typeof score !== "number" || !Number.isFinite(score) || score <= 0) return null;
  return score / (1 + score);
}

/**
 * Variant of `hitFromRow` that uses an externally-computed score (from
 * RRF or arm-rank normalization) instead of LanceDB's `_distance`.
 */
function hitFromRowWithScore(row: Record<string, unknown>, score: number): SearchHit {
  const base = hitFromRow(row);
  return { ...base, score };
}

/**
 * Coerce a `mtime_ms` value read back from LanceDB into a JS number. The
 * column is `Int64`, which the LanceDB JS bindings return as a `bigint`;
 * but in older versions or under certain code paths it may already be a
 * `number`. We accept both and normalise.
 */
function asNumber(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  return undefined;
}

/**
 * Open or create the per-vault table. Throws `StoreDimensionMismatchError`
 * when an existing table was built with a different vector dim.
 */
export async function openVaultStore(opts: OpenVaultStoreOptions): Promise<VaultStore> {
  const connect = opts.connect ?? lancedb.connect;
  const dbPath = lanceDbDir(opts.dataDir);
  const db = await connect(dbPath);
  const names = await db.tableNames();
  let table: lancedb.Table;
  if (names.includes(opts.slug)) {
    table = await db.openTable(opts.slug);
    const sch = await table.schema();
    const tableDim = getTableDim(sch);
    if (tableDim === null) {
      throw new StoreDimensionMismatchError(0, opts.dim);
    }
    if (tableDim !== opts.dim) {
      throw new StoreDimensionMismatchError(tableDim, opts.dim);
    }
  } else {
    table = await db.createEmptyTable(opts.slug, makeSchema(opts.dim));
  }

  // The "auto-build vector / FTS index at ≥ 256 rows" trigger lives in
  // `maybeBuildIndex` / `maybeBuildFtsIndex` below. We track a lifetime
  // flag per column so a single process doesn't rebuild on every upsert
  // after the threshold; the truth-of-record is the table itself,
  // consulted on open.
  //
  // Both build paths funnel through a SINGLE serialised queue
  // (`indexBuildChain`) so:
  //   - two concurrent upserts that both cross the FTS (or vector)
  //     threshold can't race into `createIndex` — the loser's call would
  //     otherwise fail with "index already exists";
  //   - and a vector build doesn't collide with an FTS build issued from
  //     a different concurrent upsert. LanceDB's transaction layer
  //     rejects two CreateIndex transactions at the same version even
  //     when they target different columns; the chain forces them to
  //     observe each other's commits sequentially.
  const indices = await table.listIndices();
  let vectorIndexBuilt = indices.some((i) => i.columns.includes("vector"));
  let ftsIndexBuilt = indices.some((i) => i.columns.includes("embed_text"));
  let indexBuildChain: Promise<void> = Promise.resolve();

  async function buildIndexSerialised(work: () => Promise<void>): Promise<void> {
    // Wait for the prior build (if any) to settle — fulfilled or
    // rejected — before starting our own. Using `await` with try/catch
    // lets a transiently-failed prior build still let us run, while
    // surfacing OUR own failure to the caller (the upsert retry loop).
    // The chain is saved as the awaited-and-swallowed shape so two
    // concurrent callers observe the same serialisation point without
    // a dedicated catch handler.
    const prev = indexBuildChain;
    let resolveSlot!: () => void;
    indexBuildChain = new Promise<void>((res) => {
      resolveSlot = res;
    });
    try {
      try {
        await prev;
      } catch {
        // Prior build failed; that's its caller's problem, not ours.
      }
      await work();
    } finally {
      resolveSlot();
    }
  }

  async function maybeBuildIndex(): Promise<void> {
    if (vectorIndexBuilt) return;
    return buildIndexSerialised(async () => {
      // Re-check under the chain — a previous queued build may have
      // already flipped the flag.
      if (vectorIndexBuilt) return;
      const rows = await table.countRows();
      if (rows < VECTOR_INDEX_THRESHOLD) return;
      // Spec calls for non-blocking. We do the work inline here (it's
      // already I/O-bound in LanceDB) and let any failure propagate out
      // of the calling `upsert` — the pipeline already retries store
      // writes 3× with linear backoff and counts persistent failures.
      await table.createIndex("vector");
      vectorIndexBuilt = true;
    });
  }

  async function maybeBuildFtsIndex(): Promise<void> {
    if (ftsIndexBuilt) return;
    return buildIndexSerialised(async () => {
      if (ftsIndexBuilt) return;
      const rows = await table.countRows();
      if (rows < FTS_INDEX_THRESHOLD) return;
      // FTS tokenizer config per change 0008 spec: `simple` base
      // tokenizer (whitespace + punctuation), lowercase, English
      // stemming, English stop-word removal. Other knobs stay at
      // LanceDB defaults — notably `withPosition: true` so phrase
      // queries work.
      await table.createIndex("embed_text", {
        config: lancedb.Index.fts({
          baseTokenizer: "simple",
          lowercase: true,
          stem: true,
          removeStopWords: true,
          language: "English",
        }),
      });
      ftsIndexBuilt = true;
    });
  }

  return {
    dim: opts.dim,
    async upsert(path: string, rows: readonly StoreRow[]): Promise<void> {
      // Empty rows means "drop all chunks for this path". Calling
      // mergeInsert with an empty source array would be a no-op for the
      // delete branch, so we fall through to an explicit delete here.
      if (rows.length === 0) {
        await table.delete(`path = ${sqlString(path)}`);
        return;
      }
      const records = rows.map((r) => rowToInsert(opts.slug, r));
      // mergeInsert on `id` performs the entire delete-old + insert-new
      // step as a single LanceDB transaction. `whenNotMatchedBySourceDelete`
      // scoped to the same `path` removes any stale chunks (e.g. a chunk
      // count drop from 5 → 3) without touching unrelated paths. From a
      // search reader's perspective, the file is never absent — the old
      // and new manifests commit atomically per the LanceDB contract.
      await table
        .mergeInsert(["id"])
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .whenNotMatchedBySourceDelete({ where: `path = ${sqlString(path)}` })
        .execute(records);
      await maybeBuildIndex();
      await maybeBuildFtsIndex();
    },
    async drop(path: string): Promise<void> {
      await table.delete(`path = ${sqlString(path)}`);
    },
    async search(queryVector: Float32Array, searchOpts?: SearchOpts): Promise<SearchHit[]> {
      const limit = searchOpts?.limit ?? 20;
      let q = table.vectorSearch(queryVector).limit(limit);
      // `starts_with` is the literal-prefix operator; using `LIKE` would
      // treat `_` and `%` as wildcards and a request for `notes_2026/`
      // would silently match `notesA2026/` etc. `sqlString` single-quote
      // escapes so values can't break out of the string literal either.
      const where = buildFilterClause(searchOpts?.filter);
      if (where !== undefined) q = q.where(where);
      const rows = (await q.toArray()) as Record<string, unknown>[];
      return rows.map(hitFromRow);
    },
    async searchHybrid(
      queryVector: Float32Array,
      queryText: string,
      hybridOpts: SearchHybridOpts = {},
    ): Promise<SearchHit[]> {
      const limit = hybridOpts.limit ?? 20;
      const mode = hybridOpts.mode ?? "hybrid";
      const perArm = hybridOpts.perArmCandidates ?? Math.max(60, 3 * limit);
      const k = hybridOpts.rrfK ?? 60;
      const filterClause = buildFilterClause(hybridOpts.filter);

      const runVector = async (): Promise<RankedHit[]> => {
        hybridOpts.hooks?.onVectorSearch?.();
        let q = table.vectorSearch(queryVector).limit(perArm).withRowId();
        if (filterClause !== undefined) q = q.where(filterClause);
        const rows = (await q.toArray()) as Record<string, unknown>[];
        return rows.map((r, i) => ({ rowId: rowIdOf(r), rank: i + 1, row: r }));
      };
      const runFts = async (): Promise<RankedHit[]> => {
        hybridOpts.hooks?.onFtsSearch?.();
        // `table.search(query, "fts", "embed_text")` returns a Query
        // builder with `.limit()` / `.where()` / `.withRowId()` like
        // vectorSearch.
        let q = table
          .search(queryText, "fts", "embed_text")
          .limit(perArm)
          .withRowId() as ReturnType<typeof table.query>;
        if (filterClause !== undefined) q = q.where(filterClause);
        const rows = (await q.toArray()) as Record<string, unknown>[];
        return rows.map((r, i) => ({ rowId: rowIdOf(r), rank: i + 1, row: r }));
      };

      let arms: RankedHit[][];
      if (mode === "vector") {
        arms = [await runVector()];
      } else if (mode === "fts") {
        arms = [await runFts()];
      } else {
        arms = await Promise.all([runVector(), runFts()]);
      }

      // Build a row map keyed by rowId, taking the first arm's row for
      // each id. `_distance` / `_score` are kept on the captured row so
      // single-arm modes can derive an absolute score below.
      const rowMap = new Map<string, Record<string, unknown>>();
      for (const arm of arms) {
        for (const hit of arm) {
          if (!rowMap.has(hit.rowId)) rowMap.set(hit.rowId, hit.row);
        }
      }

      let scored: { rowId: string; score: number }[];
      if (mode === "hybrid") {
        // Reciprocal Rank Fusion. The fused score for `n` arms is
        // bounded above by `n / (k + 1)` (every arm placing the row at
        // rank 1 contributes `1 / (k + 1)` apiece). Divide by that
        // fixed upper bound so output stays in `(0, 1]` WITHOUT making
        // the top hit of every query equal `1` — the threshold knob's
        // contract is absolute ("score < threshold drops"), not
        // query-relative. A row appearing in fewer arms or at deeper
        // ranks scores strictly less than 1.
        const fused = new Map<string, number>();
        for (const arm of arms) {
          for (const hit of arm) {
            fused.set(hit.rowId, (fused.get(hit.rowId) ?? 0) + 1 / (k + hit.rank));
          }
        }
        const maxPossible = arms.length / (k + 1);
        scored = [];
        for (const [rowId, v] of fused) {
          // Guard against pathological k (k + 1 ≤ 0) — fall through to
          // 0 rather than dividing by zero / negative.
          const score = maxPossible > 0 ? Math.min(1, v / maxPossible) : 0;
          if (score > 0) scored.push({ rowId, score });
        }
      } else {
        // Single-arm mode: derive an ABSOLUTE score from the underlying
        // LanceDB signal so `threshold` is meaningful even on weak
        // queries. Vector → `1 / (1 + _distance)` (matches
        // `hitFromRow`). FTS → saturating `s / (1 + s)`. Neither path
        // normalises by the max of the current result set. When the FTS
        // arm doesn't expose a usable `_score` (e.g., un-indexed
        // small-table fallback), we fall back to a rank-derived score
        // `1 / (k + rank)` mapped through the same saturating function
        // so the scale stays absolute and bounded.
        const arm = arms[0] ?? [];
        scored = [];
        for (const hit of arm) {
          const row = hit.row;
          let score: number;
          if (mode === "vector") {
            const d = row._distance;
            score = vectorDistanceToScore(typeof d === "number" ? d : 0);
          } else {
            // mode === "fts"
            const fromScore = ftsScoreToNormalized(row._score);
            if (fromScore !== null) {
              score = fromScore;
            } else {
              // Fallback: rank-derived absolute score. `1 / (k + rank)`
              // is in (0, 1/k] — saturate so the output stays in (0, 1).
              const rrf = 1 / (k + hit.rank);
              score = rrf / (1 + rrf);
            }
          }
          if (score > 0) scored.push({ rowId: hit.rowId, score });
        }
      }

      // Sort descending by score, materialize SearchHit list.
      scored.sort((a, b) => b.score - a.score);
      const hits: SearchHit[] = [];
      for (const s of scored) {
        const row = rowMap.get(s.rowId);
        if (row === undefined) continue;
        hits.push(hitFromRowWithScore(row, s.score));
      }
      return hits;
    },
    async documentCount(): Promise<number> {
      // LanceDB doesn't expose a `COUNT DISTINCT path` natively in the JS
      // SDK (yet); scan and dedupe in TS. The cardinality is bounded by
      // vault size — roughly thousands at the high end — so this remains
      // cheap. Switch to a server-side aggregate if vault sizes ever
      // change that calculus.
      const rows = (await table.query().select(["path"]).toArray()) as {
        path: string;
      }[];
      const seen = new Set<string>();
      for (const r of rows) seen.add(r.path);
      return seen.size;
    },
    chunkCount(): Promise<number> {
      return table.countRows();
    },
    async fingerprint(path: string): Promise<PathFingerprint | undefined> {
      const rows = (await table
        .query()
        .where(`path = ${sqlString(path)}`)
        .select(["sha256", "mtime_ms"])
        .limit(1)
        .toArray()) as { sha256: string; mtime_ms: unknown }[];
      const first = rows[0];
      if (first === undefined) return undefined;
      const mtimeMs = asNumber(first.mtime_ms);
      if (mtimeMs === undefined) return undefined;
      return { sha256: first.sha256, mtimeMs };
    },
    async fingerprints(): Promise<Map<string, PathFingerprint>> {
      const rows = (await table.query().select(["path", "sha256", "mtime_ms"]).toArray()) as {
        path: string;
        sha256: string;
        mtime_ms: unknown;
      }[];
      const out = new Map<string, PathFingerprint>();
      for (const r of rows) {
        const mtimeMs = asNumber(r.mtime_ms);
        if (mtimeMs === undefined) continue;
        // Multiple chunks per path: keep the highest mtime as canonical.
        const existing = out.get(r.path);
        if (existing === undefined || existing.mtimeMs <= mtimeMs) {
          out.set(r.path, { sha256: r.sha256, mtimeMs });
        }
      }
      return out;
    },
    close(): void {
      table.close();
      db.close();
    },
  };
}

/** Used in tests to wipe a tmp lancedb dir between runs. */
export function clearStoreDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Resolve `<dataDir>/lancedb` via `node:path.join` (handles trailing slashes). */
function lanceDbDir(dataDir: string): string {
  return join(dataDir, "lancedb");
}

/** Resolve the pipeline-version sidecar path for a given data dir. */
export function pipelineVersionPath(dataDir: string): string {
  return join(lanceDbDir(dataDir), ".pipeline_version");
}

/**
 * Read the pipeline-version sidecar. Returns `undefined` when the file is
 * missing (first-run / fresh data dir). Malformed contents (non-integer)
 * are reported as `undefined` too — the caller treats both as "rebuild
 * required" because we can't reason about the rows written under an
 * unknown version.
 */
export function readPipelineVersion(dataDir: string): number | undefined {
  const file = pipelineVersionPath(dataDir);
  if (!existsSync(file)) return undefined;
  const raw = readFileSync(file, "utf8").trim();
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || `${n}` !== raw) return undefined;
  return n;
}

/** Write the pipeline-version sidecar, creating the lancedb dir as needed. */
export function writePipelineVersion(dataDir: string, version: number): void {
  const dir = lanceDbDir(dataDir);
  mkdirSync(dir, { recursive: true });
  writeFileSync(pipelineVersionPath(dataDir), `${version}\n`, "utf8");
}

export class PipelineVersionMismatchError extends Error {
  readonly dataVersion: number;
  readonly binaryVersion: number;
  constructor(dataVersion: number, binaryVersion: number) {
    super(
      `pipeline version mismatch: data_dir=${dataVersion} binary=${binaryVersion}; upgrade the binary or wipe DATA_DIR/lancedb`,
    );
    this.name = "PipelineVersionMismatchError";
    this.dataVersion = dataVersion;
    this.binaryVersion = binaryVersion;
  }
}

/**
 * Reconcile the on-disk pipeline-version sidecar with the binary's compiled
 * `PIPELINE_VERSION`:
 *
 *   missing or `< PIPELINE_VERSION` → drop every per-vault LanceDB table
 *     (per-slug log line `pipeline upgrade: rebuilding vault <slug> ...`),
 *     write the new version, and let the caller's initial-scan logic
 *     rebuild from the working tree.
 *   `> PIPELINE_VERSION`            → throw `PipelineVersionMismatchError`.
 *   equal                           → no-op.
 *
 * The binary version is injected for testability; production callers pass
 * the module-level `PIPELINE_VERSION`.
 */
export interface ReconcileOptions {
  readonly dataDir: string;
  readonly slugs: readonly string[];
  readonly binaryVersion?: number;
  readonly logger?: Logger;
  /** Inject a custom connect (tests). Default: `lancedb.connect`. */
  readonly connect?: typeof lancedb.connect;
}

export async function reconcilePipelineVersion(opts: ReconcileOptions): Promise<void> {
  const binary = opts.binaryVersion ?? PIPELINE_VERSION;
  const current = readPipelineVersion(opts.dataDir);
  if (current === binary) return;
  if (current !== undefined && current > binary) {
    throw new PipelineVersionMismatchError(current, binary);
  }
  // Missing or older: drop every per-vault table, then bump.
  const oldVersion = current ?? 1;
  const connect = opts.connect ?? lancedb.connect;
  const dbPath = lanceDbDir(opts.dataDir);
  // The lancedb directory may not exist yet on a fresh data dir; calling
  // `connect` against a missing path creates it on demand. We only need to
  // drop tables when there's something to drop.
  if (existsSync(dbPath)) {
    const db = await connect(dbPath);
    try {
      const existing = new Set(await db.tableNames());
      for (const slug of opts.slugs) {
        if (!existing.has(slug)) continue;
        opts.logger?.info(
          `pipeline upgrade: rebuilding vault ${slug} (version: ${oldVersion} → ${binary})`,
        );
        await db.dropTable(slug);
      }
    } finally {
      // Mirror `VaultStore.close` in `openVaultStore`, which calls
      // `db.close()` directly. The drop-only connection here doesn't open
      // a table, so we only need to close the connection itself.
      db.close();
    }
  }
  writePipelineVersion(opts.dataDir, binary);
}

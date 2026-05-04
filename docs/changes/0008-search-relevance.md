# 0008: Search relevance — hybrid retrieval, MMR, threshold

## Summary

Three retrieval-side improvements layered on top of [0007](./0007-indexer-relevance.md)'s richer chunks:

1. **Hybrid retrieval (vector + FTS via RRF).** Build a LanceDB full-text-search index on the `embed_text` column (added in 0007) and execute vector + FTS searches in parallel, fusing results with Reciprocal Rank Fusion. Default mode is `hybrid`; `vector` and `fts` are also selectable.
2. **MMR diversification.** Cap per-source dominance: at most 3 chunks per `path` in the returned list, with `λ = 0.5` mixing relevance against path diversity.
3. **Score threshold.** Optional `threshold` knob drops post-fusion hits with `score < threshold` so callers can ask for confident-only results.

All three knobs propagate through the service core to REST and to the MCP `search` tool.

**Spec:** [Vault Indexer › Search relevance](../specs/vault-indexer/index.md#search-relevance), [REST API › Search](../specs/rest-api/index.md#search), [MCP Server › Tool surface](../specs/mcp-server/index.md#tool-surface)
**Status:** complete
**Depends On:** 0007

## Motivation

The eval set committed in 0007 demonstrates that even after better chunking, pure-vector retrieval over `Xenova/all-MiniLM-L6-v2` (384-dim) underperforms on:

- **Proper-noun queries** — "Alice", "BFF", "Principal" — where lexical match is the right primary signal.
- **Single-source dominance** — one query about review feedback returns 7 chunks of one review file, hiding 5 other relevant files.
- **Low-confidence noise** — score spreads of 0.04 across the top 10 mean half the results are statistical noise dressed up as ranked hits.

Hybrid retrieval is the standard fix for #1, MMR for #2, threshold for #3. LanceDB ships native FTS + an RRF reranker module, so this is integration work, not algorithm work.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint)). CI enforces these as merge gates:

- The standing 100% line + branch coverage gate on `src/` (see [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint)) MUST hold. CI runs `bun run test:cov`, which invokes `bun test --coverage` and then `test/check-coverage.ts` to enforce the per-file gate (today's Bun proxy is line + function; branch records flip on automatically when Bun emits them — see the script header). New code without tests is a defect.
- LanceDB MUST be exercised against a real store rooted in a `Bun.tmpdirSync()` directory (no mocks). Hybrid + FTS + MMR tests MUST run against a real LanceDB FTS index.
- Network calls (e.g. OpenAI embedder) MUST be mocked in unit tests; the local Transformers.js embedder is the default and runs in-process.
- Biome MUST pass with the project config; `tsc --noEmit` MUST pass.
- **REST/MCP parity tests** MUST cover every new search knob: a parity test under `test/parity/` MUST drive `POST /v1/vaults/v/search` and the `search` MCP tool with the same `{ mode, threshold, mmrLambda, maxPerPath }` envelope and assert structurally identical hit lists. Adding a knob without a parity test is a defect.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Indexer — FTS index

- The indexer MUST create a LanceDB full-text index on the `embed_text` column when the vault's row count first crosses ≥ 256 (mirroring the existing vector-index threshold).
- The FTS tokenizer MUST be `simple` with: `lowercase: true`, `stem: true`, `removeStopWords: true`, `language: "english"`. Other tokenizer options remain at LanceDB defaults.
- The FTS index MUST be rebuilt automatically when the pipeline-version sidecar (from 0007) triggers a rebuild.
- The "is FTS index built" check MUST be cached on the in-memory store handle, the same shape as the existing `vectorIndexBuilt` flag.

#### Scenario: FTS index auto-builds at 256 rows

- **GIVEN** a vault with 0 rows and the embedder loaded
- **WHEN** indexing crosses 256 rows
- **THEN** `table.listIndices()` includes an FTS index on `embed_text` within the same upsert call

### Indexer — hybrid retrieval

- `Indexer.search` MUST accept a `mode: "hybrid" | "vector" | "fts"` option (default `"hybrid"`).
- In `hybrid` mode the indexer MUST execute the vector arm and the FTS arm in parallel.
  - The vector arm MUST embed the query string and call `table.vectorSearch(queryVec).limit(max(60, 3 × limit))` with `withRowId()` so candidates are joinable.
  - The FTS arm MUST call `table.search(query, "fts", "embed_text").limit(max(60, 3 × limit))` with `withRowId()`.
- The two candidate lists MUST be fused via Reciprocal Rank Fusion with `k = 60`. LanceDB's bundled `@lancedb/lancedb/rerankers/rrf` reranker SHOULD be used; if its API doesn't fit, the indexer MAY implement RRF directly (it's three lines of code).
- `vector` mode MUST execute only the vector arm; `fts` mode MUST execute only the FTS arm. Both MUST still apply MMR + threshold (below) — the diversification and threshold knobs are mode-independent so callers don't get surprising behavior shifts when toggling `mode`.
- The score on the returned `SearchHit` MUST be normalized to `(0, 1]` so it stays comparable across modes. In `hybrid` mode the score is the fused RRF score; in `vector` and `fts` modes it's the per-arm score scaled into the same range. Per-arm raw scores MAY be exposed via an optional `SearchHit.scores` object — required if practical, OPTIONAL if it complicates the LanceDB result shape.

#### Scenario: Verbatim query lands the verbatim chunk

- **GIVEN** indexed `self/tasks.md` containing the verbatim line `Promote Alice to Principal next year`
- **WHEN** the client calls `Indexer.search("v", "promote Alice to Principal next year", { mode: "hybrid" })`
- **THEN** the top-1 hit's `path` is `self/tasks.md`
- **AND** its `text` contains the verbatim line

#### Scenario: vector mode runs only the vector arm

- **GIVEN** an indexed vault and a query
- **WHEN** the client calls `Indexer.search("v", query, { mode: "vector" })`
- **THEN** the implementation MUST NOT issue an FTS query (verifiable by injecting a counting decorator on `table.search(_, "fts", _)`)
- **AND** the returned hits MUST come exclusively from the vector arm's candidate set, post-MMR and post-threshold

### Indexer — MMR diversification

- After fusion, the indexer MUST apply Maximal Marginal Relevance to the top `K = max(60, 3 × limit)` candidates.
- The relevance term MUST be the fused score (already in `(0, 1]`).
- For each remaining candidate, the indexer MUST compute `mmrScore(c) = λ × relevance(c) − (1 − λ) × similarity-to-selected(c)`, where `similarity-to-selected(c)` is `1` if any already-selected hit shares the same `path`, else `0`. The candidate with the **highest** `mmrScore` is picked next (selection MUST maximize `mmrScore`, NOT minimize a penalty). This is the standard MMR formulation: the `(1 − λ) × similarity-to-selected` term is the diversity penalty subtracted from relevance, making MMR per-source rather than per-vector. At `λ = 1` the diversity term vanishes and selection collapses to pure relevance order; at `λ = 0` selection ignores relevance and only spreads across paths. The failure mode we're fixing is "all 7 hits from one file," not "two near-duplicate vectors."
- `opts.mmrLambda` MUST default to `0.5` and accept any value in `[0, 1]`.
- `opts.maxPerPath` MUST default to `3` and cap the count of returned hits per `path`. After MMR, if a `path` is already at the cap, further candidates from that path MUST be skipped.
- The final cut to `limit` happens AFTER MMR and AFTER threshold filtering (see below).

#### Scenario: maxPerPath caps single-source dominance

- **GIVEN** a query whose pre-MMR top-10 contains 8 chunks of one file and 2 of another
- **WHEN** the client searches with `limit: 10, maxPerPath: 3`
- **THEN** the response contains at most 3 chunks of that file
- **AND** other paths fill the remaining slots from the candidate pool

### Indexer — score threshold

- `opts.threshold` MUST default to `0` (no filtering).
- The threshold MUST be applied to the post-MMR candidate stream **before** the final cut to `limit`: candidates with `score < threshold` MUST be dropped first, and only then MUST the indexer take the first `limit` of what remains. This ordering guarantees that a below-threshold candidate in the top-`limit` slots cannot displace a qualifying candidate that exists deeper in the post-MMR list.
- The empty-result case (everything below threshold) MUST return `hits: []` — NOT an error.

#### Scenario: threshold gates noise

- **GIVEN** a query whose post-fusion top scores are `[0.42, 0.40, 0.38, …]`
- **WHEN** the client searches with `threshold: 0.5`
- **THEN** the response is `{ hits: [] }`
- **AND** HTTP status is 200

### REST surface

- `POST /v1/vaults/:slug/search` body MUST accept the new optional fields:
  - `mode?: "hybrid" | "vector" | "fts"` (default `"hybrid"`)
  - `threshold?: number` in `[0, 1]` (default `0`)
  - `mmrLambda?: number` in `[0, 1]` (default `0.5`)
  - `maxPerPath?: number` integer in `[1, 100]` (default `3`)
- Out-of-range or wrong-type values MUST 400 with `code: "invalid_input"` and the Zod message.
- The response shape is unchanged: `{ hits: SearchHit[] }`. `SearchHit.score` is the fused score; `SearchHit.scores` (object) is OPTIONAL per-arm scores.

#### Scenario: invalid mode returns 400

- **WHEN** the client posts `{ query: "foo", mode: "bogus" }`
- **THEN** the response is 400 with `error.code = "invalid_input"`
- **AND** the message names the allowed values

### MCP surface

- The MCP `search` tool's input schema MUST add the same four optional fields with the same defaults and validation.
- The tool description MUST explicitly tell the calling agent: default `mode: "hybrid"` is the right choice for almost every query; `vector` is for semantics-only evaluation; `fts` is for exact-phrase or proper-noun queries; the other knobs (`threshold`, `mmrLambda`, `maxPerPath`) are tuning levers and the defaults are good.
- A new parity test MUST drive REST and MCP with `{ query, mode, threshold, mmrLambda, maxPerPath }` envelopes and assert identical hit lists.

### Eval harness extension

- The harness from 0007 MUST grow assertions for hybrid mode:
  - The "promote Alice to Principal next year" query MUST hit top-1 in `mode: "hybrid"` (escalates from advisory in 0007 to required in 0008).
  - At least one query MUST be added that fails in `vector` and succeeds in `fts` (proves the FTS arm pulls weight).
  - At least one query MUST exercise `maxPerPath` by checking that the top-10 contains ≥ N distinct paths.
- Failures here remain advisory in CI for v1 unless they regress a previously-passing assertion. Once the seed set stabilizes, the harness MAY be promoted to a hard gate; that promotion is OUT OF SCOPE for this change.

## Design

### Approach

- **FTS index build** lives in `src/indexer/store.ts` next to the existing `maybeBuildIndex`. Add `maybeBuildFtsIndex` that calls `table.createIndex("embed_text", { config: lancedb.Index.fts({ lowercase: true, stem: true, removeStopWords: true, language: "english" }) })`. Cache `ftsIndexBuilt` like `vectorIndexBuilt`.
- **Hybrid query** lives in `src/indexer/store.ts` as a new `searchHybrid(queryVec, queryText, opts)` method. Issues both arms in parallel via `Promise.all`, joins by `_rowid`, applies RRF, returns the same `SearchHit[]` shape as `search` so the service core's interface is "one method, mode parameter."
- **RRF fusion** uses LanceDB's `RRFReranker` if it accepts pre-fetched candidate batches; otherwise inline:
  ```ts
  function rrf(arms: { rowId: string; rank: number }[][], k = 60): Map<string, number> {
    const score = new Map<string, number>();
    for (const arm of arms) for (const { rowId, rank } of arm) {
      score.set(rowId, (score.get(rowId) ?? 0) + 1 / (k + rank));
    }
    return score;
  }
  ```
- **MMR + threshold** are pure post-processing in `src/indexer/index.ts` (or a new `src/indexer/rank.ts`). They take the fused list and produce the final list; no LanceDB involvement.
- **REST** adds Zod validation in `src/schemas/search.ts` and passes the new fields through to the service core. **MCP** does the same in its tool schema, mirroring the Zod model.

### Decisions

- **RRF over learned-rank fusion.** RRF is parameter-free (k=60 is the literature default), reproducible, and ships in LanceDB. Anything more sophisticated requires labeled data we don't have.
- **MMR by `path`, not by vector similarity.** The failure mode we're fixing is "one file dominates," not "two near-identical chunks." Path-level diversification matches the failure pattern and is O(K²) trivial.
- **Threshold AFTER MMR.** Threshold gates the final ordering, not raw arm scores. Otherwise a low-confidence FTS hit could survive while a high-confidence vector hit gets filtered.
- **Default `mode = "hybrid"`.** The eval shows hybrid strictly improves over vector on every query that has lexical signal and matches vector on queries that don't. There's no reason to default to a worse mode.

### Non-Goals

- Cross-encoder reranker (e.g. `bge-reranker-base`) — separate change once hybrid is in.
- Bigger embedder swap — separate change with its own dim-mismatch path.
- HyDE / query expansion — defer; relies on an LLM call per query.
- Promoting the eval harness to a hard CI gate — defer until seed set stabilizes.

## Tasks

- [x] **FTS index** — `maybeBuildFtsIndex` in `src/indexer/store.ts`; threshold and tokenizer per spec. Tests cover: no index < 256 rows; index built ≥ 256 rows; index rebuilt after a pipeline-version drop.
- [x] **`searchHybrid`** — new method on the store. Tests against a real Bun.tmpdirSync LanceDB: vector-only path matches today's behavior; fts-only path returns lexical hits; hybrid fuses both via RRF.
- [x] **MMR + threshold** — `src/indexer/rank.ts` with pure-function unit tests covering: K-cap, λ extremes (0 and 1), maxPerPath cap, threshold dropping, threshold-yields-empty.
- [x] **Indexer surface** — `Indexer.search` signature extended; type-checked propagation through `src/vault/search.ts`.
- [x] **REST schema** — Zod schema in `src/schemas/search.ts` extended; validation tested for each invalid case (bad mode, out-of-range threshold, etc).
- [x] **MCP tool** — input schema and description updated in `src/mcp/tools/search.ts`. Tool description copy MUST include the agent guidance from the spec.
- [x] **Parity test** — `test/parity/search-modes.test.ts` covers each mode and each knob, REST vs MCP.
- [x] **Eval harness extension** — new assertions per spec; "promote Alice to Principal" lifted from advisory to required.
- [x] **Spec status flip** — same PR flips `0008` to `complete` in `docs/index.yml` and `docs/index.md`.

## Open Questions

- **`SearchHit.scores` per-arm exposure.** LanceDB's hybrid result shape may or may not expose per-arm scores cleanly through the JS SDK. **Default**: best-effort — expose if free, omit if it requires a second query pass. Spec marks the field optional.
- **Tokenizer language.** English-only stemming is a project assumption. **Default**: English; revisit if multilingual content shows up in real vaults.
- **Threshold default.** `0` (off) is conservative. Some clients may want `0.3` as a floor. **Default**: leave at `0` and let callers tune; revisit after eval data accumulates.

## References

- Spec: [Vault Indexer › Search relevance](../specs/vault-indexer/index.md#search-relevance)
- Spec: [REST API › Search](../specs/rest-api/index.md#search)
- Spec: [MCP Server › Tool surface](../specs/mcp-server/index.md#tool-surface)
- Prerequisite: [Change 0007 — Indexer relevance](./0007-indexer-relevance.md)
- [LanceDB FTS](https://lancedb.github.io/lancedb/fts/)
- [Reciprocal Rank Fusion (Cormack et al., 2009)](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)
- [Maximal Marginal Relevance (Carbonell & Goldstein, 1998)](https://www.cs.cmu.edu/~jgc/publication/The_Use_MMR_Diversity_Based_LTMIR_1998.pdf)

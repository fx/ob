# 0007: Indexer relevance — flat-list chunking + embedded heading/path

## Summary

Two pipeline-side changes that lift recall and precision before any retrieval-side work in [0008](./0008-search-relevance.md):

1. **Flat-list chunker.** Sections that are essentially "a list of unrelated bullets" (`self/tasks.md`, `Inbox.md`, daily-log task blocks) currently pack many bullets into one ≤1500-char chunk, diluting per-bullet signal. The chunker MUST detect such sections and emit one chunk per top-level bullet group instead.
2. **Embedded `embed_text` column.** Today only the body is embedded; `heading_path` and `path` are stored as columns but never seen by the embedder. The pipeline MUST persist a new `embed_text = path + headingPath + text` column and embed THAT instead — making file paths and heading tokens (e.g. `Alice Example`, `Tasks > Work`) first-class signal in the vector AND (after 0008) in the FTS index.

Both changes alter the chunk corpus and therefore force a one-time full re-embed. To make that safe, this change adds a `pipeline_version` sidecar that triggers an automatic table-drop-and-rebuild on mismatch.

**Spec:** [Vault Indexer](../specs/vault-indexer/)
**Status:** complete
**Depends On:** 0006

## Motivation

Two evaluations run on the production `v` vault on 2026-05-03 motivated this change.

**Failure A — proper-noun verbatim miss.** Query `"promote Alice to Principal next year"` (a near-verbatim sentence in `self/tasks.md`) returned `"ask Alice to organize team outing for core week"` at top-1; the verbatim chunk ranked #10. Root cause: the bullet lives in a 7KB chunk that smashes ~30 unrelated tasks together, so its embedding signal is averaged out.

**Failure B — name-as-query weakness.** Query `"Alice"` produced 10 hits with a score spread of 0.05 (0.521–0.471). Path tokens that should have differentiated (`acme/2026/promos/Alice Example.md` is literally a file named after him) carried no weight because the embedder never sees the path.

The fixes here are upstream of any retrieval algorithm change. They make the indexed chunks themselves more retrievable. 0008 builds on top.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint)). CI enforces these as merge gates:

- The standing 100% line + branch coverage gate on `src/` (see [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint)) MUST hold. CI runs `bun run test:cov`, which invokes `bun test --coverage` and then `test/check-coverage.ts` to enforce the per-file gate (today's Bun proxy is line + function; branch records flip on automatically when Bun emits them — see the script header). New code without tests is a defect.
- LanceDB MUST be exercised against a real store rooted in a `Bun.tmpdirSync()` directory (no mocks) — chunker + store tests reuse the existing fixture pattern.
- The `ob` binary MUST NOT be invoked against real Obsidian servers in any test added by this change.
- Biome MUST pass with the project config; `tsc --noEmit` MUST pass.
- Parity tests under `test/parity/` MUST still pass — this change does not touch the search adapter signature, but it does change chunk content, so parity tests that snapshot `search` output need fixtures regenerated and reviewed.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Chunker — flat-list section heuristic

- The chunker MUST classify each heading section as either `prose` or `flat-list`.
- A section qualifies as `flat-list` when ≥ 70% of its non-blank root-level Markdown children (after frontmatter and heading removal) are list items belonging to a single list. Threshold MUST be exposed as `FLAT_LIST_THRESHOLD = 0.7` so a future tweak is one constant.
- For `flat-list` sections, each top-level list item (with its nested children) MUST become its own chunk, in document order.
- A single top-level item whose serialized text exceeds `MAX_CHUNK_CHARS` (1500) MUST fall back to the existing paragraph-boundary splitter for that item only. Sibling items are unaffected.
- The chunk's `headingPath` MUST remain the section's heading path (the bullet text MUST NOT be appended to the heading path).
- For `prose` sections, behavior MUST be identical to today.

#### Scenario: tasks.md flat list emits per-bullet chunks

- **GIVEN** `self/tasks.md` with a heading `## Work` followed by 30 top-level bullets totalling 4000 chars
- **WHEN** the chunker runs
- **THEN** 30 chunks are emitted with `headingPath = ["Tasks", "Work"]` (or however it nests)
- **AND** each chunk's `text` is exactly one top-level bullet (with any nested children)

#### Scenario: prose section unchanged

- **GIVEN** a `## Background` section with 3 paragraphs of prose totalling 800 chars
- **WHEN** the chunker runs
- **THEN** exactly one chunk is emitted with `text` containing all three paragraphs

#### Scenario: oversized bullet falls back to paragraph splitter

- **GIVEN** a flat-list section where one top-level bullet's body is 2200 chars
- **WHEN** the chunker runs
- **THEN** that bullet alone produces ≥ 2 chunks, split at paragraph boundaries
- **AND** every chunk's text length is ≤ 1500 chars
- **AND** sibling bullets each produce one chunk

### Chunker — `embedText` composition

- Each `Chunk` MUST carry an `embedText` field, populated by the chunker as:
  `<path>\n<headingPath joined by " > ">\n\n<text>`
  with the heading-path line omitted when the heading path is empty.
- The pipeline MUST send `embedText` (not `text`) to the embedder.
- The store MUST persist `embedText` in a new `embed_text` column (Utf8, non-null).
- The display `text` field MUST remain unchanged — the body alone — so REST/MCP search hits return clean snippets.

#### Scenario: embed text carries path and heading

- **GIVEN** a chunk for `entities/Alice Example.md`, heading path `["Reviews", "2026"]`, body `"Strong cross-team adoption..."`
- **WHEN** the chunker runs
- **THEN** the chunk's `embedText` is exactly `entities/Alice Example.md\nReviews > 2026\n\nStrong cross-team adoption...`
- **AND** the chunk's `text` is exactly `Strong cross-team adoption...`

### LanceDB schema — `embed_text` column

- The Arrow schema MUST add a non-null `embed_text` Utf8 column between `text` and `frontmatter` (concrete order is up to the implementer; persisted column order does not affect query API).
- `rowToInsert` MUST populate `embed_text` from the chunk's `embedText`.
- A row missing `embed_text` (which can happen only when an old-version table was opened pre-rebuild) MUST be treated as schema drift — see pipeline versioning below.

### Pipeline version sidecar

- The indexer MUST persist `<DATA_DIR>/lancedb/.pipeline_version` as a single integer.
- A `PIPELINE_VERSION` constant MUST live in `src/indexer/store.ts` (or a sibling) and MUST be incremented whenever a chunker or `embed_text` composition rule changes that would invalidate previously-indexed rows. This change MUST set `PIPELINE_VERSION = 2` (the implicit pre-change version is 1).
- On indexer startup, the indexer MUST read the sidecar:
  - If the sidecar is missing or contains `< PIPELINE_VERSION`, the indexer MUST drop every per-vault LanceDB table, write the new version into the sidecar, and let the existing initial-scan logic rebuild from the working tree.
  - If the sidecar contains `> PIPELINE_VERSION`, the indexer MUST exit non-zero with a clear message naming both versions (the operator is running an older binary against a newer data dir).
  - If the sidecar matches, behavior is unchanged.
- The drop-and-rebuild MUST log a single info line per vault: `pipeline upgrade: rebuilding vault <slug> (version: <old> → <new>)`.

#### Scenario: rolling forward triggers automatic rebuild

- **GIVEN** a `<DATA_DIR>/lancedb/` populated by a prior run with `PIPELINE_VERSION = 1` and `.pipeline_version` either missing or containing `1`
- **WHEN** the new binary starts with `PIPELINE_VERSION = 2`
- **THEN** the indexer drops every per-vault table
- **AND** writes `2` to `.pipeline_version`
- **AND** the initial scanner re-chunks and re-embeds every Markdown file
- **AND** `/readyz` reports 200 once every vault completes the rebuild

#### Scenario: rolling back errors out cleanly

- **GIVEN** `.pipeline_version` containing `2`
- **WHEN** an old binary with `PIPELINE_VERSION = 1` starts
- **THEN** the process exits non-zero with message `pipeline version mismatch: data_dir=2 binary=1; upgrade the binary or wipe DATA_DIR/lancedb`
- **AND** no rows are written

### Eval harness

This change MUST land with a small eval harness (`test/relevance/eval.ts`) that runs a fixed set of (query, expected-top-1-path) pairs against a fixture vault and reports recall@1, recall@5, and MRR. The harness MUST run in CI as part of `bun test`. At least the following queries MUST be in the seed set with documented expected outcomes:

- `"promote Alice to Principal next year"` — expected top-1 contains the verbatim line
- `"BFF architecture cross-team adoption"` — expected top-3 contains a chunk whose `headingPath` mentions cross-team work
- `"daily routine morning"` — expected top-5 contains a chunk from the user's task / habits file
- `"deeply nested heading prose"` — sanity test that the prose splitter still works

Failures here are advisory in CI for v1 (logged but not gating) so iteration on the eval set itself doesn't churn merge gates. The seed set lives in `test/relevance/queries.json` so contributors can add cases without touching the harness.

## Design

### Approach

- **Flat-list detection** lives in `src/indexer/chunker.ts`. After `collectSections` produces a section, classify by walking its already-parsed children: count nodes whose `type === "list"` (top-level lists) vs other root children, weighted by the count of child list items. If `listItems / nonBlankRootChildren ≥ 0.7`, the section is `flat-list`.
- **Per-bullet chunking** reuses the existing `splitLongSection` for individual oversized bullets. For each list-item, serialize its node back via `processor.stringify` (we already use the same trick for sections).
- **`embed_text`** is built once per chunk in the chunker and stored on the `Chunk` interface. The pipeline reads it; the store persists it.
- **Pipeline version sidecar** lives next to the LanceDB directory so it travels with the data. Reading and writing is plain `Bun.file` / `Bun.write` — no schema state in LanceDB itself, which means the rebuild path is just "delete tables, run scanner."

### Decisions

- **`embed_text` as a stored column, not derived at query time.** Storage cost is ~50–200 bytes per chunk (negligible) and 0008's FTS index needs to be built on a stable, persisted column. Deriving at embed-time AND keeping FTS on raw `text` would mean lexical search misses path/heading hits — the exact failure mode this change exists to fix.
- **Pipeline version as integer, sidecar file.** Simpler than baking it into the LanceDB table metadata (which the JS SDK does not expose ergonomically). Sidecar is one file, one read, one write.
- **Drop-and-rebuild on upgrade, not in-place migration.** Re-chunking changes chunk identity (new IDs, new bodies). An in-place migration would be more code than the rebuild and risks split-brain if it crashes mid-way. Initial scanner already exists and does the right thing.

### Non-Goals

- Hybrid retrieval, FTS index, MMR, threshold — all in 0008.
- Embedder swap (e.g. `bge-small-en-v1.5`) — separate change, separate dim mismatch.
- Eval harness as a hard CI gate — defer until the seed set is large enough.

## Tasks

- [x] **Flat-list classifier** — detection + per-bullet emission in `src/indexer/chunker.ts`. Unit tests cover: pure prose, pure flat-list, mixed (just-under-threshold), oversized bullet, empty section.
- [x] **`embedText` composition** — add to `Chunk` interface; populate in chunker. Unit test: empty heading path omits the heading line.
- [x] **Schema + store** — add `embed_text` column to `makeSchema`; persist via `rowToInsert`; ensure `mergeInsert` carries it. Update `openVaultStore` typing where needed.
- [x] **Pipeline version sidecar** — `PIPELINE_VERSION` constant + read/write helpers in `src/indexer/store.ts` (or new `src/indexer/version.ts`). Drop logic in `startIndexer` runs before any `openVaultStore` call.
- [x] **Pipeline rewires** — `src/indexer/pipeline.ts` calls embedder with `embedText` array, not `text`.
- [x] **Re-embed end-to-end** — integration test: write a `Bun.tmpdirSync()` vault with one flat-list file + one prose file, start indexer, assert chunk counts and that `embed_text` rows include the path prefix.
- [x] **Sidecar mismatch tests** — old → new triggers rebuild; new → old exits non-zero.
- [x] **Eval harness** — `test/relevance/eval.ts` with seed queries and a tiny fixture vault. Recall@1 / recall@5 / MRR computed and logged. Advisory only.
- [x] **Parity test fixtures** — regenerate `test/parity/` snapshots for any test that captures concrete search hits; review diff for behavior shifts.
- [x] **Spec status flip** — same PR flips `0007` to `complete` in `docs/index.yml` and `docs/index.md`.

## Open Questions

- **Headed flat-list bullets.** Some bullets have their own headings (`### Subsection`) intermixed with siblings. **Default**: treat any heading inside the section as a hard split — falls back to the prose path for that segment. Revisit if it shows in eval failures.
- **Bullet ordering vs document ordering.** Is preserving document order important for search ranking? **Default**: yes; chunk index assigned in document order so MMR's tie-breaks remain stable.
- **Embed-text separator.** `\n\n` between heading-path and body is a guess. Some embedders prefer `[SEP]`-style markers. **Default**: `\n\n` for `Xenova/all-MiniLM-L6-v2` and the OpenAI provider; revisit per-provider if eval shows wins.

## References

- Spec: [Vault Indexer › Chunker](../specs/vault-indexer/index.md#chunker)
- Spec: [Vault Indexer › LanceDB store](../specs/vault-indexer/index.md#lancedb-store)
- Follow-up: [Change 0008 — Search relevance](./0008-search-relevance.md)
- Eval methodology context: 2026-05-03 production vault tests against the `v` vault

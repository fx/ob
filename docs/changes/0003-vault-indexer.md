# 0003: Vault Indexer

## Summary

Implement the chokidar watcher, Markdown chunker, embedding provider abstraction (Transformers.js default, OpenAI-compatible optional), and the per-vault LanceDB store with initial-scan + incremental updates. After this PR the on-disk vault is searchable in-process — but only the indexer module exposes the API; REST/MCP wiring lands in 0004/0005.

**Spec:** [Vault Indexer](../specs/vault-indexer/)
**Status:** complete
**Depends On:** 0002

## Motivation

Search is the headline capability of this server. Splitting it from the REST layer keeps the module testable in isolation and makes both the embedding swap and the storage swap a one-file change.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint)). CI enforces these as merge gates:

- All tests run under `bun test`; coverage MUST stay at 100% line + branch on `src/`.
- Integration tests MUST exercise a real LanceDB store rooted at `Bun.tmpdirSync()` — mocking the store is forbidden, since the schema and round-trip are exactly what we need to validate.
- The default Transformers.js embedder MAY be exercised end-to-end in one slow test (gated by `INDEXER_E2E=1`) that downloads the model. Default suite MUST use a deterministic fake embedder that returns repeatable vectors so search-ranking tests are stable.
- The OpenAI provider MUST be tested by injecting a `fetch` fake — no real network calls.
- Watcher tests MUST use real `fs` writes against tmp dirs; no mocking of `chokidar`.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Watcher

- `src/indexer/watcher.ts` MUST wrap chokidar, applying ignore rules from the spec (`/.obsidian/`, `/.trash/`, dotfiles, non-Markdown extensions) and a 250 ms per-path debounce.
- The watcher MUST emit typed events: `{ kind: "upsert" | "remove", absPath, relPath }`.
- The watcher MUST tolerate `add` storms during initial scan without dropping events (no in-flight cap; debouncer collapses duplicates).

#### Scenario: Hidden file ignored

- **GIVEN** a watched tmp vault root
- **WHEN** `<root>/.obsidian/workspace.json` is written
- **THEN** no event is emitted within 1 s

#### Scenario: Debounce coalesces

- **GIVEN** a watched tmp vault root
- **WHEN** `<root>/notes/x.md` is written 5 times in 100 ms
- **THEN** exactly one `upsert` event is emitted within 500 ms

### Initial scan

- `src/indexer/scanner.ts` MUST walk the vault root (excluding the same paths as the watcher), compute sha256 of every Markdown file, and skip files whose sha256 matches the latest indexed row.
- Concurrency MUST be capped (default 4 in flight).
- Scan completion MUST resolve a per-vault "ready" promise that `/readyz` consumes.

### Chunker

- `src/indexer/chunker.ts` MUST parse a Markdown buffer with `micromark`/`remark` (decision: `remark` because we need AST traversal for headings + frontmatter + wikilinks in one pass).
- Splits at heading boundaries; sections > 1500 chars split at paragraph boundaries within the section.
- Output: `Chunk[]` where each `Chunk = { index, headingPath, text, frontmatter, links, tags }`.
- Wikilinks (`[[Name]]`, `[[Name|alias]]`, `[[Name#section]]`) MUST be extracted as their normalized target name.
- Inline tags (`#foo`, `#foo/bar`) MUST be extracted; tags inside fenced code blocks MUST NOT be extracted.

#### Scenario: Long section split

- **GIVEN** a Markdown file with one heading and a 4000-char section beneath it
- **WHEN** chunked
- **THEN** ≥ 3 chunks are produced
- **AND** each chunk's `headingPath` is identical
- **AND** no chunk's `text` exceeds 1500 chars

#### Scenario: Wikilink + tag extraction

- **GIVEN** body `See [[Foo|the foo]] about #brewing/pour-over.`
- **WHEN** chunked
- **THEN** the chunk's `links` contains `"Foo"`
- **AND** the chunk's `tags` contains `"brewing/pour-over"`

#### Scenario: Tag inside code block ignored

- **GIVEN** body `\`\`\`\n# not a tag\n#also not\n\`\`\`\n`
- **WHEN** chunked
- **THEN** the chunk's `tags` is empty

### Embedder

- `src/embeddings/index.ts` MUST select the provider from `cfg.embeddingProvider`.
- Both providers MUST satisfy `interface Embedder { dim: number; embed(texts: string[]): Promise<Float32Array[]> }`.
- Transformers.js provider MUST lazy-load the model on first call and cache to `cfg.dataDir + "/models"` via the HF env var (`TRANSFORMERS_CACHE` or `HF_HOME`).
- OpenAI provider MUST batch ≤ 96 inputs per request and back off on 429/5xx (1s, 2x, cap 30s, max 5).

### Store

- `src/indexer/store.ts` MUST open one LanceDB database at `<DATA_DIR>/lancedb/`, with one table per vault slug.
- Schema as defined in the spec.
- On `upsert(path, chunks)`: delete by `path`, then insert all new chunks. The delete + insert MUST be a single LanceDB transaction.
- On `drop(path)`: delete by `path`.
- On `search(query, opts)`: embed query → vector search → optional `pathPrefix` and `tag` filter → top `limit` ordered by score.
- A vector index MUST be created the first time the table reaches ≥ 256 rows (one-shot, non-blocking).

### Public surface

- `src/indexer/index.ts` MUST export `startIndexer(cfg, sup): Promise<Indexer>` matching the spec's interface.
- It MUST verify each table's vector dimension against the embedder's `dim` on open and exit non-zero on mismatch.
- It MUST expose `reindex(slug, path)` and `drop(slug, path)` for the REST layer to call after writes/deletes.

#### Scenario: Round-trip search

- **GIVEN** a fake embedder that maps "coffee" → vector v1 and "tea" → vector v2 (orthogonal)
- **AND** vault contains `notes/a.md` (about coffee) and `notes/b.md` (about tea)
- **WHEN** the initial scan completes and `search("coffee", limit=2)` runs
- **THEN** `hits[0].path === "notes/a.md"`
- **AND** `hits[0].score > hits[1].score`

#### Scenario: Dimension mismatch on open

- **GIVEN** a LanceDB table previously created with 384-dim vectors
- **WHEN** `startIndexer` runs with a mocked embedder reporting `dim = 1536`
- **THEN** it throws an error whose message contains `384` and `1536`

## Design

### Approach

- Single in-process pipeline: watcher → batcher → embedder → store.
- The batcher is a small async generator that holds events for up to 100 ms or 32 chunks, whichever first.
- The pipeline runs in `Promise.all`-bounded fashion so a slow embedder slows but does not break indexing.

### Decisions

- **`remark` not regex** for Markdown: needed for correct fenced-code, frontmatter, and wikilink handling.
  - Alternatives: `markdown-it` (no plugin parity), hand-rolled regex (always wrong).
- **Per-vault table, not per-database**: vault scoping is the API's primary axis; one table per vault makes deletes and dimension changes vault-local.
- **Sha256 short-circuit instead of mtime-only**: file watchers fire on touch with no content change; sha256 keeps the embedder's bill honest.
- **No HNSW until 256 rows**: tiny vaults are fine with full scan; index build cost isn't worth it below threshold.

### Non-Goals

- No vault-write loopback suppression (relies on sha256 short-circuit).
- No incremental table compaction tuning.
- No reranker / hybrid BM25.

## Tasks

- [x] **Embedder interface + fake** — `src/embeddings/index.ts`, `src/embeddings/fake.ts` (test-only), tests.
- [x] **Transformers provider** — `src/embeddings/transformers.ts`, lazy load, model-cache env wiring; one slow E2E test gated by `INDEXER_E2E=1`.
- [x] **OpenAI provider** — `src/embeddings/openai.ts`, batching, backoff; tests with injected `fetch` fake.
- [x] **Markdown chunker** — `src/indexer/chunker.ts` + tests covering: heading splits, long-section sub-splits, frontmatter parse, wikilink extraction, tag extraction (incl. code-block exclusion).
- [x] **LanceDB store** — `src/indexer/store.ts` covering open, upsert (delete+insert), drop, search with filters; integration tests against tmp store.
- [x] **Initial scanner** — `src/indexer/scanner.ts` with sha256 short-circuit + concurrency cap; tests against a tmp vault.
- [x] **Watcher** — `src/indexer/watcher.ts` with ignore rules + debounce; tests with real fs writes.
- [x] **Pipeline + facade** — `src/indexer/pipeline.ts` and `src/indexer/index.ts` exposing the `Indexer` interface; integration test: write file → search returns it.
- [x] **Wire into server** — `src/server.ts` calls `startIndexer` after supervisor; `/readyz` waits on indexer ready too.
- [x] **Coverage 100%**.

## Open Questions

- [ ] **Bun fs.watch vs chokidar.** If chokidar misbehaves on Bun under Linux, switch to `Bun.fs.watch`. Smoke-test in this PR.
- [ ] **`@huggingface/transformers` package vs `@xenova/transformers`.** Upstream rebranded; check which has the latest model + better Bun compat. **Default**: `@huggingface/transformers`.
- [ ] **Frontmatter normalization.** YAML date types (`2026-05-03`) parse to `Date` objects which don't JSON-serialize round-trip. Decide whether to coerce to ISO strings on store. **Default**: ISO strings.

## References

- Spec: [Vault Indexer](../specs/vault-indexer/)
- Related changes: [0002-obsidian-supervisor](./0002-obsidian-supervisor.md)
- [LanceDB JS reference](https://lancedb.github.io/lancedb/js/globals/)
- [Transformers.js](https://huggingface.co/docs/transformers.js)

# Vault Indexer

## Overview

The vault indexer watches each on-disk vault directory for Markdown changes, splits notes into semantic chunks, embeds those chunks with a pluggable embedding provider, and stores the result in an embedded LanceDB table — one table per vault. It is the read path behind natural-language search and keeps itself eventually consistent with the working tree owned by `ob sync`.

In v1 the indexer covers Markdown only (`.md` / `.markdown`). Binary files (images, PDFs, audio, attachments) are stored on disk and round-tripped through `ob sync` and the REST `files` surface, but they are NOT embedded or returned by `search`. Image/PDF embeddings are a future change.

## Background

- LanceDB is an embedded vector store usable directly from TypeScript via `@lancedb/lancedb`. There is no separate database process.
- For v1 the default embedder MUST be `Xenova/all-MiniLM-L6-v2` via `@huggingface/transformers` (Transformers.js), 384-dim, fully in-process. OpenAI-compatible HTTP embedders MUST be selectable via env (`EMBEDDING_PROVIDER=openai`).
- Related specs: [Architecture](../architecture/), [Obsidian Sync](../obsidian-sync/), [REST API](../rest-api/).

## Requirements

### Watcher

- For each configured vault, the indexer MUST watch `<DATA_DIR>/vaults/<slug>/` recursively with `chokidar` (or the Bun-native equivalent if it covers add/change/unlink semantics on Linux — to be confirmed in Change 0003).
- The watcher MUST ignore: any path containing a `/.obsidian/` segment, any path containing a `/.trash/` segment, any path beginning with `.`, and any file whose extension is not `.md` or `.markdown`.
- The watcher MUST coalesce events on the same path within a 250 ms debounce window.
- The watcher MUST handle `add`, `change`, and `unlink` events. Renames MUST be observable as `unlink` followed by `add` (chokidar default).

#### Scenario: New note created

- **GIVEN** the indexer is running for vault `v`
- **WHEN** a file `/data/vaults/v/notes/foo.md` is written
- **THEN** within 1s, a row set for `path = "notes/foo.md"` exists in the `v` LanceDB table

#### Scenario: Note deleted

- **GIVEN** previously indexed `notes/foo.md`
- **WHEN** the file is deleted
- **THEN** within 1s, all rows where `path = "notes/foo.md"` are removed from the `v` table

#### Scenario: Hidden file ignored

- **GIVEN** the indexer is running
- **WHEN** `/data/vaults/v/.obsidian/workspace.json` is written
- **THEN** no LanceDB write occurs and no embedder call is made

### Initial scan

- On startup (after `ob sync-setup` succeeds for a vault), the indexer MUST perform an initial scan of the vault directory.
- The scan MUST compare each file's `mtime_ms` and `sha256` against the latest indexed row for that path. Files whose `sha256` matches MUST be skipped (no embedding call).
- The scan MUST run with bounded concurrency (default 4 files in flight) to avoid swamping the embedder.
- The scan MUST mark `/readyz` as ready for that vault only after the initial scan completes.

#### Scenario: Restart with no changes

- **GIVEN** a vault that was fully indexed before the previous shutdown
- **WHEN** the process restarts
- **THEN** the initial scan completes without invoking the embedder
- **AND** `/readyz` reports 200 within seconds

### Chunker

- The chunker MUST split a Markdown note into chunks rooted at headings.
- Each chunk MUST contain: the heading-path (e.g. `["H1 Title","H2 Subsection"]`), the chunk body text, and the chunk index within the file.
- A chunk's text MUST NOT exceed 1500 characters. If a heading section exceeds the limit, the section MUST be split into multiple chunks at paragraph boundaries.
- A section whose root-level children are ≥ 70% top-level list items of a single list MUST be treated as a **flat-list section**. For flat-list sections, each top-level list item (together with its nested children) MUST become its own chunk rather than being packed with sibling bullets into a single ≤1500-char chunk. A single top-level item that itself exceeds 1500 chars MUST fall back to the paragraph-boundary splitter. This rule prevents per-bullet signal dilution in task-list / inbox / daily-log files where unrelated bullets share a heading.
- Frontmatter (YAML between `---` fences at the top) MUST be parsed out and stored on each chunk as `frontmatter` (object), but MUST NOT be embedded.
- Wikilink targets (`[[Note Name]]`) and inline tags (`#tag`) MUST be extracted and stored on each chunk for filtered search.
- Each chunk MUST carry an `embedText` field — the text that is sent to the embedder AND indexed for full-text search. `embedText` MUST be composed as `<path>\n<headingPath joined by " > ">\n\n<text>` (heading-path line omitted when empty). The plain `text` field MUST remain the body alone so search hits return clean snippets. `embedText` is what the FTS index in [Search relevance](#search-relevance) tokenizes, so path tokens (e.g. `Alice` in `entities/Alice Example.md`) and heading tokens (e.g. `Tasks > Work`) become first-class lexical signal.

### Embedder

- The embedder MUST expose one async function: `embed(texts: string[]): Promise<Float32Array[]>` returning vectors of provider-fixed dimension.
- The provider abstraction MUST live in `src/embeddings/` with one file per provider.
- The default provider (`transformers`) MUST load `Xenova/all-MiniLM-L6-v2` via `@huggingface/transformers`, cache to `<DATA_DIR>/models/`, and run on CPU.
- The OpenAI provider MUST POST to `${OPENAI_BASE_URL ?? "https://api.openai.com"}/v1/embeddings` with `model = EMBEDDING_MODEL`, batched at ≤ 96 inputs per request, and exponentially back off on 429/5xx (initial 1s, factor 2, cap 30s, max 5 attempts).
- The embedder MUST batch chunks coming from the watcher: if multiple chunks arrive within a 100 ms window, they MUST be sent in a single `embed` call.

### LanceDB store

- One table per vault, named by slug, located under `<DATA_DIR>/lancedb/`.
- The table schema MUST be:

```text
id            string   PK   (path + "#" + chunk_index)
path          string        (relative to vault root, forward slashes, no leading slash)
chunk_index   int32
heading_path  list<string>
text          string        (display body; what hit snippets render)
embed_text    string        (composed: path + heading_path + text; embedded AND FTS-indexed)
frontmatter   string        (JSON-serialized object; empty string if none)
links         list<string>  (wikilink targets)
tags          list<string>
mtime_ms      int64
sha256        string        (sha256 of full note bytes)
vector        fixed_size_list<float32, DIM>
```

- `DIM` MUST be a constant per-provider (384 for default). Switching providers requires recreating the table; the indexer MUST detect a dimension mismatch on open and error out with a clear message naming both dims.
- The chunker pipeline is versioned. The indexer MUST persist a `pipeline_version` integer alongside the LanceDB store (sidecar file `<DATA_DIR>/lancedb/.pipeline_version` is RECOMMENDED). On open, a mismatch between the on-disk version and the code's current version MUST trigger a full re-chunk + re-embed of every vault — drop the per-vault tables and rebuild from the working tree. This is how a chunker change ships safely without manual operator intervention.
- A vector index MUST be created on `vector` once a vault has ≥ 256 rows.
- A full-text index MUST be created on `embed_text` once a vault has ≥ 256 rows. The tokenizer MUST be `simple` with `lowercase`, English `stem`, and `removeStopWords` enabled. See [Search relevance](#search-relevance) below.
- Updates to a path MUST be performed as: `DELETE WHERE path = ?` then `INSERT` the new chunks. Updates MUST be transactional from the perspective of search (no partial result visible).

#### Scenario: Provider switch detected

- **GIVEN** a LanceDB table created with 384-dim vectors
- **WHEN** the process restarts with `EMBEDDING_MODEL=text-embedding-3-small` (1536-dim)
- **THEN** the indexer logs `embedding dimension mismatch: table=384 provider=1536` and exits non-zero
- **AND** does not write any rows

### Search relevance

Pure-vector retrieval over a 384-dim local model (`Xenova/all-MiniLM-L6-v2`) underperforms on two query shapes that real users hit constantly:

1. **Proper-noun / verbatim queries** ("Promote Alice to Principal next year") where lexical match exists but semantic overlap is low.
2. **Single-source dominance** where a query about one topic returns 6–7 chunks of one file, hiding other relevant files.

The indexer MUST address these via four cooperating mechanisms.

#### Hybrid retrieval

- `Indexer.search` MUST support three retrieval modes selected by an `opts.mode` argument: `"hybrid"` (default), `"vector"`, `"fts"`.
- In `hybrid` mode the indexer MUST execute a vector search and a full-text search (over `embed_text`) in parallel, then fuse the two ranked lists via Reciprocal Rank Fusion (RRF, k=60). LanceDB's bundled RRF reranker (`@lancedb/lancedb/rerankers/rrf`) MAY be used.
- Both arms MUST return up to `max(60, 3 × limit)` candidates so the fusion has headroom before the final cut.
- The fused score MUST be exposed as `SearchHit.score` (already in `(0, 1]`); per-arm scores MAY be exposed in `SearchHit.scores` (object keyed by arm name) for debugging.
- `vector` and `fts` modes MUST execute only their named arm — useful for evaluation and for clients that need one-or-the-other behavior.

#### Diversification (MMR)

- The fused candidate list MUST be diversified via Maximal Marginal Relevance before the final `limit` cut. The diversification axis MUST be source `path` (so multiple chunks of one file compete with each other for slots).
- The MMR mixing parameter MUST default to `λ = 0.5` and MUST be tunable via `opts.mmrLambda` (range `[0, 1]`; `1` = pure relevance, `0` = pure diversity).
- A single `path` MUST NOT contribute more than `opts.maxPerPath` hits (default 3) in the returned list.

#### Score threshold

- `Indexer.search` MUST accept `opts.threshold` (range `[0, 1]`). Hits with `score < threshold` MUST be dropped from the returned list.
- The default threshold MUST be `0` (no filtering). Callers wanting confident-only results pass an explicit value.
- The threshold MUST apply AFTER fusion and MMR (so it gates the final ordering, not raw arm scores).

#### Scenario: Verbatim query lands on the verbatim chunk

- **GIVEN** indexed `self/tasks.md` containing the line `Promote Alice to Principal next year`
- **WHEN** the client searches `mode: "hybrid"`, `query: "promote Alice to Principal next year"`
- **THEN** the top-1 hit's `path` is `self/tasks.md`
- **AND** its `text` contains the verbatim line

#### Scenario: MMR caps per-source dominance

- **GIVEN** a query whose vector arm would return 8 chunks of `acme/2026/reviews/manager/alice-example.md` in the top 10
- **WHEN** the client searches with default `maxPerPath: 3`
- **THEN** the returned list contains at most 3 chunks of that file
- **AND** at least 4 distinct `path` values appear

#### Scenario: Threshold filters low-confidence noise

- **GIVEN** a query whose post-fusion top scores are all `< 0.5`
- **WHEN** the client passes `threshold: 0.5`
- **THEN** the response `hits` is `[]`
- **AND** the response is not an error

### Public surface

```ts
interface IndexerStatus {
  slug: string;
  state: "starting" | "scanning" | "ready" | "failed";
  documents: number;
  chunks: number;
  lastIndexedAt: number | null;
  pending: number;
  errors: number;
}
interface SearchHit {
  path: string;
  chunkIndex: number;
  headingPath: string[];
  text: string;
  score: number;
  scores?: { vector?: number; fts?: number };
  frontmatter: Record<string, unknown>;
  links: string[];
  tags: string[];
}
type SearchMode = "hybrid" | "vector" | "fts";
interface SearchOptions {
  limit?: number;
  filter?: { tag?: string; pathPrefix?: string };
  mode?: SearchMode;            // default "hybrid"
  threshold?: number;           // default 0
  mmrLambda?: number;           // default 0.5
  maxPerPath?: number;          // default 3
}
interface Indexer {
  status(slug: string): IndexerStatus | null;
  list(): IndexerStatus[];
  search(slug: string, query: string, opts?: SearchOptions): Promise<SearchHit[]>;
  reindex(slug: string, path: string): Promise<void>;
  drop(slug: string, path: string): Promise<void>;
  stop(): Promise<void>;
}
```

- `search` MUST return at most `limit ?? 20` hits ordered by descending fused score (after MMR and threshold).
- `reindex` and `drop` are imperative hooks called by REST writes/deletes — they let the API skip waiting for the chokidar debounce when the API itself was the writer.

## Design

### Architecture

```text
src/indexer/
  index.ts        # public Indexer factory
  watcher.ts      # chokidar wrapper, debounce, ignore rules
  scanner.ts      # initial directory walk + sha256 diff
  chunker.ts      # markdown → chunks
  store.ts        # LanceDB open, schema, upsert, delete, search
  pipeline.ts    # path → chunks → vectors → upsert
src/embeddings/
  index.ts        # provider selection from env
  transformers.ts # local Xenova model
  openai.ts       # OpenAI-compatible HTTP
```

### Pipeline

```text
fs change ──▶ debounce ──▶ read+hash ──▶ unchanged? skip
                                    │
                                    ▼
                                 chunker ──▶ batcher ──▶ embedder ──▶ store.upsert
fs unlink ─────────────────────────────────────────────────────────▶ store.delete
```

### Error handling

- A single bad file (parse error, embedder error after retries) MUST NOT halt the watcher. It MUST be logged, counted in `IndexerStatus.errors`, and the pipeline MUST continue.
- LanceDB write errors MUST be retried 3× with linear backoff. If still failing, the vault transitions to `failed`.

## Constraints

- The default embedder MUST run with no external network call after the initial model download.
- Per-call embedder latency MUST NOT block HTTP request handling — search is allowed to take whatever time the embedder needs (one call to embed the query), but indexing MUST happen on background tasks.
- Memory: a single in-flight scan MUST NOT load the entire vault into memory. Files MUST be processed one at a time (with concurrency `n=4`).

## Open Questions

- **Chokidar under Bun.** Chokidar uses Node fs.watch APIs. Bun ships compatibility shims; we need a smoke test before committing. **Default**: chokidar; fall back to `Bun.fs.watch` if compatibility breaks.
- **Re-chunking on Markdown spec edge cases.** Setext headings, malformed frontmatter, fenced code blocks containing `#`, etc. **Default**: use `remark`/`micromark` for parsing rather than regex.
- **Self-write loopback.** When the REST API writes a file, chokidar will fire. The pipeline already short-circuits on unchanged sha256, but we may also want to mark API writes as "indexer-handled" to skip the watcher entirely. **Default for v1**: rely on sha256 short-circuit; revisit if it shows in profiles.

## References

- [LanceDB JS reference](https://lancedb.github.io/lancedb/js/globals/)
- [Transformers.js](https://huggingface.co/docs/transformers.js)
- [OpenAI Embeddings API](https://platform.openai.com/docs/api-reference/embeddings)

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-05-03 | Initial spec created | — |
| 2026-05-03 | Chunker: flat-list-section heuristic + `embed_text` composition. Schema adds `embed_text` column. Pipeline-version sidecar drives full re-embed on chunker change. | [Change 0007](../../changes/0007-indexer-relevance.md) |
| 2026-05-03 | New "Search relevance" section: hybrid retrieval (vector + FTS via RRF), MMR diversification, score threshold. Indexer interface gains `mode`, `threshold`, `mmrLambda`, `maxPerPath`. | [Change 0008](../../changes/0008-search-relevance.md) |

# 0021: List Tags

## Summary

Add tag listing: `Indexer.tags()`, REST `GET /v1/vaults/:slug/tags`, and the read-only MCP tool `list_tags`, reporting the inline tags in a vault's index with distinct-document counts. Implements [Vault Indexer › Tag listing](../specs/vault-indexer/index.md#tag-listing), [REST API › Tags](../specs/rest-api/index.md#tags), and the `list_tags` row of [MCP Server › Tool surface](../specs/mcp-server/index.md#tool-surface).

**Spec:** [Vault Indexer](../specs/vault-indexer/), [REST API](../specs/rest-api/), [MCP Server](../specs/mcp-server/)
**Status:** draft
**Depends On:** 0008, 0014, 0018

## Motivation

`search` accepts `filter.tag`, but nothing tells a client which tags exist. An agent filing a note has to guess at the vault's tag vocabulary, and usually invents near-duplicates of tags already in use. The index already stores every chunk's inline tags (`tags` column, `src/indexer/store.ts`), so listing them needs no new extraction.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint)). CI enforces these as merge gates:

- The 100% line + branch coverage gate on `src/` MUST hold (`bun run test:cov`). New code without tests is a defect. Codecov does not report on this repo; the in-CI coverage check is the gate.
- The store method MUST be tested against a real LanceDB store in a `Bun.tmpdirSync()` directory, per the architecture spec — no mocked store.
- Route tests MUST go through the real Hono app; MCP tests through the real registry.
- A parity test under `test/parity/` MUST assert identical `list_tags` / `GET /tags` payloads and error `code`s for the same fixture vault.
- `test/mcp/server.test.ts`'s exact `readOnlyHint` set MUST include `list_tags`.
- Biome and `bunx tsc --noEmit` MUST pass; suppression comments MUST carry a same-comment justification. No `.skip` / `.only`.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Behavior owned by the specs

[Vault Indexer › Tag listing](../specs/vault-indexer/index.md#tag-listing) owns what is reported, counting, ordering, `total`, and the prefix filter, with its scenarios as acceptance criteria; [REST API › Tags](../specs/rest-api/index.md#tags) the route and query validation; [MCP Server](../specs/mcp-server/index.md#tool-surface) the tool input, description, read-only hint, and scoped-session rule.

### What this change owns

- **Scoped sessions.** The scoped indexer wrapper in `src/mcp/scope.ts` MUST translate `tags()` the way it translates `search`: force a `pathPrefix` of `<scope>/` in a non-root scope, nest a caller-supplied prefix under it after validating it, and never pass the caller's prefix through unnested.
- **Indexer surface.** `tags` is added to the `Indexer` interface and to every implementation and fake (`src/indexer/index.ts`, the scope wrapper, test fakes); an unknown vault surfaces `vault_not_found`, matching `search`.

## Design

`VaultStore.tagCounts(pathPrefix?)` scans `path` and `tags` with LanceDB's `query().select(["path", "tags"])`, applying `starts_with(path, …)` the way `search` does, and builds a `Map<tag, Set<path>>` in TypeScript — the same scan-and-dedupe approach `documentCount()` already takes, for the same reason (no `COUNT DISTINCT` over a list column in the JS SDK) and with the same vault-size bound. The indexer sorts, applies `limit`, and returns `total`. A service-core function `listTags` in `src/vault/tags.ts` resolves the vault and calls it, and both adapters call that function. Schemas `ListTagsQuery` / `ListTagsInput` / `ListTagsResponse` live in `src/schemas/tags.ts`.

### Decisions

- **Decision:** Report only stored inline tags; frontmatter `tags:` properties are not included.
  - **Why:** It keeps the invariant the spec states — every listed tag is a working `search` `filter.tag` value with the listed count. Including frontmatter tags would list tags that `filter.tag` cannot find, because the chunker does not store them in `tags`.
  - **Alternatives considered:** Merge frontmatter tags into the chunker's `tags`. Deferred: it changes what `filter.tag` matches and needs a pipeline-version bump (a full re-index of every vault); worth its own change if requested.
- **Decision:** No roll-up of nested tags into parents.
  - **Why:** Same invariant: `filter.tag: "project"` does not match chunks tagged `project/alpha`, so a rolled-up count for `project` would overstate what search returns. Clients can aggregate with the `/` hierarchy themselves.
  - **Alternatives considered:** Obsidian's tag pane roll-up. Rejected for the mismatch above.
- **Decision:** Case-sensitive, as stored.
  - **Why:** `filter.tag` is a case-sensitive `array_contains`. Obsidian treats tags case-insensitively in its tag pane; case-folding here without folding the filter would break the invariant.
- **Decision:** `limit` plus `total`, no cursor.
  - **Why:** A count-ordered list has no stable cursor under concurrent indexing, and tag vocabularies are small enough that `limit: 1000` covers them.

### Non-Goals

- Frontmatter tags, case-folding, nested roll-up (see Decisions).
- Tag rename or merge operations.

## Tasks

- [ ] `VaultStore.tagCounts(pathPrefix?)` in `src/indexer/store.ts`; real-LanceDB tests including multi-chunk documents, literal prefix with SQL wildcard characters, and an empty table
- [ ] `Indexer.tags()` in `src/indexer/index.ts` (sort, limit, total, unknown vault); tests for both spec scenarios
- [ ] Scoped wrapper translation in `src/mcp/scope.ts`; tests for root scope, folder scope, nested caller prefix, invalid caller prefix
- [ ] `src/vault/tags.ts` service function and `src/schemas/tags.ts` schemas with tests
- [ ] `GET /v1/vaults/:slug/tags` route and tests (validation → `invalid_query`)
- [ ] `src/mcp/tools/list_tags.ts` (read-only) registered in `src/mcp/index.ts`; tool tests; registry and `readOnlyHint` assertions updated
- [ ] Parity test `test/parity/list_tags.test.ts`
- [ ] README gains `list_tags` and the route
- [ ] Tracking: tick this list, set Status to complete, sync `docs/index.yml` / `docs/index.md`

## References

- Spec: [Vault Indexer › Tag listing](../specs/vault-indexer/index.md#tag-listing), [REST API › Tags](../specs/rest-api/index.md#tags)
- Related changes: [0003 — Vault indexer](0003-vault-indexer.md) (tag extraction), [0008 — Search relevance](0008-search-relevance.md) (`filter.tag`), [0014 — MCP folder scoping](0014-mcp-folder-scoping.md)

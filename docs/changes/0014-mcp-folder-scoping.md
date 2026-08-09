# 0014: MCP Folder Scoping

## Summary

Make the MCP mount scopeable by URL: `POST /mcp/<slug>/<prefix...>` binds the session to one vault and one folder prefix, and presents that prefix to the client as if it were the vault root. `/mcp` (unscoped) is unchanged. A scoped session can read, write, list, and search only inside its prefix, and every path it sees or sends is relative to that prefix — it never learns the prefix at all. Implements the Session scoping section newly added to the [MCP Server spec](../specs/mcp-server/index.md#session-scoping).

**Spec:** [MCP Server](../specs/mcp-server/)
**Status:** draft
**Depends On:** 0005, 0012

## Motivation

The intended use case is a **memory backend for LLM agents**: each agent gets a private folder (`agents/<id>/`) inside a shared vault, writes its notes there, and searches its own memory without seeing — or corrupting — anyone else's.

Today that is impossible. Every MCP tool takes a `vault` argument and addresses the whole vault root: `write_file { vault: "v", path: "anything/at/all.md" }` is always legal, `list_files` returns every file in the vault, and `search` ranks over every indexed chunk. Three concrete failures follow:

1. **Collision.** Two agents told (in their prompts) to keep memory in `agents/a/` and `agents/b/` are one hallucinated path away from writing over each other. Prompt-level convention is not a boundary; nothing rejects `agents/b/secrets.md` from agent `a`.
2. **Context pollution.** `search { query: "what did I decide about X" }` ranks over the operator's entire vault. An agent's own memory competes with thousands of unrelated notes, and unrelated notes leak into the agent's context window.
3. **Identity plumbing.** Without scoping, every agent prompt must carry its own folder name and every tool call must prefix it correctly, forever. The agent's id ends up embedded in note bodies, wikilinks, and search filters — where a later rename cannot reach it.

The obvious server-side fixes — an agent registry, per-agent credentials, service accounts — are explicitly rejected by the operator: they add a control plane, a database, and a lifecycle to a single-process server whose whole premise is that there isn't one. The MCP client configuration is trusted, and it is already per-agent (each agent has its own `mcpServers` entry). That makes the client's **connection URL** the natural place to carry the scope, with zero server-side state.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint)). CI enforces these as merge gates:

- The standing 100% line + branch coverage gate on `src/` MUST hold. CI runs `bun run test:cov` (which invokes `bun test --coverage` and `test/check-coverage.ts`). New code without tests is a defect.
- Scope-resolution unit tests MUST live in `test/mcp/scope.test.ts` and MUST drive the real `safeJoin` / `assertSafeRelativePath` / `assertNotSymlinkEscape` against real on-disk tmpdirs — no `fs` mocking, matching `test/vault/files.test.ts`.
- Route-level tests MUST go through the real Hono app (`app.fetch`) and the real MCP SDK transport, exactly as `test/mcp/transport.test.ts` does today. Every containment scenario below MUST assert BOTH the returned envelope AND the on-disk effect (nothing created, read, or removed outside the scope root).
- The existing unscoped `/mcp` tests and the `test/parity/` suite MUST continue to pass unchanged. Parity between REST and MCP is defined on the unscoped mount; a scoped mount has no REST counterpart in this change.
- Biome MUST pass with the project config; `bunx tsc --noEmit` MUST pass.
- `// @ts-expect-error`, `// biome-ignore`, and `// eslint-disable*` MUST carry a one-line same-comment justification.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Scope carrier and routing

The MCP sub-app MUST accept the scope as URL path segments after `/mcp`:

| Route | Meaning |
|---|---|
| `POST\|GET\|DELETE /mcp` | Unscoped. Behavior identical to today. |
| `POST\|GET\|DELETE /mcp/:slug` | Scoped to vault `:slug`, prefix empty (vault root). |
| `POST\|GET\|DELETE /mcp/:slug/*prefix` | Scoped to vault `:slug`, folder prefix `*prefix`. |

A client configures it exactly like any other HTTP MCP server:

```jsonc
{ "mcpServers": { "memory": { "type": "http", "url": "https://ob.example/mcp/v/agents/claude-1" } } }
```

Rules:

- The `prefix` segments MUST be percent-decoded, joined with `/`, stripped of any trailing `/`, and normalized by dropping empty and single-dot (`.`) segments before validation. Normalization is what makes `/mcp/v/agents/a`, `/mcp/v/agents/a/`, and `/mcp/v/agents/./a` one scope rather than three — they resolve to the same root, so they MUST produce the same scope key, or the per-scope memo and the session scope-match check below would treat aliases of one scope as distinct.
- A prefix that is empty after normalization (`/mcp/:slug`, or a prefix of only `.` / `/` segments) is the **vault-root scope**. It MUST be accepted, and it MUST NOT be passed to `assertSafeRelativePath` — that function rejects the empty string outright (`src/errors.ts:241-243`). The vault-root scope is exactly today's unscoped behavior narrowed to a single vault.
- Every non-empty normalized prefix MUST be validated with the existing `assertSafeRelativePath`. `..`, absolute paths, NUL bytes, hidden (leading-dot) segments, drive prefixes, and over-length paths MUST be rejected — the same closed set the file surface already rejects.
- An invalid prefix MUST be rejected with HTTP `400` and the JSON-RPC envelope `{ jsonrpc: "2.0", error: { code: -32000, message: "Bad Request: invalid MCP scope" }, id: null }`, matching the shape of the existing `rejectMissingSession` fast path in `src/mcp/index.ts`. No transport and no server instance may be allocated for a rejected scope.
- A `:slug` that is not a configured vault MUST be rejected with HTTP `404` and the same envelope shape carrying `message: "Not Found: unknown vault \"<slug>\""`. This is deliberately identical in shape to a mistyped-scope rejection so a scan of the URL space yields no more information than the already-public `GET /v1/vaults`.
- The scope root MUST be checked with `assertNotSymlinkEscape(scopeRoot, vaultRoot)` when the session is bound. `safeJoin` and the per-operation symlink guards only walk up to the root they are given, so a symlinked scope root would otherwise be invisible to every later check.
- The scope root MUST NOT be created eagerly. `walkVault` / `walkVaultFolders` already treat a missing root as empty, and `write_file` / `create_folder` create parents on first use, so a typo'd URL leaves no directory behind.

### Session binding

- The scope MUST be resolved from the URL on the `initialize` request and stored alongside the transport and server in the existing `SessionPair` (`src/mcp/index.ts`).
- Every subsequent request MUST compare the scope derived from ITS OWN URL against the scope stored on the looked-up `SessionPair`. A mismatch MUST be rejected exactly like an unknown session (HTTP `404`, `-32001`), and MUST NOT be served from the stored pair. Without this check a session id obtained on `/mcp/v/agents/a` would work verbatim on `/mcp/v/agents/b`, silently re-scoping an in-flight session.
- The tool registry and resource handler MUST be built once per distinct scope and memoized, not once per session. The memo MUST be bounded (evicting the least-recently-used entry beyond a fixed cap) — the key is client-controlled URL text, so an unbounded map is an unbounded allocation.

### Scoped service dependencies

A new module `src/mcp/scope.ts` MUST expose a single wrapper:

```ts
export interface McpScope {
  readonly slug: string;
  /** Vault-relative folder prefix, no leading or trailing "/". "" means the vault root. */
  readonly prefix: string;
}

export function scopeDeps(deps: McpRoutesDeps, scope: McpScope): McpRoutesDeps;
```

The returned deps MUST behave as follows. Everything below is achieved by wrapping the deps — no service-core function in `src/vault/` may be modified by this change.

#### Vault lookup

- `vault(s)` MUST return `null` for every `s !== scope.slug`, so any attempt to address another vault surfaces the existing `vault_not_found` error.
- `vault(scope.slug)` MUST return a descriptor with `root = join(vaultRoot, scope.prefix)` and an unchanged `slug` / `name`.

Because `listFiles`, `listFolders`, `readFile`, `writeFile`, `patchFile`, `appendFile`, `deleteFile`, `createFolder`, and `deleteFolder` all resolve through `resolveVault(deps, slug).root` and then `safeJoin` + `assertNotSymlinkEscape`, this single substitution confines all of them, keeps every emitted path scope-relative, and makes every pagination cursor scope-relative — with no changes at any call site.

#### Indexer translation

The indexer is per-vault and stores vault-relative paths, so the wrapper MUST translate at the boundary:

- `reindex(slug, path)` and `drop(slug, path)` MUST prepend the prefix before delegating.
- `search(slug, query, opts)` MUST force `filter.pathPrefix` to `` `${prefix}/` `` — **with the trailing slash**. `store.ts` filters with `starts_with(path, …)` (`src/indexer/store.ts:362`), so the bare prefix `agents/a` would also match `agents/ab/note.md`.
- A caller-supplied `filter.pathPrefix` MUST be validated with `assertSafeRelativePath` and joined UNDER the scope prefix, never used to replace it.
- Returned `SearchHit.path` values MUST have the prefix stripped before they reach the client. Any hit whose path does not start with the scope prefix MUST be dropped rather than returned unprefixed — a defensive filter, since a stale index entry is otherwise indistinguishable from an in-scope hit after stripping.

#### Status tools

- `list_vaults` MUST return only the scoped vault's summary.
- `vault_status` MUST return `vault_not_found` for any other slug.
- The `documents` / `chunks` / `pending` / `errors` counts remain **vault-wide** — they come from the indexer's per-vault runtime and there is no per-prefix accounting. The scoped `vault_status` tool description MUST say so explicitly, so an agent does not read the count as "my memory has N documents".

#### Implicit vault argument

In a scoped session the vault is already fixed by the URL, and an agent has no way to know its slug without calling `list_vaults` first. Therefore, in scoped registries only:

- The `vault` argument MUST become optional: when absent it MUST default to the scope slug.
- When present and equal to the scope slug it MUST be accepted; when present and different it MUST surface `vault_not_found`.
- The advertised `inputSchema` MUST reflect this by removing `"vault"` from the schema's `required` array for the scoped registry. This is a shallow transform of the already-plain JSON Schema object produced by `zodToJsonSchema`; the Zod schemas themselves MUST NOT be forked or duplicated.

#### Session instructions

The scoped per-session `Server` MUST be constructed with the SDK's `instructions` option set to a short statement that all paths are relative to a private root, that the vault argument may be omitted, and that nothing outside the root is reachable. This is how the agent learns its situation — tool descriptions MUST NOT be forked per scope.

### Error and leak rules

- Every error envelope produced in a scoped session MUST report scope-relative paths. The existing errors already echo the caller-supplied path (`InvalidPathError`, `DocNotFoundError`), and `toPosixRelative` in `src/vault/path.ts` computes against the root it is given, which is the scope root — so this holds by construction and MUST be asserted by tests.
- No response, error message, or log field surfaced to a scoped client may contain the absolute vault path or the scope prefix.
- No new error code is introduced. Out-of-scope addressing surfaces as the existing `invalid_path`, `not_found`, or `vault_not_found`.

### Resource surface

- `obvault://<slug>/<path>` URIs in a scoped session MUST carry scope-relative paths, and `resources/read` MUST accept only those. This follows from the deps wrapper (the handler is a pure adapter over `listFiles` / `readFile`) and MUST be asserted by tests rather than re-implemented.

### Out of scope for REST

The REST surface stays unscoped in this change. `test/parity/` continues to compare REST against the **unscoped** MCP mount.

#### Scenario: Scoped write lands under the prefix

- **GIVEN** a session initialized on `/mcp/v/agents/a`
- **WHEN** the client invokes `write_file` with `{ path: "memory.md", content: "hello" }` (no `vault` argument)
- **THEN** the response is not an error and `path` is `memory.md`
- **AND** the file exists on disk at `<vault>/agents/a/memory.md`
- **AND** the indexer received `reindex("v", "agents/a/memory.md")`

#### Scenario: Traversal out of the scope is rejected

- **GIVEN** a session initialized on `/mcp/v/agents/a`
- **AND** a file exists at `<vault>/agents/b/secret.md`
- **WHEN** the client invokes `read_file` with `{ path: "../b/secret.md" }`
- **THEN** the response is `isError: true` with `code: "invalid_path"`
- **AND** the message does not contain `agents/a` or any absolute path

#### Scenario: Sibling scopes are mutually invisible

- **GIVEN** files at `<vault>/agents/a/note.md` and `<vault>/agents/b/note.md`
- **WHEN** a session on `/mcp/v/agents/a` invokes `list_files` with `{}`
- **THEN** `items` is exactly `[{ path: "note.md", … }]`

#### Scenario: Prefix boundary is not a string prefix

- **GIVEN** files at `<vault>/agents/a/note.md` and `<vault>/agents/ab/other.md`
- **WHEN** a session on `/mcp/v/agents/a` invokes `list_files` and `search`
- **THEN** neither result contains anything derived from `agents/ab/other.md`

#### Scenario: Search is confined and scope-relative

- **GIVEN** an indexed vault where `agents/a/coffee.md` and `notes/coffee.md` both match a query
- **WHEN** a session on `/mcp/v/agents/a` invokes `search` with that query
- **THEN** every hit's `path` is scope-relative (`coffee.md`)
- **AND** no hit derives from `notes/coffee.md`
- **AND** the indexer received `filter.pathPrefix === "agents/a/"`

#### Scenario: Caller-supplied search filter nests under the scope

- **GIVEN** a session on `/mcp/v/agents/a`
- **WHEN** the client invokes `search` with `filter: { pathPrefix: "journal" }`
- **THEN** the indexer received `filter.pathPrefix === "agents/a/journal"`
- **AND** when the client passes `filter: { pathPrefix: "../b" }` the response is `isError: true` with `code: "invalid_path"`

#### Scenario: Only the scoped vault is visible

- **GIVEN** vaults `v` and `w` are configured
- **AND** a session on `/mcp/v/agents/a`
- **WHEN** the client invokes `list_vaults`
- **THEN** the result is a one-element array for `v`
- **AND** `vault_status { vault: "w" }` is `isError: true` with `code: "vault_not_found"`
- **AND** `read_file { vault: "w", path: "x.md" }` is `isError: true` with `code: "vault_not_found"`

#### Scenario: A session id cannot hop scopes

- **GIVEN** a session initialized on `/mcp/v/agents/a` returning `Mcp-Session-Id: S`
- **WHEN** a `tools/call` carrying `Mcp-Session-Id: S` is sent to `/mcp/v/agents/b`
- **THEN** the response is `404` with JSON-RPC error code `-32001`
- **AND** the call is not executed

#### Scenario: Malformed scope never allocates a session

- **GIVEN** an `initialize` request to `/mcp/v/../../etc`
- **WHEN** the server handles it
- **THEN** the response is `400` with JSON-RPC error code `-32000`
- **AND** no `Mcp-Session-Id` header is returned
- **AND** a subsequent `initialize` on a valid scope still succeeds

#### Scenario: Symlinked scope root is refused

- **GIVEN** `<vault>/agents/evil` is a symlink to `/etc`
- **WHEN** a client initializes a session on `/mcp/v/agents/evil`
- **THEN** the response is `400` with JSON-RPC error code `-32000`

#### Scenario: An empty scope is usable immediately

- **GIVEN** no directory exists at `<vault>/agents/new`
- **WHEN** a session on `/mcp/v/agents/new` invokes `list_files`
- **THEN** the result is `{ items: [], nextCursor: null }` — not an error
- **AND** a subsequent `write_file { path: "memory.md" }` creates `<vault>/agents/new/memory.md`

#### Scenario: Unscoped mount is unchanged

- **GIVEN** a session initialized on `/mcp`
- **WHEN** the client invokes any tool
- **THEN** the behavior, paths, and `vault`-argument requirement are byte-identical to the pre-change server

## Design

### Approach

The whole change lives in the MCP adapter. `src/vault/` is untouched, because the service core already funnels every filesystem operation through one root:

```ts
// src/mcp/scope.ts — the load-bearing 20 lines.
export function scopeDeps(deps: McpRoutesDeps, scope: McpScope): McpRoutesDeps {
  const inner = deps.vault(scope.slug);              // null → caller already rejected the scope
  const root = join(inner.root, scope.prefix);
  const under = (p: string): string => (scope.prefix === "" ? p : `${scope.prefix}/${p}`);
  const strip = (p: string): string | null =>
    scope.prefix === "" ? p : p.startsWith(`${scope.prefix}/`) ? p.slice(scope.prefix.length + 1) : null;

  return {
    ...deps,
    vault: (s) => (s === scope.slug ? { ...inner, root } : null),
    indexer: {
      reindex: (s, p) => deps.indexer.reindex(s, under(p)),
      drop: (s, p) => deps.indexer.drop(s, under(p)),
      search: async (s, q, opts) => {
        const hits = await deps.indexer.search(s, q, withScopedFilter(opts, scope));
        return hits.map((h) => ({ ...h, path: strip(h.path) })).filter((h) => h.path !== null);
      },
    },
  };
}
```

`safeJoin(root, rel)` then does all the containment work it already does — `..`, hidden segments, NUL, over-length, and the "resolves to the root itself" guard all fire against the *scope* root — and `assertNotSymlinkEscape(abs, root)` refuses any symlink between the scope root and the target. The only gap that scoping opens is the scope root itself, which the per-operation walk never inspects because it stops at the root it is handed; hence the one-time `assertNotSymlinkEscape(scopeRoot, vaultRoot)` at bind time.

Routing changes are confined to `buildMcpRoutes`: the three method handlers gain `/:slug` and `/:slug/*` variants, a `resolveScope(c)` helper that returns either an `McpScope` or a rejection `Response`, a `scopeKey` field on `SessionPair`, and an LRU-bounded `Map<scopeKey, { registry, resources }>`.

### Decisions

- **Decision:** Present the scope as a chroot (paths relative to the prefix) rather than filtering visible full paths.
  - **Why:** The agent never learns its own folder name, so the id cannot leak into note bodies, wikilinks, or search filters, and renaming an agent's folder does not invalidate anything it wrote. It also makes the prompt portable: the same memory prompt works for every agent with no per-agent path templating. Mechanically it is also the *smaller* change — one deps wrapper versus a rejection check plus result filtering at every list, search, and resource site.
  - **Alternatives considered:** **Visible full paths + reject out-of-prefix** — the agent must know and repeat `agents/<id>/` in every call, and every listing/search/resource result still needs filtering, so it is strictly more code for worse ergonomics. **A separate vault per agent** — `VAULTS_JSON` is operator-configured and each vault is a separate `ob sync` child process plus a separate LanceDB store; that is a heavyweight, operator-mediated lifecycle for what should be a folder.
- **Decision:** Carry the scope in the URL path.
  - **Why:** Every MCP client can configure a URL; not every client can set custom headers. The URL is also the one piece of configuration that is already per-agent, and it keeps the server stateless — no registry, no mapping table, nothing to provision.
  - **Alternatives considered:** **A custom header** (`X-Ob-Scope`) — equivalent in security terms, but client support is uneven and it splits the configuration across two fields. **Server-side env config** (`MCP_SCOPES_JSON`) — reintroduces exactly the registry the operator rejected, and requires a restart to onboard an agent. **A tool argument** (`scope: "agents/a"`) — self-selected by the model, therefore not a boundary at all.
- **Decision:** Bind the scope at `initialize` and reject session ids presented on a different scope path.
  - **Why:** The session id is the only credential the SDK carries after `initialize`. If it were accepted on any path, a leaked or guessed id would re-scope an existing session, and the pairing between a session's tool registry and its URL would become advisory. The check is one string comparison per request.
  - **Alternatives considered:** **Re-derive the scope per request and ignore the stored one** — makes the registry/scope pairing incoherent (the session's tools were built for a different root). **Namespace the session map by scope** — equivalent effect, but it turns a mismatch into a confusing "session not found" for the *same* id in two places rather than one explicit check.
- **Decision:** Force `filter.pathPrefix` with a trailing slash and nest any caller-supplied prefix under it.
  - **Why:** `starts_with(path, "agents/a")` matches `agents/ab/…`. The trailing slash is the difference between confinement and a near-miss that only shows up once someone creates a sibling folder with a prefix-colliding name.
  - **Alternatives considered:** Post-filtering hits in the wrapper only — still needed as a defensive second pass, but doing it *instead* of the store filter would silently shrink result sets below `limit` because the cap is applied inside the store.
- **Decision:** Make `vault` optional in scoped sessions by dropping it from the advertised `required` array.
  - **Why:** The vault is already determined by the URL; requiring the agent to name it forces a `list_vaults` round trip purely to learn a string the operator already wrote into the config.
  - **Alternatives considered:** **Keep `vault` required** — an avoidable round trip and an avoidable class of `vault_not_found` errors. **Fork the Zod schemas per scope** — duplicates every input schema for one optional field; the JSON Schema transform is a single shallow edit that cannot drift from the Zod source.
- **Decision:** Announce the scope through the SDK's `instructions` field, not through per-scope tool descriptions.
  - **Why:** Tool descriptions are process-wide values built once (`src/mcp/server.ts` header); forking them per scope would multiply the registry by the number of live scopes for a purely informational string. `instructions` is delivered once at `initialize`, which is exactly the lifetime of the fact.
  - **Alternatives considered:** Appending a sentence to each tool description — N strings rebuilt per scope to say the same thing once.
- **Decision:** Do not create the scope root eagerly.
  - **Why:** A typo'd URL would otherwise litter the operator's vault with empty folders that then sync to every device. Every write path already creates parents, and every read path already treats a missing root as empty.
  - **Alternatives considered:** `mkdir -p` at bind time — makes the folder immediately visible in Obsidian, at the cost of materializing every mistyped URL.

### Non-Goals

- **This is not an authentication or authorization boundary, and MUST NOT be described as one.** The server has no auth (see [MCP Server › Constraints](../specs/mcp-server/index.md#constraints)); anything that can reach `/mcp/v/agents/a` can also reach `/mcp` unscoped and address the entire vault. Scoping confines a *cooperating, trusted* client that was configured with a scoped URL. The prerequisite for making it a real boundary is a credential on the listener, which is tracked as the standing auth open question — not here.
- **No agent registry, service accounts, or per-agent credentials.** Explicitly rejected by the operator; the MCP client configuration is the trusted carrier.
- **No REST scoping.** The REST surface stays unscoped; the same `scopeDeps` wrapper could back a future scoped mount if demand appears.
- **No read-through / overlay scopes.** A scope is a closed box, not "write here, read everywhere". A read-only view of the wider vault alongside a private write root is a plausible follow-up and deliberately deferred.
- **No cross-scope sharing primitives.** No links, no copy-between-scopes, no shared subfolder.
- **No per-scope index, quotas, or accounting.** The LanceDB store stays per-vault; scoping is a filter over it. Per-scope document counts, size limits, and eviction are out of scope.
- **No scope-aware `tools/list_changed` notifications.** Vault membership is still fixed at startup.

## Tasks

- [x] **Docs: this change document + spec** (this PR)
  - [x] Add `docs/changes/0014-mcp-folder-scoping.md`
  - [x] Add the Session scoping section to `docs/specs/mcp-server/index.md`, extend its module layout, and note in Constraints that scoping is not an auth boundary
  - [x] Append a row to the MCP Server spec Changelog table
  - [x] Add this change to `docs/index.yml` (`status: draft`) and a row to the `docs/index.md` Changes table
- [ ] **Scope resolution + scoped deps: `src/mcp/scope.ts`**
  - [ ] `McpScope`, `parseScope(slug, prefixSegments)` — percent-decode, normalize (trailing `/`, empty and `.` segments), accept the empty result as the vault-root scope, validate everything else; returns a validated scope or a typed rejection (invalid prefix vs unknown vault)
  - [ ] `assertScopeRootSafe(scopeRoot, vaultRoot)` wrapping `assertNotSymlinkEscape`
  - [ ] `scopeDeps(deps, scope)` — vault lookup substitution, indexer `reindex` / `drop` prefixing, `search` filter forcing + hit stripping + out-of-scope hit rejection
  - [ ] `scopeStatusDeps(deps, scope)` — supervisor/indexer listings filtered to the scoped slug
  - [ ] Tests in `test/mcp/scope.test.ts` covering: prefix validation (`..`, leading `/`, hidden segment, NUL, over-length), alias normalization (`agents/a`, `agents/a/`, `agents/./a` → one scope key), empty prefix accepted as the vault-root scope, boundary non-collision (`agents/a` vs `agents/ab`), symlinked scope root, hit stripping, out-of-scope hit rejection, caller `pathPrefix` nesting and rejection
- [ ] **Routing + session binding: `src/mcp/index.ts`**
  - [ ] `/:slug` and `/:slug/*` variants on POST / GET / DELETE
  - [ ] `resolveScope(c)` returning an `McpScope` or a rejection `Response` (400 `-32000` invalid scope, 404 `-32000` unknown vault)
  - [ ] `scopeKey` on `SessionPair` + mismatch rejection (404 `-32001`)
  - [ ] LRU-bounded per-scope registry + resource-handler memo
  - [ ] Tests in `test/mcp/scope-routes.test.ts` covering every routing / session scenario above, asserting on-disk effects
- [ ] **Scoped tool surface**
  - [ ] Optional `vault` argument in scoped registries: default-injection plus the `required`-array transform on the advertised `inputSchema`
  - [ ] `instructions` on the scoped per-session `Server`
  - [ ] Scoped `vault_status` description stating that counts are vault-wide
  - [ ] Tests asserting `tools/list` schemas differ only in `required`, that omitted / matching / mismatched `vault` arguments behave per spec, and that `initialize` carries `instructions`
- [ ] **README**
  - [ ] Document the scoped mount URL form, the memory-per-agent use case, and the explicit "not an auth boundary" caveat

## References

- Spec: [MCP Server › Session scoping](../specs/mcp-server/index.md#session-scoping)
- Spec: [MCP Server › Constraints](../specs/mcp-server/index.md#constraints) — the standing "no auth in v1" constraint this change does not alter
- Related changes: [0005 — MCP server](./0005-mcp-server.md) (introduced the transport, session map, and tool registry this change extends), [0012 — Folder operations](./0012-folder-operations.md) (folder surface a scoped session inherits), [0008 — Search relevance](./0008-search-relevance.md) (`filter.pathPrefix` and the `starts_with` store filter this change forces)
- Code: `src/vault/path.ts` (`safeJoin`, `assertNotSymlinkEscape`), `src/indexer/store.ts:353-365` (`pathPrefix` → `starts_with` filter), `src/mcp/index.ts` (session map, fast-path rejections)
- External: [MCP specification — Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#streamable-http)

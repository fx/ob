# Architecture

## Overview

`ob` is a single-process Bun server packaged as a single Docker image. Inside that one process it (a) supervises the official `obsidian-headless` CLI to keep one or more Obsidian vaults bidirectionally synced to local disk, (b) embeds and indexes the on-disk vault into an in-process LanceDB store, and (c) exposes both a REST API and a Streamable HTTP/SSE MCP server so an LLM agent can CRUD documents and search them by natural language.

This spec covers project-level concerns only: runtime, layout, build, container topology, configuration surface, and the standing testing/lint conventions every other spec inherits. Feature behavior lives in the feature specs listed below.

## Background

- The repo is greenfield — no prior implementation. Every spec describes desired behavior and is currently unimplemented; the bootstrap change documents (0001–0006) bring the system into existence.
- Related specs:
  - [Obsidian Sync](../obsidian-sync/) — supervising `ob` and the on-disk vault layout
  - [Vault Indexer](../vault-indexer/) — chokidar → chunker → LanceDB pipeline
  - [REST API](../rest-api/) — HTTP CRUD + search surface
  - [MCP Server](../mcp-server/) — MCP HTTP/SSE transport mirroring REST

## Requirements

### Single-Process Topology

- The container MUST run exactly one long-lived Bun process as PID 1.
- That process MUST be the only owner of the HTTP listener, the LanceDB connections, the chokidar watchers, and every spawned `ob` child process.
- The container MUST NOT use a process supervisor (`s6`, `supervisord`, `runit`). Child-process supervision MUST be implemented in TypeScript inside the Bun process.
- `tini` MAY be used as PID 1 only as a thin signal/zombie reaper that `exec`s the Bun process; it MUST NOT be configured to launch any other service.

#### Scenario: Container start-up

- **GIVEN** a container started with `OBSIDIAN_AUTH_TOKEN` and `VAULTS_JSON` set
- **WHEN** the container starts
- **THEN** exactly one Bun process is visible to the host
- **AND** any `ob` child processes appear as descendants of that Bun process

#### Scenario: SIGTERM

- **GIVEN** the running container
- **WHEN** the orchestrator sends SIGTERM to PID 1
- **THEN** the Bun process stops accepting new HTTP requests within 1s
- **AND** sends SIGTERM to every spawned `ob` child
- **AND** flushes/closes all LanceDB tables
- **AND** exits with code 0 within 10s

### Runtime & Language

- The implementation language MUST be TypeScript with `"strict": true` and `"noUncheckedIndexedAccess": true`.
- The runtime MUST be Bun (`oven/bun:1` base image, pinned minor version in `Dockerfile`). Source files MUST run directly under Bun without a separate transpile step in development.
- `obsidian-headless` MUST be installed via `npm install -g obsidian-headless` against an embedded Node 22 toolchain in the same image, because the upstream CLI is published for Node and is not guaranteed to run under Bun.
- If a chosen npm dependency is incompatible with Bun, the project MUST replace the dependency rather than introduce a second long-lived runtime in the container.

### Configuration

All runtime configuration MUST come from environment variables. The container MUST NOT read config files baked into the image. Required and optional variables:

| Variable | Required | Description |
|---|---|---|
| `OBSIDIAN_AUTH_TOKEN` | yes | Token written verbatim to `${XDG_CONFIG_HOME:-/home/ob/.config}/obsidian-headless/auth_token` at startup if the file is missing. |
| `VAULTS_JSON` | yes | JSON array of vault objects: `[{"name":"v","slug":"v","e2eePassword":"..."}]`. `slug` MUST default to `name` lower-cased and kebab-cased. `e2eePassword` is OPTIONAL. |
| `DATA_DIR` | no | Root directory for vaults, LanceDB store, and model cache. Default `/data`. |
| `HTTP_PORT` | no | HTTP listener port. Default `3000`. |
| `HTTP_HOST` | no | Bind host. Default `0.0.0.0`. |
| `EMBEDDING_PROVIDER` | no | `transformers` (default) or `openai`. |
| `EMBEDDING_MODEL` | no | Provider-specific model id. Default `Xenova/all-MiniLM-L6-v2` (384-dim) for `transformers`, `text-embedding-3-small` for `openai`. |
| `OPENAI_API_KEY` | when provider=openai | API key. |
| `OPENAI_BASE_URL` | no | Override OpenAI base URL (for compatible endpoints). |
| `LOG_LEVEL` | no | `trace` `debug` `info` `warn` `error`. Default `info`. |
| `OB_SYNC_*` | no | The sync-behavior family, owned by the [Obsidian Sync](../obsidian-sync/) spec: `ob sync-config` flags (see [Sync configuration bootstrap](../obsidian-sync/index.md#sync-configuration-bootstrap)) and the sync-log watchdog knobs `OB_SYNC_STALL_TIMEOUT_SECONDS` / `OB_SYNC_STALL_POLL_SECONDS` / `OB_SYNC_LOG_TAIL` (see [Sync stall watchdog](../obsidian-sync/index.md#sync-stall-watchdog)). Every member is optional and every member is validated at startup, before any `ob` child is spawned; an invalid value exits 78. |

- Missing `VAULTS_JSON` MUST cause the process to exit non-zero before opening any port.
- Missing `OBSIDIAN_AUTH_TOKEN` MUST cause the process to exit non-zero **only when** no `auth_token` file is present at `${XDG_CONFIG_HOME:-$HOME/.config}/obsidian-headless/auth_token`. A pre-existing token file (e.g. mounted volume) is an acceptable substitute, per [Obsidian Sync › Auth-token bootstrap](../obsidian-sync/index.md#credential-bootstrap).
- Invalid `VAULTS_JSON` (not a non-empty array of `{name: string}` objects) MUST cause the process to exit non-zero with an actionable message naming the offending field.

#### Scenario: Auth token bootstrap

- **GIVEN** the container starts and `${XDG_CONFIG_HOME}/obsidian-headless/auth_token` does not exist
- **WHEN** `OBSIDIAN_AUTH_TOKEN` is set
- **THEN** the process writes the token to that path with mode `0600` before spawning any `ob` child
- **AND** subsequent `ob sync` calls inherit the credential without prompting

#### Scenario: Auth token already present

- **GIVEN** the container starts and the auth_token file already exists (e.g. mounted volume)
- **WHEN** `OBSIDIAN_AUTH_TOKEN` is also set with a different value
- **THEN** the env var wins — the file is overwritten with the env value, mode `0600`

### Directory Layout (in-container)

- `/data/vaults/<slug>/` — synced vault working tree owned by `ob sync`.
- `/data/lancedb/` — LanceDB store directory. One table per vault, named by slug.
- `/data/models/` — Transformers.js model cache (when provider is `transformers`).
- `/home/ob/.config/obsidian-headless/auth_token` — credential file (XDG default).

The container MUST run as a non-root user (uid `1000`, name `ob`) that owns `/data` and `/home/ob`.

### Project Layout (source tree)

```text
src/
  config/         # env parsing, Vault config types
  obsidian/       # ob child-process supervisor, sync lifecycle
  indexer/        # chokidar watcher, chunker, embedder, LanceDB writer
  embeddings/     # provider abstraction (transformers, openai)
  vault/          # SHARED CORE: file CRUD service (any file type), search wrapper, vault status, path/contentType helpers — used by both REST and MCP
  errors.ts       # SHARED CORE: typed error classes (one per closed-set error code) used by both adapters
  schemas/        # SHARED CORE: Zod input/output schemas reused by REST body parsing and MCP tool inputs
  http/           # ADAPTER: Hono routes, content-type negotiation, error→HTTP-status mapping
  mcp/            # ADAPTER: MCP server, tool registration, Streamable HTTP transport, error→isError mapping
  server.ts       # entrypoint: load config, wire everything, listen
test/             # bun test specs mirroring src/ structure
docs/             # this folder (specs + changes)
Dockerfile
biome.json
tsconfig.json
package.json
.env.example
```

- Production source MUST live under `src/`. Tests MUST live under `test/` mirroring the `src/` layout.
- New top-level directories MUST NOT be added without a change document amending this spec.

### Shared Service Core

REST and MCP MUST be two interfaces to the same functionality, not two implementations of the same functionality. Concretely:

- All vault behavior — file list/read/write/patch/append/delete, search, vault status — MUST live in `src/vault/` and `src/indexer/`. Adapter code under `src/http/` and `src/mcp/` MUST NOT contain any of this logic.
- An adapter handler is a "thin adapter" if its body is restricted to: (1) parse and validate input via a shared schema, (2) call exactly one core service function, (3) translate the result and any thrown typed error into the adapter's response envelope. Anything beyond this — branching on file type, computing hashes, walking directories, formatting frontmatter, applying edits — MUST live in the core.
- Typed error classes MUST live in `src/errors.ts`. Each has a single canonical `code` from the closed set in [REST API › Error model](../rest-api/index.md#error-model). Both adapters MUST translate the same error class to the same `code`; only the transport envelope differs (HTTP status vs. MCP `isError` payload).
- Input validation schemas MUST live in `src/schemas/` (Zod). REST handlers parse request bodies and query params with these schemas; MCP tool registrations derive `inputSchema` from the same Zod schemas (via `zod-to-json-schema`). A field MUST NOT be defined twice.
- Adding a capability MUST be a one-place edit: a new function in `src/vault/`, a new schema in `src/schemas/`, a new error class if needed, then a thin adapter binding in each of `src/http/` and `src/mcp/`. A capability that exists in only one of the two adapters is a defect.
- The two adapters' tasks/PRs MUST land in dependency order: the REST PR (0004) introduces the core service functions; the MCP PR (0005) only adds adapters and parity tests. The MCP PR MUST NOT modify any file under `src/vault/`, `src/errors.ts`, or `src/schemas/` (other than additive exports needed by the new tools — and even those should land in 0004 by anticipation).

#### Scenario: Adding a new file operation

- **GIVEN** a hypothetical "rename file" capability
- **WHEN** it is implemented
- **THEN** the change adds `renameFile` to `src/vault/files.ts`, a Zod schema to `src/schemas/`, and (if needed) an error class to `src/errors.ts`
- **AND** `src/http/` gains a new route whose body is parse → call → respond
- **AND** `src/mcp/tools/rename_file.ts` registers a tool whose body is parse → call → wrap
- **AND** the parity test in 0005's pattern can be extended without touching either adapter's logic

### Build & Container

- The Docker image MUST be a single multi-stage build producing one runnable image.
- Stage 1 ("deps") MUST install npm production deps (incl. `obsidian-headless` globally) using the embedded Node 22 toolchain.
- Stage 2 ("app") MUST install Bun deps and copy `src/`.
- The final stage MUST be `oven/bun:1` (or smaller `-distroless`-style base if compatible) containing: Bun runtime, Node 22 binary, the global `ob` binary, our app source, and `tini` as PID 1.
- The image MUST `EXPOSE 3000` and define `HEALTHCHECK` against `GET /healthz`.
- The image MUST NOT bake any secrets.
- The runtime stage's apt packages (`tini`, `curl`, `ca-certificates`) MUST be installed unpinned. Debian removes superseded versions from the archive on every point release, so an exact `=<version>` pin turns into `E: Version '...' was not found` and breaks every build — including unrelated PRs — until someone hand-edits the string. apt-level reproducibility is deliberately traded for build resilience; image reproducibility instead rests on the pinned base image and the toolchain build ARGs (`NODE_VERSION`, `BUN_VERSION`, `OBSIDIAN_HEADLESS_VERSION`), which MUST stay pinned to an exact version.
- Hadolint's DL3008 ("pin versions in apt get install") MUST therefore be suppressed narrowly, via an inline `# hadolint ignore=DL3008` directive on the affected instruction. It MUST NOT be disabled repo-wide. The directive MUST be the bare form with its justification in the adjacent comment — hadolint 2.12 (the version CI installs) does not parse a same-line reason.

### Testing & Lint

- Unit and integration tests MUST be written with `bun test` (no Jest, no Vitest).
- Coverage MUST be measured by `bun test --coverage` and MUST report ≥ 100% line and branch coverage on `src/` for CI to pass. New code without tests is a defect.
- Network calls to Obsidian's servers and to OpenAI MUST be mocked in unit tests. LanceDB MUST be exercised with a real store rooted in a `Bun.tmpdirSync()` directory — it is embedded, so isolation is cheap.
- The `ob` binary MUST be exercised in at least one integration test per top-level change (a smoke test that runs `ob --help` and asserts exit 0). Tests MUST NOT call `ob login`, `ob sync-setup`, or `ob sync` against real Obsidian servers.
- Biome MUST be the only linter and formatter. `biome.json` MUST extend `recommended`, enable `noExplicitAny`, and ignore: `node_modules/`, `dist/`, `data/`, `coverage/`, `*.md`, `bun.lockb`, lockfiles, and any path under `vault/`.
- TypeScript MUST be type-checked in CI via `tsc --noEmit`. A failing type-check MUST block merge.
- `// @ts-expect-error`, `// biome-ignore`, and `// eslint-disable*` MUST carry a one-line justification on the same comment.
- For every capability exposed by both REST and MCP, a **parity test** MUST exist that drives both adapters with the same inputs against the same fixture vault and asserts structurally identical successful payloads (modulo each adapter's transport envelope) and identical error `code`s on failure. Parity tests live under `test/parity/`.

### Observability

- Structured JSON logs MUST be emitted to stdout. Each log line MUST include `level`, `msg`, `vault` (when applicable), and a monotonic `ts`.
- The HTTP server MUST expose:
  - `GET /healthz` — liveness, returns 200 once the process is up.
  - `GET /readyz` — readiness **and** the aggregate process-health surface. Returns 503 whenever any critical component is not healthy, and its body reports the state of every critical long-lived component. The exact 200/503 conditions and the body shape are owned by [REST API › Health endpoints](../rest-api/index.md#health-endpoints).
  - `GET /metrics` — text/plain Prometheus exposition (basic counters: indexed docs, search queries, sync errors).
- `/healthz` MUST remain a dependency-free liveness probe: its status code MUST NOT depend on vault sync state, indexer state, or any other subsystem, and it MUST NOT read any state that can block. Sync health MUST NOT be attached to it. The container is a single process hosting the API and every vault child, so a liveness failure restarts all of them; using one wedged vault to trigger that would take down the API and every healthy vault to recover one child. In-process supervision (restarting the individual `ob` child) is the correct blast radius, and `/readyz` is the correct place to *report* the condition.
- `/readyz` MUST be the single aggregate status surface: every critical long-lived in-process component MUST be represented in its body. Today that is the per-vault `ob sync` children and the per-vault indexers. Introducing another long-lived component MUST extend the body rather than add a fourth health route — a status surface that does not enumerate everything long-lived is worse than none, because it reads as an all-clear.
#### Scenario: A wedged vault does not restart the pod

- **GIVEN** two configured vaults, one of whose `ob sync` children has stopped making progress
- **WHEN** the orchestrator polls `GET /healthz`
- **THEN** the response is 200 — the process is alive and serving
- **AND** `GET /readyz` reports 503 with the affected vault's state, `lastError`, and `lastSyncActivityAt` in the body
- **AND** the healthy vault's child and the HTTP listener are untouched

## Design

### Process model

```text
PID 1: tini
  └─ bun src/server.ts
       ├─ ob sync --continuous --path /data/vaults/v        (child)
       ├─ ob sync --continuous --path /data/vaults/work     (child)
       └─ HTTP listener on :3000 (REST + MCP SSE)
```

Each `ob` child is a long-lived process owned by the supervisor in `src/obsidian/`. Watchers, embedder, and LanceDB connections live in the parent's event loop.

### Data flow

```text
remote vault ──ob sync─→ /data/vaults/<slug>/  ──chokidar─→ chunker ──embedder─→ LanceDB(<slug>)
                            ▲                                                          │
                            │                                                          ▼
            REST/MCP ───────┴──── write file ────────────────────────────────── search/read
```

A REST `PUT /vaults/v/files/foo.md` writes the file to `/data/vaults/v/foo.md`; chokidar picks it up and triggers reindex; `ob sync --continuous` pushes the change to the remote.

### Entry point shape

```ts
// src/server.ts (sketch)
import { loadConfig } from "./config";
import { startSupervisor } from "./obsidian";
import { startIndexer } from "./indexer";
import { buildHttpApp } from "./http";

const cfg = loadConfig(process.env);
const sup = await startSupervisor(cfg);
const idx = await startIndexer(cfg);
const app = buildHttpApp({ cfg, sup, idx });
const server = Bun.serve({ port: cfg.httpPort, hostname: cfg.httpHost, fetch: app.fetch });

const shutdown = async () => {
  server.stop();
  await sup.stop();
  await idx.stop();
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
```

## Constraints

- The container MUST run rootless (uid 1000).
- No outbound calls except: Obsidian Sync (`ob`), HuggingFace model CDN (first run, then cached), OpenAI (only when `EMBEDDING_PROVIDER=openai`).
- Memory budget target ≤ 1 GiB resident with one small vault (≤ 5k notes).
- The HTTP API MUST NOT require auth in v1 (per user direction); deployment MUST therefore be private network only. This is documented as a deliberate non-goal in [Change 0004](../../changes/0004-rest-api.md).

## Open Questions

- **Bun ↔ `obsidian-headless` compatibility.** `ob` ships as a CommonJS Node bundle. We have not yet validated that running `ob` as a child of a Bun parent works for the SIGTERM/stdio path on Alpine. **Default**: ship Node 22 alongside Bun in the image and run `ob` under `node`.
- **Model cache warm-up.** On first run, Transformers.js downloads ~90 MB. Should the Dockerfile pre-bake the model into `/data/models` to avoid first-request latency? **Default**: no — keep the image small; warm on first start and document the latency in the README.
- **OpenAI-compatible endpoints (Ollama, vLLM).** `OPENAI_BASE_URL` covers most, but some servers diverge on the `embeddings` schema. **Default**: target the OpenAI v1 schema strictly; document which servers are known to work.

## References

- [obsidianmd/obsidian-headless](https://github.com/obsidianmd/obsidian-headless)
- [LanceDB JS docs](https://lancedb.github.io/lancedb/js/globals/)
- [MCP Streamable HTTP transport](https://modelcontextprotocol.io/)
- [Hono](https://hono.dev/) — chosen HTTP framework for Bun-native fit

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-05-03 | Initial spec created | — |
| 2026-05-03 | Landed: CI workflow (`.github/workflows/ci.yml`) runs `bun run lint` / `bunx tsc --noEmit` / `bun run test:cov` on every PR and push to `main`, with a `continue-on-error` Codecov upload. The `CI / ci` check is the intended merge gate; branch-protection wiring is held until the path-skipped-PR shim described in [0009 — CI test suite](../../changes/0009-ci-test-suite.md#ciyml--merge-gate) lands, so until then the gate is enforced by reviewer discipline rather than a required-status rule. No new spec rules; this is the enforcement mechanism for the existing Testing & Lint section. | [0009 — CI test suite](../../changes/0009-ci-test-suite.md) |
| 2026-05-03 | Landed: release automation (`.github/workflows/release-please.yml`) cuts `vX.Y.Z` tags + a `CHANGELOG.md` from squash-merged Conventional Commits, and image publishing (`.github/workflows/docker.yml`) builds on every `v*` tag plus PR / push-to-`main` events that touch non-doc paths (the workflow `paths-ignore`s `docs/**` / `**.md` / `.gitignore`), publishing to `ghcr.io/fx/ob` under six tags across two schemes: channel tags `:main` + `:sha-<short>` on main pushes; semver tags `:X.Y.Z` + `:X.Y` + `:X` + `:latest` on `v*` tags. The push path is gated on a smoke test of the locally-built image (`bun test test/docker.test.ts`); PRs build but don't push. Adds `ARG GIT_SHA=dev` + OCI labels to the Dockerfile and `release-please-config.json` / `.release-please-manifest.json` at repo root; `package.json` version is now release-please-managed (`0.1.0` floor). Provisioning a `RELEASE_PLEASE_TOKEN` PAT/App secret is recommended so that release-please-created tags trigger downstream `docker.yml` (the default `GITHUB_TOKEN` does not chain workflow events). | [0010 — Release and image publishing](../../changes/0010-release-and-image-publishing.md) |
| 2026-08-09 | Policy change: the runtime stage's apt packages (`tini`, `curl`, `ca-certificates`) are now installed unpinned, and hadolint's DL3008 is silenced by an inline directive on that one instruction. The exact `=<version>` pins were breaking unrelated builds every time Debian dropped a superseded version on a point release; apt-level reproducibility is deliberately traded for build resilience. The toolchain ARGs (`NODE_VERSION`, `BUN_VERSION`, `OBSIDIAN_HEADLESS_VERSION`) and the base image stay pinned and remain the basis for image reproducibility. Supersedes the "`tini` pinned" detail recorded in [0006 — Production image](../../changes/0006-production-image.md), which stands as the historical record of the original decision. | — |
| 2026-08-21 | Observability: `/healthz` is pinned as a dependency-free liveness probe that MUST NOT reflect sync or indexer state, and `/readyz` is designated the single aggregate status surface that MUST enumerate every critical long-lived component. Rationale recorded: the container is one process hosting the API and every vault child, so failing liveness on a wedged vault would restart the API and the healthy vaults to recover one child. Config table gains a row for the `OB_SYNC_*` family (owned by the Obsidian Sync spec), covering both the existing `sync-config` vars and the new watchdog knobs. | [Change 0015](../../changes/0015-sync-stall-watchdog.md) |

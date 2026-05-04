# 0001: Project Scaffold

## Summary

Bootstrap the repo: Bun + TypeScript + Biome + native `bun test`, the source/test directory layout, env-driven config loader, structured logger, and the `src/server.ts` skeleton with `/healthz` and graceful shutdown. No vault behavior yet — this PR makes the rest of the work possible.

**Spec:** [Architecture](../specs/architecture/)
**Status:** complete
**Depends On:** —

## Motivation

The repo currently contains only docs. Every subsequent change document needs a working Bun project with a CI-grade lint/test/typecheck loop and a server entrypoint to extend. Doing this in one focused PR keeps every later PR small and reviewable.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint)). CI enforces these as merge gates:

- All tests MUST run under `bun test` — no Jest, no Vitest, no node test runners.
- `bun test --coverage` MUST report ≥ 100% line and branch coverage on `src/`. Lower coverage MUST fail CI.
- `tsc --noEmit` MUST pass cleanly with `"strict": true` and `"noUncheckedIndexedAccess": true`.
- `biome check` MUST pass with the recommended ruleset plus `noExplicitAny`.
- `// @ts-expect-error`, `// biome-ignore`, and similar suppressions MUST carry an inline justification on the same comment.
- Unit tests MUST NOT make real network calls. Integration tests MAY use real LanceDB rooted at `Bun.tmpdirSync()` once that work lands in 0003.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Project setup

- The repo MUST contain `package.json` declaring Bun ≥ 1.1, scripts: `dev`, `start`, `test`, `test:cov`, `typecheck`, `lint`, `lint:fix`, `format`.
- The repo MUST contain `tsconfig.json` with `"strict": true`, `"noUncheckedIndexedAccess": true`, `"target": "ESNext"`, `"module": "ESNext"`, `"moduleResolution": "bundler"`, `"types": ["bun"]`.
- The repo MUST contain `biome.json` extending `recommended`, enabling `noExplicitAny`, with `files.includes` covering `src/**` and `test/**`, ignoring `node_modules/`, `dist/`, `data/`, `coverage/`, `*.md`, `bun.lockb`, lockfiles, `vault/`.
- The repo MUST contain `.env.example` listing every env var from the architecture spec with safe placeholder values.
- The repo MUST contain `.gitignore` covering `node_modules/`, `dist/`, `data/`, `coverage/`, `.env`, `.env.local`, `*.tsbuildinfo`.

### Config loader

- `src/config/index.ts` MUST export `loadConfig(env: Record<string, string | undefined>): Config` and a `Config` type covering every variable in the architecture spec.
- The loader MUST throw a typed `ConfigError` (with exit-code suggestion `78`) on missing-required or invalid input, naming the offending variable.
- The loader MUST normalize each `VAULTS_JSON` entry to `{ name, slug, e2eePassword? }` (slug defaulted from name).
- The loader MUST reject duplicate slugs.

#### Scenario: Missing token

- **GIVEN** `loadConfig({ VAULTS_JSON: '[{"name":"v"}]' })`
- **WHEN** called
- **THEN** it throws `ConfigError` whose message names `OBSIDIAN_AUTH_TOKEN`

#### Scenario: Duplicate slug

- **GIVEN** `VAULTS_JSON='[{"name":"V"},{"name":"v"}]'`
- **WHEN** `loadConfig` runs
- **THEN** it throws `ConfigError` naming both vault names and the conflicting slug `v`

### Logger

- `src/log.ts` MUST export a logger with `trace/debug/info/warn/error` methods, each accepting `(msg: string, fields?: Record<string, unknown>)`.
- Output MUST be JSON-per-line on stdout with `ts`, `level`, `msg`, and merged fields.
- The logger MUST honor `LOG_LEVEL` from `Config`.

### Server entrypoint

- `src/server.ts` MUST: load config, build a Hono app with `GET /healthz` returning `200 {"ok":true}`, start `Bun.serve` on `cfg.httpHost:cfg.httpPort`, register SIGTERM/SIGINT handlers that stop the listener and resolve within 10s.
- For this PR, no supervisor or indexer is wired — placeholders MAY exist but MUST be no-ops.

### Container

- `Dockerfile` MUST be a multi-stage build producing one image. Stages: `deps-node` (installs `obsidian-headless` globally with Node 22), `deps-bun` (installs Bun deps), `runtime` (`oven/bun:1`, copies `node` binary + global `ob`, copies app source, runs as uid 1000).
- The runtime stage MUST `EXPOSE 3000` and use `tini` as PID 1.
- A `HEALTHCHECK` MUST `curl -f http://localhost:3000/healthz`.

## Design

### Approach

- One PR, one commit per logical concern (config / logger / server / dockerfile / lint+test config).
- Wire `tsc --noEmit`, `bun test --coverage`, and `biome check` as `npm run` scripts that CI calls.
- Do not introduce a CI runner config in this PR — that is a separate concern; expose the commands as scripts so any CI can call them.

### Decisions

- **Hono over Elysia or stock `Bun.serve`**: Hono has the smallest API surface that still supports route groups and per-route middleware, runs natively on Bun, and the same app object can serve our SSE streams in 0005.
  - Alternatives: Elysia (more opinionated, larger surface), raw `Bun.serve` (write our own router — not worth the maintenance).
- **Pino-style structured logger, written in-house, not the `pino` package**: ~50 lines, zero deps, no Node-only fast paths to worry about under Bun.
  - Alternatives: `pino` (works under Bun but ships transports we won't use), `bunyan` (unmaintained).
- **`.env.example` not `.env.sample`**: standard convention used by Docker, `dotenv`, etc.

### Non-Goals

- No supervisor, no indexer, no real REST routes, no MCP, no LanceDB, no embeddings.
- No CI workflow file. (Comes later when the team picks a provider.)
- No release automation.

## Tasks

- [x] **Project skeleton** — `package.json`, `tsconfig.json`, `biome.json`, `.gitignore`, `.env.example`, `bun install`, scripts wired. `mise.toml` pins `node@22` + `bun`.
- [x] **Config loader** — `src/config/index.ts` + `test/config.test.ts` covering: required vars, JSON parsing, slug normalization, duplicate detection.
- [x] **Logger** — `src/log.ts` + `test/log.test.ts` covering: JSON shape, level filtering, field merging.
- [x] **Server entrypoint** — `src/server.ts` (with `import.meta.main` guard), `src/http/index.ts` (with `/healthz` only) + integration test that spawns `bun src/server.ts` as a subprocess, fetches `/healthz`, asserts `200`, then SIGTERMs and asserts clean exit.
- [x] **Graceful shutdown** — SIGTERM/SIGINT handlers + tests that emit signals and assert exit code 0/1 plus shutdown idempotency.
- [x] **Dockerfile** — placeholder multi-stage build (Node 22 → `obsidian-headless`, Bun deps, runtime with `tini`, uid 1000, EXPOSE 3000, HEALTHCHECK). Real pinning lands in 0006.
- [x] **Lint/typecheck/coverage gates green** — `bun run lint && bun run typecheck && bun run test:cov` all pass with 100% line and branch coverage on `src/` (Bun ≤ 1.3 doesn't emit branch records, so `test/check-coverage.ts` enforces line + function coverage as the closest available proxy and will pick up real branch records the moment Bun emits them — see the file's header for the rationale).

## Open Questions

- [ ] **HTTP framework lock-in.** Hono is the working assumption. If implementation surfaces a Bun-specific bug, fall back to raw `Bun.serve` + a tiny in-house router; revisit before merging 0004.
- [ ] **`tini` source.** `oven/bun:1` does not ship `tini`. Install via `apt-get install -y tini` in the runtime stage, or copy from the `tini` Docker image multi-stage. Pick whichever yields the smaller final image.

## References

- Spec: [Architecture](../specs/architecture/)
- [Hono](https://hono.dev/)
- [Biome](https://biomejs.dev/)

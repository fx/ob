# ob

`ob` is a single-process Bun server, packaged as a single Docker image, that
keeps one or more Obsidian vaults bidirectionally synced via the official
`obsidian-headless` CLI, embeds and indexes their Markdown into an in-process
LanceDB store, and exposes both a REST API and a Streamable HTTP/SSE MCP
server so an LLM agent can CRUD documents and search them by natural
language. One container, one process, one image — no orchestration required.

## Run

The canonical invocation:

```bash
docker run --rm \
  -p 3000:3000 \
  -v ob-data:/data \
  -e OBSIDIAN_AUTH_TOKEN=... \
  -e VAULTS_JSON='[{"name":"v"}]' \
  ghcr.io/<org>/ob:<tag>
```

- `-p 3000:3000` — REST + MCP listener.
- `-v ob-data:/data` — persists synced vaults, the LanceDB store, and the
  embedding-model cache.
- `OBSIDIAN_AUTH_TOKEN` — bootstrapped to
  `${XDG_CONFIG_HOME:-/home/ob/.config}/obsidian-headless/auth_token` on
  first start. Mounting a token file at the same path also works.
- `VAULTS_JSON` — the vaults to sync; see the env-var table below.

## Configuration

All runtime configuration is environment-variable driven (no config files
baked into the image). The architecture spec is the single source of truth;
this table mirrors it for convenience.

| Variable | Required | Description |
|---|---|---|
| `OBSIDIAN_AUTH_TOKEN` | yes (unless token file mounted) | Token written verbatim to `${XDG_CONFIG_HOME:-/home/ob/.config}/obsidian-headless/auth_token` at startup if the file is missing. If both env and file are present, the env value wins (file overwritten, mode `0600`). |
| `VAULTS_JSON` | yes | JSON array of vault objects: `[{"name":"v","slug":"v","e2eePassword":"..."}]`. `slug` defaults to `name` lower-cased + kebab-cased. `e2eePassword` is optional. Missing or non-array `VAULTS_JSON` causes a non-zero exit before any port opens. |
| `DATA_DIR` | no | Root directory for vaults, LanceDB store, and model cache. Default `/data`. |
| `HTTP_PORT` | no | HTTP listener port. Default `3000`. |
| `HTTP_HOST` | no | Bind host. Default `0.0.0.0`. |
| `EMBEDDING_PROVIDER` | no | `transformers` (default) or `openai`. |
| `EMBEDDING_MODEL` | no | Provider-specific model id. Default `Xenova/all-MiniLM-L6-v2` (384-dim) for `transformers`, `text-embedding-3-small` for `openai`. |
| `OPENAI_API_KEY` | when `EMBEDDING_PROVIDER=openai` | API key. |
| `OPENAI_BASE_URL` | no | Override OpenAI base URL (for OpenAI-compatible endpoints). |
| `LOG_LEVEL` | no | `trace`, `debug`, `info`, `warn`, `error`. Default `info`. |

### First-run latency

With the default `transformers` embedding provider, the first request
triggers a one-time download of `Xenova/all-MiniLM-L6-v2` (~90 MB) into
`/data/models/`. Subsequent starts read from the cache, so mounting `/data`
on a persistent volume keeps that cost paid once. To pre-warm, hit any
indexing or search endpoint after start; or set `EMBEDDING_PROVIDER=openai`
to skip the local model entirely.

### Health & readiness

- `GET /healthz` — liveness; returns 200 once the process is up. Wired into
  the image's `HEALTHCHECK`.
- `GET /readyz` — readiness; returns 200 only after every configured vault
  has completed `sync-setup` and its initial index pass.
- `GET /metrics` — text/plain Prometheus exposition.

The image's `HEALTHCHECK` deliberately probes `/healthz` rather than
`/readyz` so a long initial scan doesn't flap the container as unhealthy.
Orchestrators that want readiness-gated traffic should configure their own
probe against `/readyz`.

## Specs

The system is fully spec-driven. Every behavior the running container exposes
is described in one of these documents:

- [Architecture](docs/specs/architecture/index.md) — single-process topology,
  runtime, configuration, container shape, and standing testing/lint
  conventions every other spec inherits.
- [Obsidian Sync](docs/specs/obsidian-sync/index.md) — auth-token bootstrap
  and per-vault `obsidian-headless` child-process supervision.
- [Vault Indexer](docs/specs/vault-indexer/index.md) — chokidar watcher,
  Markdown chunker, embedding providers, and per-vault LanceDB store.
- [REST API](docs/specs/rest-api/index.md) — vault-scoped HTTP CRUD over
  arbitrary files plus natural-language search over Markdown.
- [MCP Server](docs/specs/mcp-server/index.md) — Streamable HTTP/SSE MCP
  server mirroring the REST surface as MCP tools and resources.

Change documents under [`docs/changes/`](docs/changes/) describe how the
project got from greenfield to today.

## Development

Toolchain pins live in `mise.toml` (Bun + Node) and `package.json`
(`@biomejs/biome`, `typescript`, runtime deps). `obsidian-headless` and the
Docker base images are pinned in the `Dockerfile`.

```bash
mise install         # install Bun + Node 22 at the pinned versions
bun install          # resolve deps from bun.lock
bun run test:cov     # full test suite + 100% coverage gate on src/
```

### Quality gates

`make build` (the default target) runs everything CI enforces:

```bash
make build           # lint + typecheck + tests + coverage
make test            # tests + coverage only
make image           # sudo docker build -t ob:dev .   (local sanity build)
```

### Releases and image publishing

Releases and image publishing are fully automated — there is no
`make image-push` ceremony any more. Every PR title that lands on `main`
is a [Conventional Commit](CONTRIBUTING.md), which feeds two GitHub Actions
workflows:

- **Merge to `main` (non-docs paths)** → Docker workflow publishes
  `ghcr.io/fx/ob:main` (rolling) and `ghcr.io/fx/ob:sha-<short>` (immutable).
  Docs- and Markdown-only merges are skipped by the workflow's `paths-ignore`,
  so they do not republish `:main` / `:sha-<short>`.
- **Merge the release-please PR** → release-please cuts a `vX.Y.Z` git tag;
  tag pushes are NOT path-filtered, so the Docker workflow always publishes
  `ghcr.io/fx/ob:X.Y.Z`, `ghcr.io/fx/ob:X.Y`, `ghcr.io/fx/ob:X`, and updates
  `ghcr.io/fx/ob:latest`.

Pinning guidance for consumers:

| Tag | Use when |
|-----|----------|
| `:X.Y.Z` (e.g. `:0.1.2`) | You want exactly one immutable build. The strongest pin. |
| `:X.Y` (e.g. `:0.1`) | You want patch updates inside a minor line. |
| `:X` (e.g. `:0`) | You want minor + patch updates inside a major line. (Note: pre-1.0, this floats across feature work; use sparingly.) |
| `:latest` | You always want the newest stable release. |
| `:main` | You want the tip of `main` (rolling). Useful for testing pre-release fixes; not for production. |
| `:sha-<short>` | You want to pin a specific commit on `main`. |

The Makefile targets above are still useful for local sanity builds; they
are not part of the release path.

#### Repo secrets the release path needs

| Secret | Required | Purpose |
|--------|----------|---------|
| `CODECOV_TOKEN` | yes | Codecov upload from `ci.yml`. |
| `RELEASE_PLEASE_TOKEN` | recommended | A user PAT or GitHub App token used by `release-please.yml`. The default `GITHUB_TOKEN` cannot trigger downstream `pull_request` / `push` workflows, so without this secret the release PR will not get CI and the `vX.Y.Z` tag release-please cuts will not trigger `docker.yml` (and therefore the semver image tags `:X.Y.Z` / `:X.Y` / `:X` / `:latest` will not be published). With it provisioned, the full chain is automated. The workflow falls back to `GITHUB_TOKEN` if the secret is unset, so `release-please.yml` will still maintain the release PR — just not chain into CI / Docker. |

`bun run lint` runs Biome and `hadolint Dockerfile`. Hadolint is preinstalled
in the dev container; on a fresh machine, install it once:

```bash
sudo curl -fsSL https://github.com/hadolint/hadolint/releases/download/v2.12.0/hadolint-Linux-x86_64 \
  -o /usr/local/bin/hadolint && sudo chmod +x /usr/local/bin/hadolint
```

### Docker E2E test

`test/docker.test.ts` builds the production image and runs `ob --help` +
`id -u` against it. It is gated behind `DOCKER_E2E=1` so the default `bun
test` suite skips it (no daemon required). To exercise it locally:

```bash
sudo service docker start
DOCKER_E2E=1 bun test test/docker.test.ts
```

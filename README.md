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
| `OB_SYNC_FILE_TYPES` | no | Comma-separated subset of `image,audio,pdf,video,unsupported` passed to `ob sync-config --file-types`. Empty string clears the list (sync everything). Unset preserves the on-disk value. |
| `OB_SYNC_EXCLUDED_FOLDERS` | no | Forwarded verbatim to `ob sync-config --excluded-folders`. Empty string clears. |
| `OB_SYNC_MODE` | no | One of `bidirectional`, `pull-only`, `mirror-remote`. Forwarded to `ob sync-config --mode`. Empty string clears. |
| `OB_SYNC_CONFLICT_STRATEGY` | no | One of `merge`, `conflict`. Forwarded to `ob sync-config --conflict-strategy`. Empty string clears. |
| `OB_SYNC_DEVICE_NAME` | no | Forwarded verbatim to `ob sync-config --device-name`. Empty string clears. |
| `OB_SYNC_CONFIGS` | no | Comma-separated subset of `app,appearance,appearance-data,hotkey,core-plugin,core-plugin-data,community-plugin,community-plugin-data`. Forwarded to `ob sync-config --configs`. Empty string clears. |

The `OB_SYNC_*` family runs `ob sync-config` once per vault between
`ob sync-setup` and `ob sync --continuous`. Unset vars omit the
corresponding flag entirely (preserving whatever was on disk); empty
strings forward verbatim as the upstream "empty to clear" sentinel; if
every `OB_SYNC_*` var is unset the call is skipped. Invalid enum values
fail fast with exit 78 before any vault is touched. For example,
`-e OB_SYNC_FILE_TYPES=image,audio,pdf,video,unsupported` keeps the
default attachment types AND syncs everything else (the typical fix for
"my `.json`/`.txt`/`.docx` files are missing in the cloud").

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

### Scoped MCP sessions

The MCP mount takes an optional scope in the URL path. A scoped session is
confined to one vault and one folder inside it, and that folder is presented
to the client **as if it were the vault root** — every path the client sends
and every path it receives is relative to the folder, and the client is never
told what the folder is.

| URL | Session sees |
|-----|--------------|
| `/mcp` | Every configured vault, addressed by `vault` + vault-relative path. Unchanged. |
| `/mcp/<slug>` | Vault `<slug>` only, whole-vault paths. |
| `/mcp/<slug>/<folder>/<subfolder>` | Vault `<slug>`, rooted at that folder. |

The intended use is **memory per agent**: give each agent its own folder in a
shared vault and hand it a scoped URL, with no server-side provisioning — no
registry, no credentials, nothing to create before an agent connects.

```jsonc
// agent "claude-1"
{ "mcpServers": { "memory": { "type": "http", "url": "https://ob.example/mcp/v/agents/claude-1" } } }
// agent "claude-2"
{ "mcpServers": { "memory": { "type": "http", "url": "https://ob.example/mcp/v/agents/claude-2" } } }
```

Each agent then writes `write_file { path: "decisions.md", … }` and searches
its own notes without seeing — or overwriting — the other's, and without
carrying its own folder name in any prompt, note body, or search filter. In a
scoped session the `vault` argument is optional and defaults to the session's
vault; `search` results, `list_files` pages, resource `obvault://` URIs, and
error messages are all folder-relative. The `vault_status` document and chunk
counts are the exception: they come from the per-vault indexer and stay
vault-wide.

The scope binds at `initialize` and is checked on every later request, so a
session id issued for one scope is rejected on another. `..`, absolute paths,
percent-encoded separators, hidden (leading-dot) segments, and a scope folder
that is a symlink out of the vault are all refused; a scope folder that does
not exist yet is fine — it lists as empty and is created on first write.

> **Scoping is not an authentication or authorization boundary.** The server
> has no auth (see the [MCP Server spec](docs/specs/mcp-server/index.md)), so
> anything that can reach `/mcp/v/agents/claude-1` can also reach `/mcp` and
> address the whole vault. Scoping confines a *cooperating* client that was
> configured with a scoped URL; it does not defend against a hostile one. Put
> the listener behind your own authenticated proxy if the network is not
> trusted.

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

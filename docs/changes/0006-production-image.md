# 0006: Production Docker Image

## Summary

Finalize the single Docker image: pin versions, add Node 22 + global `ob`, add `tini`, set up the `ob` user (uid 1000), wire `HEALTHCHECK`, document `docker run` ergonomics, and publish a reproducible build. After this PR a single `docker run` with two env vars produces a working multi-vault server.

**Spec:** [Architecture](../specs/architecture/)
**Status:** complete
**Depends On:** 0005

## Motivation

The minimal Dockerfile from 0001 was a placeholder. This PR makes the image production-shaped: small, rootless, signal-correct, with a real healthcheck that distinguishes "process up" from "vaults ready", and a documented run surface.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint)). CI enforces these as merge gates:

- `bun test --coverage` MUST stay at 100% on `src/`.
- A new `test/docker.test.ts` MUST be added that, when `DOCKER_E2E=1`, runs `docker build -t ob:test .` and `docker run --rm ob:test ob --help` to assert the `ob` binary is installed and runnable inside the image. Default suite skips the test when `DOCKER_E2E` is unset.
- The Dockerfile MUST be linted with `hadolint` as part of the lint step (`bun run lint` adds a `hadolint Dockerfile` invocation; the hadolint binary is installed in the dev container).

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Image content

- Base: `oven/bun:1.1.<pinned>` (latest at time of PR; pin exact patch).
- Node 22 binary copied from `node:22-bookworm-slim` (only the `node` binary + `npm` directory; not the full image).
- `obsidian-headless` installed globally with `npm install -g obsidian-headless@<pinned>`.
- App source under `/app`, owned by uid 1000.
- `tini` installed via `apt-get install -y tini`, set as `ENTRYPOINT ["/usr/bin/tini","--"]`.
- `CMD ["bun","run","start"]` where the `start` script invokes `bun src/server.ts`.
- `USER 1000:1000`.
- `WORKDIR /app`.
- `EXPOSE 3000`.
- `VOLUME ["/data"]` to make the data dir explicit.
- `HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD curl -fsS http://localhost:3000/healthz || exit 1`.

#### Scenario: Built image runs `ob`

- **GIVEN** a built `ob:test` image
- **WHEN** `docker run --rm ob:test ob --help` runs
- **THEN** exit code is 0
- **AND** stdout contains `Usage: ob` (proving the program is `ob`)
- **AND** stdout lists a `sync` subcommand (proving the supervised CLI is wired in)

#### Scenario: Image is rootless

- **GIVEN** a built `ob:test` image
- **WHEN** `docker run --rm ob:test id -u` runs
- **THEN** stdout is `1000`

### Run surface

- `README.md` MUST document the canonical `docker run` invocation:
  ```bash
  docker run --rm \
    -p 3000:3000 \
    -v ob-data:/data \
    -e OBSIDIAN_AUTH_TOKEN=... \
    -e VAULTS_JSON='[{"name":"v"}]' \
    ghcr.io/<org>/ob:<tag>
  ```
- `README.md` MUST list every env var with description (single source-of-truth pointer to the Architecture spec).
- `README.md` MUST link to all five specs.

### Image size & layers

- The final image SHOULD be ≤ 350 MB uncompressed (Bun + Node + ob + app). If exceeded, document why in the PR description.
- Layers MUST be ordered `apt → npm globals → bun deps → app source` so source edits don't bust the heavier layers.

### CI hand-off

- A `Makefile` (or `bunx`-equivalent commands documented in README) MUST expose `make build`, `make test`, `make image`, `make image-push`. CI workflow files are out of scope for this PR.

## Design

### Approach

- One multi-stage `Dockerfile`: stages `node-tools`, `bun-deps`, `runtime`. The `runtime` stage `COPY --from`s the Node binary and the global `ob` install dir from `node-tools`.
- Use `npm config set prefix /opt/node-globals` in the `node-tools` stage so the global install is one tidy directory we can copy to the runtime stage.
- Symlink `/opt/node-globals/bin/ob` into `/usr/local/bin/ob` in the runtime stage.

### Decisions

- **Don't pre-bake the embedding model**: keeps image small; first request pays a one-time download. README documents the latency.
- **`tini` over `dumb-init`**: same job, broader adoption, in Debian repos.
- **Bookworm-based**: matches `oven/bun:1` and gives us a recent glibc. Alpine considered and rejected — Bun on musl has historically lagged.

### Non-Goals

- No CI workflow files.
- No image signing / SBOM in this PR.
- No multi-arch build; v1 ships `linux/amd64` only.

## Tasks

- [x] **Pin versions** — Bun, Node 22, `obsidian-headless`, `tini`. Capture in Dockerfile build args.
- [x] **Multi-stage Dockerfile** — `node-tools` → `bun-deps` → `runtime`, with `--from` copies for `node` and the global `ob` prefix.
- [x] **User & permissions** — uid 1000 owns `/app` and `/data`.
- [x] **`tini` PID 1** — `ENTRYPOINT ["/usr/bin/tini","--"]`.
- [x] **`HEALTHCHECK`** — wired against `/healthz`.
- [x] **`docker.test.ts`** — `DOCKER_E2E=1` integration test that builds and runs the image.
- [x] **Hadolint** — wire into `bun run lint`.
- [x] **README** — `docker run` example, env table, links to all specs.
- [x] **Makefile** — `build`, `test`, `image`, `image-push` targets.
- [x] **Coverage 100%**.

## Open Questions

- [ ] **`/readyz` in HEALTHCHECK?** Using `/readyz` would mean Docker considers the container unhealthy until the initial scan finishes, which can take a while on large vaults. **Default**: keep `HEALTHCHECK` on `/healthz`; orchestrators that need readiness probes use `/readyz` separately.
- [ ] **Multi-arch.** `arm64` for Apple Silicon dev. Add when the team has a consumer for it; not now.
- [ ] **Upstream `obsidian-headless` semver.** If upstream pre-1.0, pin to exact version and bump deliberately.

## References

- Spec: [Architecture](../specs/architecture/)
- Related changes: [0001-project-scaffold](./0001-project-scaffold.md), [0005-mcp-server](./0005-mcp-server.md)
- [Hadolint](https://github.com/hadolint/hadolint)
- [tini](https://github.com/krallin/tini)

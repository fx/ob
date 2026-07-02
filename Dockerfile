# syntax=docker/dockerfile:1.7
#
# Production Docker image for `ob` (change 0006).
#
# Multi-stage build that produces a single rootless image containing:
#   - Bun runtime (matches mise.toml)
#   - Node 22 binary + global `obsidian-headless` CLI (CommonJS, runs on Node)
#   - the application source under /app
#   - tini as PID 1 for signal forwarding and zombie reaping
#
# Layer order (per change 0006 design): apt → npm globals → bun deps →
# app source. Source edits invalidate only the cheap final layers.
#
# Every external version is captured as a build ARG below. Bumps are
# one-edit changes; reproducing a historical build is a single
# `docker build --build-arg ...`. ARGs declared before the first FROM are
# "global" — each stage that wants to read one must redeclare it.

# Node 22 toolchain (must remain at the same major as `mise.toml`'s
# `node = "22.X.Y"`). Latest 22-bookworm-slim patch at PR time.
ARG NODE_VERSION=22.22.2

# Bun runtime — MUST match `mise.toml`'s `bun = "X.Y.Z"` so dev/CI/Docker
# share an identical toolchain.
ARG BUN_VERSION=1.3.13

# obsidian-headless is pre-1.0; lock the exact patch and bump deliberately,
# per change 0006's "Open Questions".
ARG OBSIDIAN_HEADLESS_VERSION=0.0.8

# apt package versions in oven/bun:${BUN_VERSION} (Debian trixie) at PR time.
# Pinned so rebuilds are reproducible. When Debian publishes a security
# update, `apt-get install` will fail until these strings are bumped — which
# is the desired forcing function. Re-discover with:
#   docker run --rm oven/bun:${BUN_VERSION} bash -c \
#     'apt-get update -qq && apt-cache policy tini curl ca-certificates'
ARG TINI_VERSION=0.19.0-3+b7
ARG CURL_VERSION=8.14.1-2+deb13u3
ARG CA_CERTIFICATES_VERSION=20250419

# Git revision baked into the image's OCI labels. CI sets this to the 7-char
# short SHA; local `docker build` falls back to "dev". Mirrors the
# `org.opencontainers.image.revision` label that `docker/metadata-action`
# emits in CI — these in-Dockerfile labels are the fallback for non-CI
# builds (per change 0010).
ARG GIT_SHA=dev

# ── Stage 1: node-tools ──────────────────────────────────────────────────────
# Embed Node 22 + obsidian-headless globally so the runtime stage can copy a
# single tidy directory tree.
FROM node:${NODE_VERSION}-bookworm-slim AS node-tools
ARG OBSIDIAN_HEADLESS_VERSION

# `npm config set prefix` keeps the global install under one directory we can
# COPY --from into the runtime stage. `--no-fund --no-audit` quiets noise that
# would otherwise be the only output during the build cache miss.
RUN npm config set prefix /opt/node-globals \
 && npm install -g --no-fund --no-audit "obsidian-headless@${OBSIDIAN_HEADLESS_VERSION}"

# ── Stage 2: bun-deps ────────────────────────────────────────────────────────
# Resolve Bun deps with a frozen lockfile.
FROM oven/bun:${BUN_VERSION} AS bun-deps
WORKDIR /app
COPY package.json bun.lock ./
# `--production` skips devDependencies (biome, typescript, @types/bun) which
# aren't needed at runtime and add ~80 MB. The frozen lockfile ensures we
# still get the exact deps tested in CI. After install, prune native
# binaries we don't load: LanceDB and sharp ship per-libc, per-arch native
# packages via optionalDependencies, but v1 ships linux/amd64 glibc only
# (multi-arch is an out-of-scope item in change 0006).
RUN bun install --frozen-lockfile --production \
 && rm -rf \
    node_modules/@lancedb/lancedb-linux-x64-musl \
    node_modules/@lancedb/lancedb-linux-arm64-gnu \
    node_modules/@lancedb/lancedb-linux-arm64-musl \
    node_modules/@lancedb/lancedb-darwin-x64 \
    node_modules/@lancedb/lancedb-darwin-arm64 \
    node_modules/@lancedb/lancedb-win32-x64-msvc \
    node_modules/@img/sharp-darwin-arm64 \
    node_modules/@img/sharp-darwin-x64 \
    node_modules/@img/sharp-linux-arm \
    node_modules/@img/sharp-linux-arm64 \
    node_modules/@img/sharp-linux-s390x \
    node_modules/@img/sharp-linuxmusl-x64 \
    node_modules/@img/sharp-linuxmusl-arm64 \
    node_modules/@img/sharp-win32-x64 \
    node_modules/@img/sharp-wasm32

# ── Stage 3: runtime ─────────────────────────────────────────────────────────
# Final stage. Same Bun base as bun-deps so the embedded glibc matches.
FROM oven/bun:${BUN_VERSION} AS runtime
ARG TINI_VERSION
ARG CURL_VERSION
ARG CA_CERTIFICATES_VERSION
ARG GIT_SHA

# OCI image metadata. `docker/metadata-action` writes its own labels in CI;
# these in-Dockerfile labels are the fallback for `docker build` outside CI
# so a hand-built image still self-describes (per change 0010).
LABEL org.opencontainers.image.source="https://github.com/fx/ob" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.description="Single-process Bun server that syncs Obsidian vaults, indexes them into LanceDB, and exposes REST + MCP." \
      org.opencontainers.image.licenses="MIT"

# tini (PID 1 signal forwarder), curl (HEALTHCHECK), ca-certificates (TLS for
# HuggingFace + OpenAI). Each package version is pinned via build ARG so
# rebuilds are reproducible. Bump these in the same PR that bumps the Bun
# base when Debian rotates a point release.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      "tini=${TINI_VERSION}" \
      "curl=${CURL_VERSION}" \
      "ca-certificates=${CA_CERTIFICATES_VERSION}" \
 && rm -rf /var/lib/apt/lists/*

# Pull Node 22 + the global obsidian-headless install over from node-tools.
# The symlink is unguarded — if the upstream package layout changes and `ob`
# is missing from /opt/node-globals/bin, the build MUST fail loudly here
# rather than ship an image that can't supervise vaults.
COPY --from=node-tools /usr/local/bin/node /usr/local/bin/node
COPY --from=node-tools /opt/node-globals /opt/node-globals
RUN ln -s /opt/node-globals/bin/ob /usr/local/bin/ob

# Non-root runtime user. The `oven/bun` base ships a `bun` user at uid 1000;
# we rename it to `ob` so the home directory and process listings match the
# project name. The architecture spec mandates rootless operation at uid 1000.
RUN usermod --login ob --move-home --home /home/ob bun \
 && groupmod --new-name ob bun \
 && mkdir -p /app /data /home/ob/.config/obsidian-headless \
 && chown -R 1000:1000 /app /data /home/ob

WORKDIR /app

# Bun deps from the dedicated dependency stage. Owned by the runtime user so
# the process can read them without root.
COPY --from=bun-deps --chown=1000:1000 /app/node_modules ./node_modules

# Application source last — these layers are the only ones invalidated by a
# typical code edit.
COPY --chown=1000:1000 src ./src
COPY --chown=1000:1000 package.json bun.lock ./

USER 1000:1000

EXPOSE 3000
VOLUME ["/data"]

ENV DATA_DIR=/data \
    HTTP_PORT=3000 \
    HTTP_HOST=0.0.0.0 \
    NODE_ENV=production

# Liveness probe. start-period of 60s gives the initial vault sync-setup +
# model download a chance to finish on cold start without flapping the
# container as unhealthy. Readiness (per-vault index ready) is exposed
# separately at /readyz; orchestrators that need it should probe that path.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -fsS "http://localhost:${HTTP_PORT:-3000}/healthz" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bun", "src/server.ts"]

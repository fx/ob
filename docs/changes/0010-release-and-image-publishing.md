# 0010: Release automation and image publishing

## Summary

Wire up the two GitHub-Actions workflows that turn a green `main` into a tagged release and a published Docker image, without manual gh / docker invocations:

1. **`release-please.yml`** — `googleapis/release-please-action@v4` watches Conventional Commits on `main`, maintains a permanently-open release PR, and on merge of that PR cuts a `vX.Y.Z` git tag + GitHub release with auto-generated `CHANGELOG.md`.
2. **`docker.yml`** — builds the production image on every push to `main` (publishing as `:main` + `:sha-<short>`), and on every `v*` tag (publishing as `:X.Y.Z`, `:X.Y`, `:X`, plus `:latest` via the metadata action). PRs build but don't push.

After this lands, the only human action between merging conventional commits and a versioned Docker image is "click merge on the release PR." CI itself (lint, typecheck, tests) is owned by [Change 0009 — CI test suite](./0009-ci-test-suite.md), which is a hard prerequisite — it provides the merge gate that makes "green main → publish" trustworthy.

**Spec:** [Architecture](../specs/architecture/)
**Status:** complete
**Depends On:** 0009

## Motivation

Today:
- The Makefile has `image` / `image-push` targets but they're hand-run from a laptop.
- There is no semver, no CHANGELOG, no tagged Docker image — `:latest` is whatever someone last pushed by hand.

This is fine for bootstrap (changes 0001–0008 all merged that way) but is the wrong floor for downstream consumers of the image. The pattern below is well-trodden, parameter-free, and has no project-specific surprises:

- **Conventional Commits → release-please → semver tag → Docker image tag** is one straight line. Each step is owned by an off-the-shelf, widely-deployed action.
- **No second tagging vocabulary.** Image tags derive from git tags via `docker/metadata-action`. There is exactly one source of truth for "what version is this": the git tag.
- **PR-time builds are non-pushing.** Catches Dockerfile breakage at PR review time without polluting the registry.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint)). CI enforces these as merge gates:

- `bun test --coverage` MUST stay at 100% line + function coverage on `src/`. The merge gate established in [Change 0009](./0009-ci-test-suite.md) enforces this; this change does NOT relax it.
- The Docker integration test (`test/docker.test.ts` from 0006, gated by `DOCKER_E2E=1`) MUST run inside the `docker.yml` workflow's pre-push step on push events. PR builds MAY skip it to keep PR feedback fast, but the production-image push path MUST exercise it.
- Workflow files added by this change MUST be valid GitHub Actions YAML (parseable, schema-conformant, no missing required fields) — i.e. they MUST run when triggered. Running `actionlint` (or equivalent) locally during PR prep is RECOMMENDED but not REQUIRED; if it IS run and reports errors, those errors SHOULD be fixed before merge. CI does NOT gate on `actionlint` in v1 — see Decisions for the rationale. There is no contradiction with the "RECOMMENDED, not REQUIRED" line below: the requirement is that the workflows actually work, not that any specific linter has been run.
- The release PR cut by `release-please` MUST be allowed to merge ONLY after `CI / ci` (from 0009) is green on it.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Conventional Commits as the merge convention

- Every PR title that lands on `main` MUST follow [Conventional Commits](https://www.conventionalcommits.org/) — `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, with optional scope `feat(indexer): …` and optional `!` for breaking change. release-please derives the next version bump from these prefixes.
- The repo MUST adopt squash-merge (default) so a PR's title becomes the single commit message on `main`. Per-commit titles inside a branch MAY be free-form; only the squash result feeds release-please.
- A short `CONTRIBUTING.md` section MUST document the convention with two or three concrete examples and a "what triggers what bump" cheat sheet. The implementation PR for this change MUST create `CONTRIBUTING.md` at the repo root (it does not exist yet — see Tasks below); only after that PR lands will `[../../CONTRIBUTING.md](../../CONTRIBUTING.md)` resolve.

### `release-please.yml` — semver + CHANGELOG

- The workflow MUST trigger on `push` to `main` only. PRs MUST NOT trigger it.
- It MUST use `googleapis/release-please-action@v4`.
- It MUST run on `ubuntu-latest` and grant `permissions: { contents: write, pull-requests: write }`.
- A `release-please-config.json` at repo root MUST define a single root-level package:
  ```json
  {
    "$schema": "https://raw.githubusercontent.com/googleapis/release-please/main/schemas/config.json",
    "packages": {
      ".": {
        "release-type": "node",
        "changelog-path": "CHANGELOG.md"
      }
    }
  }
  ```
- A `.release-please-manifest.json` MUST exist at repo root and MUST start at `{ ".": "0.1.0" }` (initial pre-1.0 version). The manifest is automatically maintained by the action; manual edits are reserved for bootstrap and recovery.
- The action MUST open a release PR titled `chore: release X.Y.Z` and MUST keep it up-to-date as new commits land on `main`. Merging that PR MUST tag `vX.Y.Z`, push the tag, and publish a GitHub release whose body is the CHANGELOG entry.
- Releases MUST NOT be cut from any branch other than `main`.

#### Scenario: Conventional commit triggers release PR update

- **GIVEN** a clean `main` at `v0.1.0`
- **WHEN** a PR titled `feat(search): hybrid retrieval` is squash-merged
- **THEN** within minutes, release-please updates its open release PR to bump the proposed version to `0.2.0`
- **AND** the proposed `CHANGELOG.md` includes a `### Features` entry citing the merged PR

#### Scenario: Merging the release PR cuts a tag

- **GIVEN** an open release-please PR proposing `v0.2.0`
- **WHEN** the PR is squash-merged
- **THEN** a `v0.2.0` git tag is pushed
- **AND** a GitHub release `v0.2.0` is created with the CHANGELOG body
- **AND** the `docker.yml` workflow's `tags: ['v*']` trigger fires for the new tag

### `docker.yml` — image build and publish

- The workflow MUST trigger on:
  - `push` to `main` (paths-ignored to skip docs)
  - `push` of any tag matching `v*`
  - `pull_request` (paths-ignored to skip docs)
- It MUST run on `ubuntu-latest` and grant `permissions: { contents: read, packages: write }`.
- It MUST log into `ghcr.io` using `${{ secrets.GITHUB_TOKEN }}`. The login step MUST be skipped on `pull_request` events (no token to push with).
- It MUST use `docker/setup-buildx-action@v3` for buildkit + GHA cache support.
- It MUST use `docker/metadata-action@v5` to compute tags and OCI labels:

  ```yaml
  images: ghcr.io/${{ github.repository }}
  tags: |
    type=ref,event=branch          # produces :main on main pushes
    type=sha,prefix=sha-           # produces :sha-<7-char-shortsha>
    type=semver,pattern={{version}}     # produces :X.Y.Z on v* tags
    type=semver,pattern={{major}}.{{minor}}  # produces :X.Y
    type=semver,pattern={{major}}            # produces :X
  ```

  The `type=semver` patterns derive cleanly from `v*` tags only. PRs and main pushes do not produce semver tags.
- It MUST use `docker/build-push-action@v6` with:
  - `context: .`
  - `push: ${{ github.event_name != 'pull_request' }}` so PRs build but don't publish
  - `tags: ${{ steps.meta.outputs.tags }}`
  - `labels: ${{ steps.meta.outputs.labels }}` (OCI labels — image source, revision, created)
  - `build-args: GIT_SHA=${{ steps.sha.outputs.short }}` where `sha.outputs.short` is the 7-char SHA
  - `cache-from: type=gha` and `cache-to: type=gha,mode=max`
- The Dockerfile MUST gain `ARG GIT_SHA=dev` and the runtime stage MUST set `LABEL org.opencontainers.image.revision="${GIT_SHA}"` plus the standard source/license/description labels (the metadata action emits OCI labels too — these Dockerfile labels are the fallback for `docker build` outside CI).

#### Scenario: PR builds but doesn't push

- **GIVEN** an open PR
- **WHEN** the docker workflow runs
- **THEN** the image builds successfully
- **AND** no image is pushed to `ghcr.io`
- **AND** no login step runs

#### Scenario: Main push publishes channel tags

- **GIVEN** a squash-merge to `main` with short SHA `abc1234`
- **WHEN** the docker workflow runs
- **THEN** `ghcr.io/<org>/ob:main` is updated to point at the new build
- **AND** `ghcr.io/<org>/ob:sha-abc1234` is published as an immutable tag

#### Scenario: Tag push publishes semver tags

- **GIVEN** release-please pushes tag `v0.2.1`
- **WHEN** the docker workflow runs
- **THEN** the registry contains `:0.2.1`, `:0.2`, `:0` pointing at the new build
- **AND** `:latest` follows the same image (via the metadata action's default behavior on semver tags)

### README touch-ups

- README MUST replace the hand-coded `make image-push` instructions with a section describing the automated flow ("merge to main → `:main` + `:sha-…`; merge release PR → `:X.Y.Z` + `:X.Y` + `:X` + `:latest`"). The Makefile targets MAY remain for local testing.
- README MUST list the published tag schemes so consumers know which one to pin against.

## Design

### Approach

- All three workflows live in `.github/workflows/`. The repo currently has no workflows directory; this change creates it.
- release-please manages its own state on `main` via two committed files (`release-please-config.json`, `.release-please-manifest.json`). No external service, no GitHub App.
- The metadata action is the single source of tag truth for Docker. Hand-rolled tag math (`if [[ $TAG = v* ]]; …`) is forbidden — it's exactly the kind of thing that drifts.
- GHA cache (`type=gha,mode=max`) is the right cache backend for a single-repo CI; registry-side caches are overkill for v1.

### Decisions

- **`release-type: node`** because we have a `package.json` whose `version` field release-please will keep updated; bumps the manifest in lockstep.
- **Pre-1.0 floor.** Manifest starts at `0.1.0` because we have not promised stability. release-please's `feat:` bumps minor only while major is `0`, which matches the bootstrap-grade promise.
- **No monorepo machinery.** Single root package, no `component`, no `group-pull-request-title-pattern`. If the repo ever gains a published SDK it can be added as a second package later — the schema supports it cleanly.
- **`ubuntu-latest` over self-hosted.** Self-hosted runners introduce per-runner state and a maintenance burden the project doesn't have a budget for. Bun on `ubuntu-latest` is fast enough.
- **Squash-merge convention.** Per-commit titles inside a branch are noisy; only the squash result feeds release-please. The repo MUST be configured to default to squash and to use the PR title as the commit message.
- **`paths-ignore` includes `docs/**` and `**.md`** for both `ci.yml` and `docker.yml`. Spec edits and changelog tweaks should not cost CI minutes or republish the image. Workflow files themselves MUST NOT be in `paths-ignore`.
- **Required-check interaction with `paths-ignore` (applies to `Docker / build` too).** GitHub does not create a status for a path-skipped workflow, so a branch-protection rule that requires `Docker / build` will leave docs-only PRs stuck pending. The same resolution as for `CI / ci` (see [0009 — Required-check interaction with `paths-ignore`](./0009-ci-test-suite.md#ciyml--merge-gate)) applies here: branch protection MUST NOT list `Docker / build` as a required check until either (a) GitHub natively supports per-path required checks, or (b) a tiny shim workflow with no path filter emits a `Docker / build-required` status that branch protection targets instead. Picking between those is the repo admin's call and is out of scope for this change.
- **`actionlint` is RECOMMENDED, not REQUIRED.** A single-step lint of YAML actions has a high catch rate but is not load-bearing for v1.

### Non-Goals

- **Multi-arch images.** v1 ships `linux/amd64` only (per 0006). Multi-arch is a follow-up change once a consumer needs it.
- **Image signing / SBOM / provenance.** Defer; introduce alongside the multi-arch change.
- **Registry mirrors / pull-through caches.** GHCR is the only publish target.
- **Automated security scanning** (`docker scout`, Trivy, etc.) — defer.
- **Branch protection rule wiring.** This change adds the workflow; the repo admin enables required-checks separately. The workflow names (`CI / ci`, `Docker / build`) MUST be stable so the admin can target them.

## Tasks

- [x] **`.github/workflows/release-please.yml`** — minimal: trigger on push to main, run the official action with `GITHUB_TOKEN`.
- [x] **`.github/workflows/docker.yml`** — full pattern: triggers, login (skip on PR), buildx, metadata-action with the five tag patterns, build-push-action with cache + GIT_SHA build-arg + push gate.
- [x] **`release-please-config.json` + `.release-please-manifest.json`** — root-level single-package config; manifest at `0.1.0`.
- [x] **`package.json` version** — set to `0.1.0` to match the manifest. Future bumps land via release-please PRs only.
- [x] **Dockerfile diff** — `ARG GIT_SHA=dev` and OCI labels (`source`, `revision`, `description`, `licenses`) in the runtime stage. The metadata action writes its own labels too; Dockerfile labels are the fallback for non-CI builds.
- [x] **Create `CONTRIBUTING.md`** at repo root — this file does not yet exist (0009 does NOT create it; the implementer of 0010 owns its creation). Required content: a Conventional Commits section with prefixes, scopes, breaking-change marker, three concrete examples, and a "what triggers what bump" cheat sheet.
- [x] **README** — replace hand-run image instructions with a section describing automated tags. List the tag schemes consumers can pin to.
- [x] **`docs/index.yml` + `docs/index.md`** — flip 0010 to `complete` in the same PR per the standing rule.
- [x] **`docs/specs/architecture/index.md` changelog** — add a row noting the release-please + docker workflows have landed and the published tag schemes. The placeholder entry seeded by this PR will be updated/replaced at implementation time.
- [ ] **First release PR sanity** — after merge, confirm release-please opens its release PR within minutes; merge it once to validate the tag-and-publish path end-to-end on a `0.1.1` patch (an empty `chore:` commit is acceptable to drive the first cycle). _(Post-merge)_

## Open Questions

- **`docker.yml` running tests pre-push.** Whether to run `bun test` inside the docker workflow as well as `ci.yml` from 0009. **Default**: no; `ci.yml` is the merge gate, `docker.yml` trusts it. The `DOCKER_E2E=1` integration test from 0006 runs in `docker.yml` after build because it requires the image and is therefore docker-specific.
- **`v*` tag prefix vs un-prefixed.** release-please defaults to `vX.Y.Z`. We accept the default. **Default**: `v` prefix.
- **Initial version.** `0.1.0` matches the conservative floor. **Default**: `0.1.0` and bump via release-please from there.

## References

- Spec: [Architecture › Build and Image](../specs/architecture/index.md)
- Prerequisite: [Change 0009 — CI test suite](./0009-ci-test-suite.md)
- Underlies image: [Change 0006 — Production Image](./0006-production-image.md)
- [Conventional Commits 1.0](https://www.conventionalcommits.org/en/v1.0.0/)
- [release-please](https://github.com/googleapis/release-please)
- [release-please-action](https://github.com/googleapis/release-please-action)
- [docker/metadata-action](https://github.com/docker/metadata-action)
- [docker/build-push-action](https://github.com/docker/build-push-action)
- [GHA cache for Docker buildx](https://docs.docker.com/build/cache/backends/gha/)

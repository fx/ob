# 0009: CI test suite — lint, typecheck, and tests on every PR

## Summary

Add a single GitHub Actions workflow (`.github/workflows/ci.yml`) that runs the project's existing test suite, type-check, and lint on every push to `main` and every pull request. After this lands, the merge gate is green CI — not honor-system local `make test`.

This change is intentionally narrow: it wires the **already-existing** suite to the **already-existing** rules in the [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint) section. It introduces no new rules, no new tools, and no behavior changes in `src/`.

**Spec:** [Architecture](../specs/architecture/)
**Status:** complete
**Depends On:** 0006

## Motivation

Six changes have shipped (0001–0006) without an automated CI gate. The architecture spec already pins coverage at 100% and requires Biome + hadolint + `tsc --noEmit` to pass on every PR — these rules exist on paper but are enforced only by reviewer discipline and pre-merge ceremony. That works at one or two contributors and breaks at three.

Adding CI now, before [Change 0010](./0010-release-and-image-publishing.md) wires up image publishing, means publishing is gated by green CI from day one. Doing it the other way around — publishing first, CI later — would make `:main` and `:sha-…` images potentially-broken until the gate exists.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint)). The workflow added by this change IS the enforcement mechanism for those rules:

- The standing 100% line + branch coverage gate on `src/` (see [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint)) MUST hold. The workflow MUST run `bun run test:cov`, which executes `bun test --coverage` and then `test/check-coverage.ts` to enforce the per-file gate (today's Bun proxy is line + function — see the script header). The workflow MUST fail the build on any drop.
- `bun run lint` (Biome + hadolint, both per [Change 0006](./0006-production-image.md)) MUST pass; the workflow MUST fail the build on any error.
- `bunx tsc --noEmit` MUST pass; the workflow MUST fail the build on any type error.
- The workflow itself MUST be self-validating — a no-op edit to `ci.yml` MUST trigger CI on the PR that introduces it (i.e. workflow files MUST NOT be in `paths-ignore`).

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### `ci.yml` — merge gate

- The workflow MUST live at `.github/workflows/ci.yml` and MUST be named `CI`. The job name MUST be stable (`ci`) so a downstream branch-protection setting can require the check `CI / ci`.
- The workflow MUST trigger on:
  - `push` to `main`
  - every `pull_request`
- The workflow MUST `paths-ignore` paths that cannot affect runtime: `docs/**`, `**.md`, `.gitignore`. Workflow files themselves (`.github/workflows/**`) MUST NOT be in `paths-ignore` — changing CI must run CI.
- **Required-check interaction with `paths-ignore`.** When a `pull_request` is path-skipped, GitHub does NOT create a `CI / ci` status, and a branch-protection rule that requires `CI / ci` will leave the PR pending forever. The intended resolution in v1 is that branch protection MUST NOT list `CI / ci` as a required status check until path-skipped PRs are handled. Two acceptable handling options for the implementer of the branch-protection setup (out of scope for this change, owned by the repo admin):
  1. Configure branch protection to require `CI / ci` only on PRs that touch non-ignored paths (GitHub does not natively support this; the practical workaround is option 2).
  2. Add a tiny `ci-required.yml` workflow (no path filter) whose only job is named `ci-required` and either calls `ci.yml` as a reusable workflow or always succeeds for path-skipped PRs; require `ci-required` instead of `CI / ci`.
  This change document does not pick between those two; it just requires that branch-protection wiring not be turned on for `CI / ci` until one of them is in place.
- The workflow MUST run on `ubuntu-latest`. Self-hosted runners are OUT OF SCOPE for v1.
- The workflow MUST grant `permissions: { contents: read }` and nothing else.

### Setup steps

- The workflow MUST `actions/checkout@v4`.
- The workflow MUST set up Bun via `oven-sh/setup-bun@v2`, pinned to the version declared in `mise.toml` (`1.3.13` at time of writing). The literal version MUST appear in `ci.yml` with a comment pointing at `mise.toml`. (See open question on auto-syncing.)
- The workflow MUST cache `~/.bun/install/cache` via `actions/cache@v4`, keyed on `${{ runner.os }}-bun-${{ hashFiles('**/bun.lock') }}` with a `${{ runner.os }}-bun-` restore-keys fallback.
- The workflow MUST run `bun install --frozen-lockfile`. A lockfile drift MUST fail the build (frozen-lockfile guarantees this).

### Verification steps

The workflow MUST run, in this order:

1. **Lint** — `bun run lint`. This is the existing script from 0006 and runs Biome (with `noExplicitAny` and the project ignores) plus `hadolint Dockerfile`. The `hadolint` binary is installed in the dev container; the CI runner MUST install it via the project's existing approach (apt or a release download — implementer's call, but must be reproducible).
2. **Typecheck** — `bunx tsc --noEmit`.
3. **Test with coverage** — `bun run test:cov`. This is the existing script that runs `bun test --coverage` and then invokes `test/check-coverage.ts` to enforce the per-file 100% gate (line + function as today's Bun proxy for the standing line + branch requirement). The workflow MUST fail when coverage drops on any `src/` file. The script MUST also emit an LCOV report that the next step uploads — pass `--coverage-reporter=lcov --coverage-dir=./coverage` (or equivalent) so `coverage/lcov.info` exists after this step.
4. **Upload coverage to Codecov** — `codecov/codecov-action@v5` consumes `coverage/lcov.info` and posts a check + PR comment. Auth is via a repo secret `CODECOV_TOKEN`. The step MUST run on push and on `pull_request` events; it MUST NOT block CI on Codecov upload failure (`continue-on-error: true`) so a Codecov outage doesn't redden a green test run. The Codecov-emitted `codecov/patch` and `codecov/project` checks are independent of `CI / ci` and stand on their own as merge signals.

The order matters: lint and typecheck are cheaper than tests, and a lint failure shouldn't wait on a test pass to surface. Codecov runs last because it depends on the test step's coverage artifact.

### What this workflow is NOT

- It is NOT a Docker workflow. The `DOCKER_E2E=1` integration test from 0006 stays gated behind that env var and runs only in the docker workflow added by [Change 0010](./0010-release-and-image-publishing.md). PR feedback time matters; image rebuilds belong in their own workflow.
- It is NOT a release or publish workflow. No `GITHUB_TOKEN` use beyond default read permissions; no registry login.
- It does NOT run `bun build` or any production-bundle step. The Bun runtime executes TS directly per the architecture spec; there is no separate build artifact to validate.

#### Scenario: Failing test blocks merge

- **GIVEN** an open PR whose `bun test` exit code is non-zero
- **WHEN** the CI workflow runs
- **THEN** the `Test` step fails
- **AND** the GitHub PR check `CI / ci` is red
- **AND** branch protection (configured separately) MUST prevent merge

#### Scenario: Lint failure short-circuits

- **GIVEN** an open PR with a Biome violation in `src/`
- **WHEN** the CI workflow runs
- **THEN** the `Lint` step fails
- **AND** subsequent steps (`Typecheck`, `Test`) MAY be skipped (GHA default is "skip dependent steps on failure")
- **AND** the PR check is red within ~1 minute

#### Scenario: Coverage regression blocks merge

- **GIVEN** an open PR that introduces an `src/` line not exercised by any test
- **WHEN** the CI workflow runs
- **THEN** the `Test` step fails with the existing `check-coverage` gate's error
- **AND** the PR check is red

#### Scenario: docs-only PR skips CI

- **GIVEN** an open PR that touches only `docs/**` and `README.md`
- **WHEN** GitHub evaluates the workflow's `paths-ignore`
- **THEN** the workflow does not run
- **AND** branch protection MUST be configured per the "Required-check interaction with `paths-ignore`" rule above so that path-skipped PRs are not stuck on a never-emitted `CI / ci` status (handled by the admin alongside the workflow rollout)

#### Scenario: Workflow edit triggers CI on its own PR

- **GIVEN** an open PR that modifies `.github/workflows/ci.yml`
- **WHEN** GitHub evaluates triggers
- **THEN** the workflow runs (workflow files are NOT in `paths-ignore`)
- **AND** the PR check reflects the result of the new workflow content

## Design

### Approach

A minimal `ci.yml` per the requirements above. The full workflow is small enough to inline:

```yaml
name: CI

on:
  push:
    branches: [main]
    paths-ignore:
      - 'docs/**'
      - '**.md'
      - '.gitignore'
  pull_request:
    paths-ignore:
      - 'docs/**'
      - '**.md'
      - '.gitignore'

permissions:
  contents: read

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: oven-sh/setup-bun@v2
        with:
          # Pinned to mise.toml — bump in lockstep.
          bun-version: 1.3.13

      - uses: actions/cache@v4
        with:
          path: ~/.bun/install/cache
          key: ${{ runner.os }}-bun-${{ hashFiles('**/bun.lock') }}
          restore-keys: ${{ runner.os }}-bun-

      - name: Install hadolint
        # GitHub-hosted runners execute steps as the unprivileged `runner`
        # user, so writes into /usr/local/bin require sudo (this matches the
        # README's local install recipe).
        run: |
          sudo curl -sSL -o /usr/local/bin/hadolint https://github.com/hadolint/hadolint/releases/download/v2.12.0/hadolint-Linux-x86_64
          sudo chmod +x /usr/local/bin/hadolint

      - run: bun install --frozen-lockfile

      - name: Lint
        run: bun run lint

      - name: Typecheck
        run: bunx tsc --noEmit

      - name: Test (with coverage)
        run: bun run test:cov

      - name: Upload coverage reports to Codecov
        if: always()
        continue-on-error: true
        uses: codecov/codecov-action@v5
        with:
          token: ${{ secrets.CODECOV_TOKEN }}
          slug: fx/ob
```

`if: always()` is what makes the upload run when the test step fails — partial coverage on a failing run is still useful Codecov data. `continue-on-error: true` keeps a Codecov upload glitch from reddening an otherwise green PR (Codecov posts its own checks, which DO gate merge).

### Decisions

- **`ubuntu-latest` over self-hosted.** Self-hosted runners introduce per-runner state and a maintenance burden the project doesn't have a budget for. Bun on `ubuntu-latest` is fast enough for v1.
- **Pin Bun via the literal version with a `mise.toml` reference comment.** Reading `mise.toml` from a `setup-bun` action input requires either a third-party action or an extra shell step; the catch is small (occasional drift between `mise.toml` and the workflow), the cost of avoiding it is high, and a future change can introduce a `mise`-aware setup if it pays off.
- **Hadolint installed inline.** Adding it as a separate action is a wash; the curl-and-chmod approach is one line and version-pinned. (See open question on extracting it.)
- **`bun.lock` (text) for the cache key.** Bun's text lockfile is the project's canonical lockfile; binary `bun.lockb` is no longer authoritative.
- **`frozen-lockfile` for installs.** Lockfile drift is a defect, not a soft warning.
- **No matrix, no cross-version, no cross-OS.** The runtime is "Bun on Linux" per the architecture spec. Matrix runs would test what the project doesn't support and slow down PR feedback.
- **Codecov uploads run on every CI run (push + PR).** The repo's standing 100% gate already blocks merge locally; Codecov adds per-PR diff coverage visibility and historical trend, which the local script does not. `continue-on-error: true` keeps the upload step from reddening CI on Codecov's own outages.
- **`CODECOV_TOKEN` is a repo secret.** The token is required for upload from forked PRs and for private repos; the user has provisioned it. The workflow MUST reference `${{ secrets.CODECOV_TOKEN }}` directly.

### Non-Goals

- Docker integration tests — owned by 0010's `docker.yml`.
- Release tagging — owned by 0010.
- Branch-protection wiring — repo-admin operation, not a workflow concern.
- `actionlint` / workflow-linting in CI — RECOMMENDED for local PR prep but not enforced in v1.
- A `bun build` step — the runtime executes TS directly.

## Tasks

- [x] **`.github/workflows/ci.yml`** — author per the inlined snippet above; verify locally via `act` or by pushing a throwaway PR.
- [x] **Confirm `bun run lint` does both Biome and hadolint.** From 0006 it should already; if not, the lint script is updated in this PR to include `hadolint Dockerfile`.
- [x] **Verify hadolint pin** — match the version used in the dev container (or pin to a recent stable release and document).
- [x] **`test:cov` script emits LCOV** — extend `package.json#scripts.test:cov` (or the underlying invocation) so `coverage/lcov.info` is produced alongside today's text summary. The Codecov action consumes it. (Already produced via `bunfig.toml`'s `coverageReporter = ["text", "lcov"]`; no script change needed.)
- [x] **`CODECOV_TOKEN` repo secret is set.** Verified by the user; the implementation PR MUST reference `${{ secrets.CODECOV_TOKEN }}` and slug `fx/ob`.
- [x] **`docs/index.yml` + `docs/index.md`** — flip 0009 to `complete` in the same PR per the standing rule.
- [x] **`docs/specs/architecture/index.md` changelog** — add a row noting the CI workflow has landed and `CI / ci` is the merge gate. The placeholder entry seeded by this PR will be updated/replaced at implementation time.
- [x] **Smoke the gate end-to-end** — moved to [`docs/tasks.md`](../tasks.md) as a post-merge validation item, since it requires a throwaway PR opened *against* the gate and so cannot run inside the PR that introduces it.

## Open Questions

- **Auto-sync `bun-version` to `mise.toml`.** A small step like `echo "BUN=$(grep '^bun ' mise.toml | …)" >> $GITHUB_ENV` could remove the duplication. **Default**: defer; eat the literal duplication for v1, revisit if it ever drifts.
- **Hadolint as a separate workflow step vs bundled into `bun run lint`.** Separating it gives clearer step-level red/green; bundling matches the dev-container experience. **Default**: bundle inside `bun run lint` (the dev-container experience), accept that step-level granularity is "Lint" not "Biome + Hadolint."
- **`actionlint` in CI.** Catch-rate is high but the workflow surface is tiny. **Default**: not in v1; recommend running locally during workflow edits.
- **Whether to add `codecov/patch` and `codecov/project` to required status checks.** The local 100% gate already blocks coverage regressions; Codecov's checks become useful once a) the standing gate ever softens or b) per-PR diff coverage visibility matters more than raw pass/fail. **Default**: don't require Codecov checks in v1; the repo admin can flip them on later without a code change.

## References

- Spec: [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint)
- Prerequisite: [Change 0006 — Production Image](./0006-production-image.md) (gives us the lint script that includes hadolint)
- Followed by: [Change 0010 — Release and image publishing](./0010-release-and-image-publishing.md) (depends on this gate)
- [oven-sh/setup-bun](https://github.com/oven-sh/setup-bun)
- [actions/cache](https://github.com/actions/cache)
- [hadolint](https://github.com/hadolint/hadolint)
- [codecov/codecov-action](https://github.com/codecov/codecov-action)

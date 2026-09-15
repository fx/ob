# 0016: Landing Site

## Summary

Add a minimal one-page landing site under `site/` and publish it to GitHub Pages at `https://ob.fx.gd`. It copies `fx/tx`'s `site/` and `Pages` workflow almost file for file. Implements the [Landing Site spec](../specs/landing-site/index.md) and the `site/` entry newly added to [Architecture › Project Layout](../specs/architecture/index.md#project-layout-source-tree).

**Spec:** [Landing Site](../specs/landing-site/)
**Status:** complete
**Depends On:** —

## Motivation

`ob` has a published image and a thorough README, but no front door. The repository's homepage field is empty, and nothing gives a newcomer a thirty-second answer to "what is this and how do I run it". `fx/tx` solved the same problem with a small static page at `tx.fx.gd`. DNS for `ob.fx.gd` already points at `fx.github.io`, so what's missing is the page and the deploy.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint)). CI enforces these as merge gates:

- The 100% line and branch coverage gate on `src/` (`bun run test:cov`) MUST stay green. This change adds no code under `src/` or `test/`, so it MUST NOT add, remove, or exclude any coverage target.
- Biome and `bunx tsc --noEmit` at the repository root MUST pass. Both MUST NOT be widened to `site/`. The root `tsconfig.json` include is unaffected. Root `biome.json` include globs (`src/**`, `test/**`) are unanchored in Biome 1.x and matched `site/src/**`, so this change adds `site/**` to its `files.ignore`, which narrows root lint rather than widening it. The site type-checks with its own `tsconfig.json`.
- The standing rules cover server code only, so the site's gate is its build: `bun run build` in `site/` (`tsc --noEmit && vite build`) MUST pass in the `Pages` workflow on every PR that touches `site/`, and a failing build MUST block deploy.
- The site ships no unit tests, just like `fx/tx`. Its only logic is the copy-to-clipboard control and the theme toggle, both taken unchanged from `fx/tx`. That gap is deliberate and recorded here, not an oversight.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Behavior owned by the specs

The [Landing Site spec](../specs/landing-site/index.md) owns hosting, publishing guarantees, required content, look and feel, and metadata. Its scenarios are this change's acceptance criteria and are not restated here. [Architecture › Project Layout](../specs/architecture/index.md#project-layout-source-tree) owns the new `site/` top-level directory.

What implementing them requires of this change:

- **Path filters.** `.github/workflows/ci.yml` and `.github/workflows/docker.yml` MUST add `site/**` to both their `push` and `pull_request` `paths-ignore` lists. Without it, a site-only merge republishes `ghcr.io/fx/ob:main` and `:sha-<short>` and runs the full server suite.
- **Release exclusion.** `release-please-config.json` MUST add `"exclude-paths": ["site"]` to the `"."` package, so release-please ignores commits that touch only `site/` whatever their type. That is what enforces the spec's no-release guarantee for later site-only PRs, including one titled `feat(site): …`.
- **Commit type.** The implementing PR also touches `.github/workflows/` and `README.md`, which the exclusion does not cover, so its title MUST use `docs(site): …` to avoid a version bump (per [CONTRIBUTING](../../CONTRIBUTING.md), `docs` never bumps).
- **Image isolation.** The Dockerfile copies only `src/`, `package.json`, and `bun.lock` into the app stage (verified), so `site/` stays out of the image with no Dockerfile change. The implementation MUST NOT add a `COPY . .` or similar.
- **Lint isolation.** Root `biome.json` MUST list `site/**` in `files.ignore`. Its unanchored `src/**` include otherwise picks up `site/src/**`, and the site's files, copied verbatim from `fx/tx`, follow `fx/tx`'s formatting rather than this repository's.
- **Repository settings** (manual, outside git): Pages source set to GitHub Actions, custom domain `ob.fx.gd`, repository homepage set to `https://ob.fx.gd`, and the `github-pages` environment deploying from `main` only. Enforce HTTPS is enabled once GitHub issues the `ob.fx.gd` certificate after the first deploy, tracked in [docs/tasks.md](../tasks.md).

#### Scenario: Site-only PR skips server workflows

- **GIVEN** a PR whose diff is confined to `site/`
- **WHEN** it is opened
- **THEN** the `Pages` build job runs and the deploy job is skipped
- **AND** neither the `CI` nor the `Docker` workflow is triggered

## Design

### Approach

One PR copies `fx/tx`'s site and rewrites only what is `tx`-specific:

| Path | Source |
|------|--------|
| `site/package.json`, `site/bun.lock` | From `fx/tx`. `name` → `@fx/ob-site`, same dependency set; regenerate the lockfile with `bun install`. |
| `site/.npmrc`, `site/tsconfig.json`, `site/vite.config.ts` | Verbatim. |
| `site/src/main.tsx`, `site/src/index.css` | Verbatim. |
| `site/src/components/CommandBlock.tsx`, `ThemeToggle.tsx` | Verbatim. |
| `site/src/App.tsx` | Same structure, `ob` content (see Decisions). |
| `site/index.html` | Same theme-bootstrap script; `ob` title, description, and `og:*`. |
| `site/public/CNAME` | `ob.fx.gd` |
| `site/public/favicon.svg` | Simple `ob` monogram in the same style as `tx`'s. |
| `.github/workflows/pages.yml` | From `fx/tx`, with the deltas below. |

`pages.yml` deltas from `fx/tx`:

- `bun-version: 1.3.13`, pinned to `mise.toml` like `ci.yml` and `docker.yml`.
- The install step's `GITHUB_TOKEN` env is `${{ secrets.GITHUB_TOKEN }}` alone, without `fx/tx`'s `PACKAGES_TOKEN ||` fallback. `fx/ob` has been granted Actions access to the `@fx/ui` package, so the job token with `packages: read` can read it. GitHub Packages still rejects anonymous installs, so the token itself is required.
- A `pull_request` trigger on the same `site/**` and `.github/workflows/pages.yml` paths, with the `deploy` job gated by `if: github.event_name != 'pull_request'`. PRs build; only `main` deploys.
- Everything else as in `fx/tx`: `workflow_dispatch`, a `pages` concurrency group without cancellation, least-privilege job permissions, `upload-pages-artifact` of `site/dist`, `deploy-pages` into the `github-pages` environment, and no `configure-pages` step (a custom domain means no base path).

`README.md` gains one line under the intro linking to `https://ob.fx.gd`, and (by the amendment in Decisions) a short "What an agent gets" section with the scoped-session pitch and the tool list.

### Decisions

- **Decision:** copy `fx/tx`'s stack (Vite + React + `@fx/ui` + Tailwind) rather than hand-write plain HTML.
  - **Why:** the user asked for a sibling of `tx.fx.gd`. Shared components and tokens keep the sites visually identical at almost no cost, and a later change to one site ports to the other.
  - **Alternatives considered:** a single hand-written `index.html` with no build, which is smaller but drifts from the fx design system on the first restyle.
- **Decision:** page copy, which the PR MAY tighten but MUST NOT expand past the spec's content list:
  - Headline: "Obsidian vaults, for agents." Description: "`ob` keeps your Obsidian vaults synced, indexes them for natural-language search, and serves them over REST and MCP, from a single container."
  - Run command, one line in the copy block (it scrolls horizontally): `docker run -p 3000:3000 -v ob-data:/data -e OBSIDIAN_AUTH_TOKEN=… -e VAULTS_JSON='[{"name":"vault"}]' ghcr.io/fx/ob:latest`. Buttons: "Read the docs" → README, "Configuration" → README `#configuration`.
  - Capability cells: **Sync** (official Obsidian Sync client, bidirectional, restarts itself when sync stalls) · **Search** (hybrid vector + full-text search over Markdown) · **REST and MCP** (the same file and search operations on both, with per-agent folder scoping on MCP) · **One container** (one process, one image, one volume).
  - Path-scoped sessions, directly after the capability grid. Headline: "One vault, a folder per agent." Pitch: each agent gets its own folder in a shared vault, presented as the vault root, with nothing to provision on the server. URL shapes: `/mcp` → every vault; `/mcp/<slug>` → one vault; `/mcp/<slug>/<folder>` → that folder, presented as the root. "Connect an agent": a code block holding `{ "mcpServers": { "ob": { "type": "http", "url": "http://<host>:3000/mcp/<slug>/agents/<name>" } } }`, followed by: "Scoping confines a cooperating client. It is not access control." and "No built-in authentication. Keep it on a private network or behind a proxy that authenticates."
  - MCP tools, names only, grouped: **Files** `list_files` `read_file` `write_file` `append_file` `patch_file` `delete_file` · **Folders** `list_folders` `create_folder` `delete_folder` · **Vaults and search** `list_vaults` `vault_status` `search`. The README carries the same pitch and list in a short "What an agent gets" section above `## Run`.
  - The path-scoped sessions section and the tool list are a user-approved amendment to the spec's content list, made in this same PR.
  - Header: `MIT` badge next to the wordmark. Footer: MIT licensed · GitHub · Releases · Issues. The root `LICENSE` (MIT) is already in place.
- **Decision:** exclude `site/` from release-please, and title the implementing PR `docs(site)` rather than `feat(site)` (which `fx/tx` used).
  - **Why:** in `fx/ob`, `feat` drives a minor bump, a `vX.Y.Z` tag, and a full image publish, and none of that ships the site. A title convention alone would not hold for future PRs; the path exclusion does.
  - **Alternatives considered:** relying on `docs(site)` titles for every site PR, which breaks the first time someone writes `feat(site)`.
- **Decision:** build on PRs, which `fx/tx` does not.
  - **Why:** otherwise a broken site build only shows up after merge. One `if:` line buys a pre-merge signal.

### Non-Goals

- Documentation pages, an API reference, a changelog view, or anything past one page.
- Hosting docs from `docs/` on Pages.
- Analytics, a newsletter, or any form.
- Changing the README's content beyond the one link and the "What an agent gets" section.
- Extracting shared site code into a package shared with `fx/tx`.

## Tasks

- [x] Add the landing site and Pages workflow (one PR titled `docs(site): add the ob landing page and publish it to GitHub Pages`)
  - [x] Copy `site/` from `fx/tx` per the Approach table; set `package.json` `name`, `CNAME`, favicon, and `index.html` metadata
  - [x] Rewrite `site/src/App.tsx` with the copy in Decisions
  - [x] `cd site && GITHUB_TOKEN=$(gh auth token) bun install` to produce `site/bun.lock`. `site/.npmrc` reads `GITHUB_TOKEN`, and GitHub Packages rejects anonymous installs, so the token needs `read:packages`. Every later local `bun install` in `site/` needs the same.
  - [x] Add `.github/workflows/pages.yml` with the listed deltas
  - [x] Add `site/**` to `paths-ignore` (push and pull_request) in `ci.yml` and `docker.yml`
  - [x] Add `"exclude-paths": ["site"]` to the `"."` package in `release-please-config.json`
  - [x] Add the `https://ob.fx.gd` link to `README.md`
  - [x] Verify locally: `bun run build` passes in `site/`; `bun run dev` serves on `0.0.0.0:5173`; check the page at 360 px wide and in both themes through DOM inspection
  - [x] Confirm the PR's `Pages` build job passes and its deploy job is skipped
  - [x] Feature path-scoped sessions and the grouped MCP tool list on the site and in `README.md` (user-approved amendment)
- [x] Configure repository settings (maintainer, manual): Pages source = GitHub Actions; custom domain `ob.fx.gd`; homepage URL `https://ob.fx.gd`; `github-pages` environment deploys from `main` only (verified). Enforce HTTPS moved to docs/tasks.md — GitHub issues the `ob.fx.gd` certificate only after the first deploy, which this PR's merge triggers
- [x] Live-site verification moved to docs/tasks.md — it is a post-merge validation that cannot run before the deploy this PR triggers

## Open Questions

- [x] Custom-domain verification for `fx.gd` at the org level. `tx.fx.gd` already serves with an approved certificate, which suggests it is in place; confirm when setting the custom domain. **Resolved:** GitHub accepted the custom domain `ob.fx.gd` for `fx/ob`'s Pages site when it was configured on 2026-09-15. Certificate issuance and Enforce HTTPS follow the first deploy and are tracked in [docs/tasks.md](../tasks.md).

## References

- Spec: [Landing Site](../specs/landing-site/index.md)
- Spec: [Architecture › Project Layout](../specs/architecture/index.md#project-layout-source-tree), [› Testing & Lint](../specs/architecture/index.md#testing--lint)
- Related changes: [0009 — CI test suite](./0009-ci-test-suite.md) and [0010 — Release and image publishing](./0010-release-and-image-publishing.md), the workflows whose path filters this change extends
- Reference implementation: [`fx/tx` `site/`](https://github.com/fx/tx/tree/main/site), [`fx/tx` `.github/workflows/pages.yml`](https://github.com/fx/tx/blob/main/.github/workflows/pages.yml), fx/tx#36

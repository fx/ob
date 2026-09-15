# Landing Site

## Overview

`ob` has a one-page public landing site at `https://ob.fx.gd`. It says what `ob` is, shows how to run it, and links to the repository. The site MUST stay minimal. It is not documentation and does not replace the README.

## Background

- Status: **implemented** by [Change 0016](../../changes/0016-landing-site.md), which builds `site/` and publishes it through the `Pages` workflow. DNS for `ob.fx.gd` resolves as a CNAME to `fx.github.io`.
- The [README](../../../README.md) owns the run instructions, configuration reference, and operator guidance. The [Architecture spec](../architecture/index.md) owns the repository layout and the container image. This spec owns only what a visitor to `ob.fx.gd` can observe, plus how the site gets published.

## Requirements

### Hosting

- The site MUST be served at `https://ob.fx.gd/` over HTTPS. Plain-HTTP requests MUST redirect to HTTPS.
- The site MUST be fully static. The page MUST NOT call any backend or `ob` API, and MUST NOT load analytics or tracking.
- Site assets MUST NOT be part of the `ob` container image.

#### Scenario: HTTP is upgraded

- **GIVEN** the site is published
- **WHEN** a client requests `http://ob.fx.gd/`
- **THEN** it is redirected to `https://ob.fx.gd/`
- **AND** that URL returns 200 with the landing page

### Publishing

- A change to the site merged to `main` MUST be published without manual steps.
- A change that touches only the site MUST NOT publish a container image, run the server CI suite, or cut a release.
- A site that fails to build MUST NOT replace the published site.

#### Scenario: Site-only merge

- **GIVEN** a merged PR whose diff is confined to the site
- **WHEN** it lands on `main`
- **THEN** the published site reflects it
- **AND** no `ghcr.io/fx/ob` tag is pushed, the `CI` workflow does not run, and release-please does not propose a version bump for it

#### Scenario: Broken build

- **GIVEN** a site change that fails to type-check or build
- **WHEN** it lands on `main`
- **THEN** the previously published site keeps being served

### Content

The site is one page. It MUST contain:

- the project name and a one-sentence description of what `ob` is;
- the canonical `docker run` invocation against the published `ghcr.io/fx/ob` image, which can be copied in one action;
- a short list of core capabilities: Obsidian Sync, natural-language search, REST and MCP access, and a single container;
- how to point an MCP client at a running server;
- path-scoped MCP sessions — a URL that confines a session to one vault folder and presents it as the root — featured prominently, with the note that scoping is not an authentication boundary;
- a brief list of the MCP tools;
- a plain statement that the server has no built-in authentication and belongs on a private network or behind an authenticating proxy;
- the license (MIT);
- links to the GitHub repository (README), releases, and issues.

The page MUST NOT restate the configuration reference, env-var table, or operator guidance. It links to the README, which owns them. Anything beyond the list above SHOULD be left out.

#### Scenario: Copying the run command

- **GIVEN** the landing page
- **WHEN** the visitor activates the copy control on the run command
- **THEN** the clipboard holds exactly the command text, with no prompt glyph
- **AND** the control briefly confirms the copy

#### Scenario: Clipboard API unavailable

- **GIVEN** a browser where the async clipboard API is missing or rejects
- **WHEN** the visitor activates the copy control
- **THEN** the command is still copied through a fallback, or the control shows no success state

### Look and Feel

- The page MUST use the fx design system.
- By default the page MUST follow the visitor's system color scheme. It MUST offer a light/dark toggle and remember an explicit choice across visits, with no flash of the wrong theme on load.
- The page MUST be usable at 360 px wide with no horizontal page scroll. Long command lines scroll inside their own block.
- Every interactive control MUST be reachable by keyboard, and icon-only controls MUST have an accessible name.

#### Scenario: Remembered theme

- **GIVEN** a visitor on a light-mode system who switched the page to dark
- **WHEN** they reload the page
- **THEN** it renders dark from the first paint

### Metadata

- The page MUST set a descriptive `<title>`, a meta description, Open Graph title, description, and type, and `og:url` of `https://ob.fx.gd`.
- The page MUST serve a favicon.

## Design

### Architecture

- `site/` is a standalone package with its own lockfile. It is not a workspace of the root package.
- It is a single-page React app built with Vite and styled with `@fx/ui` (the fx design system, from GitHub Packages) plus Tailwind. `vite build` writes static output to `site/dist`.
- A `Pages` GitHub Actions workflow builds `site/` and deploys `site/dist` to GitHub Pages. The custom domain is recorded in `site/public/CNAME`.
- An inline script in `index.html` applies the stored or system theme before the first paint.

### Content Shape

Header: `$ ob` wordmark, GitHub link, theme toggle. Hero: headline, one-sentence description, the copyable run command, and links to the README. A four-cell capability grid. A prominent path-scoped sessions section directly after the grid: the three MCP URL shapes, the per-agent-folder pitch, and a "Connect an agent" client config using a scoped URL, next to the not-an-access-control note and the no-auth statement. A brief MCP tool list, grouped. Footer links. [Change 0016](../../changes/0016-landing-site.md#decisions) records the exact copy.

## Constraints

- **DNS:** `ob.fx.gd` → CNAME `fx.github.io`, already in place (verified 2026-09-15). Changing it is outside this repository.
- **Package auth:** `@fx/ui` is public but only published to `npm.pkg.github.com`, which rejects anonymous installs (401, verified 2026-09-15). `fx/ob` has been granted Actions access to the package, so the workflow's own `GITHUB_TOKEN` with `packages: read` is sufficient; no extra secret is needed.
- **Privacy:** the page and its build output carry no personal data, internal hostnames, or private domains.

## Open Questions

- **Image tag on the page.** **Default:** `:latest`, with the README's pinning table linked for anyone who wants an exact version.

## References

- [GitHub Pages custom domains](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site)
- [Architecture › Project Layout](../architecture/index.md#project-layout-source-tree)
- [README](../../../README.md): owns run instructions and configuration

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-09-15 | Initial spec created (planned, not yet implemented) | [0016-landing-site](../../changes/0016-landing-site.md) |
| 2026-09-15 | Implemented: `site/` package and `Pages` workflow; `site/**` excluded from CI, Docker, and release-please | [0016-landing-site](../../changes/0016-landing-site.md) |
| 2026-09-15 | Content amended to feature path-scoped MCP sessions and a brief MCP tool list (user request) | [0016-landing-site](../../changes/0016-landing-site.md) |

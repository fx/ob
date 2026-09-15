# Tasks

Catch-all task list for work not tracked in a specific [change document](changes/).

## Backlog

- **Pin GitHub Actions to commit SHAs.** Currently `ci.yml` uses moving major tags (`actions/checkout@v4`, `oven-sh/setup-bun@v2`, `actions/cache@v4`, `codecov/codecov-action@v5`); change 0010 will add the same pattern for `release-please.yml` / `docker.yml`. SHA-pinning is a stronger supply-chain guarantee. Should be a single repo-wide change document covering all workflows uniformly, with a Dependabot policy that bumps the pins on a schedule.
- **Smoke the `CI / ci` gate end-to-end.** Open a throwaway PR that intentionally drops a line of coverage; confirm the `Test` step fails, the PR is non-mergeable, and Codecov posts a `codecov/patch` check. Close the throwaway PR; do not land it. (Originally listed in [change 0009](changes/0009-ci-test-suite.md); moved here because it is a post-merge validation that cannot run inside the PR introducing the gate.)
- **Verify the live landing site.** Once the `Pages` deploy from the merged change 0016 finishes: enable Enforce HTTPS in the Pages settings once GitHub has issued the `ob.fx.gd` certificate after the first deploy; then check the site against the [Landing Site spec](specs/landing-site/index.md) scenarios: `curl -sI http://ob.fx.gd/` redirects to HTTPS; `https://ob.fx.gd/` returns 200 with the `ob` title; the copy control, theme persistence, and 360 px layout work; `ghcr.io/fx/ob:latest` pulls anonymously, so the copied command works as shown. (Originally listed in [change 0016](changes/0016-landing-site.md); moved here because it is a post-merge validation that cannot run before the deploy the implementing PR triggers.)

## Completed

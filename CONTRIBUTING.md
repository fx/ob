# Contributing

This repo squash-merges every PR. The PR title becomes the single commit message
on `main`, so PR titles MUST follow [Conventional Commits](https://www.conventionalcommits.org/).
[release-please](https://github.com/googleapis/release-please) reads those
commit messages to maintain a permanently-open release PR; merging that PR
cuts a `vX.Y.Z` git tag, publishes a GitHub release, and triggers the Docker
workflow to publish a versioned image. Per-commit titles inside a feature
branch can be free-form — only the squashed result feeds release-please.

## Conventional Commit prefixes

| Prefix | Meaning |
|--------|---------|
| `feat` | New user-visible behavior |
| `fix` | Bug fix in user-visible behavior |
| `chore` | Tooling, deps, repo plumbing — no user-visible behavior |
| `docs` | Documentation only |
| `refactor` | Internal restructure, no behavior change |
| `test` | Test-only change |

A scope is optional and goes in parentheses: `feat(indexer): …`. A trailing
`!` marks a breaking change: `feat(api)!: …`.

### Examples

```text
feat(indexer): hybrid retrieval
fix(api): clamp limit to 100
feat!: drop 0.x token bootstrap
```

## What triggers what bump

The repo is pre-1.0 (`0.x.y`), so SemVer's "anything-goes-while-major-is-0"
clause applies. release-please follows the standard pre-1.0 mapping:

| Commit type | Pre-1.0 bump (current) | Post-1.0 bump (future) |
|-------------|------------------------|------------------------|
| `fix:` | patch (`0.1.0` → `0.1.1`) | patch |
| `feat:` | minor (`0.1.0` → `0.2.0`) | minor |
| `feat!:` / `BREAKING CHANGE:` | major (`0.1.0` → `1.0.0`) | major |
| `chore:` / `docs:` / `refactor:` / `test:` | no version bump (still in CHANGELOG via configured sections) | same |

Once the project crosses `1.0.0`, `feat!:` continues to drive major bumps;
`feat:` stays minor and `fix:` stays patch.

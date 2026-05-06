# 0011: Sync Config Bootstrap

## Summary

Add an env-var-driven `ob sync-config` step between `sync-setup` and `sync --continuous` so operators can configure file types, excluded folders, sync mode, conflict strategy, configs, and device name without `kubectl exec`'ing into the pod. Implements the Sync-configuration-bootstrap section newly added to the [Obsidian Sync spec](../specs/obsidian-sync/index.md#sync-configuration-bootstrap).

**Spec:** [Obsidian Sync](../specs/obsidian-sync/)
**Status:** draft
**Depends On:** 0002

## Motivation

The supervisor implemented in change 0002 spawns `ob sync --continuous` after `ob sync-setup`, but never invokes `ob sync-config`. The CLI's defaults are then in force: `File types: image, audio, pdf, video` — i.e. `.json`, `.txt`, `.csv`, `.docx`, etc. are silently dropped from sync.

Real-world symptoms (observed in a running pod):

- A user enabled "All other file types" in Obsidian Sync on desktop. The pod ignored it because the daemon's file-type filter is local. `.json` voice transcripts under `logs/transcripts/` were created on the pod (or arrived from another device pre-pod) but were never pushed to the cloud.
- The desktop saw `logs/transcripts/` as an empty directory, and deletes from desktop kept "reappearing" because the cloud only had a directory record (no file contents) and the pod kept re-asserting the directory.
- The only fix today is `kubectl exec ... ob sync-config --file-types image,audio,pdf,video,unsupported` — operationally awkward, and the value is lost on pod restart if it isn't also baked into the deployment.

The Obsidian Sync spec previously deferred sync-config to "a future change." This is that change. It targets all `ob sync-config` flags (mode, conflict strategy, file types, excluded folders, configs, device name), not just `--mode`, because the same plumbing supports them all.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint)). CI enforces these as merge gates:

- The standing 100% line + branch coverage gate on `src/` MUST hold. CI runs `bun run test:cov` (which invokes `bun test --coverage` and `test/check-coverage.ts`). New code without tests is a defect.
- The `ob` binary MUST NOT be called against real Obsidian servers. New unit tests MUST drive the env-var → flag → spawn pipeline through the existing `Spawner` fake (`src/obsidian/spawn.ts`), exactly as 0002 does for `sync-setup` and `sync`.
- The repo's standing rule that the `ob` binary be exercised in at least one integration test per top-level change is satisfied by the existing `OB_BIN`-gated `ob --help` smoke test; this change MUST NOT add new `ob` integration tests that touch real Obsidian endpoints.
- LanceDB-touching code is unaffected; no new LanceDB tests required.
- Biome MUST pass with the project config; `bunx tsc --noEmit` MUST pass.
- `// @ts-expect-error`, `// biome-ignore`, and `// eslint-disable*` MUST carry a one-line same-comment justification.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Env-var → flag mapping

The supervisor MUST translate the following env vars into `ob sync-config` flags, one flag per set var:

| Env var | CLI flag | Validation |
|---|---|---|
| `OB_SYNC_FILE_TYPES` | `--file-types` | comma-separated subset of `image,audio,pdf,video,unsupported`, or empty |
| `OB_SYNC_EXCLUDED_FOLDERS` | `--excluded-folders` | passed verbatim |
| `OB_SYNC_MODE` | `--mode` | one of `bidirectional`, `pull-only`, `mirror-remote`, or empty |
| `OB_SYNC_CONFLICT_STRATEGY` | `--conflict-strategy` | one of `merge`, `conflict`, or empty |
| `OB_SYNC_DEVICE_NAME` | `--device-name` | passed verbatim |
| `OB_SYNC_CONFIGS` | `--configs` | comma-separated subset of `app,appearance,appearance-data,hotkey,core-plugin,core-plugin-data,community-plugin,community-plugin-data`, or empty |

Rules:

- An **unset** env var MUST result in the flag being omitted entirely (preserving prior on-disk value).
- An **empty-string** env var (set, but value `""`) MUST be passed verbatim (matches the upstream "empty to clear" semantic).
- Validation MUST happen at startup, before any `ob` child is spawned. An invalid value MUST cause exit 78 with a `VaultConfigError` naming the offending var.
- The supervisor MUST NOT shell-interpolate any env value; flags MUST go through array-form spawn.

#### Scenario: Unset → no flag

- **GIVEN** `OB_SYNC_FILE_TYPES` is unset
- **WHEN** the supervisor builds the `sync-config` argv for vault `v`
- **THEN** the argv MUST NOT contain `--file-types`

#### Scenario: Empty string → "empty to clear"

- **GIVEN** `OB_SYNC_EXCLUDED_FOLDERS=""`
- **WHEN** the supervisor builds the `sync-config` argv for vault `v`
- **THEN** the argv MUST be `["sync-config", "--path", "/data/vaults/v", "--excluded-folders", ""]`

#### Scenario: Invalid mode rejected

- **GIVEN** `OB_SYNC_MODE=push-only`
- **WHEN** the process starts
- **THEN** the process exits 78 with a message naming `OB_SYNC_MODE` and listing the valid values
- **AND** no `ob` child has been spawned

#### Scenario: Invalid file-type token rejected

- **GIVEN** `OB_SYNC_FILE_TYPES=image,markdown` (markdown is not a valid attachment type)
- **WHEN** the process starts
- **THEN** the process exits 78 with a message naming `OB_SYNC_FILE_TYPES` and the unknown token

### Lifecycle integration

- `ob sync-config` MUST be invoked at most once per vault per startup.
- Invocation MUST happen **after** `ensureVaultSetup` (i.e. after `ob sync-setup` succeeds, or after the supervisor confirms setup is already done) and **before** the per-vault `VaultChild.start()` that spawns `ob sync --continuous`.
- A vault's `state` MUST remain `starting` while `sync-config` is in-flight or retrying.
- The supervisor MUST NOT re-invoke `sync-config` while the continuous sync child is running.
- If all `OB_SYNC_*` vars are unset, the supervisor MUST skip the `sync-config` invocation entirely (no-op; preserves upstream defaults / on-disk values).

#### Scenario: Order of operations on fresh vault

- **GIVEN** `OB_SYNC_FILE_TYPES=image,audio,pdf,video,unsupported` and an empty `/data/vaults/v/`
- **WHEN** the supervisor starts vault `v`
- **THEN** the spawn order MUST be: `ob sync-setup --vault v --path /data/vaults/v` → `ob sync-config --path /data/vaults/v --file-types image,audio,pdf,video,unsupported` → `ob sync --continuous --path /data/vaults/v`

#### Scenario: All vars unset → no-op

- **GIVEN** none of the `OB_SYNC_*` env vars are set
- **WHEN** the supervisor starts vault `v`
- **THEN** `ob sync-config` MUST NOT be invoked
- **AND** `ob sync --continuous --path /data/vaults/v` MUST be spawned directly after setup completes

### Failure handling

- A non-zero exit from `ob sync-config` MUST be retried with exponential backoff (initial 1s, factor 2, cap 60s, max 5 attempts), mirroring `ensureVaultSetup`.
- After 5 failed attempts, the vault MUST transition to `failed` state with `lastError` populated, future restarts of that vault's `sync` child MUST NOT begin, and `/readyz` MUST return 503 with the failed vault listed.
- A `sync-config` failure on one vault MUST NOT block other vaults' setup or sync. Vaults are processed serially as today, but per-vault failure is per-vault.

#### Scenario: Transient sync-config failure recovers

- **GIVEN** `ob sync-config` exits 1 on attempt 1 and exits 0 on attempt 2 for vault `v`
- **WHEN** the supervisor reaches the sync-config phase
- **THEN** `sync-config` is invoked twice with the same argv
- **AND** `ob sync --continuous` is spawned only after the second invocation succeeds
- **AND** vault `v` transitions `starting → running` (never `failed`)

#### Scenario: Permanent sync-config failure marks vault failed

- **GIVEN** `ob sync-config` exits 1 on five consecutive attempts for vault `v`
- **WHEN** the 5th attempt fails
- **THEN** vault `v` state is `failed` with `lastError` populated
- **AND** `ob sync --continuous` MUST NOT be spawned for `v`
- **AND** other vaults configured in `VAULTS_JSON` continue normally

## Design

### Approach

Add `src/obsidian/syncconfig.ts` with two responsibilities:

1. **Pure validation + arg construction.** Export a function `buildSyncConfigArgs(env, vaultPath): string[] | null` that returns either the argv to pass to `ob` (e.g. `["sync-config", "--path", "/data/vaults/v", "--file-types", "..."]`) or `null` to signal "no vars set, skip the call." Validation lives here; throws a structured error for invalid values.
2. **Orchestration.** Export `applyVaultSyncConfig(vault, deps, log, env)` analogous to `ensureVaultSetup`. Reuses the shared backoff helper (factor it out of `setup.ts` if not already a util) and the shared `Spawner` interface.

Wire it into `src/obsidian/index.ts`:

```ts
// pseudo-code, in startSupervisor's per-vault init loop, after ensureVaultSetup
await ensureVaultSetup(vault, deps, log);
await applyVaultSyncConfig(vault, deps, log, env);  // NEW
void child.start();
```

Validation runs once up-front in `loadConfig` (or a new `loadSyncConfigEnv`) so that a bad env var fails fast — before auth bootstrap, before any vault directory is touched.

### Decisions

- **Decision:** Global `OB_SYNC_*` env vars apply to every vault.
  - **Why:** Matches the operational reality (one operator, one deployment, same settings everywhere). Per-vault overrides would require extending `VAULTS_JSON` schema and would fork the validation surface.
  - **Alternatives considered:** Per-vault override fields in `VAULTS_JSON`. Rejected for v1; can be added later by extending the entry schema without breaking existing deployments.

- **Decision:** Run `sync-config` between `setup` and `sync`, not in parallel.
  - **Why:** `sync-config` writes to the vault's `.obsidian/` config directory; running it concurrently with the continuous sync child risks racing the same files. Doing it once before `sync --continuous` starts is the upstream-supported pattern.
  - **Alternatives considered:** A periodic re-apply on a timer. Rejected — env vars don't change at runtime; a one-shot at startup is sufficient.

- **Decision:** Empty string is "clear," unset is "preserve."
  - **Why:** Mirrors the upstream CLI semantic exactly (`--excluded-folders ""` clears the list per the README). Operators can opt out of clearing by leaving the var unset.
  - **Alternatives considered:** A separate `OB_SYNC_RESET=true` flag. Rejected — it complicates the surface for no gain.

- **Decision:** Validate enums at startup, fail-fast with exit 78.
  - **Why:** Same exit code convention as existing `VaultConfigError` (sysexits.h `EX_CONFIG`). Late discovery of "your file-types value is wrong" via a sync child crash loop is bad operator UX.
  - **Alternatives considered:** Pass through and let `ob` reject. Rejected — `ob`'s error messages are less actionable than ours can be, and we'd have to backoff-retry an unrecoverable error.

### Non-Goals

- Per-vault sync-config overrides (any `VAULTS_JSON` schema extension).
- Runtime/dynamic re-config (SIGHUP, API endpoint, file watcher).
- Surfacing `ob sync-config`'s read-back values (the `sync-config` no-arg display) via `/readyz` or `/metrics`.
- Helm chart / k8s manifest in this repo. The repo ships a Docker image; orchestration is the operator's concern. The README's env-var table is the canonical surface.

## Tasks

- [ ] Implement `src/obsidian/syncconfig.ts`
  - [ ] `buildSyncConfigArgs(env, vaultPath)` — env-var → argv with full validation; returns `null` when no vars are set
  - [ ] `applyVaultSyncConfig(vault, deps, log, env)` — orchestrates the spawn with exponential backoff (1s/×2/cap 60s/max 5); throws `SyncConfigPermanentError` on terminal failure
  - [ ] Unit tests covering: each var unset, each var set to a valid value, each var set to empty, each enum's invalid-value path, the no-op `null` return when nothing is set, and transient-then-success retry
- [ ] Wire `applyVaultSyncConfig` into `src/obsidian/index.ts`
  - [ ] Call between `ensureVaultSetup` and `void child.start()` in the per-vault init IIFE
  - [ ] On `SyncConfigPermanentError`, set vault state to `failed` with `lastError`, and do NOT call `child.start()` for that vault
  - [ ] Update tests in `test/obsidian/index.test.ts` (or equivalent) to cover the new ordering and the failed-vault path
- [ ] Validate `OB_SYNC_*` env vars in `src/config/index.ts`
  - [ ] Add a `loadSyncConfigEnv(env)` that returns `{ fileTypes?, excludedFolders?, mode?, conflictStrategy?, deviceName?, configs? }` (each field is `string | undefined`; `undefined` = unset, `""` = empty/clear)
  - [ ] Throw `VaultConfigError` (exit 78) on bad enum values, naming the offending var and acceptable values
  - [ ] Plumb the result through `Config` so `startSupervisor` can pass it to `applyVaultSyncConfig`
  - [ ] Tests under `test/config/` for each invalid case
- [ ] Update `.env.example` with a documented `OB_SYNC_*` block (one line per var, each commented as optional)
- [ ] Update `README.md` Configuration table with the six new vars and a worked example showing `OB_SYNC_FILE_TYPES=image,audio,pdf,video,unsupported`
- [ ] Update spec changelog row already added in this change to mark "complete" with the merged PR number once shipping

## Open Questions

- [ ] Should `OB_SYNC_DEVICE_NAME` default to the pod hostname when unset? Rationale: the live pod's `device-name` is currently empty (per `ob sync-config` output), and the sync log already tags lines with the hostname. Leaving it unset (current behavior) preserves whatever upstream chooses; auto-defaulting would make the Obsidian sync version-history more readable. Default for v1: leave unset (no auto-default), document the option in the README.
- [ ] Should we expose the `OB_SYNC_CONFIGS` flag at all in v1, given the spec already says `Configs: none (config syncing disabled)` is the desired posture? Including it costs ~5 lines of validation; excluding it means a follow-up if someone wants to enable plugin-data sync. Default for v1: include it; document that the recommended value is unset (i.e. config sync stays disabled).

## References

- Spec: [Obsidian Sync](../specs/obsidian-sync/) — see [Sync configuration bootstrap](../specs/obsidian-sync/index.md#sync-configuration-bootstrap)
- Related changes: [0002 — Obsidian supervisor](./0002-obsidian-supervisor.md) (introduced the supervisor; this change extends its lifecycle)
- External: [obsidian-headless README — `ob sync-config`](https://github.com/obsidianmd/obsidian-headless#ob-sync-config)

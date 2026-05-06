# Obsidian Sync

## Overview

This spec defines how the `ob` server bootstraps credentials, configures one or more Obsidian vaults for sync, and supervises the official `obsidian-headless` CLI as long-lived child processes. It owns everything between the `OBSIDIAN_AUTH_TOKEN` env var and the on-disk vault working tree under `/data/vaults/<slug>/`.

## Background

- The official CLI is `obsidian-headless` (`ob`), Node 22+, distributed as the `ob` binary with subcommands `login`, `sync-list-remote`, `sync-setup`, `sync`, `sync-config`, `sync-status`, `sync-unlink` (full list in the upstream README).
- Auth state is persisted at `${XDG_CONFIG_HOME:-~/.config}/obsidian-headless/auth_token`. The user already has a token from a prior login; the container MUST NOT call `ob login` itself.
- Per-vault sync state (remote vault id, e2ee key, device id, sync mode) is persisted by `ob` inside each vault's `.obsidian/` config directory. Setup writes there.
- Related specs: [Architecture](../architecture/), [Vault Indexer](../vault-indexer/).

## Requirements

### Credential bootstrap

- Before spawning any `ob` child, the supervisor MUST ensure `${XDG_CONFIG_HOME}/obsidian-headless/auth_token` contains the value of `OBSIDIAN_AUTH_TOKEN`.
- The bootstrap MUST create parent directories with mode `0700` and the file with mode `0600`, owned by uid 1000.
- The bootstrap MUST be idempotent: running it twice with the same env value MUST leave file contents and mode unchanged.
- If the env value differs from on-disk contents, the env value MUST overwrite the file.

#### Scenario: First start with token

- **GIVEN** an empty `/home/ob/.config/`
- **WHEN** the process starts with `OBSIDIAN_AUTH_TOKEN=abc123`
- **THEN** `/home/ob/.config/obsidian-headless/auth_token` exists with content `abc123` and mode `0600`

#### Scenario: Mounted token wins when env unset

- **GIVEN** `OBSIDIAN_AUTH_TOKEN` is unset and `auth_token` was mounted as a volume
- **WHEN** the process starts
- **THEN** the file is left unchanged
- **AND** the supervisor proceeds to vault setup

#### Scenario: Missing both

- **GIVEN** `OBSIDIAN_AUTH_TOKEN` is unset and the auth_token file does not exist
- **WHEN** the process starts
- **THEN** the process exits non-zero with message `OBSIDIAN_AUTH_TOKEN is required (or mount /home/ob/.config/obsidian-headless/auth_token)`

### Vault configuration

- Each entry in `VAULTS_JSON` MUST be normalized to `{ name, slug, e2eePassword? }` where `slug` is `name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')` if not provided.
- Two vaults MUST NOT resolve to the same slug. A duplicate slug MUST cause startup to fail with the offending names.
- For each vault, the supervisor MUST ensure `<DATA_DIR>/vaults/<slug>/` exists (mode `0700`).
- For each vault, the supervisor MUST detect whether `ob sync-setup` has already been run by checking for the presence of `<DATA_DIR>/vaults/<slug>/.obsidian/sync.json` (or whichever file `ob` writes; the implementation MUST detect this by parsing the output of `ob sync-status --path <dir>` rather than guessing the filename).
- If `sync-setup` has not been run, the supervisor MUST execute `ob sync-setup --vault "<name>" --path <dir>` (with `--password` if `e2eePassword` is set) and wait for exit code 0 before continuing for that vault.
- `sync-setup` failures MUST be retried with exponential backoff (initial 1s, factor 2, cap 60s, max 5 attempts) before marking the vault failed.

#### Scenario: First start, fresh vault

- **GIVEN** `VAULTS_JSON=[{"name":"v"}]` and an empty `/data/vaults/`
- **WHEN** the supervisor starts
- **THEN** `/data/vaults/v/` is created
- **AND** `ob sync-setup --vault v --path /data/vaults/v` is invoked exactly once
- **AND** `ob sync --continuous --path /data/vaults/v` is spawned only after setup completes

#### Scenario: Already-set-up vault

- **GIVEN** `/data/vaults/v/.obsidian/sync.json` exists from a prior run
- **WHEN** the supervisor starts
- **THEN** `sync-setup` is NOT invoked
- **AND** `ob sync --continuous` is spawned directly

### Sync configuration bootstrap

- After `sync-setup` completes (or is skipped because the vault is already configured) and before `ob sync --continuous` is spawned, the supervisor MUST evaluate the `OB_SYNC_*` env vars and invoke `ob sync-config --path <dir>` with flags derived from them only when at least one mapped var is set. When every `OB_SYNC_*` var is unset, the supervisor MUST NOT invoke `sync-config` and MUST proceed directly to spawning the continuous sync child.
- The mapping from env var to `ob sync-config` flag MUST be:

  | Env var | CLI flag |
  |---|---|
  | `OB_SYNC_FILE_TYPES` | `--file-types <value>` |
  | `OB_SYNC_EXCLUDED_FOLDERS` | `--excluded-folders <value>` |
  | `OB_SYNC_MODE` | `--mode <value>` |
  | `OB_SYNC_CONFLICT_STRATEGY` | `--conflict-strategy <value>` |
  | `OB_SYNC_DEVICE_NAME` | `--device-name <value>` |
  | `OB_SYNC_CONFIGS` | `--configs <value>` |

- If an env var is unset, the corresponding flag MUST NOT be passed. The upstream default or the value persisted by `ob` from a prior run MUST be preserved.
- If an env var is set to the empty string, the empty string MUST be passed verbatim to honor the upstream "empty to clear" semantic.
- `OB_SYNC_*` env-var values MUST apply identically to every configured vault. Per-vault overrides are out of scope.
- The supervisor MUST validate enum-typed env vars before spawning any `ob` child:
  - `OB_SYNC_MODE` MUST be one of `bidirectional`, `pull-only`, `mirror-remote`, or empty.
  - `OB_SYNC_CONFLICT_STRATEGY` MUST be one of `merge`, `conflict`, or empty.
  - `OB_SYNC_FILE_TYPES` MUST be a comma-separated subset of `image,audio,pdf,video,unsupported`, or empty.
  - `OB_SYNC_CONFIGS` MUST be a comma-separated subset of `app,appearance,appearance-data,hotkey,core-plugin,core-plugin-data,community-plugin,community-plugin-data`, or empty.
  - Any invalid value MUST cause startup to fail with `VaultConfigError` (exit 78) before any vault is touched.
- `OB_SYNC_EXCLUDED_FOLDERS` and `OB_SYNC_DEVICE_NAME` values MUST be passed verbatim; the supervisor MUST NOT validate folder existence or device-name format.
- `sync-config` MUST be invoked at most once per vault per startup. The supervisor MUST NOT re-invoke it while the continuous sync child is running.
- `sync-config` non-zero exits MUST be retried with exponential backoff (initial 1s, factor 2, cap 60s, max 5 attempts) before marking the vault `failed`. A `sync-config` failure on one vault MUST NOT block other vaults.

#### Scenario: Enable unsupported file types

- **GIVEN** `OB_SYNC_FILE_TYPES=image,audio,pdf,video,unsupported` and a fresh vault `v`
- **WHEN** the supervisor starts
- **THEN** the order of operations for `v` is: `ob sync-setup --vault v --path /data/vaults/v` → `ob sync-config --path /data/vaults/v --file-types image,audio,pdf,video,unsupported` → `ob sync --continuous --path /data/vaults/v`

#### Scenario: All sync-config vars unset

- **GIVEN** none of the `OB_SYNC_*` env vars are set
- **WHEN** the supervisor starts vault `v`
- **THEN** `ob sync-config` MUST NOT be invoked for `v`
- **AND** the upstream defaults / values persisted from prior runs are left unchanged

#### Scenario: Clear excluded folders

- **GIVEN** `OB_SYNC_EXCLUDED_FOLDERS=` (set, empty string)
- **WHEN** the supervisor starts vault `v`
- **THEN** `ob sync-config` is invoked exactly once with argv `["sync-config", "--path", "/data/vaults/v", "--excluded-folders", ""]` (the empty string is a single argv element, not the literal characters `""`)
- **AND** any previously configured excluded folders are cleared

#### Scenario: Invalid mode rejected at startup

- **GIVEN** `OB_SYNC_MODE=push-only` (not a valid mode)
- **WHEN** the process starts
- **THEN** the process exits 78 with a message naming the offending var and value
- **AND** no `ob` child has been spawned

### Sync supervision

- For each configured vault, the supervisor MUST maintain exactly one running `ob sync --continuous --path <dir>` child process.
- The supervisor MUST tag every child stdio line with `{vault: <slug>, source: "ob"}` and emit it as a structured log line on the parent's stdout.
- If a child exits with non-zero status, the supervisor MUST restart it with exponential backoff (initial 1s, factor 2, cap 60s). Restart attempts MUST NOT block other vaults.
- If a child exits ≥ 10 times in 5 minutes, the vault MUST transition to a `failed` state, future restarts MUST be paused, and `/readyz` MUST report 503 with the failed vault listed in the response body. Per the [Architecture spec](../architecture/index.md#observability) (the higher-level authority), `/readyz` returns 200 only when **every** configured vault has reached the ready state; any vault in `starting` or `failed` keeps `/readyz` at 503.
- On SIGTERM to the parent, the supervisor MUST SIGTERM every child, await exit up to 5s each (in parallel), then SIGKILL any survivor.

#### Scenario: Child crashes once

- **GIVEN** an `ob sync` child running for vault `v`
- **WHEN** the child exits with code 1
- **THEN** the supervisor logs the exit
- **AND** spawns a replacement after ~1s
- **AND** the vault state remains `running` (not `failed`)

#### Scenario: Child crashes 10 times in 5 minutes

- **GIVEN** repeated crash loop on vault `v`
- **WHEN** the 10th crash occurs within a 5-minute window
- **THEN** the supervisor sets vault `v` state to `failed`
- **AND** stops attempting restarts for `v`
- **AND** continues normal supervision for other vaults

#### Scenario: Graceful shutdown

- **GIVEN** two healthy vault children
- **WHEN** the parent receives SIGTERM
- **THEN** both children receive SIGTERM in parallel
- **AND** the parent exits within 6s (5s grace + slack)

### Public surface to the rest of the app

The supervisor module MUST expose:

```ts
type VaultState = "starting" | "running" | "failed";
interface VaultStatus {
  slug: string;
  name: string;
  state: VaultState;
  pid: number | null;
  restarts: number;
  lastError: string | null;
}
interface Supervisor {
  list(): VaultStatus[];
  get(slug: string): VaultStatus | null;
  stop(): Promise<void>;
}
```

- `list()` and `get()` MUST be synchronous, non-blocking reads of in-memory state.
- The supervisor MUST NOT expose raw child handles to other modules.

## Design

### Architecture

```text
src/obsidian/
  index.ts          # public Supervisor factory + types
  bootstrap.ts      # auth_token bootstrap
  setup.ts          # `ob sync-setup` orchestration with backoff
  syncconfig.ts     # `ob sync-config` env-var → flag mapping + validation
  child.ts          # spawn + log-tag + restart loop for one vault
  status.ts         # parse `ob sync-status` output
```

### Process spawning

- All child invocations MUST go through a single `spawn(cmd, args, opts)` helper that uses `Bun.spawn` (or `child_process.spawn` if `Bun.spawn` lacks needed signal semantics — to be settled in Change 0002).
- The helper MUST inherit `XDG_CONFIG_HOME` from the parent.
- The helper MUST capture stdout and stderr line by line and forward to the project logger.

### Error taxonomy

| Class | Trigger | Behavior |
|---|---|---|
| `AuthMissingError` | env + file both unset | exit 78 (config) |
| `VaultConfigError` | invalid `VAULTS_JSON` | exit 78 |
| `SetupTransientError` | `ob sync-setup` non-zero, attempt < 5 | retry with backoff |
| `SetupPermanentError` | `ob sync-setup` non-zero, attempt ≥ 5 | mark vault `failed` |
| `SyncConfigTransientError` | `ob sync-config` non-zero, attempt < 5 | retry with backoff |
| `SyncConfigPermanentError` | `ob sync-config` non-zero, attempt ≥ 5 | mark vault `failed` |
| `SyncCrashLoop` | ≥ 10 crashes in 5 min | mark vault `failed` |

## Constraints

- The supervisor MUST NOT call `ob login`, `ob logout`, or `ob sync-create-remote` (creating remote vaults is a user action, not a server action).
- The supervisor MUST NOT shell-interpolate vault names; arguments MUST go through array-form spawn.
- Sync settings (mode, file types, excluded folders, conflict strategy, configs, device name) are configured via `OB_SYNC_*` env vars applied identically to every vault (see [Sync configuration bootstrap](#sync-configuration-bootstrap)). Per-vault overrides are out of scope.

## Open Questions

- **Detecting "already set up".** The README documents `ob sync-status` output but not its machine-readable form. We may need to parse human text or add a `--json` flag upstream. **Default for v1**: parse exit code (0 = configured, non-zero = not configured) and human output, with a fallback path-existence check on `.obsidian/`.
- **Token rotation.** If `OBSIDIAN_AUTH_TOKEN` changes between restarts, do we need to invalidate any per-vault sync state? Likely no, but worth confirming with a real run.

## References

- [obsidianmd/obsidian-headless README](https://github.com/obsidianmd/obsidian-headless)

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-05-03 | Initial spec created | — |
| 2026-05-03 | Align `/readyz` semantics with Architecture spec: strict 200-only-if-all-ready (replaces the prior "200 if any vault healthy" wording). | [Change 0002](../../changes/0002-obsidian-supervisor.md) |
| 2026-05-06 | Add Sync-configuration-bootstrap requirements: env-var-driven `ob sync-config` step between `sync-setup` and `sync --continuous`, with `OB_SYNC_*` mapping, validation, and retry semantics. Replaces the prior "Per-vault sync mode override is OUT OF SCOPE for v1" deferral with a global, env-driven mechanism; per-vault overrides remain out of scope. | [Change 0011](../../changes/0011-sync-config-bootstrap.md) |

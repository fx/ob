# Obsidian Sync

## Overview

This spec defines how the `ob` server bootstraps credentials, configures one or more Obsidian vaults for sync, and supervises the official `obsidian-headless` CLI as long-lived child processes. It owns everything between the `OBSIDIAN_AUTH_TOKEN` env var and the on-disk vault working tree under `/data/vaults/<slug>/`.

## Background

- The official CLI is `obsidian-headless` (`ob`), Node 22+, distributed as the `ob` binary with subcommands `login`, `sync-list-remote`, `sync-setup`, `sync`, `sync-config`, `sync-status`, `sync-unlink` (full list in the upstream README).
- Auth state is persisted at `${XDG_CONFIG_HOME:-${HOME:-/home/ob}/.config}/obsidian-headless/auth_token`. The user already has a token from a prior login; the container MUST NOT call `ob login` itself.
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

### Sync activity log

The upstream `ob sync --continuous` child writes its progress to its own per-vault log file rather than to stdout, so the stdio forwarding above observes nothing at all while sync is working normally. The supervisor MUST therefore locate that file and read it.

- The supervisor MUST resolve, per vault, the absolute path `${XDG_CONFIG_HOME:-${HOME:-/home/ob}/.config}/obsidian-headless/sync/<vaultId>/sync.log`, resolving the base exactly as [Architecture › Directory Layout](../architecture/index.md#directory-layout-in-container) defines it — the same base the [credential bootstrap](#credential-bootstrap) writes to, resolved by the same expression rather than a re-derived one.
- `<vaultId>` is assigned by the upstream CLI and is not known to the supervisor up front. It MUST be resolved by reading each immediate subdirectory of `${XDG_CONFIG_HOME:-${HOME:-/home/ob}/.config}/obsidian-headless/sync/` and selecting the one whose `config.json` carries a `vaultPath` that resolves to the same absolute path as the vault's working directory `<DATA_DIR>/vaults/<slug>`. The comparison MUST be between normalized absolute paths; a prefix match MUST NOT be accepted (`/data/vaults/v` MUST NOT match a `vaultPath` of `/data/vaults/vault2`).
- Resolution MUST be attempted only after the vault's `ob sync --continuous` child has been spawned — the `sync/` directory does not exist until the CLI has performed its first sync setup — and MUST be retried on every subsequent poll until it succeeds or the child exits.
- An entry whose `config.json` is missing, unreadable, or unparseable MUST be skipped individually and MUST NOT abort the scan. The supervisor MUST examine every remaining immediate subdirectory and MUST select a valid matching candidate if one exists. One stale or junk directory sitting beside the real one would otherwise leave the watchdog permanently dormant for a vault whose log was resolvable all along.
- Resolution MUST fail soft. If the `sync/` directory is absent, or no readable entry matches after the whole scan, the supervisor MUST NOT mark the vault `failed`, MUST NOT kill or restart the child, and MUST NOT propagate the error out of the poll. The condition MUST be observable as `watchdog.state === "resolving"` on the vault's [public status](#public-surface-to-the-rest-of-the-app). What `logPath` reads in that state is governed there and not restated here: `null` for a vault that has never resolved a log, the last resolved path for one that has.
- A vault whose watchdog never resolves is **unprotected, not unhealthy**. Its `watchdog.state` MUST NOT influence the `/readyz` status code — an unarmed watchdog is a loss of the safety net, never a loss of service, and failing readiness on it would turn an upstream layout change into a self-inflicted outage across every vault at once. The condition is reported in the `/readyz` body and is what an operator alerts on; see [REST API › Health endpoints](../rest-api/index.md#health-endpoints).
- Once the child has been running longer than the stall threshold with the log still unresolved, the supervisor MUST log at `warn` naming the vault and the directory it searched, and MUST NOT repeat that warning more than once per child lifetime. Silence here would be indistinguishable from a working watchdog, which is the exact condition that let the original outage run for four and a half days.
- If more than one entry matches the vault path, the supervisor MUST select the entry whose `config.json` has the most recent mtime, breaking an exact mtime tie by taking the lexicographically greatest directory name, and MUST log one `warn` naming every candidate. A stale directory left behind by a re-link is the expected cause, and staying dormant in that case would silently forfeit stall detection for that vault. The tiebreak is required rather than left to directory-read order: two `config.json` files written in the same filesystem timestamp tick would otherwise resolve differently between polls, so a vault could silently swap which log it watches.
- Resolution MUST be treated as successful only once `sync.log` inside the selected directory can itself be stat'd. A selected directory whose `sync.log` does not yet exist MUST leave the watchdog in `resolving`, because there is nothing yet whose silence could mean anything.
- A resolved path MUST be cached for the remainder of that child's lifetime and MUST be re-resolved when a replacement child is spawned.
- If a stat of an already-resolved log fails — the file was deleted, or the directory was replaced — the supervisor MUST NOT treat the failure as activity and MUST NOT treat it as a stall. It MUST return the watchdog to `resolving`, discard the read offset and any buffered partial line, and re-anchor staleness on the next successful stat. A vanished log means the watchdog can no longer tell whether the child is healthy, and killing on that ignorance would be a guess.
- When log tailing is enabled, every poll MUST forward each newly appended complete line to the parent logger at `info` with the same field shape as the stdio forwarding: `{ vault: <slug>, source: "ob", stream: "sync.log", line: <text> }` under the message `ob output`. Empty lines MUST NOT be emitted.
- The tail MUST start from the file's size at the moment of resolution. Content written before that point MUST NOT be emitted — a production log holds tens of thousands of lines, and re-emitting the backlog on every restart would bury the live signal.
- At resolution the supervisor MUST record whether the anchor offset sits on a line boundary — that is, whether the byte immediately preceding it is a newline, with an empty file counting as a boundary. If it does **not**, resolution landed mid-line, and the first read MUST discard everything up to and including the first newline it encounters: if the file ends with an unterminated `Connect` and the next append is `ing...\n`, both emitting `ing...` and reconstructing `Connecting...` are wrong — the first splits a line, the second replays bytes the no-backlog rule excludes, and dropping the one straddling line is the only option satisfying both. If the anchor **does** sit on a line boundary, nothing MUST be discarded and the first newly appended complete line MUST be emitted; discarding unconditionally would silently swallow the first line of every normally-rotated log.
- The tail MUST detect truncation or replacement — an observed size smaller than the current read offset, or a change in the file's inode identity — and MUST respond by resetting the read offset to the start of the file and discarding any buffered partial line.
- The tail MUST cap the number of bytes it reads per poll (default 262144). When an append exceeds the cap, the supervisor MUST skip forward so that only the most recent capped span is read, MUST discard the leading partial line of that span, and MUST emit one `warn` naming the number of bytes skipped.
- An incomplete trailing line MUST be buffered and emitted only once its terminating newline arrives, so that a half-written line is never split across two log entries.
- A read error while tailing MUST be logged at `warn` and MUST NOT kill the child, fail the vault, or stop subsequent polls.

#### Scenario: Log path resolved by vault path

- **GIVEN** `${XDG_CONFIG_HOME}/obsidian-headless/sync/` contains `aaa/config.json` with `vaultPath: "/data/vaults/other"` and `bbb/config.json` with `vaultPath: "/data/vaults/v"`
- **WHEN** the watchdog resolves the log for vault `v` rooted at `/data/vaults/v`
- **THEN** the resolved path is `${XDG_CONFIG_HOME}/obsidian-headless/sync/bbb/sync.log`
- **AND** the vault's status reports that path in `watchdog.logPath`

#### Scenario: Sync directory does not exist yet

- **GIVEN** vault `v` has a running child, has never resolved a log, and `${XDG_CONFIG_HOME}/obsidian-headless/sync/` does not exist
- **WHEN** the watchdog polls
- **THEN** the vault state remains `running`
- **AND** the vault's status reports `watchdog.state === "resolving"`, `watchdog.logPath === null`, and `lastSyncActivityAt === null`
- **AND** no child is killed no matter how many polls elapse

#### Scenario: Watchdog never arms

- **GIVEN** vault `v` whose child is running, which has never resolved a log, and whose sync log is permanently unresolvable
- **WHEN** the child has been running for longer than the stall threshold
- **THEN** exactly one `warn` is logged for that child naming the vault and the searched directory
- **AND** the vault reports `state: "running"`, `watchdog.state === "resolving"`, `watchdog.logPath === null`, `lastSyncActivityAt === null`
- **AND** `/readyz` still returns 200 provided every vault is `running` and every indexer is `ready`
- **AND** no child is ever killed for that vault

#### Scenario: Resolution lands mid-line

- **GIVEN** the resolved `sync.log` ends with the unterminated fragment `Connect` at the moment of resolution
- **WHEN** the upstream appends `ing...\n` and then `Fully synced\n`
- **THEN** the only line emitted is `Fully synced`
- **AND** neither `ing...` nor `Connecting...` is emitted

#### Scenario: Resolution lands on a line boundary

- **GIVEN** the resolved `sync.log` ends with a complete line and its terminating newline at the moment of resolution
- **WHEN** the upstream appends `Fully synced\n`
- **THEN** `Fully synced` is emitted
- **AND** nothing is discarded

#### Scenario: Backlog is not replayed

- **GIVEN** the resolved `sync.log` already holds 20000 lines when the watchdog resolves it
- **WHEN** the upstream appends one new line
- **THEN** exactly one `ob output` log line is emitted for that vault with `stream: "sync.log"`
- **AND** none of the 20000 pre-existing lines is emitted

#### Scenario: Log truncated under the tail

- **GIVEN** the tail has read up to offset 4096 of the resolved `sync.log`
- **WHEN** the file is truncated to 120 bytes and those 120 bytes hold two complete lines
- **THEN** both lines are emitted exactly once
- **AND** no error is logged and the child is not killed

### Sync stall watchdog

An `ob sync --continuous` child can stop making progress while remaining alive and never exiting; the restart machinery above keys entirely off `exited` and is blind to it. Sync-log silence is the supervisor's proxy for "this child is wedged". A healthy child writes a progress line roughly every 30 seconds, so the absence of any write over several minutes is unambiguous.

- While a vault's child is running, the supervisor MUST poll the resolved sync log's mtime every `pollIntervalMs` (default 30000).
- **Activity** is an observed mtime that differs from the previously recorded mtime, **or** an observed inode identity that differs from the previously recorded one. A difference in either direction counts. Inode identity is part of the definition rather than a tail-only concern: a log rotated out and replaced by a file whose mtime is preserved — or merely equal at the filesystem's timestamp granularity — would otherwise read as silence and get a healthy child killed one threshold later, which is exactly the outcome the "never mistaken for silence" guarantee excludes. The tail already reads inode identity from the same stat, so this costs nothing.
- On the first successful stat after resolution, the supervisor MUST anchor staleness to the current wall clock rather than to the file's mtime, and MUST treat the anchor as the last instant at which activity was observed. The file's own mtime MAY be arbitrarily old — that is precisely the state a wedged child leaves behind — so measuring staleness against it would kill a freshly resolved healthy child immediately.
- Time elapsed between the child being spawned and the log being resolved MUST NOT count toward staleness. The clock starts at the anchor, not at spawn, so a vault whose sync directory takes minutes to appear gets a full threshold of grace once it does. Concretely, the watchdog cannot kill a child earlier than one full threshold after the anchor, whatever happened before it.
- The interval between the anchor and the first observed mtime change is therefore the only window in which a never-yet-active child can be killed, and it MUST be treated exactly like any other silence: a child that hangs before its first successful connect writes nothing, so its anchor never refreshes and it is killed one threshold later. A first sync that is merely slow keeps writing progress lines, so its mtime keeps advancing and it is never killed however long the sync itself takes. Slowness is not the signal; total silence is.
- **Stall** is `now - lastActivityObservedAt >= stallTimeoutMs` (default 300000, ten times the upstream's 30-second progress cadence). Because the anchor is taken when the log resolves and refreshed only by activity, a child that hangs before its first successful connect is detected one threshold after resolution, while a slow-but-progressing first sync is never killed as long as it keeps writing to the log.
- On detecting a stall the supervisor MUST log at `error` with `{ vault, logPath, lastSyncActivityAt, stalledForMs, thresholdMs }`, then MUST send `SIGTERM` to the child, and MUST send `SIGKILL` if the child has not exited within the stall-kill grace period (default 10000 ms).
- The stall verdict itself MUST take the vault out of `running` immediately — before the `SIGTERM` is sent, not when the child finally exits — and MUST set `lastError` at the same moment. A child that ignores `SIGTERM` stays alive for the whole grace period, and a vault the supervisor has already declared unhealthy MUST NOT be able to hold `/readyz` at 200 for that window. The vault moves to `starting`, matching the state a vault takes on any other loss of its child; the transition to `failed` happens only if a ceiling is reached.
- The supervisor MUST issue at most one stall kill per child lifetime. Once a stall kill is in flight the watchdog MUST NOT issue a second one for the same child.
- After the kill, the existing restart machinery MUST take over unchanged: `restarts` increments, the capped exponential backoff applies, and a replacement child is spawned — unless that kill takes the vault to either ceiling below, in which case the vault becomes `failed` and no replacement is spawned.
- Stall classification MUST be driven by the recorded verdict, never by the exit code the killed child happens to produce. A child that installs a `SIGTERM` handler can exit 0, and treating that as an ordinary clean exit would skip stall accounting entirely and let a wedging vault restart forever without ever approaching a ceiling. Whenever a verdict was recorded for the attempt, the stall path applies — `lastError` names the stall, the healthy-uptime reset is suppressed, and both windows are credited — whatever the exit code was.
- A recorded verdict MUST apply to exactly the attempt that produced it. The supervisor MUST clear it when starting each attempt and after consuming it, so that an ordinary crash on a later attempt cannot inherit an earlier attempt's stall classification and be miscounted toward the stall ceiling.
- `lastError` MUST name the stall explicitly and MUST carry both the threshold and the last observed sync-log mtime, so that a stalled vault is distinguishable from a crashed one without reading logs — for example `sync stalled: no sync.log activity for 300000ms (last activity 2026-08-16T07:25:09.289Z)`.
- A child terminated by the watchdog MUST NOT count as healthy uptime, however long it stayed alive. It MUST NOT reset the crash-window history or the consecutive-failure counter that drives the restart backoff.
- Every stall kill MUST be recorded both in the crash window that drives the [crash-loop ceiling](#sync-supervision) and in a separate rolling stall window (default: 3 stall kills within 3600000 ms). The stall window MUST be rolling and MUST NOT be cleared by anything other than kills ageing out of it — in particular, an ordinary crash-and-recover between two stalls, and any amount of healthy uptime, MUST NOT reset it. Reaching **either** ceiling MUST transition the vault to `failed` with `lastError` naming the reason, after which restarts stop and `/readyz` reports 503 with the vault listed. The separate window is required because a stall kill can only occur once per threshold: with the default 300-second threshold, ten kills cannot fall inside the crash-loop ceiling's 5-minute window, so the crash-loop ceiling alone can never fire on stalls.
- The watchdog MUST NOT poll while the vault has no running child. It MUST stop when the child exits — including when the child is killed by the watchdog itself — so that no poll runs during the restart backoff, during `sync-setup`, or during `sync-config`.
- After `requestStop()` the watchdog MUST NOT issue a kill and MUST NOT perform any further poll, and the process MUST be able to exit without waiting for a pending poll interval to elapse.
- The watchdog and the [sync activity log](#sync-activity-log) tail share one poll. Configuration MUST be read from the following environment variables:

  | Env var | Default | Meaning |
  |---|---|---|
  | `OB_SYNC_STALL_TIMEOUT_SECONDS` | `300` | Seconds of sync-log silence after which a running child is treated as crashed. `0` disables stall detection: no child is ever killed for silence, while resolution and tailing continue. |
  | `OB_SYNC_STALL_POLL_SECONDS` | `30` | Seconds between polls of the resolved sync log. |
  | `OB_SYNC_LOG_TAIL` | `true` | Whether newly appended sync-log lines are forwarded to the parent logger. |

- Validation MUST happen at startup, before any `ob` child is spawned, and any violation MUST exit 78 naming the offending variable and its value:
  - `OB_SYNC_STALL_TIMEOUT_SECONDS` and `OB_SYNC_STALL_POLL_SECONDS` MUST each match `^\d+$`.
  - Each MUST be at most 86400 (24 hours). An unbounded value converts to a millisecond duration that overflows the safe-integer range, and the resulting `Infinity` or precision-lost comparison makes `now - lastActivityObservedAt >= stallTimeoutMs` never true — the watchdog would silently disarm while reporting itself `armed`, which is the exact silent-failure mode this change exists to remove. A day is far beyond any useful bound against a 30-second heartbeat, so rejecting outright is better than clamping.
  - `OB_SYNC_STALL_POLL_SECONDS` MUST be at least 1.
  - When `OB_SYNC_STALL_TIMEOUT_SECONDS` is greater than 0, `OB_SYNC_STALL_POLL_SECONDS` MUST be less than or equal to it — a poll interval longer than the threshold would delay detection past the configured bound.
  - `OB_SYNC_LOG_TAIL` MUST be exactly `true` or `false`.
- When `OB_SYNC_STALL_TIMEOUT_SECONDS` is `0` **and** `OB_SYNC_LOG_TAIL` is `false`, the supervisor MUST NOT resolve the log or poll at all, and every vault MUST report `watchdog.state === "disabled"` with `watchdog.logPath === null` and `lastSyncActivityAt === null`.

#### Scenario: Wedged child is killed and restarted

- **GIVEN** vault `v` has a running child, a resolved sync log, and `OB_SYNC_STALL_TIMEOUT_SECONDS=300`
- **AND** the log's mtime has not changed since the watchdog anchored it
- **WHEN** the first poll at or after 300 seconds from the anchor runs
- **THEN** the child receives `SIGTERM`
- **AND** the vault's `restarts` increments and a replacement child is spawned after the usual backoff
- **AND** `lastError` names the stall and carries the last observed sync-log mtime

#### Scenario: Replacement child before its log resolves

- **GIVEN** vault `v` was killed for stalling and a replacement child has just been spawned
- **WHEN** the replacement's log has not been re-resolved yet
- **THEN** `watchdog.state` is `resolving` — protection is not in force for this child
- **AND** `watchdog.logPath` and `lastSyncActivityAt` still carry the previous child's values, so the evidence of the stall is still readable
- **AND** the non-`null` `logPath` is NOT read as protection being in force

#### Scenario: Unresponsive to SIGTERM

- **GIVEN** a stall has been detected for vault `v`
- **WHEN** the child has not exited 10 seconds after `SIGTERM`
- **THEN** the child receives `SIGKILL`
- **AND** throughout that 10-second window the vault reports `state: "starting"` with `lastError` naming the stall, so `/readyz` is already 503
- **AND** the restart proceeds exactly as it would after any other non-zero exit

#### Scenario: Slow first sync on a fresh vault is not killed

- **GIVEN** a fresh vault whose sync directory appears only 10 minutes after the child is spawned
- **AND** whose initial sync then runs for another hour, writing a progress line every 30 seconds
- **WHEN** the whole sequence completes
- **THEN** no kill is issued at any point
- **AND** the 10 minutes before resolution contributed nothing to staleness

#### Scenario: Hung on first connect is still killed

- **GIVEN** a vault whose child resolves its sync log and then writes nothing ever again
- **WHEN** one stall threshold elapses from the anchor
- **THEN** the child is killed
- **AND** this holds even though the log's mtime never advanced once while the supervisor was watching

#### Scenario: Rotation with a preserved mtime is not silence

- **GIVEN** a running child whose resolved `sync.log` is rotated out and replaced by a different file carrying the same mtime
- **WHEN** the watchdog's next poll observes the new inode
- **THEN** the replacement counts as activity and the staleness clock is refreshed
- **AND** no kill is issued one threshold later

#### Scenario: Progressing sync is never killed

- **GIVEN** vault `v` has a running child and `OB_SYNC_STALL_TIMEOUT_SECONDS=300`
- **WHEN** the sync log's mtime advances every 30 seconds for an hour
- **THEN** no kill is issued
- **AND** `lastSyncActivityAt` tracks the most recently observed mtime
- **AND** `watchdog.stallKills` remains 0

#### Scenario: Repeated stalls fail the vault

- **GIVEN** vault `v` whose every child wedges immediately after start
- **WHEN** the third stall kill occurs within one hour
- **THEN** vault `v` transitions to `failed` with `lastError` naming the stall ceiling
- **AND** no further child is spawned for `v`
- **AND** `/readyz` returns 503 with `v` listed
- **AND** other vaults continue to be supervised normally

#### Scenario: Stall kill does not count as healthy uptime

- **GIVEN** a child that has been running for 10 minutes (longer than the healthy-uptime reset window) with no sync-log activity
- **WHEN** the watchdog kills it
- **THEN** the crash-window history and consecutive-failure counter are NOT reset
- **AND** the next restart uses the next backoff step rather than restarting from the initial delay

#### Scenario: Watchdog is silent during shutdown

- **GIVEN** a vault whose sync log has been silent for longer than the threshold
- **WHEN** `requestStop()` is called before the next poll fires
- **THEN** no stall kill is issued
- **AND** the child is terminated by the ordinary SIGTERM/SIGKILL shutdown path
- **AND** the process exits without waiting for a poll interval

#### Scenario: Watchdog disabled

- **GIVEN** `OB_SYNC_STALL_TIMEOUT_SECONDS=0` and `OB_SYNC_LOG_TAIL=false`
- **WHEN** a vault's child runs with a permanently silent sync log
- **THEN** no kill is ever issued
- **AND** the vault reports `watchdog.state === "disabled"`, `watchdog.logPath === null`, and `lastSyncActivityAt === null`

#### Scenario: Out-of-range threshold rejected at startup

- **GIVEN** `OB_SYNC_STALL_TIMEOUT_SECONDS=999999999999`
- **WHEN** the process starts
- **THEN** the process exits 78 with a message naming the variable, its value, and the 86400 bound
- **AND** no `ob` child has been spawned
- **AND** the process does NOT start with a watchdog that reports itself `armed` while never firing

#### Scenario: Invalid poll interval rejected at startup

- **GIVEN** `OB_SYNC_STALL_TIMEOUT_SECONDS=60` and `OB_SYNC_STALL_POLL_SECONDS=120`
- **WHEN** the process starts
- **THEN** the process exits 78 with a message naming both variables and their values
- **AND** no `ob` child has been spawned

### Public surface to the rest of the app

The supervisor module MUST expose:

```ts
type VaultState = "starting" | "running" | "failed";
type WatchdogState = "disabled" | "resolving" | "tailing" | "armed";
interface WatchdogStatus {
  state: WatchdogState;
  logPath: string | null;
  thresholdMs: number;
  pollIntervalMs: number;
  stallKills: number;
}
interface VaultStatus {
  slug: string;
  name: string;
  state: VaultState;
  pid: number | null;
  restarts: number;
  lastError: string | null;
  lastSyncActivityAt: number | null;
  watchdog: WatchdogStatus;
}
interface Supervisor {
  list(): VaultStatus[];
  get(slug: string): VaultStatus | null;
  stop(): Promise<void>;
}
```

- `list()` and `get()` MUST be synchronous, non-blocking reads of in-memory state.
- The supervisor MUST NOT expose raw child handles to other modules.
- `lastSyncActivityAt` MUST be the epoch-millisecond mtime of the resolved sync log as of the most recent successful poll — the upstream's own timestamp, not the instant the supervisor observed it. During a wedge it stays pinned at the moment the child stopped writing, which is what makes it the field an operator alerts on.
- `lastSyncActivityAt` is **last observed log activity, not last successful sync**, and MUST NOT be documented or presented as the latter. The mtime advances on any line the upstream writes, including the `Disconnected` / `Waiting to connect to server` / `Connecting...` sequence a reconnect loop emits. A recent value therefore proves only that the child is still writing — a vault churning through reconnects indefinitely has a fresh `lastSyncActivityAt` and is not syncing. Distinguishing the two would require parsing log contents, which [Change 0015](../../changes/0015-sync-stall-watchdog.md) rules out; the watchdog deliberately detects total silence, not unsuccessful progress.
- `lastSyncActivityAt` MUST be present on every `VaultStatus` and MUST be `null`, never absent, while the value is unknown. It follows the same never-versus-not-yet split as `logPath` below: `null` only while the vault has **never** resolved a log or the watchdog is `disabled`, and thereafter the most recently observed mtime — including while `state` is `resolving` for a later child. It matches the existing `pid` / `lastError` convention, so consumers never have to distinguish "absent" from "unknown".
- `watchdog` MUST be present on every `VaultStatus`. `watchdog.state` describes the watchdog's configuration and resolution progress, not whether a poll is currently in flight, and MUST have exactly these meanings:

  | Value | Meaning |
  |---|---|
  | `disabled` | Stall detection and log tailing are both switched off; nothing is resolved and nothing is polled. |
  | `resolving` | Configured, but the sync log is not resolved — the watchdog is dormant and this vault is not protected. This does not imply a poll is in flight: it is also the value before the vault's first child is spawned and during `sync-setup` and `sync-config`, when nothing is resolved yet. |
  | `tailing` | The log is resolved and being tailed, but stall detection is off (`OB_SYNC_STALL_TIMEOUT_SECONDS=0`); no child will be killed for silence. |
  | `armed` | The log is resolved and stall detection is active. |

- `state` and `logPath` answer two different questions and MUST NOT be derived from each other. `state` answers "is protection in force for the child running now". `logPath` answers "has this vault ever resolved a log, and which one". `resolving` covers both "never resolved at all" and "not resolved for this child yet", and only `logPath` distinguishes them:

  | `state` | `logPath` |
  |---|---|
  | `disabled` | always `null` — nothing is ever resolved |
  | `resolving` | `null` before the vault's first successful resolution; the last successfully resolved path thereafter |
  | `tailing` | always non-`null` — the state is reachable only once resolved |
  | `armed` | always non-`null` — the state is reachable only once resolved |

- `logPath` MUST be `null` until the vault's first successful resolution, and MUST thereafter report the most recently resolved path — including while `state` is `resolving` for a later child. A non-`null` `logPath` alongside `resolving` therefore means "resolved for a previous child, not yet for this one" and MUST NOT be read as protection being in force; `state` alone answers that. Every other rule in this spec that names a `state` together with a `logPath` value is an instance of this rule and MUST NOT be read as imposing a separate constraint.
- Before a vault's first child is spawned, `watchdog.state` MUST be `disabled` when configuration disables the watchdog entirely and `resolving` otherwise, with `stallKills` zero. This is the never-resolved case of the rule above, so `logPath` and `lastSyncActivityAt` are both `null` here. A vault therefore has a fully-formed `watchdog` object from the moment the supervisor returns, matching the existing guarantee that `list()` reflects every configured vault immediately.
- `lastSyncActivityAt` and `watchdog` MUST retain their most recent values while the vault has no running child — during restart backoff, and after the vault has reached `failed`. An operator reading the status of a vault that has just been killed for stalling MUST still see the mtime that proves it stalled. Whether a child is running is what the vault's own `state` field reports.
- Retention governs only what the surface reports while no child exists; it does not extend a resolution across children. When a replacement child is spawned, `watchdog.state` MUST return to `resolving` — the new child's log genuinely is not resolved yet and the vault is not protected until it is — while `logPath` and `lastSyncActivityAt` MUST keep their previous values until re-resolution replaces them. Blanking those two at spawn would destroy the stall evidence in exactly the window an operator is looking at it, and reporting `armed` before the new child's log resolves would claim a protection that is not in force.
- `watchdog.thresholdMs` and `watchdog.pollIntervalMs` MUST report the resolved effective configuration, so an operator can confirm from the status surface alone which threshold is actually in force.
- `watchdog.stallKills` MUST be the cumulative count of stall kills for that vault over the process lifetime, not the count inside the rolling stall window.

## Design

### Architecture

```text
src/obsidian/
  index.ts          # public Supervisor factory + types
  bootstrap.ts      # auth_token bootstrap
  setup.ts          # `ob sync-setup` orchestration with backoff
  syncconfig.ts     # `ob sync-config` env-var → flag mapping + validation
  child.ts          # spawn + log-tag + restart loop for one vault
  watchdog.ts       # sync.log resolution, stall detection, incremental tail
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
| `SyncStalled` | no `sync.log` activity within the stall threshold | SIGTERM → SIGKILL after grace; restart via the usual backoff; counts toward both the crash-loop and stall ceilings |
| `SyncStallLoop` | ≥ 3 stall kills in 60 min | mark vault `failed` |

## Constraints

- The supervisor MUST NOT call `ob login`, `ob logout`, or `ob sync-create-remote` (creating remote vaults is a user action, not a server action).
- The supervisor MUST NOT shell-interpolate vault names; arguments MUST go through array-form spawn.
- Sync settings (mode, file types, excluded folders, conflict strategy, configs, device name) are configured via `OB_SYNC_*` env vars applied identically to every vault (see [Sync configuration bootstrap](#sync-configuration-bootstrap)). Per-vault overrides are out of scope.

## Open Questions

- **Detecting "already set up".** The README documents `ob sync-status` output but not its machine-readable form. We may need to parse human text or add a `--json` flag upstream. **Default for v1**: parse exit code (0 = configured, non-zero = not configured) and human output, with a fallback path-existence check on `.obsidian/`.
- **Token rotation.** If `OBSIDIAN_AUTH_TOKEN` changes between restarts, do we need to invalidate any per-vault sync state? Likely no, but worth confirming with a real run.
- **`sync.log` as a liveness proxy.** Neither the log's location, its `config.json` sidecar, nor its ~30-second progress cadence is a documented upstream contract; all three are observed behavior. If a future `obsidian-headless` release relocates or silences the log, the watchdog degrades to `watchdog.state === "resolving"` (dormant, observable, never destructive) rather than misfiring — which is why unresolvable is specified as fail-soft. **Default for v1**: depend on the observed layout, keep the dormant fallback, and revisit if upstream exposes a machine-readable `sync-status`.
- **Should a stall get its own `VaultState`?** A `"stalled"` value would be more legible than inferring the condition from `lastError` plus `watchdog.stallKills`, but `VaultState` is a closed set consumed by the REST and MCP status surfaces, and widening it is a breaking change for every consumer. **Default for v1**: no new state; a stall is observable through `lastError`, `watchdog.stallKills`, and `lastSyncActivityAt`.

## References

- [obsidianmd/obsidian-headless README](https://github.com/obsidianmd/obsidian-headless)

## Changelog

| Date | Change | Document |
|------|--------|----------|
| 2026-05-03 | Initial spec created | — |
| 2026-05-03 | Align `/readyz` semantics with Architecture spec: strict 200-only-if-all-ready (replaces the prior "200 if any vault healthy" wording). | [Change 0002](../../changes/0002-obsidian-supervisor.md) |
| 2026-05-06 | Add Sync-configuration-bootstrap requirements: env-var-driven `ob sync-config` step between `sync-setup` and `sync --continuous`, with `OB_SYNC_*` mapping, validation, and retry semantics. Replaces the prior "Per-vault sync mode override is OUT OF SCOPE for v1" deferral with a global, env-driven mechanism; per-vault overrides remain out of scope. | [Change 0011](../../changes/0011-sync-config-bootstrap.md) |
| 2026-08-21 | Add Sync-activity-log and Sync-stall-watchdog requirements: per-vault resolution of the upstream `sync.log` by matching `config.json`'s `vaultPath`, incremental tailing of that log into the parent structured logger, and an mtime-silence watchdog that SIGTERM/SIGKILLs a hung-but-alive child so the existing restart loop can take over. Extends the public `VaultStatus` with `lastSyncActivityAt` and a `watchdog` sub-object, and adds the `OB_SYNC_STALL_TIMEOUT_SECONDS` / `OB_SYNC_STALL_POLL_SECONDS` / `OB_SYNC_LOG_TAIL` env vars plus the `SyncStalled` and `SyncStallLoop` error classes. | [Change 0015](../../changes/0015-sync-stall-watchdog.md) |

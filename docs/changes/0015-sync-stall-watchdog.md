# 0015: Sync Stall Watchdog and Health Surface

## Summary

Detect an `ob sync --continuous` child that has stopped making progress but is still alive, kill it so the existing restart loop can replace it, forward the upstream sync log into the parent's structured logs, and report per-vault sync liveness on `/readyz`. Implements the Sync-activity-log and Sync-stall-watchdog sections newly added to the [Obsidian Sync spec](../specs/obsidian-sync/index.md#sync-activity-log), the liveness/readiness split newly pinned in [Architecture › Observability](../specs/architecture/index.md#observability), and the `/readyz` body contract newly added to [REST API › Health endpoints](../specs/rest-api/index.md#health-endpoints).

**Spec:** [Obsidian Sync](../specs/obsidian-sync/)
**Status:** draft
**Depends On:** 0002, 0011

## Motivation

Sync dies at random and never comes back. Observed in production on `obsidian-headless` 0.0.8: both vaults wedged from **2026-08-16T07:25 until 2026-08-20T19:29 — four and a half days** of silent, total sync loss (reported at the time as 4.8 days; the timestamps give 4d 12h). The child process stayed alive the whole time, never exited, and never produced an exit code.

The last three lines of `~/.config/obsidian-headless/sync/<vaultId>/sync.log` for each vault:

```text
[2026-08-16T07:24:51.770Z] Disconnected from server
[2026-08-16T07:24:51.770Z] Waiting to connect to server
[2026-08-16T07:25:09.289Z] Connecting...        ← end of file, four and a half days
```

Five earlier disconnects on Aug 13–14 all self-recovered, each followed within seconds by `Connection successful. Detecting changes...`. A healthy steady state writes a `Fully synced` line every 30 seconds. So the failure is not "the network went away" — it is a reconnect path that can hang forever.

Three independent layers all failed to notice:

1. **The supervisor.** `VaultChild.runLoop()` (`src/obsidian/child.ts`) restarts only on `handle.exited`. A hung-but-alive child never settles that promise, so the loop simply waits. The backoff and crash-loop machinery are correct — they just never got a chance to run.
2. **Log forwarding.** `forwardLines()` sees nothing useful, because the upstream CLI writes progress to its own `sync.log` file rather than to stdout. Confirmed against the running pod: 20226 lines in that file and **zero** `ob output` entries in the pod logs across the whole 10-day pod lifetime.
3. **The orchestrator.** The deployment's liveness probe GETs `/healthz`, which returns `{ok:true}` unconditionally and knows nothing about sync state.

Nothing in the process could observe the wedge, and nothing outside it could either. The only signal that existed at all — `sync.log`'s mtime frozen four days in the past — was never read by anything.

This change makes that signal load-bearing: poll the log's mtime, treat prolonged silence as a crash, and surface both the last activity timestamp and the watchdog's own state on the status surface so an operator can alert on it.

**Explicitly not the fix:** wiring sync health into the Kubernetes liveness probe. The container is a single process hosting the HTTP API and every vault child (see [Architecture › Single-Process Topology](../specs/architecture/index.md#single-process-topology)), so failing liveness for one wedged vault restarts the API and the healthy vault to recover one child. The in-process watchdog is the right blast radius; `/readyz` is the right place to report.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint)). CI enforces these as merge gates:

- The standing 100% line + branch coverage gate on `src/` MUST hold. CI runs `bun run test:cov` (which invokes `bun test --coverage` and `test/check-coverage.ts`). New code without tests is a defect.
- Watchdog timing MUST be tested deterministically through the injected `now()` and `sleep()` seams that `ChildDeps` already exposes, exactly as the crash-loop tests collapse a 5-minute window today. A test MUST NOT wait on real wall-clock time for a stall threshold.
- Child processes MUST be driven through the existing `Spawner` fake (`test/helpers/fakeSpawner.ts`). A "hung" child is a scripted handle whose `exitWhen` promise is never resolved except by the test's own `onKill` hook; that is the fixture the whole feature turns on.
- Filesystem reads (directory scan, `config.json` parse, `stat`, ranged read) MUST go through an injected surface so unit tests can drive error shapes (`ENOENT`, `EACCES`, malformed JSON, mid-poll truncation) without a real filesystem. At least one test per feature area MUST additionally run against a real `Bun.tmpdirSync()` tree so the injected surface cannot drift from real `fs` semantics.
- The `ob` binary MUST NOT be called against real Obsidian servers. The standing "one `ob` integration test per top-level change" rule is satisfied by the existing `OB_BIN`-gated `ob --help` smoke test; this change MUST NOT add new `ob` integration tests that touch real Obsidian endpoints.
- `/readyz` body changes MUST be asserted through the real Hono app (`app.fetch`), as `test/http.test.ts` and `test/http/` do today, on both the 200 and the 503 path.
- LanceDB-touching code is unaffected; no new LanceDB tests required.
- Biome MUST pass with the project config; `bunx tsc --noEmit` MUST pass.
- `// @ts-expect-error`, `// biome-ignore`, and `// eslint-disable*` MUST carry a one-line same-comment justification.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Behavior owned by the specs

The [Obsidian Sync spec](../specs/obsidian-sync/index.md) owns log resolution, staleness semantics, the kill escalation, the crash and stall ceilings, the env-var contract, and the extended `VaultStatus` shape — with its scenarios as this change's acceptance criteria. [REST API › Health endpoints](../specs/rest-api/index.md#health-endpoints) owns the `/readyz` body and its 200/503 rules; [Architecture › Observability](../specs/architecture/index.md#observability) owns the liveness/readiness split. None of that is restated here.

What implementing them requires of this change:

- The watchdog is a new module, `src/obsidian/watchdog.ts`; `src/obsidian/child.ts` owns only the integration (start on spawn, stop on exit and on `requestStop`, consume the stall verdict).
- `VaultStatus` gains two fields. Every producer and consumer MUST be updated in the same PR that adds them: `VaultChild.snapshot()`, `src/vault/status.ts` (`VaultSummary.sync` passes the object through untouched), the `/readyz` body, `GET /v1/vaults`, `GET /v1/vaults/:slug`, and the MCP `list_vaults` / `vault_status` tools, which serialize the same object.
- The three new env vars MUST be validated in `src/config/index.ts` in the existing style — a pure function over `Record<string, string | undefined>` throwing `ConfigError` (exit 78) — and MUST reach the supervisor as a resolved `Config` field, never by reading `process.env` inside `src/obsidian/`.
- The XDG config base (`${XDG_CONFIG_HOME:-$HOME/.config}`) is currently resolved inside `startSupervisor`'s `skipAuthBootstrap !== true` branch. It MUST be hoisted so the watchdog resolves the same base regardless of that flag; otherwise every test that skips auth bootstrap silently gets a different sync directory than production.
- `/readyz` gains an `ok` field, and one **deliberate tightening**: today `src/http/index.ts` treats an absent indexer dependency as vacuously ready (`idx === undefined ? true`) and passes `idx.list()` straight through, so a configured vault the indexer has not registered yet is simply missing from `indexers` and cannot hold the response at 503. The spec now requires one entry per configured vault, synthesized as `starting` when unregistered — the same synthesis `src/vault/status.ts` already does for `GET /v1/vaults`. `test/http.test.ts`'s "returns 200 when every vault is running" case wires a supervisor with no indexer and MUST be updated in the same PR; it currently passes only because of the hole being closed. No status code rules change beyond that, no new routes, and no change to `/healthz`.

#### Scenario: Status fields reach every surface

- **GIVEN** vault `v` whose watchdog has resolved a sync log and observed activity
- **WHEN** the same vault is read via `GET /readyz`, `GET /v1/vaults`, `GET /v1/vaults/v`, and the MCP `vault_status` tool
- **THEN** all four report identical `lastSyncActivityAt` and `watchdog` values for `v`

### Operator-facing documentation

- `README.md`'s configuration table MUST gain the three new env vars, and its operations section MUST document how to recognize a stall from `/readyz` (`lastSyncActivityAt` far in the past, `watchdog.stallKills` climbing, `lastError` naming the stall), and MUST state that a *fresh* `lastSyncActivityAt` proves only that the child is writing — a vault stuck in a reconnect loop keeps it current while syncing nothing.
- `.env.example` MUST gain a commented block for the three vars.
- The README MUST state that the Kubernetes liveness probe MUST stay pointed at `/healthz` and that `/readyz` is the alerting surface, so an operator reading only the README does not "improve" the deployment by pointing liveness at `/readyz`.

## Design

### Approach

`src/obsidian/watchdog.ts` exports one factory that owns a single poll loop per child lifetime. One loop serves both features, because both need the same `stat` of the same file:

```ts
// Shape only — the poll body is the whole module.
export interface WatchdogDeps {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly fs: WatchdogFs;          // readDir, readJson, stat, readRange
  readonly logger: Logger;
  readonly syncDir: string;          // ${XDG_CONFIG_HOME:-$HOME/.config}/obsidian-headless/sync
  readonly config: SyncWatchdogConfig;
}

export interface WatchdogHandle {
  snapshot(): { lastSyncActivityAt: number | null; watchdog: WatchdogStatus };
  stop(): void;                      // idempotent; wakes the poll sleep
}

export function startWatchdog(
  vault: ChildVault,
  deps: WatchdogDeps,
  onStall: (reason: string) => void,
): WatchdogHandle;
```

Each poll does, in order: resolve the log path if not yet resolved; `stat` it; compare mtime against the recorded value to decide activity; tail any appended bytes; evaluate staleness. `onStall` is the only outward effect — the watchdog never touches the spawn handle itself, so `child.ts` keeps sole ownership of process lifecycle and the module stays testable without a process at all.

In `VaultChild.runLoop()`, immediately after a successful spawn:

```ts
// pseudo-code
this.stallReason = null;                     // per attempt: a verdict must never
                                             // outlive the attempt that produced it
const wd = startWatchdog(this.vault, this.deps.watchdog, (reason) => {
  this.stallReason = reason;                 // consumed after `exited` settles
  this.markUnhealthy(reason);                // state -> starting, lastError set,
                                             // BEFORE the signal: a child that
                                             // ignores SIGTERM must not hold
                                             // /readyz at 200 for the grace window
  handle.kill("SIGTERM");
  void this.escalate(handle);                // SIGKILL after the grace period
});
try {
  attemptCode = await handle.exited;
} finally {
  wd.stop();
}
```

The `finally` is what guarantees the "no poll during backoff, no leaked timer after stop" requirement: every path out of the attempt — clean exit, crash, stall kill, `requestStop()` — passes through it. `requestStop()` additionally calls `wd.stop()` directly so a stall verdict cannot land between the SIGTERM and the loop noticing.

After `exited` settles, `stallReason !== null` is what distinguishes a stall from an ordinary crash — never the exit code, since a child with a `SIGTERM` handler can exit 0 and would otherwise read as a clean exit. It selects the `lastError` text, suppresses the healthy-uptime reset, and pushes onto the stall window in addition to `crashTimes`. It is cleared at the top of each attempt (above) and again once consumed, so a later ordinary crash cannot inherit a stale verdict and be miscounted toward the stall ceiling.

The poll loop uses the injected `sleep` raced against a per-lifetime stop signal, mirroring the existing `Promise.race([sleep, stopSignal])` in `runLoop`'s backoff. It is not a `setInterval`: an interval would keep the event loop alive past shutdown and would be invisible to the fake clock the crash-loop tests already use.

### Decisions

- **Decision:** Anchor staleness to the wall clock at resolution, not to the sync log's own mtime.
  - **Why:** The two are different clocks and the gap between them is the bug. In the production wedge, the mtime was four and a half days old; a watchdog comparing `now - mtime` would kill a perfectly healthy child the instant it resolved a log that happened to be idle, and would kill a freshly restarted pod's child before it ever connected. Anchoring at resolution and refreshing only on observed change means every child gets exactly one full threshold of grace, whether it is the first child or the tenth.
  - **Alternatives considered:** **`now - mtime >= threshold`** — spuriously kills on any pre-existing idle log, including the very first poll after a pod restart. **No anchor, only refresh on change** — a child that hangs before writing anything is never evaluated at all, which is exactly the "hung on first connect" case in the evidence.

- **Decision:** Report `lastSyncActivityAt` as the log's mtime, while deciding staleness from the internal observation instant.
  - **Why:** These answer different questions and conflating them loses the useful one. The mtime is what an operator wants on a dashboard — "the child last wrote something at 07:25 on Aug 16" — and it survives a pod restart, so a pod that comes up into an already-stale log still shows when writing actually stopped. It is last observed log activity, not last successful sync: a reconnect loop keeps it fresh while syncing nothing, and telling those apart would need log-content parsing, which is a non-goal below. The observation instant is an implementation detail with no meaning outside the process.
  - **Alternatives considered:** Reporting the observation instant — always "a few seconds ago" even mid-wedge, i.e. actively misleading. Reporting both — a second field whose only consumer would be a test.

- **Decision:** A separate stall window with its own ceiling, in addition to counting stall kills toward `crashTimes`. The window and ceiling values are the spec's.
  - **Why:** Counting toward `crashTimes` alone cannot work, and it fails silently. A stall kill can occur at most once per threshold, so with the 300-second default the crash-loop ceiling's ten crashes would have to land inside a 5-minute window — impossible. Worse, `DEFAULT_CRASH_LOOP.healthyResetMs` is also 5 minutes, so a child that stays wedged-but-alive for 300 seconds clears the healthy-uptime bar and *resets* the counter on its way out. Without a second window, wedge → kill → wedge → kill repeats forever and nothing ever escalates, which is precisely the "unnoticed" failure this change exists to eliminate. Keeping the `crashTimes` push as well means a vault that mixes real crashes with stalls still trips the original ceiling.
  - **Alternatives considered:** **Retune `DEFAULT_CRASH_LOOP`** — changes the escalation behavior of ordinary crashes, which is not broken. **Exempt stall kills from the healthy-uptime reset and nothing else** — necessary but not sufficient; the window is still too short for ten stall kills to ever land in it.

- **Decision:** A persistently stalling vault ends in `failed`, and no restart escapes that.
  - **Why:** `failed` is what makes `/readyz` stay 503 with a `lastError` naming the stall, which is the whole alerting path. Restarting forever would keep flapping `/readyz` while the vault has demonstrably not recovered across three full thresholds, and flapping readiness is a worse signal than a steady failure.
  - **Tradeoff, stated plainly:** `failed` is terminal until the process restarts, so a vault that would have recovered on the next attempt does not get one. That is deliberate: enough stall kills inside a rolling hour is not a transient. Note the window is rolling rather than consecutive — an ordinary crash-and-recover between two stalls does not clear the earlier stall kills, because a vault that alternates between crashing and wedging is not healthier than one that only wedges. The operator remedy is a pod restart, and the alert tells them to do it.
  - **Alternatives considered:** **Restart forever** — no escalation, and the multi-day outage becomes a multi-day flap nobody is paged for. **A `stalled` VaultState** — better labeled, but `VaultState` is a closed set consumed by REST and MCP; widening it is a breaking change for every consumer, tracked instead as an open question on the spec.

- **Decision:** Disabling the watchdog (`OB_SYNC_STALL_TIMEOUT_SECONDS=0`) does not disable log tailing.
  - **Why:** The two answer different needs. An operator who distrusts the kill still wants sync progress in `kubectl logs` and still wants `lastSyncActivityAt` — that combination is the safest way to run the feature in observation mode before arming it. Only the pair of `0` and `OB_SYNC_LOG_TAIL=false` shuts the poll off entirely.
  - **Alternatives considered:** One master switch — forces an operator who wants to disarm the kill to also give up the diagnostics that would tell them whether disarming was right.

- **Decision:** Resolve the vault id by scanning `config.json` files, once per child, retried on every poll until it succeeds.
  - **Why:** The id is assigned by the upstream CLI and the `sync/` directory does not exist until the CLI has completed its first setup, so there is nothing to read at construction time. Retrying on the existing poll costs one `readdir` per interval and needs no additional scheduling. Re-resolving per child (rather than once per process) means a vault re-linked between restarts picks up its new id without a pod restart.
  - **Alternatives considered:** **Resolve once at supervisor start** — races the CLI's first setup and permanently mis-resolves a fresh vault. **Watch the directory for creation** — a second filesystem watcher for something the existing poll already visits.

- **Decision:** Unresolvable log is dormant-and-observable, never fatal.
  - **Why:** Every failure mode here is upstream-shaped — a layout change, a permissions change, a vault that has not synced yet. Failing the vault would convert "we cannot watch this" into "sync is down", turning the safety net into the outage. Dormant is safe; what makes it acceptable is that it is *visible*: `watchdog.state === "resolving"` on the status surface, plus a `warn` once the child has been running longer than the threshold with the log still unresolved. That second signal is the one that says "this vault is unprotected" rather than "this vault is fine".
  - **Alternatives considered:** **Mark the vault `failed`** — an upstream layout change would take down every vault at once. **Fail silently** — indistinguishable from a working watchdog, which is how this bug survived ten days.

- **Decision:** Extend `/readyz` rather than add a `/statusz` route.
  - **Why:** `/readyz` already aggregates exactly the right set (every vault child, every indexer) and already returns 503 on exactly the right condition. A third health surface would have to be kept in sync with it forever, and the failure mode of a split surface is the dangerous one: a component enumerated on only one of them reads as an all-clear on the other. `/healthz` stays a dumb liveness probe, unchanged, because that is what its consumer (the orchestrator's restart decision) needs.
  - **Alternatives considered:** **`/statusz` as a rich surface with `/readyz` left thin** — two surfaces, two update sites, and every consumer has to learn which one is authoritative. **Sync health on `/healthz`** — explicitly rejected; restarts the API and the healthy vault to recover one child.

- **Decision:** Tail from the file's size at resolution, never from byte zero.
  - **Why:** Production holds 20226 lines in one vault's log. Replaying it on every restart would bury the live signal and multiply log volume for zero information — the backlog is already on disk for anyone who wants it.
  - **Alternatives considered:** Emitting the last N lines as context — a bounded version of the same noise, and the useful context (`lastSyncActivityAt`) is already on the status surface.

- **Decision:** Detect rotation by inode identity as well as by a size that went backwards.
  - **Why:** Size-shrink alone misses a replacement file that happens to be larger than the current offset, which then reads from the middle of a line and emits garbage. `stat` already returns the inode; comparing it is free on a call being made anyway.
  - **Alternatives considered:** Size-only — cheaper by one comparison, wrong in the case that produces corrupted output.

### Non-Goals

- **No change to the Kubernetes liveness probe, and no manifest edits.** The deployment manifest lives in a different repository and is not editable from here; it is operator context only. The README will say what the probe must keep pointing at.
- **No `/metrics` work.** The architecture spec calls for a Prometheus endpoint; it does not exist yet, and adding one here would bundle an unrelated surface into a bugfix. Alerting keys on `/readyz` for now.
- **No new `VaultState` value.** Tracked as an open question on the spec.
- **No fix to the upstream hang.** The reconnect path in `obsidian-headless` 0.0.8 is upstream's; this change works around it. Filing upstream is worthwhile and is not this change.
- **No parsing of `sync.log` contents.** Lines are forwarded verbatim. Deriving structured sync state from log text would couple us to an undocumented, unversioned format that an upstream wording change could silently break. The cost of holding this line is stated honestly in Risks below: the mtime proves the child is writing, not that it is making progress, so a reconnect loop that keeps writing is not detected by this change.
- **No per-vault watchdog overrides.** The three env vars apply identically to every vault, matching the `OB_SYNC_*` precedent set by [0011](./0011-sync-config-bootstrap.md).
- **No indexer watchdog.** The indexer is in-process and its stalls are a different problem with different evidence. `/readyz` already reports indexer state.

## Tasks

- [x] **Docs: this change document + spec updates** (this PR)
  - [x] Add `docs/changes/0015-sync-stall-watchdog.md`
  - [x] Add the Sync-activity-log and Sync-stall-watchdog sections to `docs/specs/obsidian-sync/index.md`, extend its public `VaultStatus`, module layout, and error taxonomy, and append a Changelog row
  - [x] Pin the liveness/readiness split in `docs/specs/architecture/index.md` Observability, add the `OB_SYNC_*` config-table row, and append a Changelog row
  - [x] Rewrite `docs/specs/rest-api/index.md` Health endpoints with the exact `/readyz` body and 200/503 rules, and append a Changelog row
  - [x] Add this change to `docs/index.yml` (`status: draft`) and a row to the `docs/index.md` Changes table

- [ ] **PR 2 — Observability: sync-log resolution, tail, and status surface** (no killing)
  - [ ] `src/config/index.ts`: add `loadSyncWatchdogConfig(env)` returning `{ stallTimeoutMs, pollIntervalMs, logTail }`, plumbed onto `Config` as `syncWatchdog`; validate per the spec (integer form, poll ≥ 1, poll ≤ timeout when timeout > 0, `OB_SYNC_LOG_TAIL` exactly `true`/`false`), throwing `ConfigError` (exit 78) naming the offending var and value
  - [ ] Tests under `test/config/` for every accept and reject case, including the poll-exceeds-timeout pair and the timeout-`0`-so-poll-unconstrained case
  - [ ] `src/obsidian/watchdog.ts`: `WatchdogFs` surface, vault-id resolution by `config.json` `vaultPath` match (normalized absolute compare, no prefix match, newest-mtime selection with a lexicographic tiebreak and a `warn`), fail-soft on every filesystem error per the spec's dispositions, incremental tail with start-at-current-size, inode/size rotation reset, per-poll byte cap with a skip `warn`, partial-line buffering, and the `snapshot()` / `stop()` handle
  - [ ] `src/obsidian/child.ts`: start the watchdog after a successful spawn, `wd.stop()` in a `finally` around `await handle.exited`, and again from `requestStop()`; extend `snapshot()` with `lastSyncActivityAt` and `watchdog`
  - [ ] `src/obsidian/index.ts`: hoist the XDG base resolution out of the `skipAuthBootstrap` branch and pass `syncDir` plus `cfg.syncWatchdog` into every `VaultChild`
  - [ ] Propagate the two new `VaultStatus` fields through `src/vault/status.ts` and both adapters; update `test/parity/` fixtures so REST and MCP still agree
  - [ ] Tests in `test/obsidian/watchdog.test.ts`: resolution success, ambiguous-match tiebreak, missing directory, unreadable and malformed `config.json`, no-backlog-on-start, mid-poll truncation, inode replacement, over-cap append, partial-line buffering across polls, `lastSyncActivityAt` tracking, and the "unresolved past threshold" `warn`
  - [ ] At least one test per feature area against a real `Bun.tmpdirSync()` tree
  - [ ] `src/http/index.ts`: add `ok` to the `/readyz` body on both paths, and emit one `indexers` entry per configured vault — synthesizing `starting` for a vault the indexer has not registered — replacing the current `idx === undefined ? true` shortcut; update `test/http.test.ts`'s supervisor-only 200 case accordingly and add a test that an unregistered indexer holds `/readyz` at 503

- [ ] **PR 3 — Stall detection, kill escalation, and accounting**
  - [ ] `src/obsidian/watchdog.ts`: anchor-on-resolution, activity-on-mtime-change, staleness evaluation against the injected clock, one-verdict-per-child guard, and the `onStall` callback carrying the `lastError` text (threshold plus last observed mtime)
  - [ ] `src/obsidian/child.ts`: flip the vault out of `running` and set `lastError` on the verdict itself (before the signal), SIGTERM, SIGKILL after the grace period, `stallReason` consumed after `exited` settles to select `lastError`, suppress the healthy-uptime reset, push to both `crashTimes` and the new stall window, flip to `failed` on either ceiling, and increment `watchdog.stallKills`
  - [ ] Tests in `test/obsidian/child.test.ts` (or a sibling) covering every spec scenario: wedged child killed and restarted, SIGTERM ignored then SIGKILL, progressing sync never killed, third stall in an hour fails the vault, stall kill does not reset crash counters, no verdict after `requestStop()`, and watchdog fully disabled
  - [ ] Test that a stalled vault is reported through `/readyz` with 503 while `/healthz` still returns 200
  - [ ] `README.md`: the three env vars in the configuration table, a short "recognizing a stalled vault" operations note, and the explicit "keep liveness on `/healthz`" statement
  - [ ] `.env.example`: commented block for the three vars
  - [ ] Flip this change document to `**Status:** complete` and sync `docs/index.yml` and `docs/index.md`

## Risks / Open Questions

- **Residual risk: a chatty reconnect loop evades the watchdog entirely. This is the failure mode 0015 does not fix.** The watchdog fires on total silence. A child that loops `Disconnected` → `Waiting to connect to server` → `Connecting...` indefinitely keeps writing, so its sync-log mtime stays fresh: it is never killed, never counted toward either ceiling, never escalated, and `/readyz` stays 200 while the vault syncs nothing. To an operator it presents as a healthy vault — `state: "running"`, `watchdog.state: "armed"`, `lastSyncActivityAt` a few seconds old — which is strictly worse than the outage this change does fix, because that one at least froze a timestamp someone could alert on. This is a different failure mode from the one in the evidence: that incident ended in silence after three lines, which is exactly what the watchdog catches. But it is adjacent to it — the same reconnect path, one loop iteration short of stopping — so it is a plausible next incident rather than a theoretical one. Detecting it needs a progress signal, and mtime is not one.
- **Open question: should a future revision use the `Fully synced` heartbeat as the progress signal instead of raw mtime?** The upstream writes a `Fully synced` line about every 30 seconds in steady state, so its *absence* over several minutes would distinguish "looping without progress" from "actually syncing" — closing the residual risk above. The cost is real and is why it is a non-goal today: it couples the supervisor to the exact text of an undocumented, unversioned log format, so an upstream wording change would silently disarm detection, which is the same class of silent failure this change exists to remove. It also contradicts the standing "no parsing of `sync.log` contents" non-goal above. Deliberately left unresolved: not a requirement of this change, and not to be implemented as part of it.
- **Risk: a spurious kill on a genuinely slow operation.** If some upstream operation can run longer than 300 seconds without writing a single log line, the watchdog would interrupt it. The evidence argues against it — the healthy steady state writes every 30 seconds, and even the wedged child logged three lines during its final disconnect — but the initial sync of a very large vault has not been observed at this granularity. Mitigations, all already in the design: the threshold is env-configurable, `0` disarms the kill while keeping the diagnostics, and a kill is a restart rather than a data-loss event. Recommended rollout is `OB_SYNC_STALL_TIMEOUT_SECONDS=0` for one deployment cycle to collect `lastSyncActivityAt` from the real workload, then arm it.
- **Risk: mtime granularity or a filesystem mounted `noatime`-style with coarse timestamps.** `noatime` affects atime, not mtime, so an append always moves mtime; but a network or overlay filesystem with second-granularity timestamps could in principle coalesce writes. At a 30-second poll against a 30-second write cadence, coalescing within one second is harmless. Called out because it would be invisible if wrong.
- **Open question: should the stall window and its ceiling be env-configurable too?** Held as injected constants (3 kills / 60 min) alongside `DEFAULT_CRASH_LOOP` rather than a fourth and fifth env var. Revisit if a deployment needs to tune them; the default is deliberately conservative.
- **Open question: should PR 2 ship the tail behind `OB_SYNC_LOG_TAIL=false` by default?** Tailing adds one log line per vault per ~30 seconds at steady state, which is negligible, but it is a visible change in log volume for anyone parsing pod logs. Default for v1: on, because a silent supervisor is the condition that let this bug live for ten days.
- **Open question: alerting rule shape.** `/readyz` reporting 503 is necessary but coarse — it also fires during ordinary startup. The precise rule an operator wants is closer to "`lastSyncActivityAt` older than N minutes on any vault", which needs a scraper. That argues for the deferred `/metrics` endpoint, tracked as a follow-up rather than here.

## References

- Spec: [Obsidian Sync › Sync activity log](../specs/obsidian-sync/index.md#sync-activity-log) and [› Sync stall watchdog](../specs/obsidian-sync/index.md#sync-stall-watchdog)
- Spec: [Obsidian Sync › Public surface](../specs/obsidian-sync/index.md#public-surface-to-the-rest-of-the-app) — the extended `VaultStatus`
- Spec: [Architecture › Observability](../specs/architecture/index.md#observability) — the liveness/readiness split this change pins
- Spec: [REST API › Health endpoints](../specs/rest-api/index.md#health-endpoints) — the `/readyz` body contract
- Related changes: [0002 — Obsidian supervisor](./0002-obsidian-supervisor.md) (introduced `VaultChild`, the restart loop, the crash-loop ceiling, and `VaultStatus`), [0011 — Sync config bootstrap](./0011-sync-config-bootstrap.md) (established the `OB_SYNC_*` env-var family and its startup validation)
- Code: `src/obsidian/child.ts` (`runLoop`, `forwardLines`, `crashTimes`, `DEFAULT_CRASH_LOOP`), `src/obsidian/index.ts` (`startSupervisor`, `SupervisorDeps.xdgConfigHome` / `homeDir`), `src/http/index.ts` (`/healthz`, `/readyz`), `src/config/index.ts` (`ConfigError`, exit 78), `test/helpers/fakeSpawner.ts` (`exitWhen`, `onKill`)
- External: [obsidianmd/obsidian-headless](https://github.com/obsidianmd/obsidian-headless) — upstream CLI; the hang is in its reconnect path as of 0.0.8

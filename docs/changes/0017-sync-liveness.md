# 0017: Unbounded Sync Retry and Sync-Aware Liveness

## Summary

Make the crash-loop and stall-loop restart ceilings opt-in, so a vault whose sync keeps failing is retried forever with the existing capped backoff instead of being parked in a terminal `failed` state. Track each vault's consecutive failed sync attempts as a new `VaultStatus.consecutiveFailures` field, and make `GET /healthz` return 503 once any vault is `failed` or has failed a configurable number of attempts in a row without recovering, so the orchestrator's liveness probe restarts the pod when in-process retries cannot bring sync back. Request handling is never gated on sync health. Implements the new [Restart ceilings and liveness](../specs/obsidian-sync/index.md#restart-ceilings-and-liveness) section and the failed/recovered-attempt rules in [Obsidian Sync › Sync supervision](../specs/obsidian-sync/index.md#sync-supervision), the rewritten `/healthz` contract in [REST API › Health endpoints](../specs/rest-api/index.md#health-endpoints), and the revised liveness rule in [Architecture › Observability](../specs/architecture/index.md#observability).

**Spec:** [Obsidian Sync](../specs/obsidian-sync/)
**Status:** complete
**Depends On:** 0015

## Motivation

An upstream outage left both vaults' sync permanently dead, and nothing noticed:

- **07:05** — the server disconnected both vaults at the same moment; both children hung at `Connecting...`.
- **07:10** — the 0015 stall watchdog killed both after five minutes of silence.
- **07:10–07:24** — the replacements reconnected and logged `Fully synced` every 30 seconds.
- **07:24** — both vaults were disconnected again at the same moment and hung at `Connecting...`. A restart in between also hit `Another sync instance is already running` after a SIGKILL.
- **07:30** — the third stall kill within an hour tripped the stall-loop ceiling. ob logged `ob sync stall-loop ceiling reached` for both vaults, marked them `failed`, and stopped retrying.

Both vaults dropped together, twice, on different upstream servers (sync-19 and sync-65): an outage at Obsidian or on the network in between, not a fault in ob. But two gaps in ob turned a transient outage into a permanent one:

1. **The ceiling made failure terminal.** Once a vault is `failed`, restarts stop until the process restarts. The outage was over within minutes; the vaults stayed dead.
2. **Nothing outside the process could see it.** `/healthz` returned `{"ok":true}` unconditionally ([0015](./0015-sync-stall-watchdog.md) explicitly rejected attaching sync health to it), so the Kubernetes liveness probe never fired. `/readyz` did report 503, but nothing restarts on readiness.

The user's direction:

> there should be no ceiling on retries -- we can have one optionally via env variable, but the default should be infinite retrying, and obviously reporting not ok when sync is down (we can still accept calls though, we shouldn't stop accepting/writing just because sync is down, assuming it'll recover and sync)

On when `/healthz` should fail: "when we tried reconnecting X number of times (say ...3, at 5 minutes?) it should probably 503". On the crash-loop ceiling as well as the stall-loop one: "Both unlimited".

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint)). CI enforces these as merge gates:

- The standing 100% line + branch coverage gate on `src/` MUST hold. CI runs `bun run test:cov` (which invokes `bun test --coverage` and `test/check-coverage.ts`). New code without tests is a defect.
- Retry, recovery, and threshold timing MUST be tested deterministically through the injected `now()` and `sleep()` seams and the fake watchdog filesystem. A test MUST NOT wait on real wall-clock time for a threshold.
- Child processes MUST be driven through the existing `Spawner` fake (`test/helpers/fakeSpawner.ts`). With the ceilings now unlimited by default, every test whose loop used to end at the default crash ceiling MUST set an explicit ceiling or stop the loop itself — an unbounded fake restart loop hangs the suite.
- `/healthz` MUST be asserted through the real Hono app (`app.fetch` / `app.request`) on both the 200 and the 503 path, including one end-to-end case driving a real `VaultChild` through three stall kills and back.
- One test MUST prove that REST and MCP reads and writes keep working while `/healthz` reports 503.
- Every new env var MUST have an accept and reject matrix under `test/config/`, including the bound and a value that would parse to `Infinity`.
- The new watchdog activity accessor MUST have at least one test against a real `Bun.tmpdirSync()`-style tree, per 0015's real-filesystem rule.
- The `ob` binary MUST NOT be called against real Obsidian servers; no new `ob` integration tests.
- Biome MUST pass with the project config; `bunx tsc --noEmit` MUST pass.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Behavior owned by the specs

The [Obsidian Sync spec](../specs/obsidian-sync/index.md) owns the failed/recovered-attempt definitions, `consecutiveFailures`, the opt-in ceilings and their env vars, and the extended `VaultStatus`. [REST API › Health endpoints](../specs/rest-api/index.md#health-endpoints) owns the `/healthz` 200/503 rules and body. [Architecture › Observability](../specs/architecture/index.md#observability) owns the liveness rule and its rationale. Their scenarios are this change's acceptance criteria and are not restated here.

What implementing them requires of this change:

- `VaultStatus` gains `consecutiveFailures`. Every producer and consumer MUST be updated in the same PR: `VaultChild.snapshot()`, the Zod `VaultSyncStatus` in `src/schemas/vaults.ts`, the `src/obsidian/index.ts` header, the test fixtures `makeVaultStatus` and the MCP/parity fixture, and the parity test asserting the field reaches `/readyz`, `GET /v1/vaults`, `GET /v1/vaults/:slug`, and MCP `vault_status` identically. `src/vault/status.ts` and both adapters pass the object through untouched.
- The three env vars MUST be validated in `src/config/index.ts` in the existing style — a pure function over `Record<string, string | undefined>` throwing `ConfigError` (exit 78) — and MUST reach the supervisor and the HTTP adapter as a resolved `Config.syncHealth` field, never by reading `process.env` inside `src/obsidian/`.
- `/healthz` MUST be a pure function of `supervisor.list()` — the same synchronous in-memory read `/readyz` uses — through one exported helper, `unhealthyVaults(statuses, threshold)`.
- No route may consult sync health before handling a request.

### Operator-facing documentation

- `README.md`'s configuration table MUST gain the three env vars; the Health & readiness section MUST describe when `/healthz` fails and its 503 body; the "keep liveness on `/healthz`" callout MUST explain that `/healthz` now fails on persistent sync failure (about 15 minutes of continuous wedge at the defaults) and how to restore the old behaviour; "Recognizing a stalled vault" MUST drop the default-ceiling text and document `consecutiveFailures`.
- `.env.example` MUST gain a commented block for the three vars.

## Design

### Approach

**Ceilings.** `DEFAULT_CRASH_LOOP.maxCrashes` and `DEFAULT_STALL_LOOP.maxStalls` become `0`, meaning no ceiling, and both checks are guarded by `> 0`. The supervisor fills them per child from `Config.syncHealth` (`OB_SYNC_MAX_CRASHES`, `OB_SYNC_MAX_STALL_KILLS`). Windows are unchanged and fixed. Stall kills are still recorded in both windows whether or not a ceiling is configured.

**Failed and recovered attempts.** Every supervised attempt that ends without a stop request is a failed attempt. An attempt *recovered* when it showed life for `healthyResetMs` (5 minutes) after it spawned:

```ts
export function attemptRecovered(startedAt: number, evidenceAt: number, healthyResetMs: number): boolean {
  return evidenceAt - startedAt >= healthyResetMs;
}
```

`evidenceAt` is the watchdog's own `lastActivityObservedAt` for that attempt — the resolution anchor or the latest observed mtime/inode change — exposed through a new `WatchdogHandle.lastActivityObservedAt()` that is `null` until the child's log resolves. Only when the watchdog has no evidence for the attempt does plain uptime stand in (the attempt's end, or `now()` while it is alive).

When an attempt ends, the run loop resets `consecutiveFailures` and the crash window if that attempt recovered, then adds 1 for it. The backoff index is `consecutiveFailures - 1`, which is today's sequence exactly. While an attempt is in flight and has already recovered, `snapshot()` reports `0` without touching the stored count, so a vault that came back releases `/healthz` immediately instead of at its next exit.

**`/healthz`.**

```ts
const unhealthy = unhealthyVaults(deps.supervisor?.list() ?? [], threshold);
return unhealthy.length === 0 ? c.json({ ok: true }) : c.json({ ok: false, unhealthy }, 503);
```

`unhealthyVaults` lists, in configuration order, every vault in `failed` (reason `failed`, which wins) and every vault with `consecutiveFailures >= threshold` (reason `failed_attempts`); `threshold === 0` returns `[]`. The threshold is `Config.syncHealth.healthzFailureThreshold`, or the default of 3 when no config is wired.

**Worked timelines** (300 s stall threshold, 30 s poll, backoff 1 / 2 / 4 s, threshold 3):

- *Wedge loop from a fresh attempt:* kills at about 5:00, 10:01 and 15:03 give a count of 1, 2, 3. `/healthz` returns 503 at about 15 minutes.
- *Healthy, then wedged (the incident):* the 07:10–07:24 attempt showed activity for 14 minutes after spawn, so its kill counts as a recovery followed by one failure — not failure number two. `/healthz` returns 503 about 15 minutes after the wedge begins, and the pod restarts.
- *A vault that comes back:* once its running attempt has shown activity 5 minutes after spawn, `consecutiveFailures` reads 0 and `/healthz` returns 200 again.

### Decisions

- **Decision:** Both ceilings are opt-in and default to unlimited.
  - **Why:** In the incident the outage was over within minutes and the ceiling kept sync dead for good. A sync outage is almost always upstream; a terminal state turns a transient into an outage that outlives it. The existing capped backoff already bounds the cost of retrying forever to one spawn a minute per vault.
  - **Alternatives considered:** **Keep 0015's terminal `failed`** — it needs a pod restart that nothing triggers. **Higher default ceilings** — the same failure, later.

- **Decision:** Sync health is part of `/healthz`, reversing 0015's explicitly rejected alternative.
  - **Why:** 0015's premise was that in-process supervision is the right blast radius. That premise failed once a ceiling made failure terminal and nothing outside the process could see it. With unlimited retries, in-process recovery handles transients, and liveness becomes the backstop only after a run of consecutive failed attempts. The pod restart does take the API and the healthy vault with it; the user accepted that, and the threshold limits it to persistent failure. The API keeps serving until the restart.
  - **Alternatives considered:** **Keep `/healthz` dumb and alert on `/readyz`** — no automated recovery, which is what failed here. **Point liveness at `/readyz`** — fails on every startup scan and every transient reconnect.

- **Decision:** The trigger is a count of consecutive failed attempts, not time since last activity.
  - **Why:** It matches the user's framing ("tried reconnecting X number of times"), it reuses the counter that already drives the backoff, and it does not make liveness depend on mtime semantics. An idle vault that is genuinely in sync is not a failure.
  - **Alternatives considered:** **`lastSyncActivityAt` age** — couples liveness to log-write cadence. **A rolling-window count** — a second window to tune, and a slow trickle of failures interleaved with recoveries is not "sync is down".

- **Decision:** Recovery is judged by watchdog-observed activity at least `healthyResetMs` after spawn, falling back to uptime only without watchdog evidence.
  - **Why:** It keeps 0015's real guarantee — a child wedged from spawn has its anchor as its only activity, so it never counts as recovered however long it stayed alive — while fixing the case 0015 got wrong: a child that synced for 14 minutes and then wedged did recover. It needs no new signal and no log parsing. A pure-uptime rule would make `/healthz` flicker to 200 at minute 5 of every wedge-loop attempt, just before the kill.
  - **Alternatives considered:** **Uptime only** — the flicker above, and 0015's healthy-uptime exemption would still be needed. **Never reset on a stall kill** — counts the incident's healthy attempt as a failure.

- **Decision:** A `failed` vault always fails `/healthz` (when the threshold is above 0), including a permanent `sync-setup` / `sync-config` failure or a directory that cannot be created.
  - **Why:** `failed` is terminal for that vault until the process restarts, which is exactly the case a pod restart can fix — and a dead vault must not be invisible again. The `sync-setup` / `sync-config` 5-attempt retry limits are left as they are; a vault they mark `failed` is restarted by liveness.
  - **Alternatives considered:** **Exclude setup failures** — leaves a dead vault invisible to the orchestrator, the gap this change closes.

- **Decision:** The counter is a public `VaultStatus.consecutiveFailures` field.
  - **Why:** `/healthz` stays a pure function of `supervisor.list()`, the same input `/readyz` reads, so there is one source of truth and no second supervisor API. Operators can see how close a vault is to tripping liveness on `/readyz`, `GET /v1/vaults(/:slug)`, and MCP. Silent counters are how 0015's gap survived. The change is additive.
  - **Alternatives considered:** **An internal counter behind a `Supervisor.health()` verdict** — a second API, and the number that decides a pod restart would be invisible.

- **Decision:** Env names `OB_SYNC_MAX_CRASHES`, `OB_SYNC_MAX_STALL_KILLS`, and `OB_HEALTHZ_SYNC_FAILURE_THRESHOLD`.
  - **Why:** The first two match the internal `maxCrashes` / `maxStalls` fields, the `watchdog.stallKills` status field, and the codebase's meaning of `max` (reaching it trips the ceiling). The liveness knob configures the HTTP probe rather than sync behaviour, so it gets its own `OB_HEALTHZ_` prefix; `THRESHOLD` because "max 3" would read as "3 allowed", while 3 is the value at which `/healthz` trips. Each must match `^\d+$` and be at most 10000, for the same reason the watchdog durations are bounded: a 400-digit value parses to `Infinity`.
  - **Alternatives considered:** `OB_SYNC_HEALTHZ_*` — misfiles a probe knob in the sync-behaviour family.

- **Decision:** The 200 body stays exactly `{"ok":true}`; the 503 body enumerates the offenders.
  - **Why:** Existing probes, the Docker `HEALTHCHECK`, and any client asserting the 200 body keep working. An operator reading a 503 sees which vault and why without a second request.

### Non-Goals

- **The stale lock.** `Another sync instance is already running` after a SIGKILL is not fixed here; with unlimited retries it is now retried through. See Open Questions.
- **Diagnosing the outage** — whether it was Obsidian or the network.
- **Kubernetes manifests.** They live in another repository; probe tuning is operator guidance only.
- **Parsing `sync.log` contents** or using the `Fully synced` heartbeat as a progress signal (0015's standing non-goal).
- **A `/metrics` endpoint, a new `VaultState`, or per-vault overrides.**
- **Any change to `/readyz`.** It still returns 503 during any non-running state.
- **Env-configurable windows.** The 5-minute crash window, the 60-minute stall window, and `healthyResetMs` stay fixed.
- **The `sync-setup` / `sync-config` 5-attempt retry limits.** Unchanged; a vault they mark `failed` now fails `/healthz`.

## Tasks

- [x] `src/config/index.ts`: `SyncHealthConfig`, `DEFAULT_SYNC_HEALTH`, and `loadSyncHealthConfig(env)` for `OB_SYNC_MAX_CRASHES`, `OB_SYNC_MAX_STALL_KILLS`, and `OB_HEALTHZ_SYNC_FAILURE_THRESHOLD` (`^\d+$`, at most 10000, `ConfigError` exit 78), plumbed as `Config.syncHealth`; accept/reject matrix in `test/config/syncHealth.test.ts`; `syncHealth` added to every hand-built test `Config`, with a finite crash ceiling in `TEST_SYNC_HEALTH`
- [x] `src/obsidian/watchdog.ts`: `WatchdogHandle.lastActivityObservedAt()`, `null` until this child's log resolves; fake-fs and real-tmpdir tests
- [x] `src/obsidian/child.ts`: ceilings default to 0 (none) and are guarded by `> 0`; `attemptRecovered`; `consecutiveFailures` on `VaultStatus`, reset by a recovered attempt and incremented per failed attempt, driving the backoff; live 0 in `snapshot()` once the attempt in flight has recovered; stale comments rewritten
- [x] `src/obsidian/index.ts`: ceilings filled from `Config.syncHealth` per child; `unhealthyVaults` and its types
- [x] `src/http/index.ts`: sync-aware `/healthz`, threshold from `Config.syncHealth` or the default; no route gated on sync health
- [x] `src/schemas/vaults.ts`: `consecutiveFailures` on `VaultSyncStatus`; schema, parity, and MCP fixture tests extended
- [x] Tests: unlimited crash loop with capped backoff; counter counting, uptime reset, and live reset with the watchdog off; spawn throw counts; wedge loop retries forever; healthy-then-wedged recovery (the incident); activity under the bar does not reset; live reset at the threshold; shutdown-window evidence; supervisor plumbing of both ceilings; `unhealthyVaults` units; `/healthz` 200/503 through the app, threshold from config, threshold 0; end-to-end three stall kills to 503 and back; REST and MCP reads and writes while `/healthz` is 503; every test that relied on the default crash ceiling given an explicit one
- [x] Specs: Obsidian Sync (supervision, stall watchdog, new Restart ceilings and liveness section, `VaultStatus`, error taxonomy), REST API Health endpoints, Architecture Observability and config table, each with a Changelog row
- [x] `README.md` and `.env.example`
- [x] This change document, `docs/index.yml`, and `docs/index.md`

## Risks / Open Questions

- **Risk: a fast crash streak trips liveness within seconds.** Three attempts that exit immediately — for example the stale-lock `Another sync instance is already running` exit right after a kill — reach the default threshold of 3 within the first few backoff steps, and `/healthz` then stays at 503 until a later attempt shows 5 minutes of activity. The pod restart follows. Operators who see this can raise `OB_HEALTHZ_SYNC_FAILURE_THRESHOLD`, lengthen the probe's `failureThreshold`, or set the threshold to `0`.
- **Risk: one vault restarts the pod.** A persistently down vault restarts the API and every healthy vault with it. Accepted by the user; the threshold confines it to persistent failure, and the API keeps serving until then.
- **Risk: a permanent setup failure becomes a pod restart loop.** Bad credentials or a missing remote vault mark the vault `failed`, which now fails `/healthz` on every pod start. That makes the failure loud rather than silent, which is the intent, but it is a restart loop until an operator fixes the configuration.
- **Residual risk (unchanged from 0015): a chatty reconnect loop.** Recovery is judged by sync-log activity, which proves the child is writing, not that it is syncing. A child looping `Disconnected` → `Connecting...` keeps writing, so it counts as recovered and is never stall-killed. This change introduces no new blind spot there.
- **Risk: Docker `HEALTHCHECK`.** The image's health check now marks the container unhealthy during a persistent sync outage. Plain Docker reports that but does not restart on it.
- **Operator guidance: probe tuning.** At the defaults `/healthz` fails about 15 minutes into a continuous wedge. The threshold already debounces transients, so the probe's own `failureThreshold` × `periodSeconds` only adds delay on top of that; a few minutes is plenty.
- **Open question: the stale lock after SIGKILL.** A restart after a SIGKILL hit `Another sync instance is already running`, which suggests `obsidian-headless` leaves a lock behind when killed. Not fixed here; unlimited retries now retry through it. Worth investigating whether the lock lives under the persistent config volume — if it does, a pod restart may not clear it either, and the liveness backstop would loop. Tracked in [docs/tasks.md](../tasks.md).

## References

- Spec: [Obsidian Sync › Sync supervision](../specs/obsidian-sync/index.md#sync-supervision), [› Sync stall watchdog](../specs/obsidian-sync/index.md#sync-stall-watchdog), [› Restart ceilings and liveness](../specs/obsidian-sync/index.md#restart-ceilings-and-liveness), [› Public surface](../specs/obsidian-sync/index.md#public-surface-to-the-rest-of-the-app)
- Spec: [REST API › Health endpoints](../specs/rest-api/index.md#health-endpoints) — the `/healthz` contract
- Spec: [Architecture › Observability](../specs/architecture/index.md#observability) — the liveness rule and the reversal's rationale
- Related changes: [0015 — Sync stall watchdog](./0015-sync-stall-watchdog.md) (introduced the stall ceiling and the "no sync health on `/healthz`" decision this change reverses), [0002 — Obsidian supervisor](./0002-obsidian-supervisor.md) (introduced the crash-loop ceiling)
- Code: `src/obsidian/child.ts` (`runLoop`, `attemptRecovered`, `DEFAULT_CRASH_LOOP`, `DEFAULT_STALL_LOOP`), `src/obsidian/watchdog.ts` (`lastActivityObservedAt`), `src/obsidian/index.ts` (`startSupervisor`, `unhealthyVaults`), `src/http/index.ts` (`/healthz`), `src/config/index.ts` (`loadSyncHealthConfig`)

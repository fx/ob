/**
 * Per-vault child loop.
 *
 * Owns exactly one running `ob sync --continuous --path <dir>` child per
 * vault, restarts it with capped exponential backoff after non-zero exits,
 * and tags every stdio line with `{vault, source: "ob"}` for the parent
 * logger.
 *
 * Restarts continue indefinitely by default. The optional crash-loop and
 * stall-loop ceilings (off unless `OB_SYNC_MAX_CRASHES` /
 * `OB_SYNC_MAX_STALL_KILLS` is set) flip the vault to `failed` and stop
 * further restart attempts for that vault only — isolation between vaults is
 * the whole point of one child per vault.
 *
 * Every attempt that ends without a stop request is a failed attempt, and
 * `consecutiveFailures` counts them until one recovers. It drives the restart
 * backoff and, through `/healthz`, liveness — so a vault that in-process
 * retries cannot bring back eventually gets the pod restarted.
 *
 * A hung-but-alive child never settles `exited`, so the crash machinery above
 * is blind to it. The sync-log watchdog supplies that missing signal: on a
 * stall verdict this module takes the vault out of `running`, SIGTERMs the
 * child, SIGKILLs it if the grace period elapses, and lets the ordinary
 * restart path take over. A stall kill is credited to BOTH the crash window
 * and a separate rolling stall window, because a stall can only happen once
 * per threshold and ten of them can never land inside the crash window's five
 * minutes — a crash ceiling alone could never fire on stalls.
 *
 * `now()` and the sleep primitive are injected so crash-loop tests can
 * collapse a 5-minute window down to a deterministic sequence of fake
 * timestamps.
 */

import type { SyncWatchdogConfig } from "../config/index.ts";
import type { Logger } from "../log.ts";
import type { SpawnHandle, Spawner } from "./spawn.ts";
import {
  DISABLED_SYNC_WATCHDOG,
  EMPTY_WATCHDOG_MEMORY,
  type WatchdogFs,
  type WatchdogHandle,
  type WatchdogMemory,
  type WatchdogStatus,
  startWatchdog,
  watchdogIsDisabled,
  watchdogSnapshot,
} from "./watchdog.ts";

export type VaultState = "starting" | "running" | "failed";

export interface VaultStatus {
  readonly slug: string;
  readonly name: string;
  readonly state: VaultState;
  readonly pid: number | null;
  readonly restarts: number;
  /**
   * Supervised attempts that ended — any exit, a spawn throw, or a stall
   * kill — since the last attempt that recovered. An attempt recovered once
   * the watchdog observed sync-log activity at least `healthyResetMs` after
   * it spawned (plain uptime when the watchdog has no evidence for it).
   *
   * Reads 0 while the attempt in flight has recovered, even before the stored
   * count resets at its exit; a vault that came back must not hold `/healthz`
   * at 503 until it next fails. Retained in `failed`. `/healthz` fails once
   * any vault reaches `OB_HEALTHZ_SYNC_FAILURE_THRESHOLD`.
   */
  readonly consecutiveFailures: number;
  readonly lastError: string | null;
  /**
   * Epoch-ms mtime of the resolved sync log as of the most recent successful
   * poll — the upstream's own timestamp, not the instant we observed it, so
   * during a wedge it stays pinned at the moment the child stopped writing.
   *
   * This is last observed *log activity*, not last successful sync: a child
   * churning through reconnects keeps it fresh while syncing nothing.
   */
  readonly lastSyncActivityAt: number | null;
  readonly watchdog: WatchdogStatus;
}

export interface ChildVault {
  readonly name: string;
  readonly slug: string;
  readonly path: string;
  readonly e2eePassword?: string;
}

export interface ChildBackoff {
  readonly initialMs: number;
  readonly factor: number;
  readonly capMs: number;
}

export const DEFAULT_CHILD_BACKOFF: ChildBackoff = {
  initialMs: 1_000,
  factor: 2,
  capMs: 60_000,
};

/**
 * Crash-loop config. `maxCrashes === 0` means no ceiling, which is the
 * default; the supervisor fills it from `OB_SYNC_MAX_CRASHES`.
 */
export interface CrashLoop {
  readonly windowMs: number;
  readonly maxCrashes: number;
  /**
   * An attempt that shows life for this long after it spawned has recovered:
   * it resets the crash window and `consecutiveFailures`. See
   * `attemptRecovered`.
   */
  readonly healthyResetMs: number;
}

export const DEFAULT_CRASH_LOOP: CrashLoop = {
  windowMs: 5 * 60_000,
  maxCrashes: 0,
  healthyResetMs: 5 * 60_000,
};

/**
 * Stall-loop config. Separate from `CrashLoop` on purpose: a stall kill can
 * only occur once per stall threshold, so with the 300-second default ten of
 * them cannot land inside `DEFAULT_CRASH_LOOP.windowMs`. Counting stalls
 * toward `crashTimes` alone therefore never escalates — wedge, kill, wedge,
 * kill, forever. `maxStalls === 0` means no ceiling, which is the default; the
 * supervisor fills it from `OB_SYNC_MAX_STALL_KILLS`. The 60-min window is
 * fixed.
 */
export interface StallLoop {
  readonly windowMs: number;
  readonly maxStalls: number;
}

export const DEFAULT_STALL_LOOP: StallLoop = {
  windowMs: 60 * 60_000,
  maxStalls: 0,
};

/** Grace between the stall SIGTERM and the SIGKILL that follows it. */
export const DEFAULT_STALL_KILL_GRACE_MS = 10_000;

/**
 * Race arms for the stall-kill grace period, as named module-level functions
 * so each stays one independently coverable callable.
 */
const raceChildExited = (): true => true;
const raceGraceElapsed = (): false => false;

/**
 * Everything the sync-log watchdog needs, minus the clock and the logger,
 * which the child already owns. Omitting this block entirely means no
 * watchdog is wired at all, which the status surface reports as `disabled`.
 */
export interface ChildWatchdogDeps {
  readonly config: SyncWatchdogConfig;
  readonly fs: WatchdogFs;
  /** `<xdgConfigBase>/obsidian-headless/sync`. */
  readonly syncDir: string;
  readonly maxTailBytes?: number;
}

export interface ChildDeps {
  readonly spawner: Spawner;
  readonly logger: Logger;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly backoff?: ChildBackoff;
  readonly crashLoop?: CrashLoop;
  readonly stallLoop?: StallLoop;
  /** Grace between the stall SIGTERM and the SIGKILL. Default 10 s. */
  readonly stallKillGraceMs?: number;
  readonly obBin?: string;
  readonly watchdog?: ChildWatchdogDeps;
}

interface MutableStatus {
  state: VaultState;
  pid: number | null;
  restarts: number;
  consecutiveFailures: number;
  lastError: string | null;
}

/**
 * Compute the i-th restart backoff delay (0 = first restart).
 * Matches `setup.backoffDelay` but lives separately so each module can
 * evolve its policy independently.
 */
export function childBackoffDelay(b: ChildBackoff, attemptIndex: number): number {
  const raw = b.initialMs * b.factor ** attemptIndex;
  return Math.min(raw, b.capMs);
}

/**
 * True once an attempt spawned at `startedAt` has shown life for
 * `healthyResetMs`. `evidenceAt` is the last instant the watchdog observed
 * sync-log activity for the attempt, or — when it has no evidence for it —
 * the attempt's end (or now, while it is still alive).
 */
export function attemptRecovered(
  startedAt: number,
  evidenceAt: number,
  healthyResetMs: number,
): boolean {
  return evidenceAt - startedAt >= healthyResetMs;
}

/**
 * Drop leading entries that have aged out of a rolling window. Shared by the
 * crash window and the stall window so the two can never drift apart in how
 * they age.
 */
function trimWindow(times: number[], windowStart: number): void {
  while (times.length > 0) {
    const head = times[0];
    if (head !== undefined && head < windowStart) {
      times.shift();
    } else {
      break;
    }
  }
}

/**
 * Forward a child stream to the parent logger, line by line. Both the
 * partial-line buffer and the trailing-flush path are exercised by tests.
 */
async function forwardLines(
  stream: ReadableStream<Uint8Array>,
  source: "stdout" | "stderr",
  vault: string,
  log: Logger,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const emit = (line: string): void => {
    if (line === "") return;
    if (source === "stderr") {
      log.warn("ob output", { vault, source: "ob", stream: source, line });
    } else {
      log.info("ob output", { vault, source: "ob", stream: source, line });
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const parts = buf.split("\n");
      // Last part may be partial; keep it in the buffer.
      buf = parts.pop() ?? "";
      for (const p of parts) emit(p);
    }
    buf += decoder.decode();
    if (buf.length > 0) emit(buf);
  } finally {
    reader.releaseLock();
  }
}

/**
 * One per vault. Holds the running child handle, restart loop, and
 * crash-window state. Callers interact with it through the `Supervisor`
 * facade in `index.ts`.
 */
export class VaultChild {
  readonly vault: ChildVault;
  private readonly deps: ChildDeps;
  private readonly status: MutableStatus;
  private readonly crashTimes: number[] = [];
  /**
   * Rolling window of stall-kill instants. Cleared only by kills ageing out
   * of it — never by a recovered attempt and never by an ordinary crash in
   * between, because a vault that alternates between crashing and wedging is
   * not healthier than one that only wedges. Recorded whether or not a stall
   * ceiling is configured.
   */
  private readonly stallTimes: number[] = [];
  /**
   * The verdict recorded for the attempt currently in flight, or `null`.
   * This — never the exit code — is what classifies the attempt: a child with
   * a SIGTERM handler exits 0, and reading that as a clean exit would skip
   * stall accounting entirely and let a wedging vault restart forever without
   * approaching a ceiling. Cleared at the top of every attempt and again once
   * consumed, so a later ordinary crash cannot inherit it.
   */
  private stallReason: string | null = null;
  private currentHandle: SpawnHandle | null = null;
  private childExitedAt = 0;
  private childStartedAt = 0;
  private stopRequested = false;
  private loopPromise: Promise<void> | null = null;
  /**
   * Resolves the moment `requestStop()` is called. Used to wake the run
   * loop out of its restart-backoff `sleep` so `Supervisor.stop()` does
   * not hang for up to 60 s waiting for an unrelated backoff timer.
   */
  private readonly stopSignal: Promise<void>;
  private resolveStopSignal!: () => void;
  /**
   * Watchdog wiring, or `null` when no watchdog runs — either because none
   * was injected or because configuration disables it entirely.
   */
  private readonly watchdogDeps: ChildWatchdogDeps | null;
  private readonly watchdogConfig: SyncWatchdogConfig;
  private watchdogHandle: WatchdogHandle | null = null;
  /**
   * Survives each child, so a vault killed for stalling still reports the
   * mtime that proves it stalled while its replacement is starting up.
   */
  private watchdogMemory: WatchdogMemory = EMPTY_WATCHDOG_MEMORY;
  /**
   * The ended attempt's `lastActivityObservedAt`, captured as its watchdog
   * stops; `null` when no log was ever resolved for it (or no watchdog runs).
   * Reset at the top of every attempt.
   */
  private attemptActivityAt: number | null = null;

  constructor(vault: ChildVault, deps: ChildDeps) {
    this.vault = vault;
    this.deps = deps;
    this.status = {
      state: "starting",
      pid: null,
      restarts: 0,
      consecutiveFailures: 0,
      lastError: null,
    };
    this.watchdogConfig = deps.watchdog?.config ?? DISABLED_SYNC_WATCHDOG;
    this.watchdogDeps = watchdogIsDisabled(this.watchdogConfig) ? null : (deps.watchdog ?? null);
    this.stopSignal = new Promise<void>((resolve) => {
      this.resolveStopSignal = resolve;
    });
  }

  snapshot(): VaultStatus {
    const handle = this.watchdogHandle;
    const wd =
      handle === null
        ? watchdogSnapshot(this.watchdogConfig, this.watchdogMemory, false)
        : handle.snapshot();
    return {
      slug: this.vault.slug,
      name: this.vault.name,
      state: this.status.state,
      pid: this.status.pid,
      restarts: this.status.restarts,
      consecutiveFailures: this.liveConsecutiveFailures(),
      lastError: this.status.lastError,
      lastSyncActivityAt: wd.lastSyncActivityAt,
      watchdog: wd.watchdog,
    };
  }

  /**
   * The stored count, or 0 while the attempt in flight has already
   * recovered. The stored value itself only resets when that attempt ends.
   * `now()` is consulted only when there is no watchdog evidence to judge by.
   */
  private liveConsecutiveFailures(): number {
    const stored = this.status.consecutiveFailures;
    if (this.currentHandle === null || stored === 0) return stored;
    const healthyResetMs = (this.deps.crashLoop ?? DEFAULT_CRASH_LOOP).healthyResetMs;
    // `attemptActivityAt` covers the shutdown window, where `requestStop()`
    // has already stopped the watchdog but the child has not exited yet.
    const evidenceAt =
      this.watchdogHandle?.lastActivityObservedAt() ?? this.attemptActivityAt ?? this.deps.now();
    return attemptRecovered(this.childStartedAt, evidenceAt, healthyResetMs) ? 0 : stored;
  }

  /** Start the per-child watchdog. No-op when none is wired. */
  private beginWatchdog(handle: SpawnHandle): void {
    const wd = this.watchdogDeps;
    if (wd === null) return;
    this.watchdogHandle = startWatchdog(
      { slug: this.vault.slug, path: this.vault.path },
      {
        now: this.deps.now,
        sleep: this.deps.sleep,
        fs: wd.fs,
        logger: this.deps.logger,
        syncDir: wd.syncDir,
        config: wd.config,
        memory: this.watchdogMemory,
        ...(wd.maxTailBytes !== undefined ? { maxTailBytes: wd.maxTailBytes } : {}),
      },
      (reason) => this.onStallVerdict(handle, reason),
    );
  }

  /**
   * Act on a stall verdict for the child currently in flight.
   *
   * The vault leaves `running` and gains its `lastError` HERE, before the
   * signal — not when the child finally exits. A child that ignores SIGTERM
   * stays alive for the whole grace period, and a vault the supervisor has
   * already declared unhealthy must not hold `/readyz` at 200 for that
   * window. `starting` is the state any other loss of a child produces; the
   * move to `failed` happens only if a ceiling is configured and reached.
   */
  private onStallVerdict(handle: SpawnHandle, reason: string): void {
    this.stallReason = reason;
    this.status.state = "starting";
    this.status.lastError = reason;
    handle.kill("SIGTERM");
    this.escalateStallKill(handle);
  }

  /**
   * SIGKILL a stalled child that did not honour the SIGTERM within the grace
   * period. Fire-and-forget: the run loop is already parked on
   * `handle.exited`, and a child that exits in time makes this a no-op.
   */
  private escalateStallKill(handle: SpawnHandle): void {
    const graceMs = this.deps.stallKillGraceMs ?? DEFAULT_STALL_KILL_GRACE_MS;
    void (async () => {
      // Both arms use one handler for fulfilment and rejection. A rejected
      // `exited` is still an ended attempt; a rejected `sleep` means we
      // cannot honour the grace at all, and a child already declared stalled
      // and signalled must still be killed rather than left to wedge. Either
      // way nothing escapes this fire-and-forget task as an unhandled
      // rejection and takes the process down with it.
      const exitedInTime = await Promise.race([
        handle.exited.then(raceChildExited, raceChildExited),
        this.deps.sleep(graceMs).then(raceGraceElapsed, raceGraceElapsed),
      ]);
      if (exitedInTime) return;
      this.deps.logger.warn("stalled child ignored SIGTERM; sending SIGKILL", {
        vault: this.vault.slug,
        graceMs,
      });
      handle.kill("SIGKILL");
    })();
  }

  /**
   * Stop the per-child watchdog, retaining its memory. Idempotent, because
   * `requestStop()` and the run loop's `finally` both call it.
   */
  private endWatchdog(): void {
    const handle = this.watchdogHandle;
    if (handle === null) return;
    // Stop BEFORE reading the memory: `stop()` is what makes an in-flight
    // poll bail at its next resume point, so doing it first means the value
    // we keep cannot be overwritten by a poll belonging to a dead child.
    handle.stop();
    this.watchdogMemory = handle.memory();
    this.attemptActivityAt = handle.lastActivityObservedAt();
    this.watchdogHandle = null;
  }

  /**
   * Mark the vault `failed` without ever spawning a child. Used by the
   * supervisor when `ensureVaultSetup` raises `SetupPermanentError`.
   */
  markFailed(reason: string): void {
    this.status.state = "failed";
    this.status.lastError = reason;
    this.status.pid = null;
  }

  /** Begin the spawn-monitor-restart loop. Resolves when `stop()` settles. */
  start(): Promise<void> {
    if (this.loopPromise !== null) return this.loopPromise;
    this.loopPromise = this.runLoop();
    return this.loopPromise;
  }

  private async runLoop(): Promise<void> {
    const backoff = this.deps.backoff ?? DEFAULT_CHILD_BACKOFF;
    const crashCfg = this.deps.crashLoop ?? DEFAULT_CRASH_LOOP;
    const stallCfg = this.deps.stallLoop ?? DEFAULT_STALL_LOOP;
    const obBin = this.deps.obBin ?? "ob";

    while (!this.stopRequested) {
      // `attemptCode` is the exit code we should treat the attempt as having
      // produced. A spawner that throws synchronously, or an `exited`
      // promise that rejects, must NOT bubble out of `runLoop` — it's
      // observationally identical to a child that crashed with non-zero,
      // and we treat it that way to keep the supervisor running.
      let attemptCode: number;
      this.childStartedAt = this.deps.now();
      // A verdict must never outlive the attempt that produced it, and
      // neither may the activity evidence of the previous attempt.
      this.stallReason = null;
      this.attemptActivityAt = null;
      try {
        const handle = this.deps.spawner.run(obBin, [
          "sync",
          "--continuous",
          "--path",
          this.vault.path,
        ]);
        this.currentHandle = handle;
        this.status.state = "running";
        this.status.pid = handle.pid;

        this.deps.logger.info("ob sync started", {
          vault: this.vault.slug,
          pid: handle.pid,
        });

        // Stream forwarding runs concurrently with `exited`.
        const stdoutP = forwardLines(handle.stdout, "stdout", this.vault.slug, this.deps.logger);
        const stderrP = forwardLines(handle.stderr, "stderr", this.vault.slug, this.deps.logger);

        // The watchdog polls only while a child is running — never during
        // restart backoff, `sync-setup`, or `sync-config`.
        this.beginWatchdog(handle);
        try {
          attemptCode = await handle.exited;
          // Wait for log streams to finish flushing before deciding what to do.
          await Promise.allSettled([stdoutP, stderrP]);
        } finally {
          // Every path out of the attempt passes through here, so no poll
          // leaks into the backoff and no timer outlives the child.
          this.endWatchdog();
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.deps.logger.error("ob sync attempt threw", { vault: this.vault.slug, error: msg });
        // Synthesize an exit code so the rest of the loop body treats this
        // exactly like an honest non-zero exit. 127 mirrors the
        // `spawnFailedHandle` synthetic — keep the wire-format consistent.
        attemptCode = 127;
        this.status.lastError = `spawn/exited threw: ${msg}`;
      }
      this.currentHandle = null;
      this.childExitedAt = this.deps.now();
      this.status.pid = null;
      // Consume the verdict. Read it here and clear it in the same breath:
      // everything below classifies off `stallReason`, never off
      // `attemptCode`, and the next ordinary crash must not inherit it.
      const stallReason = this.stallReason;
      this.stallReason = null;

      // Per the spec, a vault that just exited is no longer ready. Flip
      // back to `starting`; the next successful spawn will return us to
      // `running`. A configured ceiling may overwrite this with `failed`
      // before the loop iterates again.
      if (this.status.state !== "failed") this.status.state = "starting";

      if (this.stopRequested) {
        this.deps.logger.info("ob sync exited during shutdown", {
          vault: this.vault.slug,
          code: attemptCode,
        });
        return;
      }

      // A recovered attempt resets the failure counter and crash-window
      // history. Recovery is judged by observed sync-log activity, never by
      // uptime, whenever the watchdog has evidence for the attempt: a child
      // wedged from spawn has none after its anchor, so however long it
      // stayed alive it never clears the counters on its way out and the
      // count keeps climbing. Only with no evidence at all does plain uptime
      // stand in for it.
      const evidenceAt = this.attemptActivityAt ?? this.childExitedAt;
      if (attemptRecovered(this.childStartedAt, evidenceAt, crashCfg.healthyResetMs)) {
        this.status.consecutiveFailures = 0;
        this.crashTimes.length = 0;
      }
      // Counted before the ceiling checks, so a vault that goes `failed`
      // reports a truthful count.
      this.status.consecutiveFailures += 1;

      this.status.restarts += 1;
      // Preserve a "spawn threw" error message if the catch already set one.
      if (stallReason !== null) {
        this.status.lastError = stallReason;
      } else if (
        this.status.lastError === null ||
        !this.status.lastError.startsWith("spawn/exited")
      ) {
        this.status.lastError = `ob sync exited with code ${attemptCode}`;
      }
      this.deps.logger.warn("ob sync exited", {
        vault: this.vault.slug,
        code: attemptCode,
        restarts: this.status.restarts,
        consecutiveFailures: this.status.consecutiveFailures,
        stalled: stallReason !== null,
      });

      // Track this crash for the rolling window. A stall kill counts here as
      // well as in its own window, so a vault mixing real crashes with stalls
      // still trips a configured crash ceiling.
      this.crashTimes.push(this.childExitedAt);
      trimWindow(this.crashTimes, this.childExitedAt - crashCfg.windowMs);

      if (stallReason !== null) {
        this.stallTimes.push(this.childExitedAt);
        trimWindow(this.stallTimes, this.childExitedAt - stallCfg.windowMs);
      }

      if (crashCfg.maxCrashes > 0 && this.crashTimes.length >= crashCfg.maxCrashes) {
        this.status.state = "failed";
        this.status.lastError = `crash-loop: ${this.crashTimes.length} crashes within ${crashCfg.windowMs}ms`;
        this.deps.logger.error("ob sync crash-loop ceiling reached", {
          vault: this.vault.slug,
          crashes: this.crashTimes.length,
          windowMs: crashCfg.windowMs,
        });
        return;
      }

      if (stallCfg.maxStalls > 0 && this.stallTimes.length >= stallCfg.maxStalls) {
        this.status.state = "failed";
        this.status.lastError = `sync stall-loop: ${this.stallTimes.length} stall kills within ${stallCfg.windowMs}ms`;
        this.deps.logger.error("ob sync stall-loop ceiling reached", {
          vault: this.vault.slug,
          stallKills: this.stallTimes.length,
          windowMs: stallCfg.windowMs,
        });
        return;
      }

      const delay = childBackoffDelay(backoff, this.status.consecutiveFailures - 1);
      this.deps.logger.info("ob sync restarting", {
        vault: this.vault.slug,
        delayMs: delay,
      });
      // Race the backoff against the stop signal: a SIGTERM mid-backoff must
      // not strand `Supervisor.stop()` waiting for the timer to elapse.
      await Promise.race([this.deps.sleep(delay), this.stopSignal]);
    }
  }

  /**
   * Request graceful stop. Returns a promise that resolves once the
   * spawn loop exits. The caller decides how long to wait — see
   * `Supervisor.stop()` for the SIGTERM/SIGKILL escalation.
   */
  requestStop(signal: NodeJS.Signals = "SIGTERM"): void {
    this.stopRequested = true;
    // Wake any in-flight backoff sleep so the run loop notices `stopRequested`.
    this.resolveStopSignal();
    // Stop the watchdog here as well as in the run loop's `finally`: shutdown
    // must not wait out a poll interval, and a stall verdict must not land
    // between the SIGTERM and the loop noticing.
    this.endWatchdog();
    if (this.currentHandle !== null) {
      this.currentHandle.kill(signal);
    }
  }

  /** Force-kill the running child if any. Best-effort. */
  forceKill(): void {
    if (this.currentHandle !== null) {
      this.currentHandle.kill("SIGKILL");
    }
  }

  /** Resolves once the run loop has exited. */
  awaitExit(): Promise<void> {
    return this.loopPromise ?? Promise.resolve();
  }
}

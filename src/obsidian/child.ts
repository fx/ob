/**
 * Per-vault child loop.
 *
 * Owns exactly one running `ob sync --continuous --path <dir>` child per
 * vault, restarts it with capped exponential backoff after non-zero exits,
 * and tags every stdio line with `{vault, source: "ob"}` for the parent
 * logger.
 *
 * The crash-loop ceiling (≥ 10 crashes within 5 min) flips the vault to
 * `failed` and stops further restart attempts for that vault only —
 * isolation between vaults is the whole point of one child per vault.
 *
 * `now()` and the sleep primitive are injected so crash-loop tests can
 * collapse a 5-minute window down to a deterministic sequence of fake
 * timestamps.
 */

import type { Logger } from "../log.ts";
import type { SpawnHandle, Spawner } from "./spawn.ts";

export type VaultState = "starting" | "running" | "failed";

export interface VaultStatus {
  readonly slug: string;
  readonly name: string;
  readonly state: VaultState;
  readonly pid: number | null;
  readonly restarts: number;
  readonly lastError: string | null;
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

/** Crash-loop config. Defaults match the spec: ≥ 10 crashes in 5 min. */
export interface CrashLoop {
  readonly windowMs: number;
  readonly maxCrashes: number;
  /** A child that stays up this long resets the crash counter. */
  readonly healthyResetMs: number;
}

export const DEFAULT_CRASH_LOOP: CrashLoop = {
  windowMs: 5 * 60_000,
  maxCrashes: 10,
  healthyResetMs: 5 * 60_000,
};

export interface ChildDeps {
  readonly spawner: Spawner;
  readonly logger: Logger;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly backoff?: ChildBackoff;
  readonly crashLoop?: CrashLoop;
  readonly obBin?: string;
}

interface MutableStatus {
  state: VaultState;
  pid: number | null;
  restarts: number;
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

  constructor(vault: ChildVault, deps: ChildDeps) {
    this.vault = vault;
    this.deps = deps;
    this.status = {
      state: "starting",
      pid: null,
      restarts: 0,
      lastError: null,
    };
    this.stopSignal = new Promise<void>((resolve) => {
      this.resolveStopSignal = resolve;
    });
  }

  snapshot(): VaultStatus {
    return {
      slug: this.vault.slug,
      name: this.vault.name,
      state: this.status.state,
      pid: this.status.pid,
      restarts: this.status.restarts,
      lastError: this.status.lastError,
    };
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
    const obBin = this.deps.obBin ?? "ob";

    let consecutiveFailures = 0;

    while (!this.stopRequested) {
      // `attemptCode` is the exit code we should treat the attempt as having
      // produced. A spawner that throws synchronously, or an `exited`
      // promise that rejects, must NOT bubble out of `runLoop` — it's
      // observationally identical to a child that crashed with non-zero,
      // and we treat it that way to keep the supervisor running.
      let attemptCode: number;
      this.childStartedAt = this.deps.now();
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

        attemptCode = await handle.exited;
        // Wait for log streams to finish flushing before deciding what to do.
        await Promise.allSettled([stdoutP, stderrP]);
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

      // Per the spec, a vault that just exited is no longer ready. Flip
      // back to `starting`; the next successful spawn will return us to
      // `running`. The crash-loop branch may overwrite this with `failed`
      // before the loop iterates again.
      if (this.status.state !== "failed") this.status.state = "starting";

      if (this.stopRequested) {
        this.deps.logger.info("ob sync exited during shutdown", {
          vault: this.vault.slug,
          code: attemptCode,
        });
        return;
      }

      // Healthy uptime resets the failure counter and crash-window history.
      const uptimeMs = this.childExitedAt - this.childStartedAt;
      if (uptimeMs >= crashCfg.healthyResetMs) {
        consecutiveFailures = 0;
        this.crashTimes.length = 0;
      }

      this.status.restarts += 1;
      // Preserve a "spawn threw" error message if the catch already set one.
      if (this.status.lastError === null || !this.status.lastError.startsWith("spawn/exited")) {
        this.status.lastError = `ob sync exited with code ${attemptCode}`;
      }
      this.deps.logger.warn("ob sync exited", {
        vault: this.vault.slug,
        code: attemptCode,
        restarts: this.status.restarts,
      });

      // Track this crash for the rolling window.
      this.crashTimes.push(this.childExitedAt);
      const windowStart = this.childExitedAt - crashCfg.windowMs;
      while (this.crashTimes.length > 0) {
        const head = this.crashTimes[0];
        if (head !== undefined && head < windowStart) {
          this.crashTimes.shift();
        } else {
          break;
        }
      }

      if (this.crashTimes.length >= crashCfg.maxCrashes) {
        this.status.state = "failed";
        this.status.lastError = `crash-loop: ${this.crashTimes.length} crashes within ${crashCfg.windowMs}ms`;
        this.deps.logger.error("ob sync crash-loop ceiling reached", {
          vault: this.vault.slug,
          crashes: this.crashTimes.length,
          windowMs: crashCfg.windowMs,
        });
        return;
      }

      const delay = childBackoffDelay(backoff, consecutiveFailures);
      consecutiveFailures += 1;
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

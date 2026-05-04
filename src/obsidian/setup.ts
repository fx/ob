/**
 * `ob sync-setup` orchestration.
 *
 * Wraps the spawn → exit-code → retry loop in a single function the
 * supervisor can call once per vault. Backoff matches the spec: initial
 * 1s, factor 2, cap 60s, max 5 attempts.
 *
 * Both `now()` and the sleep primitive are injected so crash-loop / retry
 * tests run instantly without touching the wall clock.
 */

import type { Logger } from "../log.ts";
import type { Spawner } from "./spawn.ts";
import { checkSetupStatus } from "./status.ts";

/**
 * Transient setup failure: `ob sync-setup` returned non-zero but we have
 * retries left. The caller may translate this into a backoff sleep.
 */
export class SetupTransientError extends Error {
  readonly attempt: number;
  readonly exitCode: number;
  constructor(attempt: number, exitCode: number, vaultName: string) {
    super(`sync-setup for "${vaultName}" failed on attempt ${attempt} with exit ${exitCode}`);
    this.name = "SetupTransientError";
    this.attempt = attempt;
    this.exitCode = exitCode;
  }
}

/**
 * Permanent setup failure: backoff exhausted (≥ 5 attempts). The vault
 * transitions to `failed` state without being restarted.
 */
export class SetupPermanentError extends Error {
  readonly attempts: number;
  constructor(attempts: number, vaultName: string, lastExit: number) {
    super(
      `sync-setup for "${vaultName}" failed permanently after ${attempts} attempts (last exit ${lastExit})`,
    );
    this.name = "SetupPermanentError";
    this.attempts = attempts;
  }
}

export interface SetupVault {
  readonly name: string;
  readonly slug: string;
  readonly path: string;
  readonly e2eePassword?: string;
}

export interface SetupBackoff {
  readonly initialMs: number;
  readonly factor: number;
  readonly capMs: number;
  readonly maxAttempts: number;
}

export const DEFAULT_BACKOFF: SetupBackoff = {
  initialMs: 1_000,
  factor: 2,
  capMs: 60_000,
  maxAttempts: 5,
};

export interface SetupDeps {
  readonly spawner: Spawner;
  readonly logger: Logger;
  readonly sleep: (ms: number) => Promise<void>;
  readonly backoff?: SetupBackoff;
  readonly obBin?: string;
  /**
   * Cooperative cancellation predicate. Polled at every yield point so the
   * supervisor can short-circuit a long retry chain on shutdown.
   */
  readonly shouldStop?: () => boolean;
}

/** Compute the i-th backoff delay (zero-indexed: 0 = initial). */
export function backoffDelay(b: SetupBackoff, attemptIndex: number): number {
  const raw = b.initialMs * b.factor ** attemptIndex;
  return Math.min(raw, b.capMs);
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { done } = await reader.read();
      if (done) return;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * Run `ob sync-setup` once. Returns the child's exit code.
 */
async function runSetupOnce(spawner: Spawner, obBin: string, vault: SetupVault): Promise<number> {
  const args = ["sync-setup", "--vault", vault.name, "--path", vault.path];
  if (vault.e2eePassword !== undefined) {
    args.push("--password", vault.e2eePassword);
  }
  const handle = spawner.run(obBin, args);
  const [, , code] = await Promise.all([drain(handle.stdout), drain(handle.stderr), handle.exited]);
  return code;
}

/**
 * Probe `ob sync-status`. Treats both a non-zero exit AND a thrown
 * exception (e.g. spawner ENOENT before an exit code is even produced)
 * as "not configured" — the retry path will reattempt either way.
 *
 * Returns the exit-code-style integer that should be fed into the retry
 * loop's `lastExit` field.
 */
async function probeStatus(
  spawner: Spawner,
  obBin: string,
  vaultPath: string,
  log: Logger,
  vaultSlug: string,
): Promise<{ status: "configured" | "not-configured"; thrown: boolean; lastExit: number }> {
  try {
    const status = await checkSetupStatus(spawner, { path: vaultPath, obBin });
    return { status, thrown: false, lastExit: status === "configured" ? 0 : 1 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn("sync-status threw — treating as transient launch failure", {
      vault: vaultSlug,
      error: msg,
    });
    return { status: "not-configured", thrown: true, lastExit: -1 };
  }
}

/**
 * Ensure a vault is set up: probe `ob sync-status`, run `ob sync-setup`
 * if needed (with capped exponential backoff), throw `SetupPermanentError`
 * if `maxAttempts` runs all fail.
 *
 * Both `checkSetupStatus` and `runSetupOnce` can throw before producing an
 * exit code (e.g. the spawner failed to launch the binary). We treat those
 * as transient failures bound to the same retry/backoff ceiling — only the
 * `maxAttempts` ceiling raises `SetupPermanentError`. Pure throws are
 * never terminal on their own.
 */
export async function ensureVaultSetup(vault: SetupVault, deps: SetupDeps): Promise<void> {
  const obBin = deps.obBin ?? "ob";
  const backoff = deps.backoff ?? DEFAULT_BACKOFF;
  const shouldStop = deps.shouldStop ?? ((): boolean => false);

  const initial = await probeStatus(deps.spawner, obBin, vault.path, deps.logger, vault.slug);
  if (initial.status === "configured") {
    deps.logger.info("vault already configured", { vault: vault.slug });
    return;
  }

  let lastExit = initial.lastExit;
  for (let attempt = 1; attempt <= backoff.maxAttempts; attempt++) {
    if (shouldStop()) {
      deps.logger.info("sync-setup cancelled by stop signal", { vault: vault.slug, attempt });
      return;
    }
    deps.logger.info("running sync-setup", { vault: vault.slug, attempt });
    let code: number;
    try {
      code = await runSetupOnce(deps.spawner, obBin, vault);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      deps.logger.warn("sync-setup threw — treating as transient failure", {
        vault: vault.slug,
        attempt,
        error: msg,
      });
      // Synthesize a non-zero "exit" so the loop falls through to the
      // backoff branch identical to a real non-zero exit.
      code = -1;
    }
    if (code === 0) {
      deps.logger.info("sync-setup succeeded", { vault: vault.slug, attempt });
      return;
    }
    lastExit = code;
    deps.logger.warn("sync-setup failed", { vault: vault.slug, attempt, exitCode: code });

    if (attempt < backoff.maxAttempts) {
      const delay = backoffDelay(backoff, attempt - 1);
      deps.logger.info("sync-setup backing off", { vault: vault.slug, delayMs: delay });
      await deps.sleep(delay);
    }
  }
  throw new SetupPermanentError(backoff.maxAttempts, vault.name, lastExit);
}

/**
 * Shared retry/backoff primitive for `ob sync-*` orchestrators.
 *
 * Both `ensureVaultSetup` (sync-setup) and `applyVaultSyncConfig`
 * (sync-config) wrap the same probe → spawn → exit-code → retry loop;
 * this module owns it. Throws inside an attempt are synthesised to a
 * `-1` exit so a launch-time failure is treated identically to a real
 * non-zero exit and falls through to the same backoff branch.
 */

import type { Logger } from "../log.ts";

export interface Backoff {
  readonly initialMs: number;
  readonly factor: number;
  readonly capMs: number;
  readonly maxAttempts: number;
}

export const DEFAULT_BACKOFF: Backoff = {
  initialMs: 1_000,
  factor: 2,
  capMs: 60_000,
  maxAttempts: 5,
};

/** Compute the i-th backoff delay (zero-indexed: 0 = initial). */
export function backoffDelay(b: Backoff, attemptIndex: number): number {
  const raw = b.initialMs * b.factor ** attemptIndex;
  return Math.min(raw, b.capMs);
}

/** Drain a stream to EOF without buffering its contents. */
export async function drain(stream: ReadableStream<Uint8Array>): Promise<void> {
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

export interface RunWithBackoffArgs {
  /** Op name woven into log messages, e.g. "sync-setup", "sync-config". */
  readonly opName: string;
  readonly vaultSlug: string;
  /** Returns the child's exit code; throws are treated as transient (-1). */
  readonly attempt: () => Promise<number>;
  readonly backoff: Backoff;
  readonly sleep: (ms: number) => Promise<void>;
  readonly logger: Logger;
  readonly shouldStop: () => boolean;
}

export type RunWithBackoffResult =
  | { ok: true }
  | { ok: false; lastExit: number }
  | { ok: "cancelled" };

/**
 * Run `attempt()` up to `backoff.maxAttempts` times with capped exponential
 * backoff. Returns:
 * - `{ ok: true }` on the first attempt that exits 0
 * - `{ ok: "cancelled" }` if `shouldStop()` trips at the top of any iteration
 * - `{ ok: false, lastExit }` after every attempt failed
 */
export async function runWithBackoff(args: RunWithBackoffArgs): Promise<RunWithBackoffResult> {
  const { opName, vaultSlug, attempt, backoff, sleep, logger, shouldStop } = args;
  let lastExit = -1;
  for (let i = 1; i <= backoff.maxAttempts; i++) {
    if (shouldStop()) {
      logger.info(`${opName} cancelled by stop signal`, { vault: vaultSlug, attempt: i });
      return { ok: "cancelled" };
    }
    logger.info(`running ${opName}`, { vault: vaultSlug, attempt: i });
    let code: number;
    try {
      code = await attempt();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`${opName} threw — treating as transient failure`, {
        vault: vaultSlug,
        attempt: i,
        error: msg,
      });
      // Synthesize a non-zero "exit" so the loop falls through to the
      // backoff branch identical to a real non-zero exit.
      code = -1;
    }
    if (code === 0) {
      logger.info(`${opName} succeeded`, { vault: vaultSlug, attempt: i });
      return { ok: true };
    }
    lastExit = code;
    logger.warn(`${opName} failed`, { vault: vaultSlug, attempt: i, exitCode: code });

    if (i < backoff.maxAttempts) {
      const delay = backoffDelay(backoff, i - 1);
      logger.info(`${opName} backing off`, { vault: vaultSlug, delayMs: delay });
      await sleep(delay);
    }
  }
  return { ok: false, lastExit };
}

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
  | { ok: false; lastExit: number; lastError?: string }
  | { ok: "cancelled" };

/**
 * Granularity (ms) at which the stop-aware backoff sleep wakes to re-check
 * `shouldStop()`. Bounds shutdown latency during a long backoff window.
 */
const STOP_POLL_SLICE_MS = 250;

/**
 * Run `attempt()` up to `backoff.maxAttempts` times with capped exponential
 * backoff. Returns:
 * - `{ ok: true }` on the first attempt that exits 0
 * - `{ ok: "cancelled" }` if `shouldStop()` trips at the top of any iteration
 *   OR during the backoff sleep window
 * - `{ ok: false, lastExit, lastError? }` after every attempt failed; `lastError`
 *   carries the most recent thrown value (stringified) so callers can surface
 *   the original ENOENT / launch-time message instead of a bare "-1" exit
 */
export async function runWithBackoff(args: RunWithBackoffArgs): Promise<RunWithBackoffResult> {
  const { opName, vaultSlug, attempt, backoff, sleep, logger, shouldStop } = args;
  let lastExit = -1;
  let lastError: string | undefined;
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
      lastError = msg;
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
      // Slice the backoff sleep so a stop signal arriving mid-window aborts
      // promptly instead of holding `stop()` open for up to `capMs` ms.
      let remaining = delay;
      while (remaining > 0) {
        if (shouldStop()) {
          logger.info(`${opName} cancelled by stop signal`, {
            vault: vaultSlug,
            attempt: i + 1,
          });
          return { ok: "cancelled" };
        }
        const slice = Math.min(remaining, STOP_POLL_SLICE_MS);
        await sleep(slice);
        remaining -= slice;
      }
    }
  }
  return { ok: false, lastExit, ...(lastError !== undefined ? { lastError } : {}) };
}

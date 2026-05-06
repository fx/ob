/**
 * `ob sync-setup` orchestration.
 *
 * Probes `ob sync-status` once and, if the vault isn't configured, runs
 * `ob sync-setup` through the shared `runWithBackoff` envelope. Both the
 * sleep primitive and the spawner are injected so retry tests run instantly
 * without touching the wall clock.
 */

import type { Logger } from "../log.ts";
import { type Backoff, DEFAULT_BACKOFF, drain, runWithBackoff } from "./backoff.ts";
import type { Spawner } from "./spawn.ts";
import { checkSetupStatus } from "./status.ts";

export { DEFAULT_BACKOFF, backoffDelay, drain } from "./backoff.ts";
export type { Backoff } from "./backoff.ts";
/** @deprecated Use `Backoff` from "./backoff.ts". */
export type SetupBackoff = Backoff;

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

export interface SetupDeps {
  readonly spawner: Spawner;
  readonly logger: Logger;
  readonly sleep: (ms: number) => Promise<void>;
  readonly backoff?: Backoff;
  readonly obBin?: string;
  /**
   * Cooperative cancellation predicate. Polled at every yield point so the
   * supervisor can short-circuit a long retry chain on shutdown.
   */
  readonly shouldStop?: () => boolean;
}

/** Run `ob sync-setup` once. Returns the child's exit code. */
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
 * Probe `ob sync-status`. A thrown exception (e.g. spawner ENOENT before an
 * exit code is even produced) is treated as "not configured" — the retry
 * path will reattempt either way.
 */
async function probeStatus(
  spawner: Spawner,
  obBin: string,
  vaultPath: string,
  log: Logger,
  vaultSlug: string,
): Promise<"configured" | "not-configured"> {
  try {
    return await checkSetupStatus(spawner, { path: vaultPath, obBin });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn("sync-status threw — treating as transient launch failure", {
      vault: vaultSlug,
      error: msg,
    });
    return "not-configured";
  }
}

/**
 * Ensure a vault is set up. Probes `ob sync-status`; if the vault isn't
 * configured, runs `ob sync-setup` through the shared retry envelope. Both
 * `checkSetupStatus` and `runSetupOnce` may throw before producing an exit
 * code — those are absorbed as transient failures bound to the same
 * retry/backoff ceiling.
 */
export async function ensureVaultSetup(vault: SetupVault, deps: SetupDeps): Promise<void> {
  const obBin = deps.obBin ?? "ob";
  const backoff = deps.backoff ?? DEFAULT_BACKOFF;
  const shouldStop = deps.shouldStop ?? ((): boolean => false);

  const status = await probeStatus(deps.spawner, obBin, vault.path, deps.logger, vault.slug);
  if (status === "configured") {
    deps.logger.info("vault already configured", { vault: vault.slug });
    return;
  }

  const result = await runWithBackoff({
    opName: "sync-setup",
    vaultSlug: vault.slug,
    attempt: () => runSetupOnce(deps.spawner, obBin, vault),
    backoff,
    sleep: deps.sleep,
    logger: deps.logger,
    shouldStop,
  });

  if (result.ok === true || result.ok === "cancelled") return;
  throw new SetupPermanentError(backoff.maxAttempts, vault.name, result.lastExit);
}

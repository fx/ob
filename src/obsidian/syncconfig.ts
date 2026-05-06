/**
 * `ob sync-config` orchestration.
 *
 * Translates `SyncConfigEnv` into an `ob sync-config` argv with two
 * load-bearing semantics: an **unset** field omits the flag (preserve
 * on-disk value); an **empty-string** field is forwarded verbatim
 * (upstream "empty to clear" sentinel). Flag order matches the spec
 * table and is part of this module's contract.
 */

import type { SyncConfigEnv } from "../config/index.ts";
import type { Logger } from "../log.ts";
import { type Backoff, DEFAULT_BACKOFF, drain, runWithBackoff } from "./backoff.ts";
import type { SetupVault } from "./setup.ts";
import type { Spawner } from "./spawn.ts";

/**
 * Permanent sync-config failure: backoff exhausted (≥ `maxAttempts`). The
 * supervisor MUST mark the vault `failed` and MUST NOT spawn its `ob sync
 * --continuous` child.
 */
export class SyncConfigPermanentError extends Error {
  readonly attempts: number;
  constructor(attempts: number, vaultName: string, lastExit: number) {
    super(
      `sync-config for "${vaultName}" failed permanently after ${attempts} attempts (last exit ${lastExit})`,
    );
    this.name = "SyncConfigPermanentError";
    this.attempts = attempts;
  }
}

export interface SyncConfigDeps {
  readonly spawner: Spawner;
  readonly logger: Logger;
  readonly sleep: (ms: number) => Promise<void>;
  readonly backoff?: Backoff;
  readonly obBin?: string;
  /**
   * Cooperative cancellation predicate. Polled at every yield point so the
   * supervisor can short-circuit the retry chain on shutdown.
   */
  readonly shouldStop?: () => boolean;
}

/**
 * Build the `ob sync-config` argv for `vaultPath`. Returns `null` when every
 * field of `env` is `undefined` (the call is a no-op and MUST be skipped).
 *
 * Flag order is part of the public contract: file-types → excluded-folders →
 * mode → conflict-strategy → device-name → configs.
 */
export function buildSyncConfigArgs(env: SyncConfigEnv, vaultPath: string): string[] | null {
  const args: string[] = [];
  if (env.fileTypes !== undefined) args.push("--file-types", env.fileTypes);
  if (env.excludedFolders !== undefined) args.push("--excluded-folders", env.excludedFolders);
  if (env.mode !== undefined) args.push("--mode", env.mode);
  if (env.conflictStrategy !== undefined) args.push("--conflict-strategy", env.conflictStrategy);
  if (env.deviceName !== undefined) args.push("--device-name", env.deviceName);
  if (env.configs !== undefined) args.push("--configs", env.configs);
  if (args.length === 0) return null;
  return ["sync-config", "--path", vaultPath, ...args];
}

/** Run `ob sync-config` once. Returns the child's exit code. */
async function runSyncConfigOnce(
  spawner: Spawner,
  obBin: string,
  argv: readonly string[],
): Promise<number> {
  const handle = spawner.run(obBin, argv);
  const [, , code] = await Promise.all([drain(handle.stdout), drain(handle.stderr), handle.exited]);
  return code;
}

/**
 * Apply `ob sync-config` to a vault using the shared retry envelope. No-op
 * when `env` has no fields set: logs once at info and returns.
 */
export async function applyVaultSyncConfig(
  vault: SetupVault,
  deps: SyncConfigDeps,
  env: SyncConfigEnv,
): Promise<void> {
  const argv = buildSyncConfigArgs(env, vault.path);
  if (argv === null) {
    deps.logger.info("skipping sync-config (no OB_SYNC_* vars set)", { vault: vault.slug });
    return;
  }

  const obBin = deps.obBin ?? "ob";
  const backoff = deps.backoff ?? DEFAULT_BACKOFF;
  const shouldStop = deps.shouldStop ?? ((): boolean => false);

  const result = await runWithBackoff({
    opName: "sync-config",
    vaultSlug: vault.slug,
    attempt: () => runSyncConfigOnce(deps.spawner, obBin, argv),
    backoff,
    sleep: deps.sleep,
    logger: deps.logger,
    shouldStop,
  });

  if (result.ok === true || result.ok === "cancelled") return;
  throw new SyncConfigPermanentError(backoff.maxAttempts, vault.name, result.lastExit);
}

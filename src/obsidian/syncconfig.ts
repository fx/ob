/**
 * `ob sync-config` orchestration.
 *
 * Translates the validated `SyncConfigEnv` (resolved by the config layer)
 * into an `ob sync-config` argv and runs it once per vault, mirroring the
 * retry/backoff envelope `ensureVaultSetup` uses for `ob sync-setup`.
 *
 * Per the change doc:
 * - An **unset** field means "omit the flag entirely" (preserve on-disk value).
 * - An **empty-string** field is forwarded verbatim as the upstream
 *   "empty to clear" sentinel.
 * - When *every* field is unset, this module is a no-op — `buildSyncConfigArgs`
 *   returns `null` and `applyVaultSyncConfig` returns immediately without
 *   spawning a child.
 *
 * The flag order matches the spec table: file-types, excluded-folders, mode,
 * conflict-strategy, device-name, configs. The order is observable to tests
 * and is part of this module's contract.
 */

import type { SyncConfigEnv } from "../config/index.ts";
import type { Logger } from "../log.ts";
import { DEFAULT_BACKOFF, type SetupBackoff, type SetupVault, backoffDelay } from "./setup.ts";
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
  readonly sleep: (ms: number) => Promise<void>;
  readonly backoff?: SetupBackoff;
  readonly obBin?: string;
  /**
   * Cooperative cancellation predicate. Polled at every yield point so the
   * supervisor can short-circuit the retry chain on shutdown.
   */
  readonly shouldStop?: () => boolean;
}

/**
 * Build the `ob sync-config` argv for `vaultPath`. Returns `null` when every
 * field of `env` is `undefined` (no `OB_SYNC_*` var was set; the call is a
 * no-op and MUST be skipped).
 *
 * Otherwise returns `["sync-config", "--path", vaultPath, ...flags]` with one
 * `--<flag> <value>` pair per set field. `value` is forwarded verbatim — an
 * empty string yields `["...", "--excluded-folders", ""]` (the upstream
 * "empty to clear" sentinel).
 *
 * Flag order matches the spec table and is part of the public contract:
 * file-types → excluded-folders → mode → conflict-strategy → device-name →
 * configs.
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
 * Apply `ob sync-config` to a vault, with the same retry envelope as
 * `ensureVaultSetup`: max 5 attempts, 1s/×2/cap 60s, throws treated as
 * transient (-1 exit).
 *
 * No-op when `env` has no fields set: logs once at info and returns.
 */
export async function applyVaultSyncConfig(
  vault: SetupVault,
  deps: SyncConfigDeps,
  log: Logger,
  env: SyncConfigEnv,
): Promise<void> {
  const argv = buildSyncConfigArgs(env, vault.path);
  if (argv === null) {
    log.info("skipping sync-config (no OB_SYNC_* vars set)", { vault: vault.slug });
    return;
  }

  const obBin = deps.obBin ?? "ob";
  const backoff = deps.backoff ?? DEFAULT_BACKOFF;
  const shouldStop = deps.shouldStop ?? ((): boolean => false);

  let lastExit = -1;
  for (let attempt = 1; attempt <= backoff.maxAttempts; attempt++) {
    if (shouldStop()) {
      log.info("sync-config cancelled by stop signal", { vault: vault.slug, attempt });
      return;
    }
    log.info("running sync-config", { vault: vault.slug, attempt });
    let code: number;
    try {
      code = await runSyncConfigOnce(deps.spawner, obBin, argv);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.warn("sync-config threw — treating as transient failure", {
        vault: vault.slug,
        attempt,
        error: msg,
      });
      // Synthesize a non-zero "exit" so the loop falls through to backoff
      // identical to a real non-zero exit.
      code = -1;
    }
    if (code === 0) {
      log.info("sync-config succeeded", { vault: vault.slug, attempt });
      return;
    }
    lastExit = code;
    log.warn("sync-config failed", { vault: vault.slug, attempt, exitCode: code });

    if (attempt < backoff.maxAttempts) {
      const delay = backoffDelay(backoff, attempt - 1);
      log.info("sync-config backing off", { vault: vault.slug, delayMs: delay });
      await deps.sleep(delay);
    }
  }
  throw new SyncConfigPermanentError(backoff.maxAttempts, vault.name, lastExit);
}

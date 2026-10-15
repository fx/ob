/**
 * Builders for the supervisor's public `VaultStatus`, so the ~15 fixtures
 * that only care about `state`/`pid` don't each have to spell out the
 * watchdog sub-object.
 *
 * `TEST_WATCHDOG_OFF` is the configuration every fixture that is NOT about
 * the watchdog should use: with both stall detection and log tailing off,
 * `VaultChild` never starts a poll loop, so a fixture driving a real
 * supervisor against a fake spawner cannot spin one in the background.
 *
 * `TEST_SYNC_HEALTH` is the same idea for the restart ceilings, which
 * default to unlimited in production. A fixture that drives a real
 * supervisor against a fake spawner whose script queue runs dry falls back
 * to an `exitCode: 0` default handle, often with a no-op sleep. Before the
 * ceilings became opt-in, the crash-loop ceiling of 10 ended that loop; with
 * "unlimited" it would restart forever — possibly as a pure microtask loop
 * that hangs the whole test file. Fixtures that are not about the ceilings
 * therefore keep a finite crash ceiling.
 */

import type { SyncHealthConfig, SyncWatchdogConfig } from "../../src/config/index.ts";
import type { VaultStatus } from "../../src/obsidian/index.ts";
import {
  DISABLED_SYNC_WATCHDOG,
  EMPTY_WATCHDOG_MEMORY,
  watchdogSnapshot,
} from "../../src/obsidian/watchdog.ts";

export const TEST_WATCHDOG_OFF: SyncWatchdogConfig = DISABLED_SYNC_WATCHDOG;

export const TEST_SYNC_HEALTH: SyncHealthConfig = {
  maxCrashes: 10,
  maxStallKills: 0,
  healthzFailureThreshold: 3,
};

const OFF = watchdogSnapshot(DISABLED_SYNC_WATCHDOG, EMPTY_WATCHDOG_MEMORY, false);

/** A `VaultStatus` for a healthy vault, overridable field by field. */
export function makeVaultStatus(over: Partial<VaultStatus> & { slug: string }): VaultStatus {
  return {
    name: over.slug,
    state: "running",
    pid: 1,
    restarts: 0,
    consecutiveFailures: 0,
    lastError: null,
    lastSyncActivityAt: OFF.lastSyncActivityAt,
    watchdog: OFF.watchdog,
    ...over,
  };
}

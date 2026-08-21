/**
 * Zod schemas for vault listing / status responses.
 */

import { z } from "zod";

const VaultState = z.enum(["starting", "running", "failed"]);
const IndexerState = z.enum(["starting", "scanning", "ready", "failed"]);
const WatchdogState = z.enum(["disabled", "resolving", "tailing", "armed"]);

export const VaultWatchdogStatus = z.object({
  state: WatchdogState,
  logPath: z.string().nullable(),
  thresholdMs: z.number().int().nonnegative(),
  pollIntervalMs: z.number().int().positive(),
  stallKills: z.number().int().nonnegative(),
});
export type VaultWatchdogStatus = z.infer<typeof VaultWatchdogStatus>;

export const VaultSyncStatus = z.object({
  slug: z.string(),
  name: z.string(),
  state: VaultState,
  pid: z.number().nullable(),
  restarts: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  lastSyncActivityAt: z.number().nullable(),
  watchdog: VaultWatchdogStatus,
});
export type VaultSyncStatus = z.infer<typeof VaultSyncStatus>;

export const VaultIndexerStatus = z.object({
  slug: z.string(),
  state: IndexerState,
  documents: z.number().int().nonnegative(),
  chunks: z.number().int().nonnegative(),
  lastIndexedAt: z.number().nullable(),
  pending: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
});
export type VaultIndexerStatus = z.infer<typeof VaultIndexerStatus>;

export const VaultSummary = z.object({
  slug: z.string(),
  name: z.string(),
  sync: VaultSyncStatus,
  indexer: VaultIndexerStatus,
});
export type VaultSummary = z.infer<typeof VaultSummary>;

export const VaultsListResponse = z.array(VaultSummary);
export type VaultsListResponse = z.infer<typeof VaultsListResponse>;

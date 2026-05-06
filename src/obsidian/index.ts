/**
 * Obsidian supervisor facade.
 *
 * Public surface for the rest of the app:
 *
 * ```ts
 * type VaultState = "starting" | "running" | "failed";
 * interface VaultStatus { slug; name; state; pid; restarts; lastError; }
 * interface Supervisor { list(); get(slug); stop(): Promise<void>; }
 * ```
 *
 * Workflow per vault:
 *   1. ensure `<DATA_DIR>/vaults/<slug>/` exists (mode 0700).
 *   2. probe `ob sync-status` → run `ob sync-setup` if needed (with backoff).
 *   3. spawn `ob sync --continuous --path <dir>` and supervise it.
 *
 * Setups run serially across vaults (decided in the change doc). Each child
 * runs concurrently once its setup completes.
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Config } from "../config/index.ts";
import type { Logger } from "../log.ts";
import type { Backoff } from "./backoff.ts";
import { ensureAuthToken } from "./bootstrap.ts";
import { type ChildBackoff, type CrashLoop, VaultChild, type VaultStatus } from "./child.ts";
import { SetupPermanentError, ensureVaultSetup } from "./setup.ts";
import { type Spawner, realSpawner } from "./spawn.ts";
import { SyncConfigPermanentError, applyVaultSyncConfig } from "./syncconfig.ts";

export type { VaultState, VaultStatus } from "./child.ts";
export type { SpawnHandle, SpawnOpts, Spawner } from "./spawn.ts";
export { AuthMissingError } from "./bootstrap.ts";
export { SetupPermanentError, SetupTransientError } from "./setup.ts";
export { SyncConfigPermanentError } from "./syncconfig.ts";

export interface Supervisor {
  list(): VaultStatus[];
  get(slug: string): VaultStatus | null;
  stop(): Promise<void>;
}

export interface SupervisorDeps {
  readonly logger: Logger;
  readonly spawner?: Spawner;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly mkdir?: (path: string, opts: { recursive: true; mode: number }) => Promise<void>;
  readonly homeDir?: string;
  readonly xdgConfigHome?: string;
  readonly setupBackoff?: Backoff;
  readonly childBackoff?: ChildBackoff;
  readonly crashLoop?: CrashLoop;
  readonly obBin?: string;
  /** Per-vault stop grace period before SIGKILL. Default 5 s. */
  readonly stopGraceMs?: number;
  /** Skip auth-token bootstrap (useful for tests that already wrote it). */
  readonly skipAuthBootstrap?: boolean;
  /** Override for `ensureAuthToken`'s `fs` arg — tests use this. */
  readonly authFs?: Parameters<typeof ensureAuthToken>[1];
}

const DEFAULT_STOP_GRACE_MS = 5_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultMkdir(path: string, opts: { recursive: true; mode: number }): Promise<void> {
  return mkdir(path, opts).then(() => undefined);
}

/**
 * Build the supervisor. Bootstraps the auth-token file, ensures every
 * vault's working directory exists, runs setup if needed, and starts the
 * supervised `ob sync` child for each vault.
 *
 * Resolves once every vault has either entered a child loop (state
 * `starting`/`running`) or been marked `failed` (e.g. setup permanently
 * failed). Restart loops keep running in the background; `stop()` reaps them.
 */
export async function startSupervisor(cfg: Config, deps: SupervisorDeps): Promise<Supervisor> {
  const spawner = deps.spawner ?? realSpawner;
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? defaultSleep;
  const mkdirImpl = deps.mkdir ?? defaultMkdir;
  const stopGraceMs = deps.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const log = deps.logger;

  if (deps.skipAuthBootstrap !== true) {
    const homeDir = deps.homeDir ?? process.env.HOME ?? "/home/ob";
    const authInput = {
      authToken: cfg.obsidianAuthToken,
      ...(deps.xdgConfigHome !== undefined ? { xdgConfigHome: deps.xdgConfigHome } : {}),
      homeDir,
    };
    const fsArg = deps.authFs;
    const result =
      fsArg !== undefined
        ? await ensureAuthToken(authInput, fsArg)
        : await ensureAuthToken(authInput);
    log.info("auth-token bootstrap", { path: result.path, action: result.action });
  }

  const children = new Map<string, VaultChild>();

  // Build the children up-front so `list()`/`get()` reflect every configured
  // vault from the moment the supervisor returns — even ones whose setup
  // hasn't finished yet.
  for (const v of cfg.vaults) {
    const vaultPath = join(cfg.dataDir, "vaults", v.slug);
    const childVault = {
      name: v.name,
      slug: v.slug,
      path: vaultPath,
      ...(v.e2eePassword !== undefined ? { e2eePassword: v.e2eePassword } : {}),
    };
    const child = new VaultChild(childVault, {
      spawner,
      logger: log,
      now,
      sleep,
      ...(deps.childBackoff !== undefined ? { backoff: deps.childBackoff } : {}),
      ...(deps.crashLoop !== undefined ? { crashLoop: deps.crashLoop } : {}),
      ...(deps.obBin !== undefined ? { obBin: deps.obBin } : {}),
    });
    children.set(v.slug, child);
  }

  // Cooperative cancellation flag for the init pipeline. `Supervisor.stop()`
  // flips it before awaiting in-flight init work, so a half-completed
  // mkdir/sync-status/sync-setup sequence will not start the next phase.
  const initState = { stopped: false };

  // Setups run serially per the spec's "default: serial" decision, but the
  // entire setup-then-supervise sequence runs in the background so
  // `startSupervisor` returns quickly. Vault state stays `starting` until the
  // child loop reports `running`. All error paths are handled inside the
  // loop and surfaced via `markFailed` — the IIFE itself never rejects.
  const initPromise = (async (): Promise<void> => {
    // Iterate over the children map directly so TypeScript sees a guaranteed
    // VaultChild instance — every vault was added in the loop above.
    for (const child of children.values()) {
      if (initState.stopped) return;
      const vaultPath = child.vault.path;
      const v = child.vault;
      try {
        await mkdirImpl(vaultPath, { recursive: true, mode: 0o700 });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error("vault directory mkdir failed", { vault: v.slug, error: msg });
        child.markFailed(`mkdir failed: ${msg}`);
        continue;
      }
      if (initState.stopped) return;
      try {
        await ensureVaultSetup(
          {
            name: v.name,
            slug: v.slug,
            path: vaultPath,
            ...(v.e2eePassword !== undefined ? { e2eePassword: v.e2eePassword } : {}),
          },
          {
            spawner,
            logger: log,
            sleep,
            ...(deps.setupBackoff !== undefined ? { backoff: deps.setupBackoff } : {}),
            ...(deps.obBin !== undefined ? { obBin: deps.obBin } : {}),
            shouldStop: () => initState.stopped,
          },
        );
      } catch (e) {
        // The only error class `ensureVaultSetup` raises by contract is
        // `SetupPermanentError`; transient throws are absorbed inside it
        // up to the configured retry ceiling. Any other Error class would
        // be a programming bug, but we still log+markFailed defensively
        // rather than letting an unhandled rejection escape.
        const msg = e instanceof Error ? e.message : String(e);
        log.error("vault setup permanently failed", {
          vault: v.slug,
          error: msg,
          permanent: e instanceof SetupPermanentError,
        });
        child.markFailed(msg);
        continue;
      }
      if (initState.stopped) return;
      try {
        await applyVaultSyncConfig(
          {
            name: v.name,
            slug: v.slug,
            path: vaultPath,
            ...(v.e2eePassword !== undefined ? { e2eePassword: v.e2eePassword } : {}),
          },
          {
            spawner,
            logger: log,
            sleep,
            ...(deps.setupBackoff !== undefined ? { backoff: deps.setupBackoff } : {}),
            ...(deps.obBin !== undefined ? { obBin: deps.obBin } : {}),
            shouldStop: () => initState.stopped,
          },
          cfg.syncConfigEnv,
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log.error("vault sync-config permanently failed", {
          vault: v.slug,
          error: msg,
          permanent: e instanceof SyncConfigPermanentError,
        });
        child.markFailed(msg);
        continue;
      }
      if (initState.stopped) return;
      // Kick off the run loop; do NOT await — children run concurrently.
      void child.start();
    }
  })();

  let stopPromise: Promise<void> | undefined;

  const supervisor: Supervisor = {
    list(): VaultStatus[] {
      return Array.from(children.values(), (c) => c.snapshot());
    },
    get(slug: string): VaultStatus | null {
      const c = children.get(slug);
      return c === undefined ? null : c.snapshot();
    },
    stop(): Promise<void> {
      if (stopPromise !== undefined) return stopPromise;
      stopPromise = (async () => {
        log.info("supervisor stopping", { vaults: children.size });
        // 1. Signal cancellation to the in-flight init pipeline so no new
        //    `sync-status`/`sync-setup` invocations are launched after this
        //    point. Then await the pipeline to settle — without this,
        //    background work would continue spawning processes after stop
        //    resolves.
        initState.stopped = true;
        await Promise.allSettled([initPromise]);
        // 2. SIGTERM all children in parallel, await up to grace, then SIGKILL.
        const tasks = Array.from(children.values(), async (child) => {
          child.requestStop("SIGTERM");
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<"timeout">((resolve) => {
            timer = setTimeout(() => resolve("timeout"), stopGraceMs);
          });
          const result = await Promise.race([
            child.awaitExit().then(() => "exited" as const),
            timeout,
          ]);
          if (timer !== undefined) clearTimeout(timer);
          if (result === "timeout") {
            log.warn("forcing SIGKILL on stuck child", { vault: child.vault.slug });
            child.forceKill();
            await child.awaitExit();
          }
        });
        await Promise.all(tasks);
        log.info("supervisor stopped");
      })();
      return stopPromise;
    },
  };

  return supervisor;
}

/**
 * Convenience helper used by `src/server.ts` and (eventually) the indexer
 * route. Returns true only when every vault is in `running`.
 */
export function isAllRunning(statuses: readonly VaultStatus[]): boolean {
  if (statuses.length === 0) return false;
  return statuses.every((s) => s.state === "running");
}

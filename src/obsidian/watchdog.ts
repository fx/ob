/**
 * Per-vault sync-log resolution and incremental tail.
 *
 * The upstream `ob sync --continuous` child writes its progress to
 * `${XDG_CONFIG_HOME:-${HOME:-/home/ob}/.config}/obsidian-headless/sync/<vaultId>/sync.log`
 * rather than to stdout, so the supervisor's stdio forwarding sees nothing at
 * all while sync is working normally. This module locates that file (the
 * `<vaultId>` is assigned by the CLI and is only discoverable by matching each
 * candidate directory's `config.json` `vaultPath` against the vault's working
 * directory), tails newly appended lines into the parent logger, and reports
 * the log's mtime as `lastSyncActivityAt`.
 *
 * One poll loop per child lifetime serves both jobs, because both need the
 * same `stat` of the same file. Every filesystem call goes through the
 * injected `WatchdogFs` so unit tests can drive `ENOENT`, `EACCES`, malformed
 * JSON, and mid-poll truncation without a real filesystem; `now` and `sleep`
 * are injected for the same reason `ChildDeps` injects them.
 *
 * Resolution is fail-soft by design: every failure mode here is
 * upstream-shaped (a layout change, a permissions change, a vault that has
 * not synced yet), and failing the vault would turn "we cannot watch this"
 * into "sync is down". Dormant-but-visible (`watchdog.state === "resolving"`,
 * plus one `warn` once the child has outlived the threshold unresolved) is
 * the safe disposition.
 *
 * NOTE: stall detection itself is deliberately NOT in this PR. Nothing here
 * kills a child, so a resolved log reports `tailing` rather than `armed` —
 * claiming `armed` while no verdict can ever fire is the exact silent failure
 * this feature exists to remove.
 */

import { stat as fsStat, readFile, readdir } from "node:fs/promises";
import { join, resolve as resolvePath } from "node:path";
import type { SyncWatchdogConfig } from "../config/index.ts";
import type { Logger } from "../log.ts";

export type WatchdogState = "disabled" | "resolving" | "tailing" | "armed";

export interface WatchdogStatus {
  readonly state: WatchdogState;
  readonly logPath: string | null;
  readonly thresholdMs: number;
  readonly pollIntervalMs: number;
  readonly stallKills: number;
}

export interface WatchdogSnapshot {
  readonly lastSyncActivityAt: number | null;
  readonly watchdog: WatchdogStatus;
}

/**
 * The slice of watchdog state that outlives a single child. `logPath` and
 * `lastSyncActivityAt` are retained across restarts on purpose: blanking them
 * when a replacement child spawns would destroy the evidence in exactly the
 * window an operator is looking at it.
 */
export interface WatchdogMemory {
  readonly logPath: string | null;
  readonly lastSyncActivityAt: number | null;
  readonly stallKills: number;
}

export const EMPTY_WATCHDOG_MEMORY: WatchdogMemory = {
  logPath: null,
  lastSyncActivityAt: null,
  stallKills: 0,
};

/** Configuration shape for "no watchdog is wired at all". */
export const DISABLED_SYNC_WATCHDOG: SyncWatchdogConfig = {
  stallTimeoutMs: 0,
  pollIntervalMs: 30_000,
  logTail: false,
};

/** Per-poll read cap. An append larger than this is skipped forward. */
export const DEFAULT_MAX_TAIL_BYTES = 262_144;

/**
 * How long an unresolved log may go unremarked when stall detection is off.
 * With a threshold configured we use it; with `stallTimeoutMs === 0` there is
 * no threshold to speak of, so we fall back to the default one purely as a
 * visibility timer — the warning is what distinguishes "unprotected" from
 * "fine", and losing it whenever the kill is disarmed would defeat the
 * recommended observation-mode rollout.
 */
const UNRESOLVED_WARN_FALLBACK_MS = 300_000;

/** Stat fields the watchdog needs. `inode` is a string so `ino` bigints survive. */
export interface WatchdogStat {
  readonly size: number;
  readonly mtimeMs: number;
  readonly inode: string;
}

/**
 * Filesystem surface. The real implementation is `defaultWatchdogFs`; tests
 * inject a stub to drive error shapes deterministically.
 */
export interface WatchdogFs {
  /** Immediate entry names of a directory. */
  readDir(path: string): Promise<readonly string[]>;
  /** Read and JSON-parse a file. */
  readJson(path: string): Promise<unknown>;
  stat(path: string): Promise<WatchdogStat>;
  /** Bytes in `[start, end)`. May return fewer than requested. */
  readRange(path: string, start: number, end: number): Promise<Uint8Array>;
}

export const defaultWatchdogFs: WatchdogFs = {
  readDir: (path) => readdir(path),
  readJson: async (path) => JSON.parse(await readFile(path, "utf8")) as unknown,
  stat: async (path) => {
    const s = await fsStat(path);
    return { size: s.size, mtimeMs: s.mtimeMs, inode: String(s.ino) };
  },
  readRange: async (path, start, end) =>
    new Uint8Array(await Bun.file(path).slice(start, end).arrayBuffer()),
};

/** Identity of the vault being watched — deliberately not `ChildVault`, to keep this module free of a cycle back to `child.ts`. */
export interface WatchdogVault {
  readonly slug: string;
  readonly path: string;
}

export interface WatchdogDeps {
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly fs: WatchdogFs;
  readonly logger: Logger;
  /** `<xdgConfigBase>/obsidian-headless/sync`. */
  readonly syncDir: string;
  readonly config: SyncWatchdogConfig;
  /** Carried over from the previous child, so evidence survives a restart. */
  readonly memory?: WatchdogMemory;
  readonly maxTailBytes?: number;
}

export interface WatchdogHandle {
  snapshot(): WatchdogSnapshot;
  /** State to carry into the next child of the same vault. */
  memory(): WatchdogMemory;
  /** Idempotent; wakes the poll sleep so no interval is waited out. */
  stop(): void;
}

/** True when configuration switches the watchdog off entirely. */
export function watchdogIsDisabled(config: SyncWatchdogConfig): boolean {
  return config.stallTimeoutMs === 0 && !config.logTail;
}

/**
 * Render the public status from configuration plus retained memory.
 *
 * Shared by the running handle and by `VaultChild` while no child exists, so
 * the two can never disagree about what `disabled` reports.
 */
export function watchdogSnapshot(
  config: SyncWatchdogConfig,
  memory: WatchdogMemory,
  resolved: boolean,
): WatchdogSnapshot {
  const disabled = watchdogIsDisabled(config);
  // `armed` is unreachable until stall detection lands; see the module note.
  const state: WatchdogState = disabled ? "disabled" : resolved ? "tailing" : "resolving";
  return {
    lastSyncActivityAt: disabled ? null : memory.lastSyncActivityAt,
    watchdog: {
      state,
      logPath: disabled ? null : memory.logPath,
      thresholdMs: config.stallTimeoutMs,
      pollIntervalMs: config.pollIntervalMs,
      stallKills: memory.stallKills,
    },
  };
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

interface Candidate {
  readonly dir: string;
  readonly mtimeMs: number;
}

/**
 * Start one poll loop for one child lifetime. The returned handle is the
 * only way to observe or stop it; the watchdog never touches the spawn
 * handle, so `child.ts` keeps sole ownership of process lifecycle.
 */
export function startWatchdog(vault: WatchdogVault, deps: WatchdogDeps): WatchdogHandle {
  const config = deps.config;
  const maxTailBytes = deps.maxTailBytes ?? DEFAULT_MAX_TAIL_BYTES;
  const initial = deps.memory ?? EMPTY_WATCHDOG_MEMORY;

  let logPath = initial.logPath;
  let lastSyncActivityAt = initial.lastSyncActivityAt;
  const stallKills = initial.stallKills;

  /** Non-null exactly while a log is resolved for THIS child. */
  let activePath: string | null = null;
  let offset = 0;
  let inode: string | null = null;
  let pending = "";
  let discardStraddlingLine = false;
  let decoder = new TextDecoder();
  let warnedUnresolved = false;

  const startedAt = deps.now();
  let stopped = false;
  let wake!: () => void;
  const stopSignal = new Promise<void>((resolve) => {
    wake = resolve;
  });

  function currentMemory(): WatchdogMemory {
    return { logPath, lastSyncActivityAt, stallKills };
  }

  /** Reset every per-file cursor. Used on rotation and on a vanished log. */
  function resetCursor(): void {
    offset = 0;
    pending = "";
    discardStraddlingLine = false;
    decoder = new TextDecoder();
  }

  /**
   * Did the anchor offset land mid-line? If so the first read must drop
   * everything up to and including the next newline: emitting the fragment
   * splits a line, and reconstructing the whole line replays bytes the
   * no-backlog rule excludes.
   */
  async function landedMidLine(path: string, size: number): Promise<boolean> {
    if (size === 0) return false; // an empty file counts as a boundary
    try {
      const bytes = await deps.fs.readRange(path, size - 1, size);
      return bytes[0] !== 0x0a;
    } catch (e) {
      // Cannot tell — assume mid-line. Dropping one line beats emitting a
      // fragment of one, which is the outcome the spec rules out outright.
      deps.logger.warn("sync log boundary probe failed; discarding first line", {
        vault: vault.slug,
        logPath: path,
        error: errText(e),
      });
      return true;
    }
  }

  /**
   * Scan `syncDir` for the entry whose `config.json` names this vault.
   * Returns the resolved `sync.log` path, or `null` while unresolvable.
   * Never throws for an ordinary filesystem error.
   */
  async function resolveLog(): Promise<string | null> {
    const target = resolvePath(vault.path);
    let entries: readonly string[];
    try {
      entries = await deps.fs.readDir(deps.syncDir);
    } catch {
      // Absent `sync/` directory is the normal pre-first-sync state.
      return null;
    }
    if (stopped) return null;

    const candidates: Candidate[] = [];
    for (const dir of entries) {
      if (stopped) return null;
      const configPath = join(deps.syncDir, dir, "config.json");
      let st: WatchdogStat;
      try {
        st = await deps.fs.stat(configPath);
      } catch {
        // Missing/unreadable entry: skip it individually. One junk directory
        // beside the real one must not abort the scan.
        continue;
      }
      let parsed: unknown;
      try {
        parsed = await deps.fs.readJson(configPath);
      } catch {
        continue;
      }
      if (!isRecord(parsed)) continue;
      const vaultPath = parsed.vaultPath;
      if (typeof vaultPath !== "string") continue;
      // Normalized absolute compare — a prefix match MUST NOT be accepted.
      if (resolvePath(vaultPath) !== target) continue;
      candidates.push({ dir, mtimeMs: st.mtimeMs });
    }

    if (candidates.length === 0) return null;
    if (candidates.length > 1) {
      deps.logger.warn("multiple sync directories match this vault", {
        vault: vault.slug,
        syncDir: deps.syncDir,
        candidates: candidates.map((c) => c.dir),
      });
    }
    // Newest `config.json` wins; an exact mtime tie breaks lexicographically
    // so two files written in the same timestamp tick cannot resolve
    // differently between polls.
    const best = candidates.reduce((a, b) =>
      b.mtimeMs > a.mtimeMs || (b.mtimeMs === a.mtimeMs && b.dir > a.dir) ? b : a,
    );

    const candidatePath = join(deps.syncDir, best.dir, "sync.log");
    let logStat: WatchdogStat;
    try {
      logStat = await deps.fs.stat(candidatePath);
    } catch {
      // Directory selected but no log yet — nothing whose silence could mean
      // anything, so stay in `resolving`.
      return null;
    }
    const midLine = await landedMidLine(candidatePath, logStat.size);
    // The child exited while we were reading: commit nothing. A resolution
    // that lands after the child is gone would tail a log nobody owns.
    if (stopped) return null;

    resetCursor();
    // Anchor the tail at the current size: production holds tens of thousands
    // of lines and replaying the backlog would bury the live signal.
    offset = logStat.size;
    inode = logStat.inode;
    lastSyncActivityAt = logStat.mtimeMs;
    logPath = candidatePath;
    discardStraddlingLine = midLine;
    deps.logger.info("sync log resolved", {
      vault: vault.slug,
      logPath: candidatePath,
      offset,
    });
    return candidatePath;
  }

  /** One `warn` per child lifetime once we have been unresolved too long. */
  function warnIfUnresolvedTooLong(): void {
    if (warnedUnresolved) return;
    const threshold =
      config.stallTimeoutMs === 0 ? UNRESOLVED_WARN_FALLBACK_MS : config.stallTimeoutMs;
    const elapsedMs = deps.now() - startedAt;
    if (elapsedMs < threshold) return;
    warnedUnresolved = true;
    deps.logger.warn("sync log still unresolved; this vault is unprotected", {
      vault: vault.slug,
      syncDir: deps.syncDir,
      elapsedMs,
    });
  }

  function emit(line: string): void {
    if (line === "") return; // empty lines are never forwarded
    deps.logger.info("ob output", {
      vault: vault.slug,
      source: "ob",
      stream: "sync.log",
      line,
    });
  }

  async function tail(path: string, st: WatchdogStat): Promise<void> {
    if (st.size <= offset) return;
    let start = offset;
    const available = st.size - start;
    if (available > maxTailBytes) {
      const skippedBytes = available - maxTailBytes;
      start += skippedBytes;
      pending = "";
      decoder = new TextDecoder();
      // The span now starts mid-line by construction.
      discardStraddlingLine = true;
      deps.logger.warn("sync log append exceeded the per-poll cap; skipped ahead", {
        vault: vault.slug,
        logPath: path,
        skippedBytes,
        capBytes: maxTailBytes,
      });
    }

    let bytes: Uint8Array;
    try {
      bytes = await deps.fs.readRange(path, start, st.size);
    } catch (e) {
      deps.logger.warn("sync log read failed", {
        vault: vault.slug,
        logPath: path,
        error: errText(e),
      });
      return;
    }
    // The child exited while the read was in flight: forward nothing. A line
    // emitted now belongs to a child that no longer exists, and could
    // interleave with its replacement's tail.
    if (stopped) return;
    // Advance by what we actually read, so a short read does not skip bytes.
    offset = start + bytes.length;

    const parts = (pending + decoder.decode(bytes, { stream: true })).split("\n");
    let trailing = parts.pop() ?? "";
    if (discardStraddlingLine) {
      if (parts.length > 0) {
        parts.shift();
        discardStraddlingLine = false;
      } else {
        // Still inside the straddling line — its bytes stay discarded.
        trailing = "";
      }
    }
    // An incomplete trailing line waits for its newline rather than being
    // split across two log entries.
    pending = trailing;
    for (const line of parts) emit(line);
  }

  async function pollOnce(): Promise<void> {
    let path = activePath;
    if (path === null) {
      path = await resolveLog();
      if (path === null) {
        if (stopped) return;
        warnIfUnresolvedTooLong();
        return;
      }
      activePath = path;
    }

    let st: WatchdogStat;
    try {
      st = await deps.fs.stat(path);
    } catch (e) {
      // A vanished or replaced log means we can no longer tell whether the
      // child is healthy. Return to `resolving` and re-anchor next time —
      // never treat it as activity, never treat it as silence.
      deps.logger.warn("resolved sync log became unreadable; returning to resolving", {
        vault: vault.slug,
        logPath: path,
        error: errText(e),
      });
      activePath = null;
      inode = null;
      resetCursor();
      return;
    }
    if (stopped) return;

    if (st.inode !== inode || st.size < offset) {
      // Truncated or replaced: read the new file from its start.
      resetCursor();
      inode = st.inode;
    }
    lastSyncActivityAt = st.mtimeMs;

    if (config.logTail) {
      await tail(path, st);
    } else {
      offset = st.size;
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        await pollOnce();
      } catch (e) {
        // Belt-and-braces: a poll must never take the loop down. Reaching
        // here means the injected surface violated its contract.
        deps.logger.warn("sync log poll failed", { vault: vault.slug, error: errText(e) });
      }
      if (stopped) break;
      try {
        await Promise.race([deps.sleep(config.pollIntervalMs), stopSignal]);
      } catch (e) {
        // A rejecting `sleep` leaves the loop with no way to pace itself.
        // Retrying immediately would spin, and letting it escape `void
        // loop()` would surface as an unhandled rejection and take the
        // process down — a worse outcome than the wedge this feature exists
        // to detect. Stand the watchdog down instead; the vault reverts to
        // reporting `resolving` and stays unprotected but running.
        deps.logger.error("sync log poll loop stopped: sleep failed", {
          vault: vault.slug,
          error: errText(e),
        });
        // Report the truth: nothing is watching this log any more.
        stopped = true;
        activePath = null;
        return;
      }
    }
  }

  void loop();

  return {
    snapshot: () => watchdogSnapshot(config, currentMemory(), activePath !== null),
    memory: currentMemory,
    stop: (): void => {
      if (stopped) return;
      stopped = true;
      wake();
    },
  };
}

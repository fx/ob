/**
 * Tests for `src/obsidian/watchdog.ts` — sync-log resolution and the
 * incremental tail.
 *
 * Every filesystem condition is driven through the injected `WatchdogFs` and
 * every timing through the injected clock, so nothing here waits on real
 * wall-clock time or a real filesystem. `watchdog.real.test.ts` covers the
 * same feature areas against a real `Bun.tmpdirSync()` tree.
 *
 * Stall detection is NOT in this PR: nothing here asserts a kill, and a
 * resolved log reports `tailing` rather than `armed`.
 */

import { describe, expect, test } from "bun:test";
import type { SyncWatchdogConfig } from "../../src/config/index.ts";
import { type Logger, createLogger } from "../../src/log.ts";
import {
  DEFAULT_MAX_TAIL_BYTES,
  DISABLED_SYNC_WATCHDOG,
  EMPTY_WATCHDOG_MEMORY,
  type WatchdogDeps,
  type WatchdogHandle,
  startWatchdog,
  watchdogIsDisabled,
  watchdogSnapshot,
} from "../../src/obsidian/watchdog.ts";
import {
  type FakeWatchdogFs,
  type PollDriver,
  createFakeWatchdogFs,
  createPollDriver,
  errno,
} from "../helpers/fakeWatchdogFs.ts";

const SYNC_DIR = "/cfg/obsidian-headless/sync";
const VAULT = { slug: "v", path: "/data/vaults/v" };

const TAIL_ON: SyncWatchdogConfig = {
  stallTimeoutMs: 300_000,
  pollIntervalMs: 30_000,
  logTail: true,
};
const TAIL_OFF: SyncWatchdogConfig = { ...TAIL_ON, logTail: false };

interface Captured {
  readonly level: string;
  readonly msg: string;
  readonly fields: Record<string, unknown>;
}

interface Capture {
  readonly logger: Logger;
  readonly lines: Captured[];
  /** Forwarded `sync.log` lines, in order. */
  tailed(): string[];
  of(msg: string): Captured[];
}

function capture(): Capture {
  const lines: Captured[] = [];
  const logger = createLogger({
    level: "trace",
    write: (raw) => {
      const {
        ts: _ts,
        level,
        msg,
        ...fields
      } = JSON.parse(raw) as {
        ts: string;
        level: string;
        msg: string;
      } & Record<string, unknown>;
      lines.push({ level, msg, fields });
    },
  });
  return {
    logger,
    lines,
    tailed: () =>
      lines
        .filter((l) => l.msg === "ob output" && l.fields.stream === "sync.log")
        .map((l) => String(l.fields.line)),
    of: (msg) => lines.filter((l) => l.msg === msg),
  };
}

function configPath(dir: string): string {
  return `${SYNC_DIR}/${dir}/config.json`;
}
function logPathOf(dir: string): string {
  return `${SYNC_DIR}/${dir}/sync.log`;
}

/** Lay down one resolvable `<dir>/{config.json,sync.log}` pair. */
function seedVaultDir(
  fs: FakeWatchdogFs,
  dir: string,
  opts: { vaultPath?: string; log?: string; configMtime?: number; logMtime?: number } = {},
): void {
  fs.write(
    configPath(dir),
    JSON.stringify({ vaultPath: opts.vaultPath ?? VAULT.path }),
    opts.configMtime ?? 500,
  );
  if (opts.log !== undefined) fs.write(logPathOf(dir), opts.log, opts.logMtime ?? 1_000);
}

function start(
  fs: FakeWatchdogFs,
  driver: PollDriver,
  log: Capture,
  over: Partial<WatchdogDeps> = {},
): WatchdogHandle {
  const deps: WatchdogDeps = {
    now: driver.now,
    sleep: driver.sleep,
    fs,
    logger: log.logger,
    syncDir: SYNC_DIR,
    config: TAIL_ON,
    ...over,
  };
  return startWatchdog(VAULT, deps);
}

describe("watchdogSnapshot / watchdogIsDisabled", () => {
  test("both switches off means disabled", () => {
    expect(watchdogIsDisabled(DISABLED_SYNC_WATCHDOG)).toBe(true);
    expect(watchdogIsDisabled({ ...DISABLED_SYNC_WATCHDOG, logTail: true })).toBe(false);
    expect(watchdogIsDisabled(TAIL_ON)).toBe(false);
  });

  test("disabled reports null logPath and null lastSyncActivityAt even with memory", () => {
    const snap = watchdogSnapshot(
      DISABLED_SYNC_WATCHDOG,
      { logPath: "/x/sync.log", lastSyncActivityAt: 42, stallKills: 3 },
      true,
    );
    expect(snap.lastSyncActivityAt).toBeNull();
    expect(snap.watchdog).toEqual({
      state: "disabled",
      logPath: null,
      thresholdMs: 0,
      pollIntervalMs: 30_000,
      stallKills: 3,
    });
  });

  test("configured but unresolved reports resolving and echoes the effective config", () => {
    const snap = watchdogSnapshot(TAIL_ON, EMPTY_WATCHDOG_MEMORY, false);
    expect(snap.watchdog.state).toBe("resolving");
    expect(snap.watchdog.logPath).toBeNull();
    expect(snap.watchdog.thresholdMs).toBe(300_000);
    expect(snap.watchdog.pollIntervalMs).toBe(30_000);
    expect(snap.lastSyncActivityAt).toBeNull();
  });

  test("a retained logPath survives an unresolved state for a later child", () => {
    const snap = watchdogSnapshot(
      TAIL_ON,
      { logPath: "/x/sync.log", lastSyncActivityAt: 7, stallKills: 1 },
      false,
    );
    expect(snap.watchdog.state).toBe("resolving");
    expect(snap.watchdog.logPath).toBe("/x/sync.log");
    expect(snap.lastSyncActivityAt).toBe(7);
  });
});

describe("watchdog — resolution", () => {
  test("selects the directory whose config.json vaultPath matches", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa", "bbb"]);
    seedVaultDir(fs, "aaa", { vaultPath: "/data/vaults/other", log: "" });
    seedVaultDir(fs, "bbb", { log: "" });

    const wd = start(fs, driver, log);
    await driver.settle();
    const snap = wd.snapshot();
    expect(snap.watchdog.state).toBe("tailing");
    expect(snap.watchdog.logPath).toBe(logPathOf("bbb"));
    expect(log.of("sync log resolved")).toHaveLength(1);
    wd.stop();
  });

  test("a prefix of the vault path is not a match", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { vaultPath: "/data/vaults/vault2", log: "" });

    const wd = start(fs, driver, log);
    await driver.settle();
    expect(wd.snapshot().watchdog.state).toBe("resolving");
    expect(wd.snapshot().watchdog.logPath).toBeNull();
    wd.stop();
  });

  test("a non-normalized vaultPath still matches after normalization", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { vaultPath: "/data/vaults/other/../v", log: "" });

    const wd = start(fs, driver, log);
    await driver.settle();
    expect(wd.snapshot().watchdog.logPath).toBe(logPathOf("aaa"));
    wd.stop();
  });

  test("an absent sync directory leaves the vault dormant and observable", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();

    const wd = start(fs, driver, log);
    await driver.settle();
    await driver.nextPoll();
    await driver.nextPoll();
    const snap = wd.snapshot();
    expect(snap.watchdog.state).toBe("resolving");
    expect(snap.watchdog.logPath).toBeNull();
    expect(snap.lastSyncActivityAt).toBeNull();
    expect(log.lines.some((l) => l.level === "error")).toBe(false);
    wd.stop();
  });

  test("resolution is retried on later polls until it succeeds", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();

    const wd = start(fs, driver, log);
    await driver.settle();
    expect(wd.snapshot().watchdog.state).toBe("resolving");

    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { log: "" });
    await driver.nextPoll();
    expect(wd.snapshot().watchdog.state).toBe("tailing");
    wd.stop();
  });

  test("an unreadable config.json is skipped without aborting the scan", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["junk", "bbb"]);
    seedVaultDir(fs, "bbb", { log: "" });
    fs.write(configPath("junk"), "{}", 400);
    fs.fail(configPath("junk"), errno("EACCES", configPath("junk")));

    const wd = start(fs, driver, log);
    await driver.settle();
    expect(wd.snapshot().watchdog.logPath).toBe(logPathOf("bbb"));
    wd.stop();
  });

  test("a missing config.json is skipped without aborting the scan", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["empty", "bbb"]);
    seedVaultDir(fs, "bbb", { log: "" });

    const wd = start(fs, driver, log);
    await driver.settle();
    expect(wd.snapshot().watchdog.logPath).toBe(logPathOf("bbb"));
    wd.stop();
  });

  test("a malformed config.json is skipped without aborting the scan", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["broken", "bbb"]);
    seedVaultDir(fs, "bbb", { log: "" });
    fs.write(configPath("broken"), "{ not json", 400);

    const wd = start(fs, driver, log);
    await driver.settle();
    expect(wd.snapshot().watchdog.logPath).toBe(logPathOf("bbb"));
    wd.stop();
  });

  test("a config.json that is not an object, or lacks a string vaultPath, is skipped", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["nullish", "numeric", "bbb"]);
    seedVaultDir(fs, "bbb", { log: "" });
    fs.write(configPath("nullish"), "null", 400);
    fs.write(configPath("numeric"), JSON.stringify({ vaultPath: 7 }), 400);

    const wd = start(fs, driver, log);
    await driver.settle();
    expect(wd.snapshot().watchdog.logPath).toBe(logPathOf("bbb"));
    wd.stop();
  });

  test("ambiguity resolves to the newest config.json and warns naming every candidate", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["stale", "fresh"]);
    seedVaultDir(fs, "stale", { log: "", configMtime: 100 });
    seedVaultDir(fs, "fresh", { log: "", configMtime: 900 });

    const wd = start(fs, driver, log);
    await driver.settle();
    expect(wd.snapshot().watchdog.logPath).toBe(logPathOf("fresh"));
    const warns = log.of("multiple sync directories match this vault");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.fields.candidates).toEqual(["stale", "fresh"]);
    wd.stop();
  });

  test("an exact mtime tie breaks to the lexicographically greatest directory", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["zzz", "aaa"]);
    seedVaultDir(fs, "zzz", { log: "", configMtime: 500 });
    seedVaultDir(fs, "aaa", { log: "", configMtime: 500 });

    const wd = start(fs, driver, log);
    await driver.settle();
    expect(wd.snapshot().watchdog.logPath).toBe(logPathOf("zzz"));
    wd.stop();
  });

  test("a matching directory whose sync.log does not exist yet stays resolving", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa");

    const wd = start(fs, driver, log);
    await driver.settle();
    expect(wd.snapshot().watchdog.state).toBe("resolving");

    fs.write(logPathOf("aaa"), "", 1_000);
    await driver.nextPoll();
    expect(wd.snapshot().watchdog.state).toBe("tailing");
    wd.stop();
  });

  test("warns exactly once per child lifetime when still unresolved past the threshold", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();

    const wd = start(fs, driver, log);
    await driver.settle();
    expect(log.of("sync log still unresolved; this vault is unprotected")).toHaveLength(0);

    driver.advance(299_000);
    await driver.nextPoll();
    expect(log.of("sync log still unresolved; this vault is unprotected")).toHaveLength(0);

    driver.advance(2_000);
    await driver.nextPoll();
    await driver.nextPoll();
    await driver.nextPoll();
    const warns = log.of("sync log still unresolved; this vault is unprotected");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.fields.syncDir).toBe(SYNC_DIR);
    expect(warns[0]?.fields.vault).toBe("v");
    wd.stop();
  });

  test("with stall detection off the unresolved warning falls back to the default timer", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();

    const wd = start(fs, driver, log, { config: { ...TAIL_ON, stallTimeoutMs: 0 } });
    await driver.settle();
    driver.advance(299_999);
    await driver.nextPoll();
    expect(log.of("sync log still unresolved; this vault is unprotected")).toHaveLength(0);
    driver.advance(1);
    await driver.nextPoll();
    expect(log.of("sync log still unresolved; this vault is unprotected")).toHaveLength(1);
    wd.stop();
  });
});

describe("watchdog — tail", () => {
  test("does not replay the backlog, and emits only what is appended after", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    const backlog = `${Array.from({ length: 20_000 }, (_, i) => `old line ${i}`).join("\n")}\n`;
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { log: backlog });

    const wd = start(fs, driver, log);
    await driver.settle();
    expect(log.tailed()).toEqual([]);

    fs.append(logPathOf("aaa"), "Fully synced\n", 2_000);
    await driver.nextPoll();
    expect(log.tailed()).toEqual(["Fully synced"]);
    wd.stop();
  });

  test("resolution on a line boundary discards nothing", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { log: "Connecting...\n" });

    const wd = start(fs, driver, log);
    await driver.settle();
    fs.append(logPathOf("aaa"), "Fully synced\n", 2_000);
    await driver.nextPoll();
    expect(log.tailed()).toEqual(["Fully synced"]);
    wd.stop();
  });

  test("resolution on an empty file treats byte 0 as a boundary", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { log: "" });

    const wd = start(fs, driver, log);
    await driver.settle();
    fs.append(logPathOf("aaa"), "first line\n", 2_000);
    await driver.nextPoll();
    expect(log.tailed()).toEqual(["first line"]);
    wd.stop();
  });

  test("resolution mid-line drops the straddling line and emits the next one", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { log: "Connect" });

    const wd = start(fs, driver, log);
    await driver.settle();
    fs.append(logPathOf("aaa"), "ing...\n", 2_000);
    await driver.nextPoll();
    fs.append(logPathOf("aaa"), "Fully synced\n", 3_000);
    await driver.nextPoll();
    expect(log.tailed()).toEqual(["Fully synced"]);
    wd.stop();
  });

  test("a mid-line anchor stays in discard until a newline actually arrives", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { log: "Conn" });

    const wd = start(fs, driver, log);
    await driver.settle();
    fs.append(logPathOf("aaa"), "ect", 2_000);
    await driver.nextPoll();
    expect(log.tailed()).toEqual([]);
    fs.append(logPathOf("aaa"), "ing...\nFully synced\n", 3_000);
    await driver.nextPoll();
    expect(log.tailed()).toEqual(["Fully synced"]);
    wd.stop();
  });

  test("an incomplete trailing line is buffered until its newline arrives", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { log: "" });

    const wd = start(fs, driver, log);
    await driver.settle();
    fs.append(logPathOf("aaa"), "Fully ", 2_000);
    await driver.nextPoll();
    expect(log.tailed()).toEqual([]);
    fs.append(logPathOf("aaa"), "synced\n", 3_000);
    await driver.nextPoll();
    expect(log.tailed()).toEqual(["Fully synced"]);
    wd.stop();
  });

  test("empty lines are never forwarded", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { log: "" });

    const wd = start(fs, driver, log);
    await driver.settle();
    fs.append(logPathOf("aaa"), "one\n\n\ntwo\n", 2_000);
    await driver.nextPoll();
    expect(log.tailed()).toEqual(["one", "two"]);
    wd.stop();
  });

  test("forwarded lines carry the same field shape as stdio forwarding", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { log: "" });

    const wd = start(fs, driver, log);
    await driver.settle();
    fs.append(logPathOf("aaa"), "Fully synced\n", 2_000);
    await driver.nextPoll();
    const line = log.of("ob output")[0];
    expect(line?.level).toBe("info");
    expect(line?.fields).toEqual({
      vault: "v",
      source: "ob",
      stream: "sync.log",
      line: "Fully synced",
    });
    wd.stop();
  });

  test("truncation under the tail re-reads from byte zero, emitting each line once", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { log: "x".repeat(4_096) });

    const wd = start(fs, driver, log);
    await driver.settle();
    // Same inode, smaller size — a truncation rather than a rotation.
    fs.write(logPathOf("aaa"), "line one\nline two\n", 2_000);
    await driver.nextPoll();
    expect(log.tailed()).toEqual(["line one", "line two"]);
    expect(log.lines.some((l) => l.level === "error")).toBe(false);
    wd.stop();
  });

  test("a replacement inode is read from the start even when the file grew", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { log: "short\n" });

    const wd = start(fs, driver, log);
    await driver.settle();
    fs.replaceFile(logPathOf("aaa"), "rotated one\nrotated two\n", {
      mtimeMs: 2_000,
      inode: "rotated",
    });
    await driver.nextPoll();
    expect(log.tailed()).toEqual(["rotated one", "rotated two"]);
    wd.stop();
  });

  test("an append past the per-poll cap skips ahead, warns, and drops the partial line", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { log: "" });

    const wd = start(fs, driver, log, { maxTailBytes: 32 });
    await driver.settle();
    fs.append(logPathOf("aaa"), `${"a".repeat(100)}\nkept one\nkept two\n`, 2_000);
    await driver.nextPoll();
    expect(log.tailed()).toEqual(["kept one", "kept two"]);
    const warns = log.of("sync log append exceeded the per-poll cap; skipped ahead");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.fields.capBytes).toBe(32);
    expect(warns[0]?.fields.skippedBytes).toBe(119 - 32);
    wd.stop();
  });

  test("an over-cap span that lands on a line boundary discards nothing", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { log: "" });

    // 9 bytes of prefix + a 10-byte tail, capped at 10: the retained span
    // starts at byte 9, immediately after the prefix's newline. Nothing was
    // cut mid-line, so both complete lines must survive.
    const wd = start(fs, driver, log, { maxTailBytes: 10 });
    await driver.settle();
    fs.append(logPathOf("aaa"), "junkjunk\nkept\nmore\n", 2_000);
    await driver.nextPoll();
    expect(log.tailed()).toEqual(["kept", "more"]);
    const warns = log.of("sync log append exceeded the per-poll cap; skipped ahead");
    expect(warns).toHaveLength(1);
    expect(warns[0]?.fields.skippedBytes).toBe(9);
    wd.stop();
  });

  test("the per-poll cap defaults to 262144 bytes when not injected", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { log: "" });

    const wd = start(fs, driver, log);
    await driver.settle();
    fs.append(logPathOf("aaa"), `${"a".repeat(DEFAULT_MAX_TAIL_BYTES + 10)}\nkept\n`, 2_000);
    await driver.nextPoll();
    expect(log.tailed()).toEqual(["kept"]);
    expect(log.of("sync log append exceeded the per-poll cap; skipped ahead")).toHaveLength(1);
    wd.stop();
  });

  test("a read error is warned and does not stop later polls", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { log: "" });

    const wd = start(fs, driver, log);
    await driver.settle();
    fs.append(logPathOf("aaa"), "lost\n", 2_000);
    const boom = new Error("EIO: read failed");
    // Fail only the ranged read; `stat` succeeded a moment earlier.
    const original = fs.readRange.bind(fs);
    let failNext = true;
    Object.assign(fs, {
      readRange: async (p: string, s: number, e: number): Promise<Uint8Array> => {
        if (failNext) {
          failNext = false;
          throw boom;
        }
        return original(p, s, e);
      },
    });
    await driver.nextPoll();
    expect(log.of("sync log read failed")).toHaveLength(1);
    expect(log.tailed()).toEqual([]);

    fs.append(logPathOf("aaa"), "found\n", 3_000);
    await driver.nextPoll();
    expect(log.tailed()).toEqual(["lost", "found"]);
    wd.stop();
  });

  test("a failing boundary probe warns and discards the first line", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { log: "Connecting..." });
    const original = fs.readRange.bind(fs);
    let probed = false;
    Object.assign(fs, {
      readRange: async (p: string, s: number, e: number): Promise<Uint8Array> => {
        if (!probed) {
          probed = true;
          throw new Error("EIO: probe failed");
        }
        return original(p, s, e);
      },
    });

    const wd = start(fs, driver, log);
    await driver.settle();
    expect(log.of("sync log boundary probe failed; discarding first line")).toHaveLength(1);
    fs.append(logPathOf("aaa"), "\nFully synced\n", 2_000);
    await driver.nextPoll();
    expect(log.tailed()).toEqual(["Fully synced"]);
    wd.stop();
  });

  test("tailing off keeps resolution and lastSyncActivityAt but forwards nothing", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { log: "" });

    const wd = start(fs, driver, log, { config: TAIL_OFF });
    await driver.settle();
    fs.append(logPathOf("aaa"), "Fully synced\n", 2_000);
    await driver.nextPoll();
    expect(log.tailed()).toEqual([]);
    expect(wd.snapshot().lastSyncActivityAt).toBe(2_000);
    expect(wd.snapshot().watchdog.state).toBe("tailing");
    expect(fs.rangeCalls.filter((c) => c.path === logPathOf("aaa"))).toHaveLength(0);
    wd.stop();
  });
});

describe("watchdog — activity reporting and memory", () => {
  test("lastSyncActivityAt tracks the most recently observed mtime", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { log: "", logMtime: 1_111 });

    const wd = start(fs, driver, log);
    await driver.settle();
    expect(wd.snapshot().lastSyncActivityAt).toBe(1_111);

    fs.append(logPathOf("aaa"), "tick\n", 2_222);
    await driver.nextPoll();
    expect(wd.snapshot().lastSyncActivityAt).toBe(2_222);
    // Nothing is ever killed in this PR, so the count stays at zero.
    expect(wd.snapshot().watchdog.stallKills).toBe(0);
    wd.stop();
  });

  test("a vanished log returns to resolving while retaining the evidence", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { log: "", logMtime: 1_500 });

    const wd = start(fs, driver, log);
    await driver.settle();
    expect(wd.snapshot().watchdog.state).toBe("tailing");

    fs.remove(logPathOf("aaa"));
    await driver.nextPoll();
    const snap = wd.snapshot();
    expect(snap.watchdog.state).toBe("resolving");
    expect(snap.watchdog.logPath).toBe(logPathOf("aaa"));
    expect(snap.lastSyncActivityAt).toBe(1_500);
    expect(log.of("resolved sync log became unreadable; returning to resolving")).toHaveLength(1);

    // Re-resolves cleanly once the log comes back, without replaying it.
    fs.write(logPathOf("aaa"), "reborn\n", 3_000);
    await driver.nextPoll();
    expect(wd.snapshot().watchdog.state).toBe("tailing");
    expect(log.tailed()).toEqual([]);
    wd.stop();
  });

  test("memory() carries logPath and lastSyncActivityAt into the next child", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { log: "", logMtime: 4_242 });

    const first = start(fs, driver, log);
    await driver.settle();
    const memory = first.memory();
    first.stop();
    expect(memory).toEqual({
      logPath: logPathOf("aaa"),
      lastSyncActivityAt: 4_242,
      stallKills: 0,
    });

    // The replacement child starts unresolved but still shows the evidence.
    const driver2 = createPollDriver();
    const fs2 = createFakeWatchdogFs();
    const second = startWatchdog(VAULT, {
      now: driver2.now,
      sleep: driver2.sleep,
      fs: fs2,
      logger: log.logger,
      syncDir: SYNC_DIR,
      config: TAIL_ON,
      memory,
    });
    await driver2.settle();
    const snap = second.snapshot();
    expect(snap.watchdog.state).toBe("resolving");
    expect(snap.watchdog.logPath).toBe(logPathOf("aaa"));
    expect(snap.lastSyncActivityAt).toBe(4_242);
    expect(snap.watchdog.stallKills).toBe(0);
    second.stop();
  });
});

describe("watchdog — lifecycle", () => {
  test("stop() is idempotent and prevents any further poll", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { log: "" });

    const wd = start(fs, driver, log);
    await driver.settle();
    wd.stop();
    wd.stop();

    // Releasing the parked sleep must not produce another poll.
    fs.append(logPathOf("aaa"), "after stop\n", 9_000);
    driver.release();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(log.tailed()).toEqual([]);
  });

  test("the poll sleep uses the configured interval", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();

    const wd = start(fs, driver, log, { config: { ...TAIL_ON, pollIntervalMs: 5_000 } });
    await driver.settle();
    expect(driver.sleeps[0]).toBe(5_000);
    wd.stop();
  });

  test("stop() during an in-flight resolution commits nothing and emits nothing", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { log: "" });
    // Hold the directory scan open so `stop()` lands mid-poll.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const realReadDir = fs.readDir.bind(fs);
    Object.assign(fs, {
      readDir: async (p: string): Promise<readonly string[]> => {
        await gate;
        return realReadDir(p);
      },
    });

    const wd = start(fs, driver, log);
    wd.stop();
    release();
    for (let i = 0; i < 50; i++) await Promise.resolve();
    const snap = wd.snapshot();
    expect(snap.watchdog.state).toBe("resolving");
    expect(snap.watchdog.logPath).toBeNull();
    expect(log.of("sync log resolved")).toHaveLength(0);
    expect(log.of("sync log still unresolved; this vault is unprotected")).toHaveLength(0);
  });

  test("stop() during an in-flight tail read forwards nothing", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { log: "" });

    const wd = start(fs, driver, log);
    await driver.settle();
    fs.append(logPathOf("aaa"), "late line\n", 2_000);

    // Hold the ranged read open, run one poll into it, then stop mid-flight.
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const realReadRange = fs.readRange.bind(fs);
    Object.assign(fs, {
      readRange: async (p: string, s: number, e: number): Promise<Uint8Array> => {
        await gate;
        return realReadRange(p, s, e);
      },
    });
    driver.release();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    wd.stop();
    release();
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(log.tailed()).toEqual([]);
  });

  test("stop() during a failing stat neither warns nor unresolves", async () => {
    // The rejection paths need the same guard as the success paths: a child
    // that has exited must produce no watchdog output at all.
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { log: "" });

    const wd = start(fs, driver, log);
    await driver.settle();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    Object.assign(fs, {
      stat: async (): Promise<never> => {
        await gate;
        throw errno("ENOENT", logPathOf("aaa"));
      },
    });
    driver.release();
    for (let i = 0; i < 10; i++) await Promise.resolve();
    wd.stop();
    release();
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(log.of("resolved sync log became unreadable; returning to resolving")).toHaveLength(0);
    expect(wd.snapshot().watchdog.state).toBe("tailing");
  });

  test("a rejecting sleep stands the watchdog down instead of escaping as an unhandled rejection", async () => {
    const fs = createFakeWatchdogFs();
    const log = capture();
    fs.addDir(SYNC_DIR, ["aaa"]);
    seedVaultDir(fs, "aaa", { log: "" });

    const wd = start(fs, createPollDriver(), log, {
      sleep: async (): Promise<void> => {
        throw new Error("timer subsystem is gone");
      },
    });
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(log.of("sync log poll loop stopped: sleep failed")).toHaveLength(1);
    // The surface must not keep claiming a log is being watched.
    expect(wd.snapshot().watchdog.state).toBe("resolving");
    wd.stop();
  });

  test("a poll that throws is logged and the loop keeps going", async () => {
    const fs = createFakeWatchdogFs();
    const driver = createPollDriver();
    const log = capture();
    // A surface that violates its contract: `readDir` resolving to a
    // non-iterable makes the scan throw outside every inner guard.
    Object.assign(fs, {
      readDir: async (): Promise<readonly string[]> => null as unknown as readonly string[],
    });

    const wd = start(fs, driver, log);
    await driver.settle();
    expect(log.of("sync log poll failed")).toHaveLength(1);
    await driver.nextPoll();
    expect(log.of("sync log poll failed")).toHaveLength(2);
    wd.stop();
  });
});

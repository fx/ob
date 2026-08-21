/**
 * `VaultChild` ↔ watchdog integration.
 *
 * The child owns the watchdog's lifecycle: start it after a successful spawn,
 * stop it on every path out of the attempt, and fold its snapshot into
 * `VaultStatus`. Nothing here kills a child — the stall verdict, its kill
 * escalation, and its accounting live in `child.stall.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import type { SyncWatchdogConfig } from "../../src/config/index.ts";
import { createLogger } from "../../src/log.ts";
import { VaultChild } from "../../src/obsidian/child.ts";
import { DISABLED_SYNC_WATCHDOG } from "../../src/obsidian/watchdog.ts";
import { createFakeSpawner } from "../helpers/fakeSpawner.ts";
import {
  type FakeWatchdogFs,
  createFakeWatchdogFs,
  createPollDriver,
} from "../helpers/fakeWatchdogFs.ts";

const silentLog = createLogger({ level: "error", write: () => undefined });
const VAULT = { name: "v", slug: "v", path: "/data/vaults/v" };
const SYNC_DIR = "/cfg/obsidian-headless/sync";

const TAIL_ON: SyncWatchdogConfig = {
  stallTimeoutMs: 300_000,
  pollIntervalMs: 30_000,
  logTail: true,
};

/** Drain the macrotask queue so the run loop can advance between assertions. */
async function flush(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

function seed(fs: FakeWatchdogFs, dir: string, log = ""): string {
  fs.addDir(SYNC_DIR, [dir]);
  fs.write(`${SYNC_DIR}/${dir}/config.json`, JSON.stringify({ vaultPath: VAULT.path }), 500);
  fs.write(`${SYNC_DIR}/${dir}/sync.log`, log, 1_234);
  return `${SYNC_DIR}/${dir}/sync.log`;
}

describe("VaultChild — watchdog absent", () => {
  test("reports a fully-formed disabled watchdog before anything is spawned", () => {
    const child = new VaultChild(VAULT, {
      spawner: createFakeSpawner(),
      logger: silentLog,
      now: () => 0,
      sleep: async () => undefined,
    });
    const snap = child.snapshot();
    expect(snap.lastSyncActivityAt).toBeNull();
    expect(snap.watchdog).toEqual({
      state: "disabled",
      logPath: null,
      thresholdMs: 0,
      pollIntervalMs: 30_000,
      stallKills: 0,
    });
  });

  test("a fully-disabled configuration never touches the filesystem", async () => {
    const fs = createFakeWatchdogFs();
    seed(fs, "aaa");
    const sp = createFakeSpawner();
    let resolveExit!: (n: number) => void;
    sp.enqueue({
      exitWhen: new Promise<number>((r) => {
        resolveExit = r;
      }),
    });
    const child = new VaultChild(VAULT, {
      spawner: sp,
      logger: silentLog,
      now: () => 0,
      sleep: async () => undefined,
      watchdog: { config: DISABLED_SYNC_WATCHDOG, fs, syncDir: SYNC_DIR },
    });
    const loop = child.start();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(child.snapshot().watchdog.state).toBe("disabled");
    expect(fs.rangeCalls).toHaveLength(0);
    child.requestStop();
    resolveExit(0);
    await loop;
  });
});

describe("VaultChild — watchdog wired", () => {
  test("starts after spawn, tails into the parent logger, and reports through snapshot()", async () => {
    const fs = createFakeWatchdogFs();
    const logPath = seed(fs, "aaa");
    const driver = createPollDriver();
    const tailed: string[] = [];
    const logger = createLogger({
      level: "trace",
      write: (raw) => {
        const obj = JSON.parse(raw) as { msg: string; stream?: string; line?: string };
        if (obj.msg === "ob output" && obj.stream === "sync.log") tailed.push(String(obj.line));
      },
    });

    const sp = createFakeSpawner();
    let resolveExit!: (n: number) => void;
    sp.enqueue({
      pid: 4242,
      exitWhen: new Promise<number>((r) => {
        resolveExit = r;
      }),
    });
    const child = new VaultChild(VAULT, {
      spawner: sp,
      logger,
      now: driver.now,
      sleep: driver.sleep,
      watchdog: { config: TAIL_ON, fs, syncDir: SYNC_DIR },
    });
    const loop = child.start();
    await driver.settle();

    const running = child.snapshot();
    expect(running.state).toBe("running");
    expect(running.watchdog.state).toBe("armed");
    expect(running.watchdog.logPath).toBe(logPath);
    expect(running.watchdog.thresholdMs).toBe(300_000);
    expect(running.lastSyncActivityAt).toBe(1_234);

    fs.append(logPath, "Fully synced\n", 5_000);
    await driver.nextPoll();
    expect(tailed).toEqual(["Fully synced"]);
    expect(child.snapshot().lastSyncActivityAt).toBe(5_000);

    child.requestStop();
    resolveExit(0);
    await loop;

    // Retained after the child is gone: the evidence outlives the process.
    const stopped = child.snapshot();
    expect(stopped.watchdog.state).toBe("resolving");
    expect(stopped.watchdog.logPath).toBe(logPath);
    expect(stopped.lastSyncActivityAt).toBe(5_000);
  });

  test("no poll runs once the child has exited", async () => {
    const fs = createFakeWatchdogFs();
    const logPath = seed(fs, "aaa");
    const driver = createPollDriver();
    const tailed: string[] = [];
    const logger = createLogger({
      level: "trace",
      write: (raw) => {
        const obj = JSON.parse(raw) as { msg: string; stream?: string; line?: string };
        if (obj.msg === "ob output" && obj.stream === "sync.log") tailed.push(String(obj.line));
      },
    });

    const sp = createFakeSpawner();
    let resolveExit!: (n: number) => void;
    sp.enqueue({
      exitWhen: new Promise<number>((r) => {
        resolveExit = r;
      }),
    });
    const child = new VaultChild(VAULT, {
      spawner: sp,
      logger,
      now: driver.now,
      sleep: driver.sleep,
      watchdog: { config: TAIL_ON, fs, syncDir: SYNC_DIR },
    });
    const loop = child.start();
    await driver.settle();

    child.requestStop();
    resolveExit(0);
    await loop;

    // Anything appended now belongs to no child; releasing the parked sleep
    // must not resurrect the poll.
    fs.append(logPath, "orphan line\n", 9_000);
    driver.release();
    for (let i = 0; i < 30; i++) await Promise.resolve();
    expect(tailed).toEqual([]);
  });

  test("a replacement child re-resolves while keeping the previous evidence", async () => {
    const fs = createFakeWatchdogFs();
    const logPath = seed(fs, "aaa");
    const driver = createPollDriver();

    const sp = createFakeSpawner();
    let resolveFirst!: (n: number) => void;
    sp.enqueue({
      exitWhen: new Promise<number>((r) => {
        resolveFirst = r;
      }),
    });
    let resolveSecond!: (n: number) => void;
    sp.enqueue({
      exitWhen: new Promise<number>((r) => {
        resolveSecond = r;
      }),
    });

    const child = new VaultChild(VAULT, {
      spawner: sp,
      logger: silentLog,
      now: driver.now,
      sleep: driver.sleep,
      watchdog: { config: TAIL_ON, fs, syncDir: SYNC_DIR },
      crashLoop: { windowMs: 60_000, maxCrashes: 100, healthyResetMs: 1_000_000 },
    });
    const loop = child.start();

    // First child resolves its log, then crashes.
    await driver.settle();
    expect(child.snapshot().watchdog.state).toBe("armed");
    // The sync directory disappears before the replacement spawns, so the
    // new child genuinely cannot resolve a log.
    fs.remove(`${SYNC_DIR}/aaa/config.json`);
    resolveFirst(1);
    await flush();
    // Wake the restart backoff so the replacement child spawns.
    driver.release();
    await driver.settle();

    const snap = child.snapshot();
    expect(sp.calls).toHaveLength(2);
    expect(snap.watchdog.state).toBe("resolving");
    // `logPath` and `lastSyncActivityAt` survive from the previous child.
    expect(snap.watchdog.logPath).toBe(logPath);
    expect(snap.lastSyncActivityAt).toBe(1_234);

    child.requestStop();
    resolveSecond(0);
    await loop;
  });
});

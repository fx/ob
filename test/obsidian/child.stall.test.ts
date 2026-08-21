/**
 * `VaultChild` ↔ stall watchdog: the kill, the escalation, and the accounting.
 *
 * Every duration here — the stall threshold, the SIGTERM→SIGKILL grace, and
 * the restart backoff — moves through the injected clock and the injected
 * sleep. Nothing waits on real wall-clock time, and the three durations are
 * deliberately distinct so a test can release exactly one of them.
 *
 * A "wedged" child is the fixture the whole feature turns on: a scripted
 * handle whose `exitWhen` promise is resolved only by the test's own `onKill`
 * hook, so it stays alive and never settles `exited` until something signals
 * it — exactly like the production child that hung for four and a half days.
 */

import { describe, expect, test } from "bun:test";
import type { SyncWatchdogConfig } from "../../src/config/index.ts";
import { buildHttpApp } from "../../src/http/index.ts";
import type { Indexer, IndexerStatus } from "../../src/indexer/index.ts";
import { type Logger, createLogger } from "../../src/log.ts";
import {
  DEFAULT_STALL_KILL_GRACE_MS,
  DEFAULT_STALL_LOOP,
  type StallLoop,
  VaultChild,
} from "../../src/obsidian/child.ts";
import type { Supervisor } from "../../src/obsidian/index.ts";
import { DISABLED_SYNC_WATCHDOG } from "../../src/obsidian/watchdog.ts";
import { createFakeSpawner } from "../helpers/fakeSpawner.ts";
import { type FakeWatchdogFs, createFakeWatchdogFs } from "../helpers/fakeWatchdogFs.ts";

const VAULT = { name: "v", slug: "v", path: "/data/vaults/v" };
const SYNC_DIR = "/cfg/obsidian-headless/sync";
const LOG_PATH = `${SYNC_DIR}/aaa/sync.log`;

const POLL_MS = 30_000;
const THRESHOLD_MS = 300_000;
const GRACE_MS = 10_000;
const BACKOFF_MS = 1_000;

const ARMED: SyncWatchdogConfig = {
  stallTimeoutMs: THRESHOLD_MS,
  pollIntervalMs: POLL_MS,
  logTail: true,
};

interface Sleeper {
  readonly ms: number;
  readonly resume: () => void;
}

/**
 * A sleep seam that parks every caller and hands the test the key. Unlike
 * `createPollDriver` it keeps ALL parked sleepers, so the poll interval, the
 * stall-kill grace, and the restart backoff can be in flight at once and
 * released independently.
 */
interface StallDriver {
  now(): number;
  advance(ms: number): void;
  sleep(ms: number): Promise<void>;
  /** How many sleepers are parked on exactly `ms`. */
  count(ms: number): number;
  /** Resolve and forget every sleeper parked on exactly `ms`. */
  release(ms: number): void;
  /** Every sleep duration requested so far, in order. */
  readonly requested: readonly number[];
}

function createStallDriver(): StallDriver {
  let clock = 0;
  const parked: Sleeper[] = [];
  const requested: number[] = [];
  return {
    requested,
    now: () => clock,
    advance: (ms): void => {
      clock += ms;
    },
    sleep: (ms): Promise<void> => {
      requested.push(ms);
      return new Promise<void>((resume) => {
        parked.push({ ms, resume });
      });
    },
    count: (ms): number => parked.filter((s) => s.ms === ms).length,
    release: (ms): void => {
      const hits = parked.filter((s) => s.ms === ms);
      for (let i = parked.length - 1; i >= 0; i--) {
        if (parked[i]?.ms === ms) parked.splice(i, 1);
      }
      for (const s of hits) s.resume();
    },
  };
}

/** Drain macrotasks until `pred` holds, so no test waits on real time. */
async function until(pred: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (pred()) return;
    await new Promise<void>((r) => setTimeout(r, 0));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function seedLog(fs: FakeWatchdogFs, mtimeMs = 1_000): void {
  fs.addDir(SYNC_DIR, ["aaa"]);
  fs.write(`${SYNC_DIR}/aaa/config.json`, JSON.stringify({ vaultPath: VAULT.path }), 500);
  fs.write(LOG_PATH, "", mtimeMs);
}

interface Harness {
  readonly child: VaultChild;
  readonly loop: Promise<void>;
  readonly fs: FakeWatchdogFs;
  readonly driver: StallDriver;
  readonly signals: readonly NodeJS.Signals[];
  readonly logged: ReadonlyArray<{ level: string; msg: string }>;
  /** Exit the child currently in flight with `code`, as if it crashed. */
  crashCurrent(code: number): void;
  /** Wait for the poll loop to park, advance past the threshold, and poll. */
  stallOnce(): Promise<void>;
  /** Release the poll sleep once without moving the clock. */
  poll(): Promise<void>;
  /** Wait until the watchdog has resolved a log for the child in flight. */
  awaitArmed(): Promise<void>;
}

interface HarnessOpts {
  /** How the scripted child reacts to a signal. Default: SIGTERM exits 0. */
  readonly ignoreSigterm?: boolean;
  readonly children?: number;
  readonly stallLoop?: StallLoop;
  readonly config?: SyncWatchdogConfig;
}

/**
 * Wire a `VaultChild` to a run of scripted wedged children. Each child exits
 * only when signalled: with `ignoreSigterm`, only `SIGKILL` ends it — the
 * child that holds `/readyz` hostage for the whole grace window.
 */
function harness(opts: HarnessOpts = {}): Harness {
  const fs = createFakeWatchdogFs();
  seedLog(fs);
  const driver = createStallDriver();
  const signals: NodeJS.Signals[] = [];
  const logged: Array<{ level: string; msg: string }> = [];
  const logger: Logger = createLogger({
    level: "trace",
    write: (raw) => {
      const obj = JSON.parse(raw) as { level: string; msg: string };
      logged.push({ level: obj.level, msg: obj.msg });
    },
  });

  const sp = createFakeSpawner();
  const exits: Array<(code: number) => void> = [];
  for (let i = 0; i < (opts.children ?? 4); i++) {
    let resolveExit!: (code: number) => void;
    const exitWhen = new Promise<number>((r) => {
      resolveExit = r;
    });
    exits.push(resolveExit);
    sp.enqueue({
      pid: 1_000 + i,
      exitWhen,
      onKill: (sig) => {
        signals.push(sig);
        if (opts.ignoreSigterm !== true || sig === "SIGKILL") {
          // A child with a SIGTERM handler exits 0. Classification MUST NOT
          // key off that, or a wedging vault restarts forever.
          resolveExit(sig === "SIGKILL" ? 137 : 0);
        }
      },
    });
  }

  const child = new VaultChild(VAULT, {
    spawner: sp,
    logger,
    now: driver.now,
    sleep: driver.sleep,
    backoff: { initialMs: BACKOFF_MS, factor: 2, capMs: 60_000 },
    stallKillGraceMs: GRACE_MS,
    ...(opts.stallLoop !== undefined ? { stallLoop: opts.stallLoop } : {}),
    watchdog: { config: opts.config ?? ARMED, fs, syncDir: SYNC_DIR },
  });
  const loop = child.start();

  const awaitArmed = (): Promise<void> =>
    until(() => child.snapshot().watchdog.state === "armed", "watchdog armed");
  const poll = async (): Promise<void> => {
    await until(() => driver.count(POLL_MS) > 0, "poll parked");
    driver.release(POLL_MS);
  };

  return {
    child,
    loop,
    fs,
    driver,
    signals,
    logged,
    awaitArmed,
    poll,
    crashCurrent: (code): void => {
      const next = exits.shift();
      next?.(code);
    },
    async stallOnce(): Promise<void> {
      await awaitArmed();
      // Consume the exit slot belonging to the child being killed, so a later
      // `crashCurrent()` addresses the child actually in flight.
      exits.shift();
      await until(() => driver.count(POLL_MS) > 0, "poll parked");
      driver.advance(THRESHOLD_MS);
      driver.release(POLL_MS);
    },
  };
}

describe("stall defaults", () => {
  test("match the spec: 3 kills in 60 minutes, 10 s SIGKILL grace", () => {
    expect(DEFAULT_STALL_LOOP).toEqual({ windowMs: 60 * 60_000, maxStalls: 3 });
    expect(DEFAULT_STALL_KILL_GRACE_MS).toBe(10_000);
  });
});

describe("VaultChild — wedged child is killed and restarted", () => {
  test("SIGTERM, restart, and a lastError naming the stall", async () => {
    const h = harness();
    await h.stallOnce();

    await until(() => h.signals.length > 0, "SIGTERM sent");
    expect(h.signals).toEqual(["SIGTERM"]);

    await until(() => h.child.snapshot().restarts === 1, "restart counted");
    const snap = h.child.snapshot();
    expect(snap.lastError).toContain("sync stalled: no sync.log activity for 300000ms");
    expect(snap.lastError).toContain("last activity 1970-01-01T00:00:01.000Z");
    expect(snap.watchdog.stallKills).toBe(1);
    // The evidence survives the child that produced it.
    expect(snap.watchdog.logPath).toBe(LOG_PATH);
    expect(snap.lastSyncActivityAt).toBe(1_000);

    // The ordinary restart machinery takes over unchanged.
    await until(() => h.driver.count(BACKOFF_MS) > 0, "backoff parked");
    h.driver.release(BACKOFF_MS);
    await until(() => h.child.snapshot().state === "running", "replacement running");

    h.child.requestStop();
    h.crashCurrent(0);
    await h.loop;
  });

  test("a stall kill is classified by the verdict, not by the exit code 0 it produced", async () => {
    const h = harness();
    await h.stallOnce();
    await until(() => h.child.snapshot().restarts === 1, "restart counted");
    // The scripted child exits 0 on SIGTERM. Read as a clean exit it would
    // have skipped stall accounting entirely.
    expect(h.child.snapshot().lastError).toContain("sync stalled");
    expect(h.logged.some((l) => l.msg === "sync log stalled; killing child")).toBe(true);

    h.child.requestStop();
    h.crashCurrent(0);
    await h.loop;
  });
});

describe("VaultChild — SIGTERM ignored", () => {
  test("the vault is already unready during the grace window, then SIGKILL lands", async () => {
    const h = harness({ ignoreSigterm: true });
    await h.stallOnce();
    await until(() => h.signals.length > 0, "SIGTERM sent");

    // The child is still alive. It must NOT be able to hold /readyz at 200.
    expect(h.signals).toEqual(["SIGTERM"]);
    const during = h.child.snapshot();
    expect(during.state).toBe("starting");
    expect(during.lastError).toContain("sync stalled");
    expect(during.restarts).toBe(0);

    await until(() => h.driver.count(GRACE_MS) > 0, "grace parked");
    h.driver.release(GRACE_MS);
    await until(() => h.signals.length > 1, "SIGKILL sent");
    expect(h.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(h.logged.some((l) => l.msg === "stalled child ignored SIGTERM; sending SIGKILL")).toBe(
      true,
    );

    await until(() => h.child.snapshot().restarts === 1, "restart counted");
    h.child.requestStop();
    h.crashCurrent(0);
    await h.loop;
  });

  test("a child that exits inside the grace window is never SIGKILLed", async () => {
    const h = harness();
    await h.stallOnce();
    await until(() => h.child.snapshot().restarts === 1, "restart counted");
    // Releasing the grace now must find the race already decided.
    h.driver.release(GRACE_MS);
    for (let i = 0; i < 20; i++) await new Promise<void>((r) => setTimeout(r, 0));
    expect(h.signals).toEqual(["SIGTERM"]);
    expect(h.logged.some((l) => l.msg === "stalled child ignored SIGTERM; sending SIGKILL")).toBe(
      false,
    );

    h.child.requestStop();
    h.crashCurrent(0);
    await h.loop;
  });
});

describe("VaultChild — the replacement child after a stall kill", () => {
  test("reports `resolving` while still carrying the killed child's evidence", async () => {
    const h = harness();
    await h.stallOnce();
    await until(() => h.child.snapshot().restarts === 1, "restart counted");

    // The sync directory goes away before the replacement spawns, so the new
    // child genuinely cannot re-resolve a log.
    h.fs.remove(`${SYNC_DIR}/aaa/config.json`);
    await until(() => h.driver.count(BACKOFF_MS) > 0, "backoff parked");
    h.driver.release(BACKOFF_MS);
    await until(() => h.child.snapshot().state === "running", "replacement running");
    await h.poll();

    const snap = h.child.snapshot();
    // Protection is NOT in force for this child, and the non-null logPath
    // must not be read as if it were.
    expect(snap.watchdog.state).toBe("resolving");
    expect(snap.watchdog.logPath).toBe(LOG_PATH);
    expect(snap.lastSyncActivityAt).toBe(1_000);
    // The stall evidence survives the child that produced it.
    expect(snap.watchdog.stallKills).toBe(1);
    expect(snap.lastError).toContain("sync stalled");

    h.child.requestStop();
    h.crashCurrent(0);
    await h.loop;
  });
});

describe("VaultChild — a progressing sync is never killed", () => {
  test("an hour of 30-second writes leaves the vault running with zero stall kills", async () => {
    const h = harness();
    await h.awaitArmed();
    for (let i = 1; i <= 120; i++) {
      h.fs.append(LOG_PATH, `Fully synced ${i}\n`, 1_000 + i * POLL_MS);
      h.driver.advance(POLL_MS);
      await h.poll();
    }
    const snap = h.child.snapshot();
    expect(snap.state).toBe("running");
    expect(snap.restarts).toBe(0);
    expect(snap.watchdog.stallKills).toBe(0);
    expect(snap.lastSyncActivityAt).toBe(1_000 + 120 * POLL_MS);
    expect(h.signals).toEqual([]);

    h.child.requestStop();
    h.crashCurrent(0);
    await h.loop;
  });
});

describe("VaultChild — stall ceiling", () => {
  test("the third stall kill inside the window fails the vault and stops restarting", async () => {
    const h = harness({ stallLoop: { windowMs: 60 * 60_000, maxStalls: 3 } });

    for (let attempt = 1; attempt <= 3; attempt++) {
      await h.stallOnce();
      await until(() => h.child.snapshot().restarts === attempt, `restart ${attempt}`);
      if (attempt === 3) break;
      // The backoff doubles every time, because a stall kill is never
      // healthy uptime and so never resets the consecutive-failure counter.
      const delay = BACKOFF_MS * 2 ** (attempt - 1);
      await until(() => h.driver.count(delay) > 0, `backoff ${delay} parked`);
      h.driver.release(delay);
    }

    await h.loop;
    const snap = h.child.snapshot();
    expect(snap.state).toBe("failed");
    expect(snap.lastError).toBe("sync stall-loop: 3 stall kills within 3600000ms");
    expect(snap.watchdog.stallKills).toBe(3);
    // No fourth child: `failed` is terminal until the process restarts.
    expect(h.signals).toEqual(["SIGTERM", "SIGTERM", "SIGTERM"]);
    expect(h.logged.some((l) => l.msg === "ob sync stall-loop ceiling reached")).toBe(true);
  });

  test("failing one vault leaves another vault's child supervised normally", async () => {
    // One child per vault is the whole isolation story, so this is really a
    // guard against any stall state accidentally living at module scope
    // rather than per instance — a shared `stallTimes` array would fail the
    // second vault along with the first.
    const failing = harness({ stallLoop: { windowMs: 60 * 60_000, maxStalls: 3 } });
    const healthy = harness();
    await healthy.awaitArmed();

    for (let attempt = 1; attempt <= 3; attempt++) {
      await failing.stallOnce();
      await until(() => failing.child.snapshot().restarts === attempt, `restart ${attempt}`);
      if (attempt === 3) break;
      const delay = BACKOFF_MS * 2 ** (attempt - 1);
      await until(() => failing.driver.count(delay) > 0, `backoff ${delay} parked`);
      failing.driver.release(delay);
      // The healthy vault keeps writing throughout.
      healthy.fs.append(LOG_PATH, "Fully synced\n", 1_000 + attempt * POLL_MS);
      healthy.driver.advance(POLL_MS);
      await healthy.poll();
    }
    await failing.loop;

    expect(failing.child.snapshot().state).toBe("failed");
    const other = healthy.child.snapshot();
    expect(other.state).toBe("running");
    expect(other.watchdog.stallKills).toBe(0);
    expect(other.lastError).toBeNull();
    expect(healthy.signals).toEqual([]);

    healthy.child.requestStop();
    healthy.crashCurrent(0);
    await healthy.loop;
  });

  test("a stall kill never counts as healthy uptime, so the backoff keeps growing", async () => {
    // Each child stays alive for a full threshold — longer than the 5-minute
    // healthy-uptime reset. If the reset applied, every backoff would restart
    // from the initial delay and nothing could ever escalate.
    const h = harness({ stallLoop: { windowMs: 60 * 60_000, maxStalls: 3 } });

    await h.stallOnce();
    await until(() => h.child.snapshot().restarts === 1, "restart 1");
    await until(() => h.driver.count(BACKOFF_MS) > 0, "first backoff");
    h.driver.release(BACKOFF_MS);

    await h.stallOnce();
    await until(() => h.child.snapshot().restarts === 2, "restart 2");
    await until(() => h.driver.count(BACKOFF_MS * 2) > 0, "second backoff doubled");

    const backoffs = h.driver.requested.filter((ms) => ms !== POLL_MS && ms !== GRACE_MS);
    expect(backoffs).toEqual([BACKOFF_MS, BACKOFF_MS * 2]);

    h.driver.release(BACKOFF_MS * 2);
    await until(() => h.child.snapshot().state === "running", "third child running");
    h.child.requestStop();
    h.crashCurrent(0);
    await h.loop;
  });

  test("an ordinary crash after a stall does not inherit the stall classification", async () => {
    const h = harness({ stallLoop: { windowMs: 60 * 60_000, maxStalls: 2 } });
    await h.stallOnce();
    await until(() => h.child.snapshot().restarts === 1, "restart 1");
    expect(h.child.snapshot().lastError).toContain("sync stalled");

    await until(() => h.driver.count(BACKOFF_MS) > 0, "backoff parked");
    h.driver.release(BACKOFF_MS);
    await until(() => h.child.snapshot().state === "running", "second child running");

    // The replacement dies of its own accord, with no verdict recorded.
    h.crashCurrent(1);
    await until(() => h.child.snapshot().restarts === 2, "restart 2");
    expect(h.child.snapshot().lastError).toBe("ob sync exited with code 1");
    // Had the verdict leaked, this crash would have been the second stall and
    // the ceiling of 2 would have failed the vault.
    expect(h.child.snapshot().state).not.toBe("failed");
    expect(h.child.snapshot().watchdog.stallKills).toBe(1);

    h.child.requestStop();
    await until(() => h.driver.count(BACKOFF_MS * 2) > 0, "second backoff");
    h.driver.release(BACKOFF_MS * 2);
    await h.loop;
  });
});

describe("VaultChild — the watchdog is silent during shutdown", () => {
  test("requestStop() before the deciding poll suppresses the verdict", async () => {
    const h = harness();
    await h.awaitArmed();
    await until(() => h.driver.count(POLL_MS) > 0, "poll parked");
    h.driver.advance(THRESHOLD_MS * 2);

    h.child.requestStop();
    h.driver.release(POLL_MS);
    h.crashCurrent(0);
    await h.loop;

    expect(h.logged.some((l) => l.msg === "sync log stalled; killing child")).toBe(false);
    const snap = h.child.snapshot();
    expect(snap.watchdog.stallKills).toBe(0);
    // Only the shutdown SIGTERM, never a stall kill.
    expect(h.signals).toEqual(["SIGTERM"]);
  });
});

describe("VaultChild — watchdog disabled", () => {
  test("a permanently silent log is never killed and reports disabled", async () => {
    const h = harness({ config: DISABLED_SYNC_WATCHDOG });
    await until(() => h.child.snapshot().state === "running", "child running");
    h.driver.advance(24 * 3_600_000);
    for (let i = 0; i < 20; i++) await new Promise<void>((r) => setTimeout(r, 0));

    const snap = h.child.snapshot();
    expect(snap.state).toBe("running");
    expect(snap.watchdog.state).toBe("disabled");
    expect(snap.watchdog.logPath).toBeNull();
    expect(snap.lastSyncActivityAt).toBeNull();
    expect(snap.watchdog.stallKills).toBe(0);
    expect(h.signals).toEqual([]);

    h.child.requestStop();
    h.crashCurrent(0);
    await h.loop;
  });

  test("threshold 0 with tailing on still reports `tailing` and never kills", async () => {
    const h = harness({
      config: { stallTimeoutMs: 0, pollIntervalMs: POLL_MS, logTail: true },
    });
    await until(() => h.child.snapshot().watchdog.state === "tailing", "tailing");
    h.driver.advance(24 * 3_600_000);
    await h.poll();
    expect(h.child.snapshot().watchdog.stallKills).toBe(0);
    expect(h.signals).toEqual([]);

    h.child.requestStop();
    h.crashCurrent(0);
    await h.loop;
  });
});

describe("a stalled vault on the health endpoints", () => {
  test("/readyz reports 503 with the stall evidence while /healthz stays 200", async () => {
    const h = harness({ ignoreSigterm: true });

    const supervisor: Supervisor = {
      list: () => [h.child.snapshot()],
      get: (slug) => (slug === "v" ? h.child.snapshot() : null),
      stop: async () => undefined,
    };
    const ready: IndexerStatus = {
      slug: "v",
      state: "ready",
      documents: 1,
      chunks: 1,
      lastIndexedAt: 100,
      pending: 0,
      errors: 0,
    };
    const indexer: Indexer = {
      list: () => [ready],
      status: () => ready,
      search: async () => [],
      reindex: async () => undefined,
      drop: async () => undefined,
      stop: async () => undefined,
    };
    const app = buildHttpApp({ supervisor, indexer });

    // Healthy first: the vault is running and its indexer is ready.
    await h.awaitArmed();
    expect((await app.request("/readyz")).status).toBe(200);

    await h.stallOnce();
    await until(() => h.signals.length > 0, "SIGTERM sent");

    // The child is still alive — it ignored the SIGTERM — but the verdict
    // has already taken the vault out of `running`, so readiness is 503
    // for the whole grace window rather than only once the child dies.
    const res = await app.request("/readyz");
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      ok: boolean;
      vaults: Array<{
        slug: string;
        state: string;
        lastError: string | null;
        lastSyncActivityAt: number | null;
      }>;
    };
    expect(body.ok).toBe(false);
    expect(body.vaults[0]?.slug).toBe("v");
    expect(body.vaults[0]?.state).toBe("starting");
    expect(body.vaults[0]?.lastError).toContain("sync stalled");
    expect(body.vaults[0]?.lastSyncActivityAt).toBe(1_000);

    // Liveness is deliberately blind to sync state: the container hosts the
    // API and every vault child, so failing liveness for one wedged vault
    // would restart the API and the healthy vaults to recover one child.
    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });

    h.driver.release(GRACE_MS);
    await until(() => h.child.snapshot().restarts === 1, "restart counted");
    h.child.requestStop();
    h.crashCurrent(0);
    await h.loop;
  });
});

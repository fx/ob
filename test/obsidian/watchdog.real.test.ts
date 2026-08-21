/**
 * Watchdog against a REAL filesystem tree.
 *
 * `watchdog.test.ts` drives every branch through the injected `WatchdogFs`;
 * this file exists so that surface cannot drift from real `fs` semantics —
 * at least one test per feature area (resolution, no-backlog tail, rotation
 * and truncation, tail-off, error dispositions, and stall detection) runs
 * against a real temporary tree through `defaultWatchdogFs`.
 *
 * The tree is a `Bun.tmpdirSync()`-style throwaway directory, built the way
 * the rest of this suite builds them (`mkdtempSync` under `os.tmpdir()`).
 * Timing still comes from the injected clock — no test here waits on real
 * wall-clock time.
 */

import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SyncWatchdogConfig } from "../../src/config/index.ts";
import { createLogger } from "../../src/log.ts";
import {
  type WatchdogHandle,
  defaultWatchdogFs,
  startWatchdog,
} from "../../src/obsidian/watchdog.ts";
import { type PollDriver, createPollDriver } from "../helpers/fakeWatchdogFs.ts";

const TAIL_ON: SyncWatchdogConfig = {
  stallTimeoutMs: 300_000,
  pollIntervalMs: 30_000,
  logTail: true,
};

interface Tree {
  readonly syncDir: string;
  readonly vaultPath: string;
  readonly root: string;
}

function makeTree(): Tree {
  const root = mkdtempSync(join(tmpdir(), "ob-wd-"));
  const syncDir = join(root, "config", "obsidian-headless", "sync");
  const vaultPath = join(root, "data", "vaults", "v");
  mkdirSync(syncDir, { recursive: true });
  mkdirSync(vaultPath, { recursive: true });
  return { root, syncDir, vaultPath };
}

function seed(tree: Tree, dir: string, vaultPath: string, log?: string): string {
  const d = join(tree.syncDir, dir);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "config.json"), JSON.stringify({ vaultPath }));
  const logPath = join(d, "sync.log");
  if (log !== undefined) writeFileSync(logPath, log);
  return logPath;
}

interface Fixture {
  readonly wd: WatchdogHandle;
  readonly driver: PollDriver;
  readonly lines: string[];
  readonly warns: string[];
  /** Stall verdicts, in order. */
  readonly stalls: string[];
}

function startReal(tree: Tree, config: SyncWatchdogConfig = TAIL_ON): Fixture {
  const driver = createPollDriver();
  const lines: string[] = [];
  const warns: string[] = [];
  const stalls: string[] = [];
  const logger = createLogger({
    level: "trace",
    write: (raw) => {
      const obj = JSON.parse(raw) as { level: string; msg: string; line?: string };
      if (obj.msg === "ob output" && typeof obj.line === "string") lines.push(obj.line);
      if (obj.level === "warn") warns.push(obj.msg);
    },
  });
  const wd = startWatchdog(
    { slug: "v", path: tree.vaultPath },
    {
      now: driver.now,
      sleep: driver.sleep,
      fs: defaultWatchdogFs,
      logger,
      syncDir: tree.syncDir,
      config,
    },
    (reason) => stalls.push(reason),
  );
  return { wd, driver, lines, warns, stalls };
}

describe("watchdog against a real filesystem", () => {
  test("resolves by vaultPath, skipping a junk sibling and a non-matching one", async () => {
    const tree = makeTree();
    try {
      mkdirSync(join(tree.syncDir, "empty"), { recursive: true });
      // A plain file among the sync entries: `readdir` returns it, and the
      // scan must skip it (ENOTDIR on its `config.json`) rather than abort.
      writeFileSync(join(tree.syncDir, "loose.txt"), "ignored");
      seed(tree, "other", join(tree.root, "data", "vaults", "other"), "");
      const wanted = seed(tree, "bbb", tree.vaultPath, "");

      const fx = startReal(tree);
      await fx.driver.settle();
      expect(fx.wd.snapshot().watchdog.state).toBe("armed");
      expect(fx.wd.snapshot().watchdog.logPath).toBe(wanted);
      fx.wd.stop();
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  test("an absent sync directory leaves the watchdog dormant, not failed", async () => {
    const tree = makeTree();
    try {
      rmSync(tree.syncDir, { recursive: true, force: true });
      const fx = startReal(tree);
      await fx.driver.settle();
      await fx.driver.nextPoll();
      const snap = fx.wd.snapshot();
      expect(snap.watchdog.state).toBe("resolving");
      expect(snap.watchdog.logPath).toBeNull();
      expect(snap.lastSyncActivityAt).toBeNull();
      fx.wd.stop();
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  test("does not replay a real backlog, and tails real appends line by line", async () => {
    const tree = makeTree();
    try {
      const backlog = `${Array.from({ length: 2_000 }, (_, i) => `old ${i}`).join("\n")}\n`;
      const logPath = seed(tree, "aaa", tree.vaultPath, backlog);

      const fx = startReal(tree);
      await fx.driver.settle();
      expect(fx.lines).toEqual([]);

      await Bun.write(logPath, `${backlog}Fully synced\n`);
      await fx.driver.nextPoll();
      expect(fx.lines).toEqual(["Fully synced"]);

      // A half-written line waits for its newline.
      await Bun.write(logPath, `${backlog}Fully synced\nDiscon`);
      await fx.driver.nextPoll();
      expect(fx.lines).toEqual(["Fully synced"]);
      await Bun.write(logPath, `${backlog}Fully synced\nDisconnected\n`);
      await fx.driver.nextPoll();
      expect(fx.lines).toEqual(["Fully synced", "Disconnected"]);
      fx.wd.stop();
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  test("resolution mid-line drops exactly the straddling line", async () => {
    const tree = makeTree();
    try {
      const logPath = seed(tree, "aaa", tree.vaultPath, "Connect");
      const fx = startReal(tree);
      await fx.driver.settle();
      await Bun.write(logPath, "Connecting...\nFully synced\n");
      await fx.driver.nextPoll();
      expect(fx.lines).toEqual(["Fully synced"]);
      fx.wd.stop();
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  test("a real truncation re-reads from byte zero without erroring", async () => {
    const tree = makeTree();
    try {
      const logPath = seed(tree, "aaa", tree.vaultPath, "x".repeat(4_096));
      const fx = startReal(tree);
      await fx.driver.settle();
      await Bun.write(logPath, "line one\nline two\n");
      await fx.driver.nextPoll();
      expect(fx.lines).toEqual(["line one", "line two"]);
      fx.wd.stop();
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  test("a real deletion returns the watchdog to resolving and keeps the evidence", async () => {
    const tree = makeTree();
    try {
      const logPath = seed(tree, "aaa", tree.vaultPath, "");
      const fx = startReal(tree);
      await fx.driver.settle();
      rmSync(logPath);
      await fx.driver.nextPoll();
      const snap = fx.wd.snapshot();
      expect(snap.watchdog.state).toBe("resolving");
      expect(snap.watchdog.logPath).toBe(logPath);
      expect(snap.lastSyncActivityAt).not.toBeNull();
      fx.wd.stop();
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  test("tail-off still resolves and reports the real mtime, forwarding nothing", async () => {
    const tree = makeTree();
    try {
      const logPath = seed(tree, "aaa", tree.vaultPath, "");
      const fx = startReal(tree, { ...TAIL_ON, logTail: false });
      await fx.driver.settle();
      await Bun.write(logPath, "Fully synced\n");
      await fx.driver.nextPoll();
      expect(fx.lines).toEqual([]);
      const snap = fx.wd.snapshot();
      expect(snap.watchdog.state).toBe("armed");
      expect(typeof snap.lastSyncActivityAt).toBe("number");
      fx.wd.stop();
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  test("a real malformed config.json is skipped in favour of a valid sibling", async () => {
    const tree = makeTree();
    try {
      mkdirSync(join(tree.syncDir, "broken"), { recursive: true });
      writeFileSync(join(tree.syncDir, "broken", "config.json"), "{ not json");
      const wanted = seed(tree, "good", tree.vaultPath, "");

      const fx = startReal(tree);
      await fx.driver.settle();
      expect(fx.wd.snapshot().watchdog.logPath).toBe(wanted);
      fx.wd.stop();
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });
  test("a real silent log produces a verdict one threshold after the anchor", async () => {
    const tree = makeTree();
    try {
      seed(tree, "aaa", tree.vaultPath, "existing\n");
      const fx = startReal(tree);
      await fx.driver.settle();
      expect(fx.wd.snapshot().watchdog.state).toBe("armed");

      // The file's real mtime is "now" in wall-clock terms, but the anchor is
      // the injected clock's zero — so only `driver.advance()` can produce a
      // verdict, and no real time is waited on.
      fx.driver.advance(299_999);
      await fx.driver.nextPoll();
      expect(fx.stalls).toEqual([]);

      fx.driver.advance(1);
      await fx.driver.nextPoll();
      expect(fx.stalls).toHaveLength(1);
      expect(fx.stalls[0]).toContain("sync stalled: no sync.log activity for 300000ms");
      expect(fx.wd.snapshot().watchdog.stallKills).toBe(1);
      fx.wd.stop();
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });

  test("a real append refreshes the staleness clock", async () => {
    const tree = makeTree();
    try {
      const logPath = seed(tree, "aaa", tree.vaultPath, "");
      const fx = startReal(tree);
      await fx.driver.settle();
      fx.driver.advance(299_000);
      appendFileSync(logPath, "Fully synced\n");
      // Move the mtime explicitly. Activity is keyed on mtime and inode, never
      // on size, and a filesystem with coarse timestamp granularity could
      // otherwise land the append in the same tick as the file's creation —
      // which would make this test pass or fail on the host's granularity
      // rather than on the code under test.
      const st = statSync(logPath);
      utimesSync(logPath, st.atime, new Date(st.mtimeMs + 1_000));
      await fx.driver.nextPoll();
      expect(fx.lines).toEqual(["Fully synced"]);

      fx.driver.advance(299_999);
      await fx.driver.nextPoll();
      expect(fx.stalls).toEqual([]);
      fx.wd.stop();
    } finally {
      rmSync(tree.root, { recursive: true, force: true });
    }
  });
});

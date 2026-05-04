/**
 * Tests for `src/obsidian/child.ts` — the per-vault spawn/restart loop.
 *
 * These tests use the fake spawner so the full crash-loop window collapses
 * into a deterministic sequence of injected timestamps.
 */

import { describe, expect, test } from "bun:test";
import { createLogger } from "../../src/log.ts";
import {
  DEFAULT_CHILD_BACKOFF,
  DEFAULT_CRASH_LOOP,
  VaultChild,
  childBackoffDelay,
} from "../../src/obsidian/child.ts";
import { createFakeSpawner } from "../helpers/fakeSpawner.ts";

const silentLog = createLogger({ level: "error", write: () => undefined });
const noSleep = async (_ms: number): Promise<void> => undefined;

const VAULT = { name: "v", slug: "v", path: "/tmp/v" };

describe("childBackoffDelay", () => {
  test("matches setup style: 1s,2s,4s,...,cap 60s", () => {
    expect(childBackoffDelay(DEFAULT_CHILD_BACKOFF, 0)).toBe(1_000);
    expect(childBackoffDelay(DEFAULT_CHILD_BACKOFF, 5)).toBe(32_000);
    expect(childBackoffDelay(DEFAULT_CHILD_BACKOFF, 100)).toBe(60_000);
  });
});

describe("VaultChild snapshot defaults", () => {
  test("starts in 'starting' with no pid and zero restarts", () => {
    const sp = createFakeSpawner();
    const child = new VaultChild(VAULT, {
      spawner: sp,
      logger: silentLog,
      now: () => 0,
      sleep: noSleep,
    });
    const snap = child.snapshot();
    expect(snap.state).toBe("starting");
    expect(snap.pid).toBeNull();
    expect(snap.restarts).toBe(0);
    expect(snap.lastError).toBeNull();
    expect(snap.slug).toBe("v");
    expect(snap.name).toBe("v");
  });

  test("markFailed transitions to failed without spawning", () => {
    const sp = createFakeSpawner();
    const child = new VaultChild(VAULT, {
      spawner: sp,
      logger: silentLog,
      now: () => 0,
      sleep: noSleep,
    });
    child.markFailed("nope");
    const snap = child.snapshot();
    expect(snap.state).toBe("failed");
    expect(snap.lastError).toBe("nope");
    expect(snap.pid).toBeNull();
    expect(sp.calls).toHaveLength(0);
  });
});

describe("VaultChild.start() — happy path", () => {
  test("spawns ob sync, transitions to 'running', pid set", async () => {
    const sp = createFakeSpawner();
    let resolveExit!: (n: number) => void;
    const exitWhen = new Promise<number>((r) => {
      resolveExit = r;
    });
    sp.enqueue({ exitWhen, stdout: ["hello"], stderr: ["warn"], pid: 4242 });
    const child = new VaultChild(VAULT, {
      spawner: sp,
      logger: silentLog,
      now: () => 0,
      sleep: noSleep,
    });
    const loop = child.start();
    // start() is idempotent — calling again returns the same promise.
    expect(child.start()).toBe(loop);
    // Yield a tick so the spawn has happened.
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));
    expect(sp.calls).toHaveLength(1);
    expect(sp.calls[0]?.args).toEqual(["sync", "--continuous", "--path", "/tmp/v"]);
    // Trigger graceful stop.
    // Mid-flight, before requesting stop, the child should be `running`.
    expect(child.snapshot().state).toBe("running");
    child.requestStop("SIGTERM");
    resolveExit(0);
    await loop;
    // After exit (during graceful shutdown), state should NOT remain `running`.
    expect(child.snapshot().state).not.toBe("running");
  });
});

describe("VaultChild.start() — crash-loop ceiling", () => {
  test("after 10 crashes within 5min the vault transitions to 'failed' and stops spawning", async () => {
    const sp = createFakeSpawner({ defaultHandle: { exitCode: 1 } });
    let nowMs = 0;
    const child = new VaultChild(VAULT, {
      spawner: sp,
      logger: silentLog,
      now: () => {
        // Each call advances by 100ms so 10 crashes fit comfortably in the window.
        const v = nowMs;
        nowMs += 100;
        return v;
      },
      sleep: noSleep,
    });
    await child.start();
    expect(sp.calls).toHaveLength(10);
    expect(child.snapshot().state).toBe("failed");
    expect(child.snapshot().lastError).toContain("crash-loop");
  });

  test("crash counter resets when child stays up past healthyResetMs", async () => {
    const sp = createFakeSpawner({ defaultHandle: { exitCode: 1 } });
    // Each iteration consumes two `now()` reads (start + exit). Always
    // return a strictly-increasing timestamp 10 minutes apart so uptime
    // is always > healthyResetMs (1s) — the crash counter must reset
    // every iteration, never reaching maxCrashes.
    let nowMs = 0;
    let iterations = 0;
    const child = new VaultChild(VAULT, {
      spawner: sp,
      logger: silentLog,
      now: () => {
        const v = nowMs;
        // Advance by 10 minutes per call.
        nowMs += 10 * 60_000;
        return v;
      },
      sleep: async () => {
        iterations += 1;
        // After 30 iterations of "healthy" exits, we're sure the reset
        // path was hit; ask the child to stop.
        if (iterations >= 30) child.requestStop();
      },
      crashLoop: { windowMs: 60_000, maxCrashes: 10, healthyResetMs: 1_000 },
    });
    await child.start();
    expect(child.snapshot().state).not.toBe("failed");
    expect(iterations).toBeGreaterThanOrEqual(10);
  });
});

describe("VaultChild.start() — log forwarding", () => {
  test("stdout lines emit info-level, stderr lines emit warn-level", async () => {
    const lines: Array<{ level: string; line: unknown }> = [];
    const captureLog = createLogger({
      level: "trace",
      write: (s) => {
        const obj = JSON.parse(s) as { level: string; line?: unknown; msg: string };
        if (obj.msg === "ob output") lines.push({ level: obj.level, line: obj.line });
      },
    });
    const sp = createFakeSpawner();
    sp.enqueue({
      exitCode: 1,
      stdout: ["info-1", "info-2"],
      stderr: ["warn-1"],
    });
    sp.enqueue({ exitCode: 1 });
    sp.enqueue({ exitCode: 1 });
    const child = new VaultChild(VAULT, {
      spawner: sp,
      logger: captureLog,
      now: () => 0,
      sleep: noSleep,
      crashLoop: { windowMs: 60_000, maxCrashes: 3, healthyResetMs: 1_000_000 },
    });
    await child.start();
    expect(lines.some((l) => l.level === "info" && l.line === "info-1")).toBe(true);
    expect(lines.some((l) => l.level === "info" && l.line === "info-2")).toBe(true);
    expect(lines.some((l) => l.level === "warn" && l.line === "warn-1")).toBe(true);
  });

  test("partial trailing line is flushed on stream close", async () => {
    const captured: string[] = [];
    const captureLog = createLogger({
      level: "trace",
      write: (s) => {
        const obj = JSON.parse(s) as { msg: string; line?: string };
        if (obj.msg === "ob output" && typeof obj.line === "string") captured.push(obj.line);
      },
    });
    // Build a custom stream that emits a chunk WITHOUT trailing newline.
    const partialStream = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode("partial-no-newline"));
        controller.close();
      },
    });
    const emptyStderr = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.close();
      },
    });
    // Inject a manual handle through the fake by overriding the stdout.
    const sp = createFakeSpawner();
    sp.enqueue({
      exitCode: 0,
      // We'll drop scripted lines and replace the stream via onKill hack — simpler to just create a small subclass test.
    });
    // The fake's stream is built from `stdout` lines; for partial-line coverage
    // we test forwardLines by calling it indirectly: spawn a child with a
    // single non-newline-terminated chunk.
    // Use the partial streams directly via a custom Spawner.
    const customSpawner = {
      calls: [] as { cmd: string; args: readonly string[] }[],
      run: () => ({
        pid: 1,
        stdout: partialStream,
        stderr: emptyStderr,
        exited: Promise.resolve(0),
        kill: (): void => undefined,
      }),
    };
    const child = new VaultChild(VAULT, {
      spawner: customSpawner,
      logger: captureLog,
      now: () => 0,
      sleep: noSleep,
      crashLoop: { windowMs: 60_000, maxCrashes: 1, healthyResetMs: 1_000_000 },
    });
    await child.start();
    expect(captured).toContain("partial-no-newline");
  });
});

describe("VaultChild.start() — spawn/exited exceptions", () => {
  test("synchronous spawner throw is treated as a crash, not bubbled", async () => {
    let throws = 3;
    const customSpawner = {
      calls: [] as { cmd: string; args: readonly string[] }[],
      run: (cmd: string, args: readonly string[]) => {
        customSpawner.calls.push({ cmd, args });
        if (throws > 0) {
          throws--;
          throw new Error("spawn ENOENT");
        }
        // After 3 throws, succeed and let the run loop exit cleanly via crash-loop.
        return {
          pid: 1,
          stdout: new ReadableStream<Uint8Array>({
            start(c): void {
              c.close();
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            start(c): void {
              c.close();
            },
          }),
          exited: Promise.resolve(1),
          kill: (): void => undefined,
        };
      },
    };
    const child = new VaultChild(VAULT, {
      spawner: customSpawner,
      logger: silentLog,
      now: () => 0,
      sleep: noSleep,
      crashLoop: { windowMs: 60_000, maxCrashes: 5, healthyResetMs: 1_000_000 },
    });
    await child.start();
    // crash-loop ceiling reached eventually; state must end in failed.
    expect(child.snapshot().state).toBe("failed");
    // The first 3 attempts threw → counted as crashes alongside subsequent exits.
    expect(customSpawner.calls.length).toBeGreaterThanOrEqual(3);
  });

  test("rejected exited promise is treated as a crash", async () => {
    let attempts = 0;
    const customSpawner = {
      calls: [] as { cmd: string; args: readonly string[] }[],
      run: () => {
        attempts++;
        return {
          pid: 1,
          stdout: new ReadableStream<Uint8Array>({
            start(c): void {
              c.close();
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            start(c): void {
              c.close();
            },
          }),
          exited: attempts <= 2 ? Promise.reject(new Error("kernel said no")) : Promise.resolve(1),
          kill: (): void => undefined,
        };
      },
    };
    const child = new VaultChild(VAULT, {
      spawner: customSpawner,
      logger: silentLog,
      now: () => 0,
      sleep: noSleep,
      crashLoop: { windowMs: 60_000, maxCrashes: 4, healthyResetMs: 1_000_000 },
    });
    await child.start();
    expect(child.snapshot().state).toBe("failed");
  });
});

describe("VaultChild.start() — state during backoff", () => {
  test("state is 'starting' (NOT 'running') after a child exit, before next spawn", async () => {
    // Build a sleep that never resolves so the run loop pauses in backoff
    // immediately after the first exit. Inspect state at that point.
    let releaseSleep!: () => void;
    const sleepGate = new Promise<void>((r) => {
      releaseSleep = r;
    });
    let sleepEntered = false;
    const sleep = (): Promise<void> => {
      sleepEntered = true;
      return sleepGate;
    };
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 1 });
    const child = new VaultChild(VAULT, {
      spawner: sp,
      logger: silentLog,
      now: () => 0,
      sleep,
      crashLoop: { windowMs: 60_000, maxCrashes: 100, healthyResetMs: 1_000_000 },
    });
    const loopP = child.start();
    // Wait for the run loop to reach the backoff sleep.
    for (let i = 0; i < 200 && !sleepEntered; i++) {
      await new Promise<void>((r) => queueMicrotask(r));
    }
    expect(child.snapshot().state).toBe("starting");
    expect(child.snapshot().pid).toBeNull();
    // Release sleep AND request stop so the loop exits.
    child.requestStop();
    releaseSleep();
    await loopP;
  });
});

describe("VaultChild.requestStop / forceKill", () => {
  test("requestStop kills the running child via spawner kill hook", async () => {
    const sp = createFakeSpawner();
    const seen: { signal: NodeJS.Signals | null } = { signal: null };
    let resolveExit!: (n: number) => void;
    const exitWhen = new Promise<number>((r) => {
      resolveExit = r;
    });
    sp.enqueue({
      exitWhen,
      onKill: (sig) => {
        seen.signal = sig;
        resolveExit(0);
      },
    });
    const child = new VaultChild(VAULT, {
      spawner: sp,
      logger: silentLog,
      now: () => 0,
      sleep: noSleep,
    });
    const loop = child.start();
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));
    child.requestStop("SIGTERM");
    await loop;
    expect(seen.signal).toBe("SIGTERM");
  });

  test("forceKill before start is a no-op", () => {
    const sp = createFakeSpawner();
    const child = new VaultChild(VAULT, {
      spawner: sp,
      logger: silentLog,
      now: () => 0,
      sleep: noSleep,
    });
    expect(() => child.forceKill()).not.toThrow();
  });

  test("forceKill while running sends SIGKILL through spawner", async () => {
    const sp = createFakeSpawner();
    const sigs: NodeJS.Signals[] = [];
    let resolveExit!: (n: number) => void;
    const exitWhen = new Promise<number>((r) => {
      resolveExit = r;
    });
    sp.enqueue({
      exitWhen,
      onKill: (sig) => {
        sigs.push(sig);
        if (sig === "SIGKILL") resolveExit(137);
      },
    });
    const child = new VaultChild(VAULT, {
      spawner: sp,
      logger: silentLog,
      now: () => 0,
      sleep: noSleep,
    });
    const loop = child.start();
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));
    child.requestStop(); // mark stopRequested + SIGTERM
    child.forceKill(); // SIGKILL
    await loop;
    expect(sigs).toContain("SIGTERM");
  });

  test("awaitExit before start resolves immediately", async () => {
    const sp = createFakeSpawner();
    const child = new VaultChild(VAULT, {
      spawner: sp,
      logger: silentLog,
      now: () => 0,
      sleep: noSleep,
    });
    await child.awaitExit();
  });
});

describe("VaultChild.requestStop — wakes the backoff sleep", () => {
  test("stop during restart-backoff returns within < 1s of the request", async () => {
    // Build a sleep that NEVER resolves (simulating a stuck wall-clock timer),
    // so the only way the run loop can advance is via the stop-signal race.
    const neverSleep = (): Promise<void> => new Promise<void>(() => undefined);
    const sp = createFakeSpawner({ defaultHandle: { exitCode: 1 } });
    const child = new VaultChild(VAULT, {
      spawner: sp,
      logger: silentLog,
      now: () => 0,
      sleep: neverSleep,
      crashLoop: { windowMs: 60_000, maxCrashes: 1000, healthyResetMs: 1_000_000 },
    });
    const loopP = child.start();
    // Wait until the child has spawned at least once and entered the
    // backoff sleep (after the first exit).
    for (let i = 0; i < 200 && sp.calls.length < 1; i++) {
      await new Promise<void>((r) => queueMicrotask(r));
    }
    for (let i = 0; i < 50; i++) await new Promise<void>((r) => queueMicrotask(r));
    const t0 = Date.now();
    child.requestStop();
    await loopP;
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(1_000);
    expect(sp.calls.length).toBeGreaterThanOrEqual(1);
  });
});

describe("DEFAULT_CRASH_LOOP exports", () => {
  test("matches spec defaults", () => {
    expect(DEFAULT_CRASH_LOOP.maxCrashes).toBe(10);
    expect(DEFAULT_CRASH_LOOP.windowMs).toBe(5 * 60_000);
  });
});

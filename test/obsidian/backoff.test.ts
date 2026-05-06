/**
 * Tests for `src/obsidian/backoff.ts` — the shared retry primitive used by
 * `ensureVaultSetup` and `applyVaultSyncConfig`.
 */

import { describe, expect, test } from "bun:test";
import { createLogger } from "../../src/log.ts";
import {
  type Backoff,
  DEFAULT_BACKOFF,
  backoffDelay,
  drain,
  runWithBackoff,
} from "../../src/obsidian/backoff.ts";

const silentLog = createLogger({ level: "error", write: () => undefined });
const noSleep = async (_ms: number): Promise<void> => undefined;
const fastBackoff: Backoff = { initialMs: 0, factor: 1, capMs: 0, maxAttempts: 5 };

describe("backoffDelay", () => {
  test("zero index returns initial", () => {
    expect(backoffDelay(DEFAULT_BACKOFF, 0)).toBe(1_000);
  });
  test("doubles each step", () => {
    expect(backoffDelay(DEFAULT_BACKOFF, 1)).toBe(2_000);
    expect(backoffDelay(DEFAULT_BACKOFF, 2)).toBe(4_000);
  });
  test("caps at capMs", () => {
    expect(backoffDelay(DEFAULT_BACKOFF, 20)).toBe(60_000);
  });
});

describe("drain", () => {
  test("reads to EOF and releases the lock", async () => {
    const enc = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(c): void {
        c.enqueue(enc.encode("hello\n"));
        c.enqueue(enc.encode("world\n"));
        c.close();
      },
    });
    await drain(stream);
    // Re-acquire the reader: would throw if the previous reader hadn't been released.
    const reader = stream.getReader();
    reader.releaseLock();
  });
});

describe("runWithBackoff", () => {
  test("returns ok:true on first-attempt success", async () => {
    let calls = 0;
    const result = await runWithBackoff({
      opName: "sync-setup",
      vaultSlug: "v",
      attempt: async () => {
        calls++;
        return 0;
      },
      backoff: fastBackoff,
      sleep: noSleep,
      logger: silentLog,
      shouldStop: () => false,
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(1);
  });

  test("retries transient non-zero exits and reports each delay", async () => {
    let calls = 0;
    const sleeps: number[] = [];
    const result = await runWithBackoff({
      opName: "sync-config",
      vaultSlug: "v",
      attempt: async () => {
        calls++;
        return calls < 3 ? 1 : 0;
      },
      backoff: { initialMs: 1_000, factor: 2, capMs: 60_000, maxAttempts: 5 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      logger: silentLog,
      shouldStop: () => false,
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([1_000, 2_000]);
  });

  test("returns ok:false with lastExit after every attempt failed", async () => {
    let calls = 0;
    const result = await runWithBackoff({
      opName: "sync-setup",
      vaultSlug: "v",
      attempt: async () => {
        calls++;
        return 7; // bespoke non-zero exit code
      },
      backoff: fastBackoff,
      sleep: noSleep,
      logger: silentLog,
      shouldStop: () => false,
    });
    expect(result).toEqual({ ok: false, lastExit: 7 });
    expect(calls).toBe(5);
  });

  test("treats throws as transient (-1 exit) and continues retrying", async () => {
    let calls = 0;
    const result = await runWithBackoff({
      opName: "sync-config",
      vaultSlug: "v",
      attempt: async () => {
        calls++;
        if (calls === 1) throw new Error("ENOENT: ob not on PATH");
        if (calls === 2) throw "raw non-Error throw";
        return 0;
      },
      backoff: fastBackoff,
      sleep: noSleep,
      logger: silentLog,
      shouldStop: () => false,
    });
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(3);
  });

  test("after all attempts throw, reports lastExit -1", async () => {
    const result = await runWithBackoff({
      opName: "sync-setup",
      vaultSlug: "v",
      attempt: async () => {
        throw new Error("nope");
      },
      backoff: { initialMs: 0, factor: 1, capMs: 0, maxAttempts: 2 },
      sleep: noSleep,
      logger: silentLog,
      shouldStop: () => false,
    });
    expect(result).toEqual({ ok: false, lastExit: -1 });
  });

  test("shouldStop short-circuits before the first attempt", async () => {
    let calls = 0;
    const result = await runWithBackoff({
      opName: "sync-setup",
      vaultSlug: "v",
      attempt: async () => {
        calls++;
        return 0;
      },
      backoff: fastBackoff,
      sleep: noSleep,
      logger: silentLog,
      shouldStop: () => true,
    });
    expect(result).toEqual({ ok: "cancelled" });
    expect(calls).toBe(0);
  });

  test("shouldStop short-circuits between attempts", async () => {
    let calls = 0;
    let stop = false;
    const result = await runWithBackoff({
      opName: "sync-setup",
      vaultSlug: "v",
      attempt: async () => {
        calls++;
        stop = true;
        return 1;
      },
      backoff: fastBackoff,
      sleep: noSleep,
      logger: silentLog,
      shouldStop: () => stop,
    });
    expect(result).toEqual({ ok: "cancelled" });
    expect(calls).toBe(1);
  });

  test("emits log lines with opName/vaultSlug substitution", async () => {
    const lines: Array<{ level: string; msg: string; fields: Record<string, unknown> }> = [];
    const log = createLogger({
      level: "trace",
      write: (line) => {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const { level, msg, ts: _ts, ...fields } = obj;
        lines.push({ level: String(level), msg: String(msg), fields });
      },
    });
    let calls = 0;
    await runWithBackoff({
      opName: "sync-config",
      vaultSlug: "vault-x",
      attempt: async () => {
        calls++;
        return calls < 2 ? 5 : 0;
      },
      backoff: { initialMs: 1, factor: 1, capMs: 1, maxAttempts: 3 },
      sleep: noSleep,
      logger: log,
      shouldStop: () => false,
    });
    // Substitution: every line is op-prefixed, every line carries vault.
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.msg).toContain("sync-config");
      expect(l.fields.vault).toBe("vault-x");
    }
    // Specific lines we expect.
    expect(lines.some((l) => l.msg === "running sync-config")).toBe(true);
    expect(lines.some((l) => l.msg === "sync-config failed" && l.fields.exitCode === 5)).toBe(true);
    expect(lines.some((l) => l.msg === "sync-config backing off")).toBe(true);
    expect(lines.some((l) => l.msg === "sync-config succeeded")).toBe(true);
  });

  test("emits cancellation log line carrying vault and attempt", async () => {
    const lines: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    const log = createLogger({
      level: "trace",
      write: (line) => {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const { msg, ts: _ts, level: _level, ...fields } = obj;
        lines.push({ msg: String(msg), fields });
      },
    });
    await runWithBackoff({
      opName: "sync-setup",
      vaultSlug: "v",
      attempt: async () => 0,
      backoff: fastBackoff,
      sleep: noSleep,
      logger: log,
      shouldStop: () => true,
    });
    const cancelled = lines.find((l) => l.msg === "sync-setup cancelled by stop signal");
    expect(cancelled).toBeDefined();
    expect(cancelled?.fields.vault).toBe("v");
    expect(cancelled?.fields.attempt).toBe(1);
  });

  test("emits transient-throw warn line with error text", async () => {
    const lines: Array<{ msg: string; fields: Record<string, unknown> }> = [];
    const log = createLogger({
      level: "trace",
      write: (line) => {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const { msg, ts: _ts, level: _level, ...fields } = obj;
        lines.push({ msg: String(msg), fields });
      },
    });
    let calls = 0;
    await runWithBackoff({
      opName: "sync-setup",
      vaultSlug: "v",
      attempt: async () => {
        calls++;
        if (calls === 1) throw new Error("boom");
        return 0;
      },
      backoff: fastBackoff,
      sleep: noSleep,
      logger: log,
      shouldStop: () => false,
    });
    const threw = lines.find((l) => l.msg === "sync-setup threw — treating as transient failure");
    expect(threw).toBeDefined();
    expect(threw?.fields.error).toBe("boom");
  });
});

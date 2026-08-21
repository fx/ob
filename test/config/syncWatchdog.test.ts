/**
 * Tests for `loadSyncWatchdogConfig` — the validator for the three
 * sync-watchdog env vars.
 *
 * The whole accept/reject matrix is exercised here, because the spec makes
 * this a startup gate: every violation MUST exit 78 naming the offending
 * variable and its value, BEFORE any `ob` child is spawned. A watchdog that
 * starts with an unusable threshold and reports itself armed is the exact
 * silent failure this feature exists to remove.
 */

import { describe, expect, test } from "bun:test";
import { ConfigError, loadConfig, loadSyncWatchdogConfig } from "../../src/config/index.ts";

describe("loadSyncWatchdogConfig — defaults", () => {
  test("unset vars yield the spec defaults (300 s / 30 s / tail on)", () => {
    const out = loadSyncWatchdogConfig({});
    expect(out).toEqual({ stallTimeoutMs: 300_000, pollIntervalMs: 30_000, logTail: true });
  });

  test("ignores unrelated env vars", () => {
    expect(loadSyncWatchdogConfig({ HOME: "/root", OB_SYNC_MODE: "bidirectional" })).toEqual({
      stallTimeoutMs: 300_000,
      pollIntervalMs: 30_000,
      logTail: true,
    });
  });
});

describe("loadSyncWatchdogConfig — OB_SYNC_STALL_TIMEOUT_SECONDS", () => {
  test("accepts a plain integer and converts to milliseconds", () => {
    expect(loadSyncWatchdogConfig({ OB_SYNC_STALL_TIMEOUT_SECONDS: "60" }).stallTimeoutMs).toBe(
      60_000,
    );
  });

  test("accepts 0, which disables stall detection while leaving the tail on", () => {
    const out = loadSyncWatchdogConfig({ OB_SYNC_STALL_TIMEOUT_SECONDS: "0" });
    expect(out.stallTimeoutMs).toBe(0);
    expect(out.logTail).toBe(true);
  });

  test("accepts the 86400 upper bound exactly", () => {
    expect(
      loadSyncWatchdogConfig({
        OB_SYNC_STALL_TIMEOUT_SECONDS: "86400",
        OB_SYNC_STALL_POLL_SECONDS: "30",
      }).stallTimeoutMs,
    ).toBe(86_400_000);
  });

  test("rejects a non-integer, naming the var and the value", () => {
    expect(() => loadSyncWatchdogConfig({ OB_SYNC_STALL_TIMEOUT_SECONDS: "5m" })).toThrow(
      /OB_SYNC_STALL_TIMEOUT_SECONDS.*"5m"/,
    );
  });

  test("rejects a negative value (the minus sign fails the integer form)", () => {
    expect(() => loadSyncWatchdogConfig({ OB_SYNC_STALL_TIMEOUT_SECONDS: "-1" })).toThrow(
      ConfigError,
    );
  });

  test("rejects an empty string", () => {
    expect(() => loadSyncWatchdogConfig({ OB_SYNC_STALL_TIMEOUT_SECONDS: "" })).toThrow(
      ConfigError,
    );
  });

  test("rejects a value past 86400, naming the bound", () => {
    expect(() => loadSyncWatchdogConfig({ OB_SYNC_STALL_TIMEOUT_SECONDS: "999999999999" })).toThrow(
      /OB_SYNC_STALL_TIMEOUT_SECONDS must be at most 86400 \(24 hours\), got 999999999999/,
    );
  });

  test("the thrown error carries exit code 78", () => {
    try {
      loadSyncWatchdogConfig({ OB_SYNC_STALL_TIMEOUT_SECONDS: "nope" });
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      expect((e as ConfigError).exitCode).toBe(78);
    }
  });
});

describe("loadSyncWatchdogConfig — OB_SYNC_STALL_POLL_SECONDS", () => {
  test("accepts a value at or below the threshold", () => {
    const out = loadSyncWatchdogConfig({
      OB_SYNC_STALL_TIMEOUT_SECONDS: "60",
      OB_SYNC_STALL_POLL_SECONDS: "60",
    });
    expect(out.pollIntervalMs).toBe(60_000);
  });

  test("accepts the minimum of 1", () => {
    expect(loadSyncWatchdogConfig({ OB_SYNC_STALL_POLL_SECONDS: "1" }).pollIntervalMs).toBe(1_000);
  });

  test("rejects 0", () => {
    expect(() => loadSyncWatchdogConfig({ OB_SYNC_STALL_POLL_SECONDS: "0" })).toThrow(
      /OB_SYNC_STALL_POLL_SECONDS must be at least 1, got 0/,
    );
  });

  test("rejects a non-integer", () => {
    expect(() => loadSyncWatchdogConfig({ OB_SYNC_STALL_POLL_SECONDS: "30s" })).toThrow(
      /OB_SYNC_STALL_POLL_SECONDS.*"30s"/,
    );
  });

  test("rejects a value past 86400", () => {
    expect(() => loadSyncWatchdogConfig({ OB_SYNC_STALL_POLL_SECONDS: "86401" })).toThrow(
      /OB_SYNC_STALL_POLL_SECONDS must be at most 86400/,
    );
  });

  test("rejects a poll interval longer than the threshold, naming both vars", () => {
    expect(() =>
      loadSyncWatchdogConfig({
        OB_SYNC_STALL_TIMEOUT_SECONDS: "60",
        OB_SYNC_STALL_POLL_SECONDS: "120",
      }),
    ).toThrow(/OB_SYNC_STALL_POLL_SECONDS \(120\).*OB_SYNC_STALL_TIMEOUT_SECONDS \(60\)/);
  });

  test("leaves the poll interval unconstrained when the threshold is 0", () => {
    const out = loadSyncWatchdogConfig({
      OB_SYNC_STALL_TIMEOUT_SECONDS: "0",
      OB_SYNC_STALL_POLL_SECONDS: "120",
    });
    expect(out).toEqual({ stallTimeoutMs: 0, pollIntervalMs: 120_000, logTail: true });
  });

  test("the default poll interval is rejected against a smaller explicit threshold", () => {
    // Guards the interaction between an explicit threshold and the *default*
    // poll: 30 s > 10 s must fail rather than silently delay detection.
    expect(() => loadSyncWatchdogConfig({ OB_SYNC_STALL_TIMEOUT_SECONDS: "10" })).toThrow(
      /OB_SYNC_STALL_POLL_SECONDS \(30\)/,
    );
  });
});

describe("loadSyncWatchdogConfig — OB_SYNC_LOG_TAIL", () => {
  test('accepts exactly "true"', () => {
    expect(loadSyncWatchdogConfig({ OB_SYNC_LOG_TAIL: "true" }).logTail).toBe(true);
  });

  test('accepts exactly "false"', () => {
    expect(loadSyncWatchdogConfig({ OB_SYNC_LOG_TAIL: "false" }).logTail).toBe(false);
  });

  test("rejects anything else, including near-misses", () => {
    for (const raw of ["TRUE", "False", "1", "0", "yes", ""]) {
      expect(() => loadSyncWatchdogConfig({ OB_SYNC_LOG_TAIL: raw })).toThrow(
        /OB_SYNC_LOG_TAIL must be exactly "true" or "false"/,
      );
    }
  });

  test("timeout 0 plus tail false is the fully-disabled combination", () => {
    expect(
      loadSyncWatchdogConfig({ OB_SYNC_STALL_TIMEOUT_SECONDS: "0", OB_SYNC_LOG_TAIL: "false" }),
    ).toEqual({ stallTimeoutMs: 0, pollIntervalMs: 30_000, logTail: false });
  });
});

describe("loadConfig — syncWatchdog plumbing", () => {
  const base = { VAULTS_JSON: '[{"name":"V"}]' };

  test("defaults reach the resolved Config", () => {
    expect(loadConfig(base).syncWatchdog).toEqual({
      stallTimeoutMs: 300_000,
      pollIntervalMs: 30_000,
      logTail: true,
    });
  });

  test("explicit values reach the resolved Config", () => {
    const cfg = loadConfig({
      ...base,
      OB_SYNC_STALL_TIMEOUT_SECONDS: "120",
      OB_SYNC_STALL_POLL_SECONDS: "15",
      OB_SYNC_LOG_TAIL: "false",
    });
    expect(cfg.syncWatchdog).toEqual({
      stallTimeoutMs: 120_000,
      pollIntervalMs: 15_000,
      logTail: false,
    });
  });

  test("an invalid watchdog var fails the whole load", () => {
    expect(() => loadConfig({ ...base, OB_SYNC_STALL_POLL_SECONDS: "0" })).toThrow(ConfigError);
  });
});

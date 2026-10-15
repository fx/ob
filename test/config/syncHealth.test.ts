/**
 * Tests for `loadSyncHealthConfig` — the validator for the two opt-in
 * restart ceilings and the `/healthz` sync-failure threshold.
 *
 * Like the watchdog vars, every violation is a startup gate: it MUST exit 78
 * naming the offending variable and its value, before any `ob` child is
 * spawned. A ceiling that silently parses to `Infinity` while the config
 * claims it is set is the failure the upper bound exists to rule out.
 */

import { describe, expect, test } from "bun:test";
import {
  ConfigError,
  DEFAULT_SYNC_HEALTH,
  loadConfig,
  loadSyncHealthConfig,
} from "../../src/config/index.ts";

const VARS = [
  ["OB_SYNC_MAX_CRASHES", "maxCrashes"],
  ["OB_SYNC_MAX_STALL_KILLS", "maxStallKills"],
  ["OB_HEALTHZ_SYNC_FAILURE_THRESHOLD", "healthzFailureThreshold"],
] as const;

describe("loadSyncHealthConfig — defaults", () => {
  test("unset vars yield no ceilings and a liveness threshold of 3", () => {
    expect(loadSyncHealthConfig({})).toEqual({
      maxCrashes: 0,
      maxStallKills: 0,
      healthzFailureThreshold: 3,
    });
    expect(DEFAULT_SYNC_HEALTH).toEqual(loadSyncHealthConfig({}));
  });

  test("ignores unrelated env vars", () => {
    expect(
      loadSyncHealthConfig({ OB_SYNC_MODE: "bidirectional", OB_SYNC_STALL_TIMEOUT_SECONDS: "60" }),
    ).toEqual(DEFAULT_SYNC_HEALTH);
  });
});

for (const [name, field] of VARS) {
  describe(`loadSyncHealthConfig — ${name}`, () => {
    test("accepts 0, a typical value, and the 10000 bound exactly", () => {
      for (const [raw, n] of [
        ["0", 0],
        ["5", 5],
        ["10000", 10_000],
      ] as const) {
        expect(loadSyncHealthConfig({ [name]: raw })[field]).toBe(n);
      }
    });

    test("leaves the other two fields at their defaults", () => {
      const out = loadSyncHealthConfig({ [name]: "7" });
      for (const [, other] of VARS) {
        if (other !== field) expect(out[other]).toBe(DEFAULT_SYNC_HEALTH[other]);
      }
    });

    test("rejects anything that is not a plain non-negative integer, naming the var and value", () => {
      for (const raw of ["abc", "-1", "1.5", "", " 3", "3 "]) {
        expect(() => loadSyncHealthConfig({ [name]: raw })).toThrow(
          `${name} must be a non-negative integer, got "${raw}"`,
        );
      }
    });

    test("rejects a value past 10000, including one that would parse to Infinity", () => {
      expect(() => loadSyncHealthConfig({ [name]: "10001" })).toThrow(
        `${name} must be at most 10000, got 10001`,
      );
      expect(() => loadSyncHealthConfig({ [name]: "9".repeat(400) })).toThrow(
        new RegExp(`${name} must be at most 10000`),
      );
    });

    test("the thrown error carries exit code 78", () => {
      try {
        loadSyncHealthConfig({ [name]: "nope" });
        throw new Error("expected a throw");
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        expect((e as ConfigError).exitCode).toBe(78);
      }
    });
  });
}

describe("loadConfig — syncHealth plumbing", () => {
  const base = { VAULTS_JSON: '[{"name":"V"}]' };

  test("defaults reach the resolved Config", () => {
    expect(loadConfig(base).syncHealth).toEqual(DEFAULT_SYNC_HEALTH);
  });

  test("explicit values reach the resolved Config", () => {
    const cfg = loadConfig({
      ...base,
      OB_SYNC_MAX_CRASHES: "10",
      OB_SYNC_MAX_STALL_KILLS: "3",
      OB_HEALTHZ_SYNC_FAILURE_THRESHOLD: "0",
    });
    expect(cfg.syncHealth).toEqual({
      maxCrashes: 10,
      maxStallKills: 3,
      healthzFailureThreshold: 0,
    });
  });

  test("an invalid sync-health var fails the whole load", () => {
    expect(() => loadConfig({ ...base, OB_SYNC_MAX_STALL_KILLS: "-1" })).toThrow(ConfigError);
  });
});

/**
 * Tests for `src/obsidian/setup.ts`.
 */

import { describe, expect, test } from "bun:test";
import { createLogger } from "../../src/log.ts";
import {
  DEFAULT_BACKOFF,
  SetupPermanentError,
  SetupTransientError,
  backoffDelay,
  ensureVaultSetup,
} from "../../src/obsidian/setup.ts";
import { createFakeSpawner } from "../helpers/fakeSpawner.ts";

const silentLog = createLogger({ level: "error", write: () => undefined });

const FAKE_VAULT = { name: "v", slug: "v", path: "/tmp/v" };

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

describe("SetupTransientError", () => {
  test("carries attempt and exit code", () => {
    const err = new SetupTransientError(2, 1, "v");
    expect(err.attempt).toBe(2);
    expect(err.exitCode).toBe(1);
    expect(err.name).toBe("SetupTransientError");
    expect(err.message).toContain("v");
  });
});

describe("ensureVaultSetup", () => {
  const noSleep = async (_ms: number): Promise<void> => undefined;

  test("skips setup when already configured", async () => {
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 0 }); // sync-status
    await ensureVaultSetup(FAKE_VAULT, { spawner: sp, logger: silentLog, sleep: noSleep });
    expect(sp.calls).toHaveLength(1);
    expect(sp.calls[0]?.args[0]).toBe("sync-status");
  });

  test("runs sync-setup when not configured (success on first try)", async () => {
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 1 }); // sync-status: not configured
    sp.enqueue({ exitCode: 0 }); // sync-setup: success
    await ensureVaultSetup(FAKE_VAULT, { spawner: sp, logger: silentLog, sleep: noSleep });
    expect(sp.calls).toHaveLength(2);
    expect(sp.calls[1]?.args).toEqual(["sync-setup", "--vault", "v", "--path", "/tmp/v"]);
  });

  test("includes --password when e2eePassword is set", async () => {
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 1 });
    sp.enqueue({ exitCode: 0 });
    await ensureVaultSetup(
      { ...FAKE_VAULT, e2eePassword: "secret" },
      { spawner: sp, logger: silentLog, sleep: noSleep },
    );
    expect(sp.calls[1]?.args).toEqual([
      "sync-setup",
      "--vault",
      "v",
      "--path",
      "/tmp/v",
      "--password",
      "secret",
    ]);
  });

  test("retries with backoff and succeeds on attempt 4", async () => {
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 1 }); // sync-status
    sp.enqueue({ exitCode: 1 }); // attempt 1
    sp.enqueue({ exitCode: 1 }); // attempt 2
    sp.enqueue({ exitCode: 1 }); // attempt 3
    sp.enqueue({ exitCode: 0 }); // attempt 4
    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
    };
    await ensureVaultSetup(FAKE_VAULT, { spawner: sp, logger: silentLog, sleep });
    expect(sp.calls).toHaveLength(5);
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
  });

  test("throws SetupPermanentError after 5 attempts", async () => {
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 1 }); // sync-status
    for (let i = 0; i < 5; i++) sp.enqueue({ exitCode: 1 });
    let err: unknown;
    try {
      await ensureVaultSetup(FAKE_VAULT, {
        spawner: sp,
        logger: silentLog,
        sleep: noSleep,
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SetupPermanentError);
    expect((err as SetupPermanentError).attempts).toBe(5);
    expect(sp.calls).toHaveLength(6); // 1 sync-status + 5 sync-setup
  });

  test("respects custom obBin", async () => {
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 0 });
    await ensureVaultSetup(FAKE_VAULT, {
      spawner: sp,
      logger: silentLog,
      sleep: noSleep,
      obBin: "/custom/ob",
    });
    expect(sp.calls[0]?.cmd).toBe("/custom/ob");
  });

  test("respects custom backoff (maxAttempts=2)", async () => {
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 1 }); // sync-status
    sp.enqueue({ exitCode: 1 }); // attempt 1
    sp.enqueue({ exitCode: 1 }); // attempt 2
    let err: unknown;
    try {
      await ensureVaultSetup(FAKE_VAULT, {
        spawner: sp,
        logger: silentLog,
        sleep: noSleep,
        backoff: { initialMs: 5, factor: 2, capMs: 100, maxAttempts: 2 },
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SetupPermanentError);
    expect(sp.calls).toHaveLength(3);
  });
});

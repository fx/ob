/**
 * Tests for `src/obsidian/syncconfig.ts`.
 *
 * Drives the env → argv → spawn pipeline through `createFakeSpawner`,
 * mirroring the test harness used by `setup.test.ts`. No real `ob` binary
 * is invoked.
 */

import { describe, expect, test } from "bun:test";
import type { SyncConfigEnv } from "../../src/config/index.ts";
import { createLogger } from "../../src/log.ts";
import {
  SyncConfigPermanentError,
  applyVaultSyncConfig,
  buildSyncConfigArgs,
} from "../../src/obsidian/syncconfig.ts";
import { createFakeSpawner } from "../helpers/fakeSpawner.ts";

const silentLog = createLogger({ level: "error", write: () => undefined });

const FAKE_VAULT = { name: "v", slug: "v", path: "/p" };
const noSleep = async (_ms: number): Promise<void> => undefined;

describe("buildSyncConfigArgs — no-op", () => {
  test("returns null when every field is undefined", () => {
    expect(buildSyncConfigArgs({}, "/p")).toBeNull();
  });

  test("returns null when env is the literal {} (extra-defensive check)", () => {
    const env: SyncConfigEnv = Object.freeze({});
    expect(buildSyncConfigArgs(env, "/p")).toBeNull();
  });
});

describe("buildSyncConfigArgs — single-flag cases", () => {
  test("file-types (single var)", () => {
    expect(buildSyncConfigArgs({ fileTypes: "image,audio" }, "/p")).toEqual([
      "sync-config",
      "--path",
      "/p",
      "--file-types",
      "image,audio",
    ]);
  });

  test("excluded-folders empty string is forwarded verbatim ('empty to clear')", () => {
    expect(buildSyncConfigArgs({ excludedFolders: "" }, "/p")).toEqual([
      "sync-config",
      "--path",
      "/p",
      "--excluded-folders",
      "",
    ]);
  });

  test("mode", () => {
    expect(buildSyncConfigArgs({ mode: "bidirectional" }, "/p")).toEqual([
      "sync-config",
      "--path",
      "/p",
      "--mode",
      "bidirectional",
    ]);
  });

  test("conflict-strategy", () => {
    expect(buildSyncConfigArgs({ conflictStrategy: "merge" }, "/p")).toEqual([
      "sync-config",
      "--path",
      "/p",
      "--conflict-strategy",
      "merge",
    ]);
  });

  test("device-name", () => {
    expect(buildSyncConfigArgs({ deviceName: "pod-1" }, "/p")).toEqual([
      "sync-config",
      "--path",
      "/p",
      "--device-name",
      "pod-1",
    ]);
  });

  test("configs", () => {
    expect(buildSyncConfigArgs({ configs: "app" }, "/p")).toEqual([
      "sync-config",
      "--path",
      "/p",
      "--configs",
      "app",
    ]);
  });
});

describe("buildSyncConfigArgs — multi-flag ordering", () => {
  test("emits flags in spec table order regardless of object insertion order", () => {
    const env: SyncConfigEnv = {
      // intentionally insert in scrambled order; result MUST follow spec table order.
      configs: "app",
      mode: "bidirectional",
      fileTypes: "image,audio",
      deviceName: "pod-7",
    };
    expect(buildSyncConfigArgs(env, "/data/vaults/v")).toEqual([
      "sync-config",
      "--path",
      "/data/vaults/v",
      "--file-types",
      "image,audio",
      "--mode",
      "bidirectional",
      "--device-name",
      "pod-7",
      "--configs",
      "app",
    ]);
  });

  test("all six flags set", () => {
    const env: SyncConfigEnv = {
      fileTypes: "image,audio,pdf,video,unsupported",
      excludedFolders: "trash",
      mode: "bidirectional",
      conflictStrategy: "merge",
      deviceName: "pod-1",
      configs: "app",
    };
    expect(buildSyncConfigArgs(env, "/p")).toEqual([
      "sync-config",
      "--path",
      "/p",
      "--file-types",
      "image,audio,pdf,video,unsupported",
      "--excluded-folders",
      "trash",
      "--mode",
      "bidirectional",
      "--conflict-strategy",
      "merge",
      "--device-name",
      "pod-1",
      "--configs",
      "app",
    ]);
  });
});

describe("applyVaultSyncConfig — no-op path", () => {
  test("returns immediately and does NOT spawn when no vars are set", async () => {
    const sp = createFakeSpawner();
    await applyVaultSyncConfig(FAKE_VAULT, { spawner: sp, sleep: noSleep }, silentLog, {});
    expect(sp.calls).toHaveLength(0);
  });
});

describe("applyVaultSyncConfig — happy paths", () => {
  test("spawns once with the built argv on first-try success", async () => {
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 0 });
    await applyVaultSyncConfig(FAKE_VAULT, { spawner: sp, sleep: noSleep }, silentLog, {
      fileTypes: "image",
    });
    expect(sp.calls).toHaveLength(1);
    expect(sp.calls[0]?.cmd).toBe("ob");
    expect(sp.calls[0]?.args).toEqual(["sync-config", "--path", "/p", "--file-types", "image"]);
  });

  test("respects custom obBin", async () => {
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 0 });
    await applyVaultSyncConfig(
      FAKE_VAULT,
      { spawner: sp, sleep: noSleep, obBin: "/custom/ob" },
      silentLog,
      { mode: "bidirectional" },
    );
    expect(sp.calls[0]?.cmd).toBe("/custom/ob");
  });
});

describe("applyVaultSyncConfig — retries", () => {
  test("retries once on a transient non-zero exit, then succeeds", async () => {
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 1 }); // attempt 1
    sp.enqueue({ exitCode: 0 }); // attempt 2 succeeds
    const sleeps: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      sleeps.push(ms);
    };
    await applyVaultSyncConfig(FAKE_VAULT, { spawner: sp, sleep }, silentLog, {
      fileTypes: "image",
    });
    expect(sp.calls).toHaveLength(2);
    expect(sleeps).toEqual([1_000]); // initial backoff between attempt 1 and 2
  });

  test("treats spawner throws as transient (-1 exit) and continues to retry", async () => {
    let throws = 1;
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const empty = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        start(c): void {
          c.close();
        },
      });
    const customSpawner = {
      run: (cmd: string, args: readonly string[]) => {
        calls.push({ cmd, args });
        if (throws > 0) {
          throws--;
          throw new Error("ENOENT: ob not on PATH");
        }
        return {
          pid: 1,
          stdout: empty(),
          stderr: empty(),
          exited: Promise.resolve(0),
          kill: (): void => undefined,
        };
      },
    };
    await applyVaultSyncConfig(FAKE_VAULT, { spawner: customSpawner, sleep: noSleep }, silentLog, {
      mode: "bidirectional",
    });
    expect(calls).toHaveLength(2);
  });

  test("throws SyncConfigPermanentError after 5 consecutive failures", async () => {
    const sp = createFakeSpawner();
    for (let i = 0; i < 5; i++) sp.enqueue({ exitCode: 1 });
    let err: unknown;
    try {
      await applyVaultSyncConfig(FAKE_VAULT, { spawner: sp, sleep: noSleep }, silentLog, {
        fileTypes: "image",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SyncConfigPermanentError);
    expect((err as SyncConfigPermanentError).attempts).toBe(5);
    expect(sp.calls).toHaveLength(5);
  });

  test("respects a custom backoff (maxAttempts=2)", async () => {
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 1 });
    sp.enqueue({ exitCode: 1 });
    let err: unknown;
    try {
      await applyVaultSyncConfig(
        FAKE_VAULT,
        {
          spawner: sp,
          sleep: noSleep,
          backoff: { initialMs: 0, factor: 1, capMs: 0, maxAttempts: 2 },
        },
        silentLog,
        { fileTypes: "image" },
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(SyncConfigPermanentError);
    expect(sp.calls).toHaveLength(2);
  });
});

describe("applyVaultSyncConfig — cancellation", () => {
  test("shouldStop short-circuits before the first attempt", async () => {
    const sp = createFakeSpawner();
    await applyVaultSyncConfig(
      FAKE_VAULT,
      { spawner: sp, sleep: noSleep, shouldStop: () => true },
      silentLog,
      { fileTypes: "image" },
    );
    expect(sp.calls).toHaveLength(0);
  });

  test("shouldStop short-circuits between attempts", async () => {
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 1 }); // attempt 1 fails
    let attemptsSeen = 0;
    const shouldStop = (): boolean => {
      attemptsSeen++;
      // Allow the first call (before attempt 1), reject the second (before attempt 2).
      return attemptsSeen > 1;
    };
    await applyVaultSyncConfig(FAKE_VAULT, { spawner: sp, sleep: noSleep, shouldStop }, silentLog, {
      fileTypes: "image",
    });
    expect(sp.calls).toHaveLength(1);
  });
});

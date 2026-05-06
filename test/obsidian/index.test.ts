/**
 * Tests for the Supervisor facade in `src/obsidian/index.ts`.
 *
 * These tests stitch the bootstrap → mkdir → setup → child loop pipeline
 * together using `createFakeSpawner`. No real `ob` binary is invoked.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../../src/config/index.ts";
import { createLogger } from "../../src/log.ts";
import {
  AuthMissingError,
  SyncConfigPermanentError,
  isAllRunning,
  startSupervisor,
} from "../../src/obsidian/index.ts";
import { createFakeSpawner } from "../helpers/fakeSpawner.ts";

const silentLog = createLogger({ level: "error", write: () => undefined });

function makeTmp(prefix = "ob-sup-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function buildConfig(over: Partial<Config> = {}): Config {
  const dataDir = makeTmp("ob-data-");
  return {
    obsidianAuthToken: "abc",
    vaults: [{ name: "v", slug: "v" }],
    dataDir,
    httpPort: 0,
    httpHost: "127.0.0.1",
    embeddingProvider: "transformers",
    embeddingModel: "Xenova/all-MiniLM-L6-v2",
    logLevel: "error",
    syncConfigEnv: {},
    ...over,
  };
}

const noSleep = async (_ms: number): Promise<void> => undefined;

function tick(): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, 0));
}

async function waitForCalls(sp: ReturnType<typeof createFakeSpawner>, n: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (sp.calls.length >= n) return;
    await tick();
  }
  throw new Error(`waitForCalls(${n}) timed out at ${sp.calls.length}`);
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error(`waitFor(${label}) timed out`);
}

describe("startSupervisor — first start, fresh dir", () => {
  test("creates vault dir, runs sync-status then sync-setup then sync", async () => {
    const xdg = makeTmp("ob-xdg-");
    const cfg = buildConfig();
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 1 }); // sync-status -> not configured
    sp.enqueue({ exitCode: 0 }); // sync-setup
    // sync runs forever; default-handle exit 0 means it'd exit and restart; provide a long-running fake.
    let resolveSync!: (n: number) => void;
    const syncExit = new Promise<number>((r) => {
      resolveSync = r;
    });
    sp.enqueue({ exitWhen: syncExit, pid: 7777 });

    const sup = await startSupervisor(cfg, {
      logger: silentLog,
      spawner: sp,
      sleep: noSleep,
      xdgConfigHome: xdg,
      homeDir: makeTmp("ob-home-"),
    });

    // The synchronous list() call already returns the vault even before
    // setup/spawn complete.
    const initialList = sup.list();
    expect(initialList).toHaveLength(1);
    expect(initialList[0]?.slug).toBe("v");

    await waitForCalls(sp, 3);

    // Vault dir was created with mode 0700.
    const vaultPath = join(cfg.dataDir, "vaults", "v");
    expect(existsSync(vaultPath)).toBe(true);
    expect(statSync(vaultPath).mode & 0o777).toBe(0o700);
    expect(sp.calls.map((c) => c.args[0])).toEqual(["sync-status", "sync-setup", "sync"]);
    expect(sp.calls[1]?.args).toEqual(["sync-setup", "--vault", "v", "--path", vaultPath]);
    expect(sp.calls[2]?.args).toEqual(["sync", "--continuous", "--path", vaultPath]);

    // Stop and clean up.
    resolveSync(0);
    await sup.stop();
  });

  test("skips setup when sync-status returns 0", async () => {
    const xdg = makeTmp("ob-xdg-");
    const cfg = buildConfig();
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 0 }); // already configured
    let resolveSync!: (n: number) => void;
    const syncExit = new Promise<number>((r) => {
      resolveSync = r;
    });
    sp.enqueue({ exitWhen: syncExit });

    const sup = await startSupervisor(cfg, {
      logger: silentLog,
      spawner: sp,
      sleep: noSleep,
      xdgConfigHome: xdg,
      homeDir: makeTmp("ob-home-"),
    });

    await waitForCalls(sp, 2);
    expect(sp.calls.map((c) => c.args[0])).toEqual(["sync-status", "sync"]);
    resolveSync(0);
    await sup.stop();
  });
});

describe("startSupervisor — bootstrap", () => {
  test("AuthMissingError propagates when no token", async () => {
    const xdg = makeTmp("ob-xdg-");
    const cfg = buildConfig({ obsidianAuthToken: "abc" });
    // Forge env with no auth token by passing through a custom fs that
    // claims no file exists; easiest: pass token "" via a clone, but
    // loadConfig won't allow that. Bootstrap directly via the supervisor.
    const sp = createFakeSpawner();
    let err: unknown;
    try {
      await startSupervisor({ ...cfg, obsidianAuthToken: "" } as Config, {
        logger: silentLog,
        spawner: sp,
        sleep: noSleep,
        xdgConfigHome: xdg,
        homeDir: makeTmp("ob-home-"),
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(AuthMissingError);
  });

  test("skipAuthBootstrap allows bypassing the bootstrap step", async () => {
    const cfg = buildConfig();
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 0 }); // sync-status
    let resolveSync!: (n: number) => void;
    const syncExit = new Promise<number>((r) => {
      resolveSync = r;
    });
    sp.enqueue({ exitWhen: syncExit });
    const sup = await startSupervisor(cfg, {
      logger: silentLog,
      spawner: sp,
      sleep: noSleep,
      skipAuthBootstrap: true,
    });
    resolveSync(0);
    await sup.stop();
  });

  test("authFs override is plumbed through", async () => {
    const cfg = buildConfig();
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 0 });
    let resolveSync!: (n: number) => void;
    const syncExit = new Promise<number>((r) => {
      resolveSync = r;
    });
    sp.enqueue({ exitWhen: syncExit });
    let writeCalled = false;
    const sup = await startSupervisor(cfg, {
      logger: silentLog,
      spawner: sp,
      sleep: noSleep,
      xdgConfigHome: makeTmp("ob-xdg-"),
      homeDir: makeTmp("ob-home-"),
      authFs: {
        mkdir: async () => undefined,
        readFile: async () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
        writeFile: async () => {
          writeCalled = true;
        },
        chmod: async () => undefined,
      },
    });
    expect(writeCalled).toBe(true);
    resolveSync(0);
    await sup.stop();
  });
});

describe("startSupervisor — failure paths", () => {
  test("mkdir failure marks vault failed without spawning", async () => {
    const cfg = buildConfig();
    const sp = createFakeSpawner();
    const sup = await startSupervisor(cfg, {
      logger: silentLog,
      spawner: sp,
      sleep: noSleep,
      skipAuthBootstrap: true,
      mkdir: async () => {
        throw new Error("EACCES: read-only");
      },
    });
    await waitFor(() => sup.get("v")?.state === "failed", "vault failed");
    const status = sup.get("v");
    expect(status?.state).toBe("failed");
    expect(status?.lastError).toContain("EACCES");
    expect(sp.calls).toHaveLength(0);
    await sup.stop();
  });

  test("mkdir failure with non-Error stringifies", async () => {
    const cfg = buildConfig();
    const sp = createFakeSpawner();
    const sup = await startSupervisor(cfg, {
      logger: silentLog,
      spawner: sp,
      sleep: noSleep,
      skipAuthBootstrap: true,
      mkdir: async () => {
        // eslint-disable-next-line no-throw-literal -- non-Error branch
        throw "raw mkdir failure";
      },
    });
    await waitFor(() => sup.get("v")?.state === "failed", "vault failed");
    expect(sup.get("v")?.lastError).toContain("raw mkdir failure");
    await sup.stop();
  });

  test("setup permanent failure marks vault failed", async () => {
    const cfg = buildConfig();
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 1 }); // sync-status
    for (let i = 0; i < 5; i++) sp.enqueue({ exitCode: 1 }); // 5 setup attempts fail

    const sup = await startSupervisor(cfg, {
      logger: silentLog,
      spawner: sp,
      sleep: noSleep,
      skipAuthBootstrap: true,
      setupBackoff: { initialMs: 0, factor: 1, capMs: 0, maxAttempts: 5 },
    });
    // Wait until the setup queue marks the vault failed.
    await waitFor(() => sup.get("v")?.state === "failed", "vault failed");
    expect(sp.calls).toHaveLength(6);
    await sup.stop();
  });

  test("setup raising synchronous spawn failures eventually marks vault failed (after maxAttempts)", async () => {
    const cfg = buildConfig();
    // Spawner throws synchronously on every call. With the new
    // retry-throws-as-transient policy, the loop tries `maxAttempts`
    // times before raising `SetupPermanentError`.
    const sp = {
      calls: [] as { cmd: string; args: readonly string[] }[],
      run: (): never => {
        throw new Error("synchronous spawn failure");
      },
    };
    const sup = await startSupervisor(cfg, {
      logger: silentLog,
      spawner: sp,
      sleep: noSleep,
      skipAuthBootstrap: true,
      setupBackoff: { initialMs: 0, factor: 1, capMs: 0, maxAttempts: 2 },
    });
    await waitFor(() => sup.get("v")?.state === "failed", "vault failed");
    // Permanent error message wins after the retry ceiling.
    expect(sup.get("v")?.lastError).toContain("permanently");
    await sup.stop();
  });

  test("setup retries through transient sync-setup launch failures and eventually succeeds", async () => {
    const cfg = buildConfig();
    // sync-status returns non-zero (not configured), then sync-setup throws
    // synchronously twice (transient launch failures) before succeeding.
    let setupThrows = 2;
    let resolveSync!: (n: number) => void;
    const syncExit = new Promise<number>((r) => {
      resolveSync = r;
    });
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const empty = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        start(c): void {
          c.close();
        },
      });
    const customSpawner = {
      calls,
      run: (cmd: string, args: readonly string[]) => {
        calls.push({ cmd, args });
        const op = args[0];
        if (op === "sync-status") {
          // not-configured.
          return {
            pid: 1,
            stdout: empty(),
            stderr: empty(),
            exited: Promise.resolve(1),
            kill: (): void => undefined,
          };
        }
        if (op === "sync-setup") {
          if (setupThrows > 0) {
            setupThrows--;
            throw new Error(`transient ENOENT #${setupThrows + 1}`);
          }
          // Succeed.
          return {
            pid: 1,
            stdout: empty(),
            stderr: empty(),
            exited: Promise.resolve(0),
            kill: (): void => undefined,
          };
        }
        // The long-running `ob sync` child. Resolve on kill.
        return {
          pid: 99,
          stdout: empty(),
          stderr: empty(),
          exited: syncExit,
          kill: (): void => {
            resolveSync(0);
          },
        };
      },
    };
    const sup = await startSupervisor(cfg, {
      logger: silentLog,
      spawner: customSpawner,
      sleep: noSleep,
      skipAuthBootstrap: true,
      setupBackoff: { initialMs: 0, factor: 1, capMs: 0, maxAttempts: 5 },
    });
    await waitFor(
      () => sup.get("v")?.state === "running",
      "vault running after transient setup throws",
    );
    // 1 sync-status + 2 throws + 1 successful setup + 1 sync child = 5 calls.
    expect(calls.length).toBeGreaterThanOrEqual(4);
    await sup.stop();
  });

  test("supervisor.stop() cancels in-flight init pipeline and prevents further setup invocations", async () => {
    const cfg = buildConfig();
    // Block sync-status until released. The supervisor calls stop() during
    // the block; once released, no further setup invocations should fire.
    let releaseStatus!: (n: number) => void;
    const statusGate = new Promise<number>((r) => {
      releaseStatus = r;
    });
    const calls: Array<{ cmd: string; args: readonly string[] }> = [];
    const customSpawner = {
      calls,
      run: (cmd: string, args: readonly string[]) => {
        calls.push({ cmd, args });
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
          exited: statusGate, // first call hangs here
          kill: (): void => releaseStatus(0),
        };
      },
    };
    const sup = await startSupervisor(cfg, {
      logger: silentLog,
      spawner: customSpawner,
      sleep: noSleep,
      skipAuthBootstrap: true,
    });
    await waitForCalls({ calls } as unknown as ReturnType<typeof createFakeSpawner>, 1);
    expect(calls.length).toBe(1);
    const stopP = sup.stop();
    // Release the in-flight call.
    releaseStatus(0);
    await stopP;
    // After stop resolves, NO further setup-style calls should have been made.
    expect(calls.length).toBe(1);
  });
});

describe("Supervisor public surface", () => {
  test("list and get reflect every configured vault", async () => {
    const cfg = buildConfig({
      vaults: [
        { name: "a", slug: "a" },
        { name: "b", slug: "b" },
      ],
    });
    const sp = createFakeSpawner({ defaultHandle: { exitCode: 0 } });
    const sup = await startSupervisor(cfg, {
      logger: silentLog,
      spawner: sp,
      sleep: noSleep,
      skipAuthBootstrap: true,
    });
    expect(
      sup
        .list()
        .map((v) => v.slug)
        .sort(),
    ).toEqual(["a", "b"]);
    expect(sup.get("a")?.slug).toBe("a");
    expect(sup.get("missing")).toBeNull();
    await sup.stop();
  });

  test("stop is idempotent", async () => {
    const cfg = buildConfig();
    const sp = createFakeSpawner({ defaultHandle: { exitCode: 0 } });
    const sup = await startSupervisor(cfg, {
      logger: silentLog,
      spawner: sp,
      sleep: noSleep,
      skipAuthBootstrap: true,
    });
    const a = sup.stop();
    const b = sup.stop();
    expect(a).toBe(b);
    await a;
  });

  test("stop sends SIGTERM and waits within stopGraceMs; SIGKILLs survivors", async () => {
    const cfg = buildConfig();
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 0 }); // sync-status configured
    // Long-running child that ignores SIGTERM, only exits on SIGKILL.
    let resolveExit!: (n: number) => void;
    const exitWhen = new Promise<number>((r) => {
      resolveExit = r;
    });
    sp.enqueue({
      exitWhen,
      onKill: (sig) => {
        if (sig === "SIGKILL") resolveExit(137);
      },
    });

    const sup = await startSupervisor(cfg, {
      logger: silentLog,
      spawner: sp,
      sleep: noSleep,
      skipAuthBootstrap: true,
      stopGraceMs: 5,
    });
    // Wait for child loop to actually spawn the sync.
    await waitForCalls(sp, 2);
    await sup.stop();
  });

  test("stop returns immediately on a never-started vault (markFailed path)", async () => {
    const cfg = buildConfig();
    const sup = await startSupervisor(cfg, {
      logger: silentLog,
      spawner: createFakeSpawner(),
      sleep: noSleep,
      skipAuthBootstrap: true,
      mkdir: async () => {
        throw new Error("nope");
      },
    });
    await sup.stop();
  });
});

describe("startSupervisor — defaults", () => {
  test("uses default sleep (real setTimeout) when none injected; backoff in setup loop is observable", async () => {
    const cfg = buildConfig();
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 1 }); // sync-status
    sp.enqueue({ exitCode: 1 }); // setup attempt 1 fails -> backoff via real setTimeout
    sp.enqueue({ exitCode: 0 }); // setup attempt 2 succeeds
    let resolveSync!: (n: number) => void;
    const syncExit = new Promise<number>((r) => {
      resolveSync = r;
    });
    sp.enqueue({ exitWhen: syncExit });
    const sup = await startSupervisor(cfg, {
      logger: silentLog,
      spawner: sp,
      // NOTE: omit `sleep` to exercise defaultSleep.
      skipAuthBootstrap: true,
      setupBackoff: { initialMs: 1, factor: 1, capMs: 1, maxAttempts: 3 },
    });
    await waitForCalls(sp, 4);
    resolveSync(0);
    await sup.stop();
  });

  test("uses default mkdir when none injected (real fs)", async () => {
    const cfg = buildConfig();
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 0 });
    let resolveSync!: (n: number) => void;
    const syncExit = new Promise<number>((r) => {
      resolveSync = r;
    });
    sp.enqueue({ exitWhen: syncExit });
    const sup = await startSupervisor(cfg, {
      logger: silentLog,
      spawner: sp,
      sleep: noSleep,
      // NOTE: omit `mkdir` to exercise defaultMkdir.
      skipAuthBootstrap: true,
    });
    await waitForCalls(sp, 2);
    resolveSync(0);
    await sup.stop();
  });

  test("plumbs e2eePassword through to setup args", async () => {
    const cfg = buildConfig({ vaults: [{ name: "v", slug: "v", e2eePassword: "pw" }] });
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 1 }); // sync-status
    sp.enqueue({ exitCode: 0 }); // sync-setup
    let resolveSync!: (n: number) => void;
    const syncExit = new Promise<number>((r) => {
      resolveSync = r;
    });
    sp.enqueue({ exitWhen: syncExit });
    const sup = await startSupervisor(cfg, {
      logger: silentLog,
      spawner: sp,
      sleep: noSleep,
      skipAuthBootstrap: true,
    });
    await waitForCalls(sp, 3);
    expect(sp.calls[1]?.args).toContain("--password");
    expect(sp.calls[1]?.args).toContain("pw");
    resolveSync(0);
    await sup.stop();
  });

  test("uses real spawner default and Date.now / process.env HOME defaults", async () => {
    // Build a config with a missing token — by default, ensureAuthToken
    // will try to read /home/ob/.config/obsidian-headless/auth_token via
    // the default fs (real fs). To avoid touching the real fs we provide
    // an authFs that always reports ENOENT, leaving the env value (which
    // we set) to be written. Net effect: every dependency that has a
    // default falls back, exercising the default codepaths.
    const cfg = buildConfig();
    const sp = createFakeSpawner({ defaultHandle: { exitCode: 0 } });
    let writes = 0;
    const sup = await startSupervisor(cfg, {
      logger: silentLog,
      spawner: sp,
      // omit sleep, mkdir, now — all defaults are exercised.
      authFs: {
        mkdir: async () => undefined,
        readFile: async () => {
          throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        },
        writeFile: async () => {
          writes++;
        },
        chmod: async () => undefined,
      },
    });
    expect(writes).toBe(1);
    await sup.stop();
  });
});

describe("startSupervisor — sync-config wiring", () => {
  test("all OB_SYNC_* unset → sync-config is not invoked (default no-op)", async () => {
    const cfg = buildConfig(); // syncConfigEnv defaults to {}
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 1 }); // sync-status -> not configured
    sp.enqueue({ exitCode: 0 }); // sync-setup
    let resolveSync!: (n: number) => void;
    const syncExit = new Promise<number>((r) => {
      resolveSync = r;
    });
    sp.enqueue({ exitWhen: syncExit });
    const sup = await startSupervisor(cfg, {
      logger: silentLog,
      spawner: sp,
      sleep: noSleep,
      skipAuthBootstrap: true,
    });
    await waitForCalls(sp, 3);
    // No sync-config call ever happened.
    expect(sp.calls.map((c) => c.args[0])).toEqual(["sync-status", "sync-setup", "sync"]);
    resolveSync(0);
    await sup.stop();
  });

  test("with OB_SYNC_FILE_TYPES set, spawn order is setup → sync-config → sync", async () => {
    const cfg = buildConfig({
      syncConfigEnv: { fileTypes: "image,audio,pdf,video,unsupported" },
    });
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 1 }); // sync-status -> not configured
    sp.enqueue({ exitCode: 0 }); // sync-setup
    sp.enqueue({ exitCode: 0 }); // sync-config
    let resolveSync!: (n: number) => void;
    const syncExit = new Promise<number>((r) => {
      resolveSync = r;
    });
    sp.enqueue({ exitWhen: syncExit });
    const sup = await startSupervisor(cfg, {
      logger: silentLog,
      spawner: sp,
      sleep: noSleep,
      skipAuthBootstrap: true,
    });
    await waitForCalls(sp, 4);
    expect(sp.calls.map((c) => c.args[0])).toEqual([
      "sync-status",
      "sync-setup",
      "sync-config",
      "sync",
    ]);
    const vaultPath = join(cfg.dataDir, "vaults", "v");
    expect(sp.calls[2]?.args).toEqual([
      "sync-config",
      "--path",
      vaultPath,
      "--file-types",
      "image,audio,pdf,video,unsupported",
    ]);
    resolveSync(0);
    await sup.stop();
  });

  test("sync-config permanent failure marks vault failed and prevents `sync` spawn", async () => {
    const cfg = buildConfig({
      syncConfigEnv: { mode: "bidirectional" },
    });
    const sp = createFakeSpawner();
    sp.enqueue({ exitCode: 0 }); // sync-status -> already configured (skips setup)
    // Five sync-config attempts all fail.
    for (let i = 0; i < 5; i++) sp.enqueue({ exitCode: 1 });

    const sup = await startSupervisor(cfg, {
      logger: silentLog,
      spawner: sp,
      sleep: noSleep,
      skipAuthBootstrap: true,
      setupBackoff: { initialMs: 0, factor: 1, capMs: 0, maxAttempts: 5 },
    });
    await waitFor(() => sup.get("v")?.state === "failed", "vault failed on sync-config");
    // 1 sync-status + 5 sync-config attempts = 6 calls. NO sync child.
    expect(sp.calls).toHaveLength(6);
    expect(sp.calls.map((c) => c.args[0])).toEqual([
      "sync-status",
      "sync-config",
      "sync-config",
      "sync-config",
      "sync-config",
      "sync-config",
    ]);
    expect(sup.get("v")?.lastError).toContain("sync-config");
    // Sanity: the error message comes from SyncConfigPermanentError; the
    // exported class is what `index.ts` uses to recognise the error type.
    expect(SyncConfigPermanentError.name).toBe("SyncConfigPermanentError");
    await sup.stop();
  });

  test("non-Error throw from a sync-config sub-step stringifies into lastError", async () => {
    // This drives the `e instanceof Error ? e.message : String(e)` branch in
    // the supervisor's catch handler. We achieve this by using a custom
    // spawner that throws a non-Error value on sync-config; the orchestrator
    // converts the throw into a -1 "exit" and reaches the permanent-failure
    // branch after maxAttempts.
    const cfg = buildConfig({ syncConfigEnv: { mode: "bidirectional" } });
    const empty = (): ReadableStream<Uint8Array> =>
      new ReadableStream<Uint8Array>({
        start(c): void {
          c.close();
        },
      });
    let calls = 0;
    const sp = {
      run: (_cmd: string, args: readonly string[]) => {
        calls++;
        if (args[0] === "sync-status") {
          return {
            pid: 1,
            stdout: empty(),
            stderr: empty(),
            exited: Promise.resolve(0),
            kill: (): void => undefined,
          };
        }
        // sync-config — always non-Error throw.
        // eslint-disable-next-line no-throw-literal -- non-Error branch
        throw "raw sync-config failure";
      },
    };
    const sup = await startSupervisor(cfg, {
      logger: silentLog,
      spawner: sp,
      sleep: noSleep,
      skipAuthBootstrap: true,
      setupBackoff: { initialMs: 0, factor: 1, capMs: 0, maxAttempts: 2 },
    });
    await waitFor(() => sup.get("v")?.state === "failed", "vault failed on sync-config throw");
    const lastError = sup.get("v")?.lastError;
    expect(lastError).toContain("permanently");
    // Regression guard: the non-Error throw value MUST survive the
    // backoff/permanent-error chain so operators can diagnose the launch
    // failure instead of seeing only a generic "permanently" message.
    expect(lastError).toContain("raw sync-config failure");
    expect(calls).toBeGreaterThanOrEqual(2);
    await sup.stop();
  });
});

describe("isAllRunning helper", () => {
  test("empty list is NOT considered ready", () => {
    expect(isAllRunning([])).toBe(false);
  });
  test("all running -> true", () => {
    expect(
      isAllRunning([
        { slug: "a", name: "a", state: "running", pid: 1, restarts: 0, lastError: null },
      ]),
    ).toBe(true);
  });
  test("any non-running -> false", () => {
    expect(
      isAllRunning([
        { slug: "a", name: "a", state: "running", pid: 1, restarts: 0, lastError: null },
        { slug: "b", name: "b", state: "starting", pid: null, restarts: 0, lastError: null },
      ]),
    ).toBe(false);
  });
});

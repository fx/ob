import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config/index.ts";
import type { Indexer, IndexerStatus, SearchHit } from "../src/indexer/index.ts";
import { type Logger, createLogger } from "../src/log.ts";
import type { Supervisor, VaultStatus } from "../src/obsidian/index.ts";
import {
  SHUTDOWN_TIMEOUT_MS,
  type ServeImpl,
  cliExit,
  installSignalHandlers,
  main,
  startServer,
  withTimeout,
} from "../src/server.ts";

const TOKEN = "tk";
const VAULTS = '[{"name":"v"}]';

function silentLogger(): Logger {
  return createLogger({ level: "error", write: () => undefined });
}

function fakeSupervisor(
  statuses: VaultStatus[] = [],
  stop: () => Promise<void> = async () => undefined,
): Supervisor {
  return {
    list: () => statuses.slice(),
    get: (slug) => statuses.find((s) => s.slug === slug) ?? null,
    stop,
  };
}

function fakeIndexer(
  statuses: IndexerStatus[] = [],
  stop: () => Promise<void> = async () => undefined,
): Indexer {
  return {
    list: () => statuses.slice(),
    status: (slug) => statuses.find((s) => s.slug === slug) ?? null,
    search: async (): Promise<SearchHit[]> => [],
    reindex: async () => undefined,
    drop: async () => undefined,
    stop,
  };
}

function readyIndexer(slugs: string[] = ["v"]): Indexer {
  return fakeIndexer(
    slugs.map(
      (slug): IndexerStatus => ({
        slug,
        state: "ready",
        documents: 0,
        chunks: 0,
        lastIndexedAt: null,
        pending: 0,
        errors: 0,
      }),
    ),
  );
}

function tmpEnv(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "ob-server-test-"));
  return { XDG_CONFIG_HOME: dir, HOME: dir };
}

function baseConfig(overrides: Partial<Config> = {}): Config {
  const cfg: Config = {
    obsidianAuthToken: TOKEN,
    vaults: [{ name: "v", slug: "v" }],
    dataDir: "/tmp/ob-test",
    httpPort: 0, // 0 = ephemeral port
    httpHost: "127.0.0.1",
    embeddingProvider: "transformers",
    embeddingModel: "Xenova/all-MiniLM-L6-v2",
    logLevel: "error",
    syncConfigEnv: {},
    ...overrides,
  };
  return cfg;
}

describe("startServer", () => {
  test("listens, /healthz responds 200, shutdown resolves", async () => {
    const running = startServer({
      config: baseConfig(),
      supervisor: fakeSupervisor(),
      indexer: readyIndexer(),
      logger: silentLogger(),
    });
    try {
      const url = `http://${running.server.hostname}:${running.server.port}/healthz`;
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
      expect(running.server.pendingRequests).toBe(0);
    } finally {
      await running.shutdown();
    }
  });

  test("shutdown is idempotent", async () => {
    const running = startServer({
      config: baseConfig(),
      supervisor: fakeSupervisor(),
      indexer: readyIndexer(),
      logger: silentLogger(),
    });
    const a = running.shutdown();
    const b = running.shutdown();
    expect(a).toBe(b);
    await a;
  });

  test("uses default logger when none supplied", async () => {
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as unknown as typeof process.stdout.write;
    try {
      const running = startServer({
        config: baseConfig({ logLevel: "error" }),
        supervisor: fakeSupervisor(),
        indexer: readyIndexer(),
      });
      await running.shutdown();
    } finally {
      process.stdout.write = originalWrite;
    }
  });

  test("uses injected serveImpl when provided", async () => {
    let observed: { port: number; hostname: string } | undefined;
    const stubServer = {
      port: 12345,
      hostname: "stub-host",
      pendingRequests: 0,
      stop: async () => undefined,
    };
    const injected: ServeImpl = (options) => {
      observed = { port: options.port, hostname: options.hostname };
      return stubServer as unknown as ReturnType<typeof Bun.serve>;
    };
    const running = startServer({
      config: baseConfig({ httpPort: 9999, httpHost: "test-host" }),
      supervisor: fakeSupervisor(),
      indexer: readyIndexer(),
      logger: silentLogger(),
      serveImpl: injected,
    });
    expect(observed).toEqual({ port: 9999, hostname: "test-host" });
    expect(running.server).toBe(stubServer as unknown as ReturnType<typeof Bun.serve>);
    await running.shutdown();
  });

  test("propagates synchronous throw from underlying serve impl", () => {
    const throwingServe: ServeImpl = () => {
      throw new Error("listen failed");
    };
    expect(() =>
      startServer({
        config: baseConfig(),
        supervisor: fakeSupervisor(),
        indexer: readyIndexer(),
        logger: silentLogger(),
        serveImpl: throwingServe,
      }),
    ).toThrow(/listen failed/);
  });
});

describe("withTimeout", () => {
  test("resolves with promise value when fast", async () => {
    const v = await withTimeout(Promise.resolve(42), 1000, "nope");
    expect(v).toBe(42);
  });

  test("rejects with provided message when slow", async () => {
    const slow = new Promise<number>((resolve) => setTimeout(() => resolve(1), 50));
    let err: unknown;
    try {
      await withTimeout(slow, 5, "timed out");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe("timed out");
  });

  test("re-throws underlying rejection", async () => {
    const failing = Promise.reject(new Error("inner"));
    let err: unknown;
    try {
      await withTimeout(failing, 1000, "should not surface");
    } catch (e) {
      err = e;
    }
    expect((err as Error).message).toBe("inner");
  });

  test("SHUTDOWN_TIMEOUT_MS is exported as 10s", () => {
    expect(SHUTDOWN_TIMEOUT_MS).toBe(10_000);
  });
});

describe("installSignalHandlers", () => {
  /**
   * Build a deferred Promise that the test can resolve at a chosen point —
   * used to make signal-handler tests deterministic instead of relying on
   * `setTimeout(..., N)` polling.
   */
  function deferred<T>(): {
    promise: Promise<T>;
    resolve: (v: T) => void;
  } {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((r) => {
      resolve = r;
    });
    return { promise, resolve };
  }

  test("invokes shutdown and exits 0 on SIGTERM, then ignores second signal", async () => {
    let calls = 0;
    const shutdownGate = deferred<void>();
    const shutdown = async (): Promise<void> => {
      calls++;
      await shutdownGate.promise;
    };
    const exitGate = deferred<number>();
    const dispose = installSignalHandlers(shutdown, (c) => {
      exitGate.resolve(c);
    });
    try {
      process.emit("SIGTERM");
      // Second signal must be ignored even though shutdown() hasn't resolved.
      process.emit("SIGTERM");
      shutdownGate.resolve();
      const exitCode = await exitGate.promise;
      expect(calls).toBe(1);
      expect(exitCode).toBe(0);
    } finally {
      dispose();
    }
  });

  test("invokes shutdown on SIGINT", async () => {
    let called = false;
    const shutdown = async (): Promise<void> => {
      called = true;
    };
    const exitGate = deferred<number>();
    const dispose = installSignalHandlers(shutdown, (c) => {
      exitGate.resolve(c);
    });
    try {
      process.emit("SIGINT");
      const exitCode = await exitGate.promise;
      expect(called).toBe(true);
      expect(exitCode).toBe(0);
    } finally {
      dispose();
    }
  });

  test("exits 1 when shutdown rejects", async () => {
    const shutdown = (): Promise<void> => Promise.reject(new Error("bad"));
    const exitGate = deferred<number>();
    const dispose = installSignalHandlers(shutdown, (c) => {
      exitGate.resolve(c);
    });
    try {
      process.emit("SIGTERM");
      expect(await exitGate.promise).toBe(1);
    } finally {
      dispose();
    }
  });

  test("dispose removes listeners (no further calls)", async () => {
    let calls = 0;
    const shutdown = async (): Promise<void> => {
      calls++;
    };
    const dispose = installSignalHandlers(shutdown, () => undefined);
    dispose();
    process.emit("SIGTERM");
    process.emit("SIGINT");
    // Drain the microtask queue so any spuriously-scheduled handler would
    // have run by now — no fixed sleep needed.
    await new Promise<void>((r) => queueMicrotask(r));
    await new Promise<void>((r) => queueMicrotask(r));
    expect(calls).toBe(0);
  });

  test("default exit argument falls through to process.exit (verified by stub)", async () => {
    // Replace process.exit to confirm the default is used.
    const original = process.exit.bind(process) as (code?: number) => never;
    const exitGate = deferred<number | undefined>();
    process.exit = ((c?: number) => {
      exitGate.resolve(c);
    }) as unknown as typeof process.exit;
    let dispose: (() => void) | undefined;
    try {
      dispose = installSignalHandlers(async () => undefined);
      process.emit("SIGTERM");
      expect(await exitGate.promise).toBe(0);
    } finally {
      if (dispose !== undefined) dispose();
      process.exit = original as unknown as typeof process.exit;
    }
  });
});

describe("main", () => {
  test("exits with code 78 on ConfigError and returns undefined", async () => {
    let exitCode: number | undefined;
    const result = await main(
      {},
      (c) => {
        exitCode = c;
      },
      silentLogger(),
    );
    expect(result).toBeUndefined();
    expect(exitCode).toBe(78);
  });

  test("starts the server and returns running handle on valid config", async () => {
    const env: Record<string, string | undefined> = {
      OBSIDIAN_AUTH_TOKEN: TOKEN,
      VAULTS_JSON: VAULTS,
      HTTP_PORT: "0",
      HTTP_HOST: "127.0.0.1",
      LOG_LEVEL: "error",
      ...tmpEnv(),
    };
    let exitCode: number | undefined;
    const running = await main(
      env,
      (c) => {
        exitCode = c;
      },
      silentLogger(),
      undefined,
      async () => fakeSupervisor(),
      async () => readyIndexer(),
    );
    expect(exitCode).toBeUndefined();
    expect(running).toBeDefined();
    if (running !== undefined) {
      try {
        const url = `http://${running.server.hostname}:${running.server.port}/healthz`;
        const res = await fetch(url);
        expect(res.status).toBe(200);
      } finally {
        // Trigger shutdown via direct call (graceful-shutdown coverage).
        await running.shutdown();
      }
    }
  });

  test("readyz returns 503 with vaults when not all running", async () => {
    const env: Record<string, string | undefined> = {
      OBSIDIAN_AUTH_TOKEN: TOKEN,
      VAULTS_JSON: VAULTS,
      HTTP_PORT: "0",
      HTTP_HOST: "127.0.0.1",
      LOG_LEVEL: "error",
      ...tmpEnv(),
    };
    const sup = fakeSupervisor([
      { slug: "v", name: "v", state: "starting", pid: null, restarts: 0, lastError: null },
    ]);
    const running = await main(
      env,
      () => undefined,
      silentLogger(),
      undefined,
      async () => sup,
      async () => readyIndexer(),
    );
    expect(running).toBeDefined();
    if (running === undefined) return;
    try {
      const res = await fetch(`http://${running.server.hostname}:${running.server.port}/readyz`);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { vaults: VaultStatus[] };
      expect(body.vaults).toHaveLength(1);
      expect(body.vaults[0]?.state).toBe("starting");
    } finally {
      await running.shutdown();
    }
  });

  test("readyz returns 200 when all vaults are running", async () => {
    const env: Record<string, string | undefined> = {
      OBSIDIAN_AUTH_TOKEN: TOKEN,
      VAULTS_JSON: VAULTS,
      HTTP_PORT: "0",
      HTTP_HOST: "127.0.0.1",
      LOG_LEVEL: "error",
      ...tmpEnv(),
    };
    const sup = fakeSupervisor([
      { slug: "v", name: "v", state: "running", pid: 1234, restarts: 0, lastError: null },
    ]);
    const running = await main(
      env,
      () => undefined,
      silentLogger(),
      undefined,
      async () => sup,
      async () => readyIndexer(),
    );
    expect(running).toBeDefined();
    if (running === undefined) return;
    try {
      const res = await fetch(`http://${running.server.hostname}:${running.server.port}/readyz`);
      expect(res.status).toBe(200);
    } finally {
      await running.shutdown();
    }
  });

  test("supervisor.stop is invoked on shutdown", async () => {
    let stopped = false;
    const sup = fakeSupervisor([], async () => {
      stopped = true;
    });
    const running = await main(
      {
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: VAULTS,
        HTTP_PORT: "0",
        HTTP_HOST: "127.0.0.1",
        LOG_LEVEL: "error",
        ...tmpEnv(),
      },
      () => undefined,
      silentLogger(),
      undefined,
      async () => sup,
      async () => readyIndexer(),
    );
    if (running === undefined) throw new Error("expected running");
    await running.shutdown();
    expect(stopped).toBe(true);
  });

  test("AuthMissingError from supervisor exits 78", async () => {
    const { AuthMissingError } = await import("../src/obsidian/index.ts");
    let exitCode: number | undefined;
    await main(
      {
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: VAULTS,
        HTTP_PORT: "0",
        HTTP_HOST: "127.0.0.1",
        LOG_LEVEL: "error",
        ...tmpEnv(),
      },
      (c) => {
        exitCode = c;
      },
      silentLogger(),
      undefined,
      async () => {
        throw new AuthMissingError("token missing");
      },
    );
    expect(exitCode).toBe(78);
  });

  test("non-AuthMissingError from supervisor exits 1 (Error path)", async () => {
    let exitCode: number | undefined;
    await main(
      {
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: VAULTS,
        HTTP_PORT: "0",
        HTTP_HOST: "127.0.0.1",
        LOG_LEVEL: "error",
        ...tmpEnv(),
      },
      (c) => {
        exitCode = c;
      },
      silentLogger(),
      undefined,
      async () => {
        throw new Error("supervisor exploded");
      },
    );
    expect(exitCode).toBe(1);
  });

  test("non-Error thrown from supervisor stringifies", async () => {
    let exitCode: number | undefined;
    await main(
      {
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: VAULTS,
        HTTP_PORT: "0",
        HTTP_HOST: "127.0.0.1",
        LOG_LEVEL: "error",
        ...tmpEnv(),
      },
      (c) => {
        exitCode = c;
      },
      silentLogger(),
      undefined,
      async () => {
        // eslint-disable-next-line no-throw-literal -- testing non-Error path
        throw "supervisor string failure";
      },
    );
    expect(exitCode).toBe(1);
  });

  test("uses default logger path when no override given (config error branch)", async () => {
    // Silence stdout so the error log doesn't pollute test output.
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as unknown as typeof process.stdout.write;
    let exitCode: number | undefined;
    try {
      await main({}, (c) => {
        exitCode = c;
      });
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(exitCode).toBe(78);
  });

  test("uses default logger path when no override given (success branch)", async () => {
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as unknown as typeof process.stdout.write;
    let exitCode: number | undefined;
    const running = await main(
      {
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: VAULTS,
        HTTP_PORT: "0",
        HTTP_HOST: "127.0.0.1",
        LOG_LEVEL: "error",
        ...tmpEnv(),
      },
      (c) => {
        exitCode = c;
      },
      undefined,
      undefined,
      async () => fakeSupervisor(),
      async () => readyIndexer(),
    );
    try {
      expect(running).toBeDefined();
      expect(exitCode).toBeUndefined();
    } finally {
      if (running !== undefined) await running.shutdown();
      process.stdout.write = originalWrite;
    }
  });

  test("non-ConfigError thrown from loadConfig path exits 1", async () => {
    // Build a Proxy env that throws synchronously when accessed — bypasses
    // ConfigError and hits the unexpected-error branch.
    const env = new Proxy(
      {},
      {
        get(): string {
          throw new TypeError("synthetic non-config error");
        },
      },
    ) as Record<string, string | undefined>;
    let exitCode: number | undefined;
    const result = await main(
      env,
      (c) => {
        exitCode = c;
      },
      silentLogger(),
    );
    expect(result).toBeUndefined();
    expect(exitCode).toBe(1);
  });

  test("non-ConfigError uses default logger when no override (covers fallback logger branch)", async () => {
    const originalWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as unknown as typeof process.stdout.write;
    const env = new Proxy(
      {},
      {
        get(): string {
          throw new TypeError("synthetic — not a string");
        },
      },
    ) as Record<string, string | undefined>;
    let exitCode: number | undefined;
    try {
      await main(env, (c) => {
        exitCode = c;
      });
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(exitCode).toBe(1);
  });

  test("non-Error thrown from loader is stringified", async () => {
    const env = new Proxy(
      {},
      {
        get(): string {
          // eslint-disable-next-line no-throw-literal -- testing non-Error throw path
          throw "raw string error";
        },
      },
    ) as Record<string, string | undefined>;
    let exitCode: number | undefined;
    await main(
      env,
      (c) => {
        exitCode = c;
      },
      silentLogger(),
    );
    expect(exitCode).toBe(1);
  });

  test("exits 1 (NOT 78) when startServer throws — Error instance", async () => {
    const failingServe: ServeImpl = () => {
      throw new Error("EADDRINUSE 127.0.0.1:3000");
    };
    let exitCode: number | undefined;
    let supStopped = false;
    const result = await main(
      {
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: VAULTS,
        HTTP_PORT: "0",
        HTTP_HOST: "127.0.0.1",
        LOG_LEVEL: "error",
        ...tmpEnv(),
      },
      (c) => {
        exitCode = c;
      },
      silentLogger(),
      failingServe,
      async () =>
        fakeSupervisor([], async () => {
          supStopped = true;
        }),
      async () => readyIndexer(),
    );
    expect(result).toBeUndefined();
    expect(exitCode).toBe(1);
    expect(supStopped).toBe(true);
  });

  test("exits 1 when startServer throws a non-Error value (covers stringify branch)", async () => {
    const failingServe: ServeImpl = () => {
      // eslint-disable-next-line no-throw-literal -- testing non-Error throw path
      throw "raw listen failure";
    };
    let exitCode: number | undefined;
    const result = await main(
      {
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: VAULTS,
        HTTP_PORT: "0",
        HTTP_HOST: "127.0.0.1",
        LOG_LEVEL: "error",
        ...tmpEnv(),
      },
      (c) => {
        exitCode = c;
      },
      silentLogger(),
      failingServe,
      async () => fakeSupervisor(),
      async () => readyIndexer(),
    );
    expect(result).toBeUndefined();
    expect(exitCode).toBe(1);
  });

  test("StoreDimensionMismatchError from startIndexer exits 78 and stops supervisor", async () => {
    const { StoreDimensionMismatchError } = await import("../src/indexer/index.ts");
    let exitCode: number | undefined;
    let supStopped = false;
    await main(
      {
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: VAULTS,
        HTTP_PORT: "0",
        HTTP_HOST: "127.0.0.1",
        LOG_LEVEL: "error",
        ...tmpEnv(),
      },
      (c) => {
        exitCode = c;
      },
      silentLogger(),
      undefined,
      async () =>
        fakeSupervisor([], async () => {
          supStopped = true;
        }),
      async () => {
        throw new StoreDimensionMismatchError(384, 1536);
      },
    );
    expect(exitCode).toBe(78);
    expect(supStopped).toBe(true);
  });

  test("non-mismatch indexer error exits 1 (Error) and stops supervisor", async () => {
    let exitCode: number | undefined;
    let supStopped = false;
    await main(
      {
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: VAULTS,
        HTTP_PORT: "0",
        HTTP_HOST: "127.0.0.1",
        LOG_LEVEL: "error",
        ...tmpEnv(),
      },
      (c) => {
        exitCode = c;
      },
      silentLogger(),
      undefined,
      async () =>
        fakeSupervisor([], async () => {
          supStopped = true;
        }),
      async () => {
        throw new Error("indexer boom");
      },
    );
    expect(exitCode).toBe(1);
    expect(supStopped).toBe(true);
  });

  test("non-Error from startIndexer is stringified", async () => {
    let exitCode: number | undefined;
    await main(
      {
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: VAULTS,
        HTTP_PORT: "0",
        HTTP_HOST: "127.0.0.1",
        LOG_LEVEL: "error",
        ...tmpEnv(),
      },
      (c) => {
        exitCode = c;
      },
      silentLogger(),
      undefined,
      async () => fakeSupervisor(),
      async () => {
        // eslint-disable-next-line no-throw-literal -- testing non-Error path
        throw "string indexer error";
      },
    );
    expect(exitCode).toBe(1);
  });

  test("dim-mismatch path swallows supervisor.stop rejection", async () => {
    const { StoreDimensionMismatchError } = await import("../src/indexer/index.ts");
    let exitCode: number | undefined;
    await main(
      {
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: VAULTS,
        HTTP_PORT: "0",
        HTTP_HOST: "127.0.0.1",
        LOG_LEVEL: "error",
        ...tmpEnv(),
      },
      (c) => {
        exitCode = c;
      },
      silentLogger(),
      undefined,
      async () => fakeSupervisor([], () => Promise.reject(new Error("sup stop fail"))),
      async () => {
        throw new StoreDimensionMismatchError(384, 1536);
      },
    );
    expect(exitCode).toBe(78);
  });

  test("indexer-failure path swallows supervisor.stop rejection", async () => {
    let exitCode: number | undefined;
    await main(
      {
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: VAULTS,
        HTTP_PORT: "0",
        HTTP_HOST: "127.0.0.1",
        LOG_LEVEL: "error",
        ...tmpEnv(),
      },
      (c) => {
        exitCode = c;
      },
      silentLogger(),
      undefined,
      async () => fakeSupervisor([], () => Promise.reject(new Error("sup stop fail"))),
      async () => {
        throw new Error("indexer boom");
      },
    );
    expect(exitCode).toBe(1);
  });

  test("startServer-throws path swallows supervisor.stop rejection", async () => {
    const failingServe: ServeImpl = () => {
      throw new Error("listen failed");
    };
    let exitCode: number | undefined;
    const result = await main(
      {
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: VAULTS,
        HTTP_PORT: "0",
        HTTP_HOST: "127.0.0.1",
        LOG_LEVEL: "error",
        ...tmpEnv(),
      },
      (c) => {
        exitCode = c;
      },
      silentLogger(),
      failingServe,
      async () => fakeSupervisor([], () => Promise.reject(new Error("stop failed"))),
      async () => readyIndexer(),
    );
    expect(result).toBeUndefined();
    expect(exitCode).toBe(1);
  });

  test("dim-mismatch path is bounded by the shutdown timeout (LDn2)", async () => {
    // Regression for LDn2: a hung supervisor.stop() during the
    // dim-mismatch cleanup must not strand the exit. The race against
    // SHUTDOWN_TIMEOUT_MS (10s) is what protects us; we drive a stop()
    // that hangs forever and assert main resolves quickly.
    const { StoreDimensionMismatchError } = await import("../src/indexer/index.ts");
    let exitCode: number | undefined;
    const start = Date.now();
    await main(
      {
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: VAULTS,
        HTTP_PORT: "0",
        HTTP_HOST: "127.0.0.1",
        LOG_LEVEL: "error",
        ...tmpEnv(),
      },
      (c) => {
        exitCode = c;
      },
      silentLogger(),
      undefined,
      async () => fakeSupervisor([], () => new Promise<void>(() => undefined)),
      async () => {
        throw new StoreDimensionMismatchError(384, 1536);
      },
      { cleanupTimeoutMs: 50 },
    );
    const elapsed = Date.now() - start;
    // Capped at the injected cleanupTimeoutMs (50ms); the assertion
    // proves the timeout path is wired without burning 10s of test wall
    // clock.
    expect(elapsed).toBeLessThan(2_000);
    expect(exitCode).toBe(78);
  }, 5_000);

  test("indexer-failure path is bounded by the shutdown timeout (LDn2)", async () => {
    let exitCode: number | undefined;
    const start = Date.now();
    await main(
      {
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: VAULTS,
        HTTP_PORT: "0",
        HTTP_HOST: "127.0.0.1",
        LOG_LEVEL: "error",
        ...tmpEnv(),
      },
      (c) => {
        exitCode = c;
      },
      silentLogger(),
      undefined,
      async () => fakeSupervisor([], () => new Promise<void>(() => undefined)),
      async () => {
        throw new Error("indexer boom");
      },
      { cleanupTimeoutMs: 50 },
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2_000);
    expect(exitCode).toBe(1);
  }, 5_000);

  test("startServer-throws path is bounded by the shutdown timeout (LDn2)", async () => {
    const failingServe: ServeImpl = () => {
      throw new Error("listen failed");
    };
    const hangingIndexer: Indexer = {
      list: () => [],
      status: () => null,
      search: async (): Promise<SearchHit[]> => [],
      reindex: async () => undefined,
      drop: async () => undefined,
      stop: () => new Promise<void>(() => undefined),
    };
    let exitCode: number | undefined;
    const start = Date.now();
    await main(
      {
        OBSIDIAN_AUTH_TOKEN: TOKEN,
        VAULTS_JSON: VAULTS,
        HTTP_PORT: "0",
        HTTP_HOST: "127.0.0.1",
        LOG_LEVEL: "error",
        ...tmpEnv(),
      },
      (c) => {
        exitCode = c;
      },
      silentLogger(),
      failingServe,
      async () => fakeSupervisor([], () => new Promise<void>(() => undefined)),
      async () => hangingIndexer,
      { cleanupTimeoutMs: 50 },
    );
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2_000);
    expect(exitCode).toBe(1);
  }, 5_000);
});

describe("startServer — shutdown failure path", () => {
  test("shutdown rejection is logged and re-thrown", async () => {
    const running = startServer({
      config: baseConfig(),
      supervisor: fakeSupervisor(),
      indexer: readyIndexer(),
      logger: silentLogger(),
    });
    const orig = running.server.stop.bind(running.server);
    try {
      // Monkey-patch server.stop to reject.
      (running.server as unknown as { stop: () => Promise<void> }).stop = (): Promise<void> =>
        Promise.reject(new Error("stop failed"));
      let err: unknown;
      try {
        await running.shutdown();
      } catch (e) {
        err = e;
      }
      expect((err as Error).message).toBe("stop failed");
    } finally {
      // Restore and actually stop, even if the assertion above failed.
      (running.server as unknown as { stop: typeof orig }).stop = orig;
      await orig();
    }
  });

  test("shutdown rejection with non-Error stringifies", async () => {
    const running = startServer({
      config: baseConfig(),
      supervisor: fakeSupervisor(),
      indexer: readyIndexer(),
      logger: silentLogger(),
    });
    const orig = running.server.stop.bind(running.server);
    try {
      (running.server as unknown as { stop: () => Promise<void> }).stop = (): Promise<void> =>
        // eslint-disable-next-line prefer-promise-reject-errors -- testing non-Error rejection branch
        Promise.reject("plain string");
      let err: unknown;
      try {
        await running.shutdown();
      } catch (e) {
        err = e;
      }
      expect(err).toBe("plain string");
    } finally {
      (running.server as unknown as { stop: typeof orig }).stop = orig;
      await orig();
    }
  });

  test("supervisor.stop() runs even when server.stop() rejects (Promise.allSettled)", async () => {
    let supStopped = false;
    const sup = fakeSupervisor([], async () => {
      supStopped = true;
    });
    const running = startServer({
      config: baseConfig(),
      supervisor: sup,
      indexer: readyIndexer(),
      logger: silentLogger(),
    });
    const orig = running.server.stop.bind(running.server);
    try {
      (running.server as unknown as { stop: () => Promise<void> }).stop = (): Promise<void> =>
        Promise.reject(new Error("server stop failed"));
      let err: unknown;
      try {
        await running.shutdown();
      } catch (e) {
        err = e;
      }
      expect((err as Error).message).toBe("server stop failed");
      expect(supStopped).toBe(true);
    } finally {
      (running.server as unknown as { stop: typeof orig }).stop = orig;
      await orig();
    }
  });

  test("AggregateError when both server.stop() and supervisor.stop() reject", async () => {
    const sup = fakeSupervisor([], () => Promise.reject(new Error("supervisor stop failed")));
    const running = startServer({
      config: baseConfig(),
      supervisor: sup,
      indexer: readyIndexer(),
      logger: silentLogger(),
    });
    const orig = running.server.stop.bind(running.server);
    try {
      (running.server as unknown as { stop: () => Promise<void> }).stop = (): Promise<void> =>
        Promise.reject(new Error("server stop failed"));
      let err: unknown;
      try {
        await running.shutdown();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(AggregateError);
      const ae = err as AggregateError;
      const messages = ae.errors.map((x: unknown) => (x as Error).message).sort();
      expect(messages).toEqual(["server stop failed", "supervisor stop failed"]);
    } finally {
      (running.server as unknown as { stop: typeof orig }).stop = orig;
      await orig();
    }
  });

  test("after a failed shutdown, a retry calls server.stop() again", async () => {
    const running = startServer({
      config: baseConfig(),
      supervisor: fakeSupervisor(),
      indexer: readyIndexer(),
      logger: silentLogger(),
    });
    const orig = running.server.stop.bind(running.server);
    let calls = 0;
    let stopped = false;
    try {
      (running.server as unknown as { stop: () => Promise<void> }).stop = (): Promise<void> => {
        calls++;
        if (calls === 1) return Promise.reject(new Error("first attempt failed"));
        stopped = true;
        return orig();
      };
      let firstErr: unknown;
      try {
        await running.shutdown();
      } catch (e) {
        firstErr = e;
      }
      expect((firstErr as Error).message).toBe("first attempt failed");

      // Retry must reach server.stop() again — the cached failed promise
      // should have been cleared.
      await running.shutdown();
      expect(calls).toBe(2);
    } finally {
      (running.server as unknown as { stop: typeof orig }).stop = orig;
      if (!stopped) await orig();
    }
  });
});

describe("cliExit", () => {
  test("delegates to process.exit with the given code", () => {
    const original = process.exit.bind(process) as (code?: number) => never;
    let captured: number | undefined;
    process.exit = ((c?: number) => {
      captured = c;
    }) as unknown as typeof process.exit;
    try {
      cliExit(42);
    } finally {
      process.exit = original as unknown as typeof process.exit;
    }
    expect(captured).toBe(42);
  });
});

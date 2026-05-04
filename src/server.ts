/**
 * Process entrypoint.
 *
 * Wires config → logger → auth-token bootstrap → supervisor → indexer → HTTP
 * listener, registers SIGTERM/SIGINT handlers that stop the listener,
 * supervisor, and indexer within 10 seconds.
 */

import { type Config, ConfigError, loadConfig } from "./config/index.ts";
import { buildHttpApp } from "./http/index.ts";
import { type Indexer, StoreDimensionMismatchError, startIndexer } from "./indexer/index.ts";
import { type Logger, createLogger } from "./log.ts";
import { AuthMissingError, type Supervisor, startSupervisor } from "./obsidian/index.ts";

export const SHUTDOWN_TIMEOUT_MS = 10_000;

type BunServer = ReturnType<typeof Bun.serve>;

interface RunningServer {
  readonly server: BunServer;
  readonly supervisor: Supervisor;
  readonly indexer: Indexer;
  readonly shutdown: () => Promise<void>;
}

/**
 * Subset of `Bun.serve` we depend on. Typed as a function so tests can inject
 * a stub that throws (port-in-use, bad host, etc.) without binding a real
 * socket.
 */
export type ServeImpl = (options: {
  port: number;
  hostname: string;
  fetch: (req: Request) => Response | Promise<Response>;
}) => BunServer;

export interface StartOptions {
  readonly config: Config;
  readonly supervisor: Supervisor;
  readonly indexer: Indexer;
  readonly logger?: Logger;
  /** Override `Bun.serve` — tests use this to simulate listen failures. */
  readonly serveImpl?: ServeImpl;
}

/**
 * Start the HTTP listener and return a handle with a `shutdown` function.
 */
export function startServer(opts: StartOptions): RunningServer {
  const log = opts.logger ?? createLogger({ level: opts.config.logLevel });
  const app = buildHttpApp({
    supervisor: opts.supervisor,
    indexer: opts.indexer,
    config: opts.config,
    logger: log,
  });
  const serve = opts.serveImpl ?? Bun.serve;

  const server = serve({
    port: opts.config.httpPort,
    hostname: opts.config.httpHost,
    fetch: app.fetch,
  });

  log.info("server listening", {
    host: opts.config.httpHost,
    port: server.port,
  });

  let shutdownPromise: Promise<void> | undefined;

  const shutdown = (): Promise<void> => {
    if (shutdownPromise !== undefined) return shutdownPromise;
    log.info("server shutting down");
    // Listener, supervisor and indexer stops are independent — run them in
    // parallel and surface any combined failure. If we awaited the listener
    // first and it rejected, the supervisor would never get a chance to
    // drain its `ob` children, and the indexer would leak its watchers.
    const attempt = withTimeout(
      (async (): Promise<void> => {
        const results = await Promise.allSettled([
          Promise.resolve().then(() => server.stop()),
          opts.supervisor.stop(),
          opts.indexer.stop(),
        ]);
        const errors: unknown[] = [];
        for (const r of results) {
          if (r.status === "rejected") errors.push(r.reason);
        }
        if (errors.length === 1) throw errors[0];
        if (errors.length > 1) {
          // Bun supports AggregateError natively; surface every error so
          // operators can see both root causes in the log.
          throw new AggregateError(errors as Error[], "shutdown failures");
        }
      })(),
      SHUTDOWN_TIMEOUT_MS,
      "shutdown did not resolve within timeout",
    ).then(
      () => {
        log.info("server stopped");
      },
      (e: unknown) => {
        // Clear the cached promise so callers can retry — a SIGTERM after a
        // failed first attempt should still get to drive shutdown again.
        shutdownPromise = undefined;
        const msg = e instanceof Error ? e.message : String(e);
        log.error("server shutdown failed", { error: msg });
        throw e;
      },
    );
    shutdownPromise = attempt;
    return attempt;
  };

  return { server, supervisor: opts.supervisor, indexer: opts.indexer, shutdown };
}

/**
 * Race a promise against a timeout. Resolves with the original promise if it
 * settles in time, otherwise rejects.
 */
export async function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Install SIGTERM/SIGINT listeners that invoke `shutdown` once and then exit.
 *
 * Returns a disposer that removes the listeners — used by tests so the global
 * `process` doesn't leak handlers across runs.
 */
export function installSignalHandlers(
  shutdown: () => Promise<void>,
  exit: (code: number) => void = (c) => process.exit(c),
): () => void {
  let firing = false;
  const handler = (signal: NodeJS.Signals): void => {
    if (firing) return;
    firing = true;
    shutdown().then(
      () => exit(0),
      () => exit(1),
    );
    // Reference the signal so tests asserting `signal` arg pass through.
    void signal;
  };
  const onTerm = (): void => handler("SIGTERM");
  const onInt = (): void => handler("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  return (): void => {
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
  };
}

/**
 * `main` is invoked when this file is the program entrypoint. It is also
 * exported so tests can drive the full path with stub `env` / `exit` / `log`.
 *
 * Exit codes:
 * - `78` (`EX_CONFIG`) — invalid configuration (`ConfigError` from
 *                        `loadConfig`), `AuthMissingError` from the
 *                        supervisor bootstrap, or
 *                        `StoreDimensionMismatchError` from the indexer.
 * - `1`                — any other failure during startup (e.g. EADDRINUSE).
 */
export type StartSupervisorImpl = typeof startSupervisor;
export type StartIndexerImpl = typeof startIndexer;

export interface MainOptions {
  /**
   * Timeout for the startup-error cleanup paths (supervisor.stop /
   * indexer.stop after a config / dim / listen error). Default
   * `SHUTDOWN_TIMEOUT_MS` (10s); tests override this to keep the
   * "bounded cleanup" assertions fast.
   */
  readonly cleanupTimeoutMs?: number;
}

export async function main(
  env: Record<string, string | undefined>,
  exit: (code: number) => void,
  loggerOverride?: Logger,
  serveImpl?: ServeImpl,
  startSupervisorImpl: StartSupervisorImpl = startSupervisor,
  startIndexerImpl: StartIndexerImpl = startIndexer,
  opts: MainOptions = {},
): Promise<RunningServer | undefined> {
  const cleanupTimeoutMs = opts.cleanupTimeoutMs ?? SHUTDOWN_TIMEOUT_MS;
  let cfg: Config;
  try {
    cfg = loadConfig(env);
  } catch (e) {
    const log = loggerOverride ?? createLogger({ level: "error" });
    if (e instanceof ConfigError) {
      log.error("invalid configuration", { error: e.message });
      exit(e.exitCode);
      return undefined;
    }
    log.error("unexpected configuration error", {
      error: e instanceof Error ? e.message : String(e),
    });
    exit(1);
    return undefined;
  }

  const logger = loggerOverride ?? createLogger({ level: cfg.logLevel });

  let supervisor: Supervisor;
  try {
    const supDeps: Parameters<typeof startSupervisor>[1] = { logger };
    if (env.XDG_CONFIG_HOME !== undefined) {
      (supDeps as { xdgConfigHome?: string }).xdgConfigHome = env.XDG_CONFIG_HOME;
    }
    if (env.HOME !== undefined) {
      (supDeps as { homeDir?: string }).homeDir = env.HOME;
    }
    supervisor = await startSupervisorImpl(cfg, supDeps);
  } catch (e) {
    if (e instanceof AuthMissingError) {
      logger.error("auth bootstrap failed", { error: e.message });
      exit(e.exitCode);
      return undefined;
    }
    logger.error("supervisor failed to start", {
      error: e instanceof Error ? e.message : String(e),
    });
    exit(1);
    return undefined;
  }

  let indexer: Indexer;
  try {
    indexer = await startIndexerImpl(cfg, { logger });
  } catch (e) {
    if (e instanceof StoreDimensionMismatchError) {
      logger.error("indexer dimension mismatch", {
        error: e.message,
        tableDim: e.tableDim,
        providerDim: e.providerDim,
      });
      // 78 = EX_CONFIG; the operator's only fix is to recreate the table
      // or reset the embedding model — both configuration concerns.
      // Bound the cleanup with the same shutdown timeout — a hung
      // supervisor.stop() must not strand the exit().
      await withTimeout(
        supervisor.stop().catch(() => undefined),
        cleanupTimeoutMs,
        "supervisor.stop did not resolve within timeout",
      ).catch(() => undefined);
      exit(78);
      return undefined;
    }
    logger.error("indexer failed to start", {
      error: e instanceof Error ? e.message : String(e),
    });
    await withTimeout(
      supervisor.stop().catch(() => undefined),
      cleanupTimeoutMs,
      "supervisor.stop did not resolve within timeout",
    ).catch(() => undefined);
    exit(1);
    return undefined;
  }

  let running: RunningServer;
  try {
    const startOpts: StartOptions =
      serveImpl !== undefined
        ? { config: cfg, supervisor, indexer, logger, serveImpl }
        : { config: cfg, supervisor, indexer, logger };
    running = startServer(startOpts);
  } catch (e) {
    logger.error("failed to start http listener", {
      error: e instanceof Error ? e.message : String(e),
    });
    // Make sure we don't leak running children or watchers when the
    // listener fails. Bound with the same shutdown budget.
    await withTimeout(
      Promise.allSettled([supervisor.stop(), indexer.stop()]),
      cleanupTimeoutMs,
      "startup cleanup did not resolve within timeout",
    ).catch(() => undefined);
    exit(1);
    return undefined;
  }
  installSignalHandlers(running.shutdown, exit);
  return running;
}

/**
 * Default exit handler — calls `process.exit`. Extracted so the unit suite
 * can exercise it directly; the wrapping `import.meta.main` block below is
 * covered end-to-end by `test/server.entrypoint.test.ts` via `Bun.spawn`,
 * since Bun's in-process coverage cannot observe subprocess hits.
 */
export const cliExit = (code: number): never => process.exit(code);

const isCliEntry: boolean = import.meta.main;
if (isCliEntry) await main(process.env, cliExit);

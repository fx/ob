/**
 * Process-spawn abstraction.
 *
 * The supervisor never calls `Bun.spawn` directly — every process invocation
 * goes through this `Spawner` interface so unit tests can replace the real
 * spawner with a deterministic fake (`test/helpers/fakeSpawner.ts`). This is
 * also the seam where we'd swap to `child_process.spawn` if `Bun.spawn`'s
 * SIGTERM behaviour ever bites us (see open question in the change doc).
 *
 * Default export: `realSpawner`, a thin wrapper around `Bun.spawn` that
 * returns `SpawnHandle` shapes the supervisor can consume.
 */

export interface SpawnOpts {
  /** Extra environment variables merged with the parent's `process.env`. */
  readonly env?: Record<string, string | undefined>;
}

export interface SpawnHandle {
  /** OS pid, or `null` if the spawn failed before the kernel assigned one. */
  readonly pid: number | null;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  /** Resolves with the child's exit code (negative for signal-terminated). */
  readonly exited: Promise<number>;
  /** Send a POSIX signal. No-op if the child has already exited. */
  kill(signal: NodeJS.Signals): void;
}

export interface Spawner {
  run(cmd: string, args: readonly string[], opts?: SpawnOpts): SpawnHandle;
}

/**
 * Real spawner backed by `Bun.spawn`. Inherits the parent's environment so
 * `XDG_CONFIG_HOME` (and therefore the auth_token path) flows through to the
 * child by default. Any `opts.env` overrides are merged on top.
 */
/** Build an empty stream — used when spawn fails before producing pipes. */
function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.close();
    },
  });
}

/**
 * Build a synthetic "spawn failed" handle so the caller can treat
 * binary-not-found exactly like a child that crashed with non-zero exit.
 * Without this the supervisor's setup loop would bubble an exception up
 * instead of triggering its retry/backoff path.
 */
export function spawnFailedHandle(message: string): SpawnHandle {
  return {
    pid: null,
    stdout: emptyStream(),
    stderr: new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode(`spawn error: ${message}\n`));
        controller.close();
      },
    }),
    exited: Promise.resolve(127),
    kill(): void {
      // No child to kill.
    },
  };
}

/**
 * Type of Bun.spawn we depend on. Extracted so unit tests can inject a
 * stub that simulates ENOENT-throws without touching the real binary.
 *
 * `import("bun").Subprocess` is the canonical export; bun-types' globals.d.ts
 * doesn't re-declare it under `namespace Bun`, so `Bun.Subprocess` doesn't
 * resolve under `--strict`.
 */
export type BunSpawnFn = (
  args: string[],
  opts: Parameters<typeof Bun.spawn>[1],
) => import("bun").Subprocess<"ignore", "pipe", "pipe">;

export interface RealSpawnerOptions {
  readonly spawn?: BunSpawnFn;
}

export function buildRealSpawner(opts: RealSpawnerOptions = {}): Spawner {
  const spawnImpl: BunSpawnFn = opts.spawn ?? (Bun.spawn as unknown as BunSpawnFn);
  return {
    run(cmd, args, runOpts) {
      const merged: Record<string, string | undefined> = {
        ...(process.env as Record<string, string | undefined>),
        ...(runOpts?.env ?? {}),
      };
      // Bun.spawn rejects undefined values, so prune them.
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(merged)) {
        if (v !== undefined) env[k] = v;
      }
      let proc: import("bun").Subprocess<"ignore", "pipe", "pipe">;
      try {
        proc = spawnImpl([cmd, ...args], {
          env,
          stdout: "pipe",
          stderr: "pipe",
          stdin: "ignore",
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return spawnFailedHandle(msg);
      }
      return {
        pid: proc.pid,
        stdout: proc.stdout as ReadableStream<Uint8Array>,
        stderr: proc.stderr as ReadableStream<Uint8Array>,
        exited: proc.exited,
        kill(signal: NodeJS.Signals): void {
          try {
            proc.kill(signal);
          } catch {
            // Bun throws when the process has already exited; for our supervisor
            // semantics that's a no-op.
          }
        },
      };
    },
  };
}

export const realSpawner: Spawner = buildRealSpawner();

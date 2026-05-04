/**
 * Deterministic fake spawner for unit tests.
 *
 * Records every call and returns scripted child handles whose stdout,
 * stderr, exit code, and signal-handling behaviour the test author
 * controls. No real processes ever spawn through this — that's what
 * `realSpawner` is for, and we exercise it only in the smoke test
 * gated by `OB_BIN`/`Bun.which("ob")`.
 */

import type { SpawnHandle, SpawnOpts, Spawner } from "../../src/obsidian/spawn.ts";

export interface RecordedCall {
  readonly cmd: string;
  readonly args: readonly string[];
  readonly opts?: SpawnOpts;
}

export interface ScriptedHandle {
  /** Lines (without trailing newline) emitted on stdout before exit. */
  readonly stdout?: readonly string[];
  /** Lines emitted on stderr before exit. */
  readonly stderr?: readonly string[];
  /** Default exit code if the child isn't killed. */
  readonly exitCode?: number;
  /** Optional pid; defaults to a synthetic counter. */
  readonly pid?: number;
  /**
   * If set, the child blocks on `exited` until this promise resolves.
   * Useful for "long-running healthy child" tests that send SIGTERM
   * mid-flight.
   */
  readonly exitWhen?: Promise<number>;
  /** Hook fired when `kill` is called. */
  readonly onKill?: (signal: NodeJS.Signals) => void;
  /** Override pid emission (e.g. simulate spawn-failed pid=null). */
  readonly pidOverride?: number | null;
}

type Script = ScriptedHandle | ((call: RecordedCall) => ScriptedHandle);

export interface FakeSpawnerOptions {
  /** Default behaviour for any unmatched call. Defaults to exit 0. */
  readonly defaultHandle?: ScriptedHandle;
}

export interface FakeSpawner extends Spawner {
  readonly calls: readonly RecordedCall[];
  /**
   * Push a script for the *next* call to `run()`. Scripts are consumed
   * in FIFO order; once exhausted, the default handle is used.
   */
  enqueue(script: Script): void;
}

function streamFromLines(lines: readonly string[] | undefined): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      if (lines !== undefined) {
        for (const line of lines) {
          controller.enqueue(encoder.encode(`${line}\n`));
        }
      }
      controller.close();
    },
  });
}

let pidCounter = 1_000;

export function createFakeSpawner(opts: FakeSpawnerOptions = {}): FakeSpawner {
  const calls: RecordedCall[] = [];
  const scripts: Script[] = [];
  const defaultHandle: ScriptedHandle = opts.defaultHandle ?? { exitCode: 0 };

  const spawner: FakeSpawner = {
    calls,
    enqueue(script: Script): void {
      scripts.push(script);
    },
    run(cmd, args, runOpts): SpawnHandle {
      const optsObj = runOpts;
      const call: RecordedCall =
        optsObj === undefined ? { cmd, args } : { cmd, args, opts: optsObj };
      calls.push(call);
      const next = scripts.shift();
      const scripted =
        next === undefined ? defaultHandle : typeof next === "function" ? next(call) : next;

      let killed = false;
      let killSignal: NodeJS.Signals | null = null;
      let resolveExit!: (code: number) => void;
      const exitedPromise: Promise<number> =
        scripted.exitWhen !== undefined
          ? scripted.exitWhen
          : new Promise<number>((resolve) => {
              resolveExit = resolve;
            });

      // Default behaviour: resolve immediately to the scripted exit code.
      if (scripted.exitWhen === undefined) {
        queueMicrotask(() => {
          if (!killed) {
            resolveExit(scripted.exitCode ?? 0);
          }
        });
      }

      const pid =
        scripted.pidOverride !== undefined ? scripted.pidOverride : (scripted.pid ?? pidCounter++);

      const handle: SpawnHandle = {
        pid,
        stdout: streamFromLines(scripted.stdout),
        stderr: streamFromLines(scripted.stderr),
        exited: exitedPromise,
        kill(signal: NodeJS.Signals): void {
          // Real kill(2) accepts repeated signals (e.g. escalation
          // SIGTERM → SIGKILL); the fake mirrors that — we always invoke
          // onKill but only auto-resolve once for the scripted-exit case.
          killSignal = signal;
          scripted.onKill?.(signal);
          if (!killed && scripted.exitWhen === undefined) {
            killed = true;
            // Convert the signal to a non-zero exit code so the supervisor
            // sees it as a crash on SIGKILL, but we resolve the exited promise
            // either way so `await handle.exited` always settles.
            resolveExit(signal === "SIGTERM" ? 0 : 137);
          }
          // Reference killSignal so TypeScript doesn't flag the assignment as
          // dead. (Some tests pull it via `onKill`; this is for completeness.)
          void killSignal;
        },
      };
      return handle;
    },
  };
  return spawner;
}

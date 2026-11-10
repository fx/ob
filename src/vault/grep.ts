/**
 * Service core: grep (REST API › Grep).
 *
 * `grep(deps, slug, args)` searches the text files on disk under
 * `vault(slug).root` — the scope root in a scoped MCP session, so scoping
 * needs nothing here — for a literal substring or an ECMAScript regex, line
 * by line. Both adapters (REST `POST /v1/vaults/:slug/grep` and the MCP
 * `grep` tool) call it unchanged.
 *
 * Isolation. The scan runs in a `Worker` (`grepWorker.ts`), so a
 * pathological regex never evaluates on the request-serving event loop. The
 * main thread races the worker's checkpoints against a deadline set when the
 * call starts; at the deadline it terminates the worker and answers with the
 * matches of every checkpoint received so far and the last one's counters.
 * The regex is compiled here first, so a syntax error is an immediate
 * `invalid_input`; a literal pattern is escaped into an equivalent regex so
 * both modes share one matcher.
 *
 * Concurrency. At most `GREP_MAX_CONCURRENT` greps run process-wide; later
 * calls wait in FIFO order. The wait is raced against the same deadline and
 * against the caller's abort signal: a call whose budget runs out while it
 * waits leaves the queue with the spec's empty `"time"` result. A slot is
 * released only once its worker has actually exited, so abandoned
 * evaluations never push the number of live workers past the cap.
 *
 * Cancellation. When `args.signal` aborts (the HTTP client disconnected, or
 * MCP cancelled the call), a waiting call leaves the queue and a running one
 * terminates its worker. The call then resolves with what it had, marked
 * `truncated: true, reason: "time"`; the transport discards that answer, and
 * resolving rather than throwing keeps a client disconnect out of the
 * server-error log.
 */

import { InvalidInputError } from "../errors.ts";
import { type VaultServiceDeps, resolveVault } from "./files.ts";
import type { GrepMatch, ScanParams, WorkerMessage } from "./grepWorker.ts";

export type { GrepMatch } from "./grepWorker.ts";

/** Time budget per call, from its arrival, queue wait included. */
export const GREP_TIME_BUDGET_MS = 5_000;
/** File content read per call before a `"bytes"` stop. */
export const GREP_BYTE_BUDGET = 64 * 1024 * 1024;
/** Larger text files are skipped. */
export const GREP_MAX_FILE_BYTES = 1024 * 1024;
/** Greps running at once, process-wide. */
export const GREP_MAX_CONCURRENT = 2;
export const DEFAULT_GREP_LIMIT = 100;

export type GrepReason = "limit" | "bytes" | "time";

export interface GrepArgs {
  readonly pattern: string;
  readonly regex?: boolean | undefined;
  readonly ignoreCase?: boolean | undefined;
  readonly prefix?: string | undefined;
  readonly limit?: number | undefined;
  readonly context?: number | undefined;
  /** Aborts when the caller goes away. */
  readonly signal?: AbortSignal | undefined;
}

export interface GrepResult {
  readonly matches: GrepMatch[];
  readonly truncated: boolean;
  readonly reason: GrepReason | null;
  readonly filesScanned: number;
  readonly filesSkipped: number;
}

/** The main thread's view of one scan worker. */
export interface GrepWorkerHandle {
  /** Start the scan. */
  start(params: ScanParams): void;
  /** Every message the worker posts, in order. */
  onMessage(cb: (message: WorkerMessage) => void): void;
  /** The worker failed outside `scan` (for example, its module did not load). */
  onError(cb: (error: Error) => void): void;
  /** Stop the worker, mid-evaluation if need be. */
  terminate(): void;
  /** Settles once the worker has exited. */
  readonly exited: Promise<void>;
}

/** Test seams and budgets. Production passes none. */
export interface GrepRuntime {
  readonly timeBudgetMs?: number;
  readonly byteBudget?: number;
  readonly maxFileBytes?: number;
  /** Concurrency gate; defaults to the process-wide one. */
  readonly slots?: Semaphore;
  /** Worker factory; defaults to a real Bun `Worker` running `grepWorker.ts`. */
  readonly spawn?: () => GrepWorkerHandle;
  /** Deadline timer; returns its cancel function. */
  readonly setTimer?: (ms: number, fire: () => void) => () => void;
}

/**
 * FIFO counting semaphore. `acquire` resolves with a release function (safe
 * to call more than once) or rejects when `signal` aborts first, in which
 * case the waiter has left the queue.
 */
export class Semaphore {
  #free: number;
  readonly #queue: (() => void)[] = [];

  constructor(size: number) {
    this.#free = size;
  }

  /** Calls waiting for a slot. */
  get waiting(): number {
    return this.#queue.length;
  }

  /** Free slots. */
  get available(): number {
    return this.#free;
  }

  acquire(signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.#free > 0) {
      this.#free--;
      return Promise.resolve(this.#releaser());
    }
    return new Promise((resolve, reject) => {
      const grant = (): void => {
        signal.removeEventListener("abort", leave);
        resolve(this.#releaser());
      };
      const leave = (): void => {
        this.#queue.splice(this.#queue.indexOf(grant), 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", leave, { once: true });
      this.#queue.push(grant);
    });
  }

  #releaser(): () => void {
    let released = false;
    return (): void => {
      if (released) return;
      released = true;
      // A slot passes straight to the oldest waiter, so the free count never
      // lets a newcomer overtake the queue.
      const next = this.#queue.shift();
      if (next === undefined) this.#free++;
      else next();
    };
  }
}

/** The process-wide gate every adapter call shares. */
export const grepSlots = new Semaphore(GREP_MAX_CONCURRENT);

export const GREP_WORKER_URL = new URL("./grepWorker.ts", import.meta.url).href;

/** Spawn a real scan worker from `url`. */
export function spawnGrepWorker(url: string = GREP_WORKER_URL): GrepWorkerHandle {
  const w = new Worker(url);
  const exited = new Promise<void>((resolve) => {
    w.addEventListener("close", () => resolve(), { once: true });
  });
  return {
    start: (params) => w.postMessage(params),
    onMessage: (cb) => {
      w.onmessage = (event: MessageEvent): void => cb(event.data as WorkerMessage);
    },
    onError: (cb) => {
      w.onerror = (event: ErrorEvent): void => {
        // Handled here; it must not also surface as an uncaught error.
        event.preventDefault();
        cb(new Error(event.message));
      };
    },
    terminate: () => w.terminate(),
    exited,
  };
}

function setTimer(ms: number, fire: () => void): () => void {
  const t = setTimeout(fire, ms);
  return () => clearTimeout(t);
}

/** Escape every regex syntax character (Unicode-mode identity escapes only). */
export function escapeLiteral(pattern: string): string {
  return pattern.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
}

/** Compile the request's matcher; a pattern that does not compile is `invalid_input`. */
function compile(args: GrepArgs): { source: string; flags: string } {
  const source = args.regex === true ? args.pattern : escapeLiteral(args.pattern);
  const flags = args.ignoreCase === true ? "iu" : "u";
  try {
    new RegExp(source, flags);
  } catch (e) {
    throw new InvalidInputError("pattern is not a valid regular expression", {
      reason: (e as Error).message,
    });
  }
  return { source, flags };
}

function timeResult(matches: GrepMatch[], filesScanned: number, filesSkipped: number): GrepResult {
  return { matches, truncated: true, reason: "time", filesScanned, filesSkipped };
}

/** Run `fire` once `signal` aborts, at once if it already has. */
function onAbort(signal: AbortSignal, fire: () => void): () => void {
  if (signal.aborted) fire();
  else signal.addEventListener("abort", fire, { once: true });
  return () => signal.removeEventListener("abort", fire);
}

export async function grep(
  deps: VaultServiceDeps,
  slug: string,
  args: GrepArgs,
  rt: GrepRuntime = {},
): Promise<GrepResult> {
  // The budget starts now, before validation and any queue wait.
  const stop = new AbortController();
  const cancelTimer = (rt.setTimer ?? setTimer)(rt.timeBudgetMs ?? GREP_TIME_BUDGET_MS, () =>
    stop.abort(),
  );
  const unsubscribe =
    args.signal === undefined ? () => {} : onAbort(args.signal, () => stop.abort());
  try {
    const v = resolveVault(deps, slug);
    const { source, flags } = compile(args);
    const params: ScanParams = {
      root: v.root,
      prefix: args.prefix ?? "",
      source,
      flags,
      limit: args.limit ?? DEFAULT_GREP_LIMIT,
      context: args.context ?? 0,
      byteBudget: rt.byteBudget ?? GREP_BYTE_BUDGET,
      maxFileBytes: rt.maxFileBytes ?? GREP_MAX_FILE_BYTES,
    };
    let release: () => void;
    try {
      release = await (rt.slots ?? grepSlots).acquire(stop.signal);
    } catch {
      // The budget ran out (or the caller left) while waiting for a slot.
      return timeResult([], 0, 0);
    }
    return await run((rt.spawn ?? spawnGrepWorker)(), params, stop.signal, release);
  } finally {
    cancelTimer();
    unsubscribe();
  }
}

/**
 * Drive one worker to its result. Matches accumulate across checkpoints; the
 * counters are the latest checkpoint's. Anything the worker posts after the
 * call settled is ignored.
 */
function run(
  handle: GrepWorkerHandle,
  params: ScanParams,
  stop: AbortSignal,
  release: () => void,
): Promise<GrepResult> {
  void handle.exited.then(release);
  const matches: GrepMatch[] = [];
  let filesScanned = 0;
  let filesSkipped = 0;
  return new Promise<GrepResult>((resolve, reject) => {
    let settled = false;
    let unsubscribe = (): void => {};
    const settle = (finish: () => void): void => {
      if (settled) return;
      settled = true;
      unsubscribe();
      handle.terminate();
      finish();
    };
    handle.onMessage((m) => {
      if (settled) return;
      if (m.type === "error") {
        settle(() => reject(new Error(`grep scan failed: ${m.message}`)));
        return;
      }
      matches.push(...m.matches);
      filesScanned = m.filesScanned;
      filesSkipped = m.filesSkipped;
      const done = m.done;
      if (done === undefined) return;
      settle(() =>
        resolve({
          matches,
          truncated: done.reason !== null,
          reason: done.reason,
          filesScanned,
          filesSkipped,
        }),
      );
    });
    handle.onError((e) => settle(() => reject(e)));
    unsubscribe = onAbort(stop, () =>
      settle(() => resolve(timeResult(matches, filesScanned, filesSkipped))),
    );
    if (!settled) handle.start(params);
  });
}

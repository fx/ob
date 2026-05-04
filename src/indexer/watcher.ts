/**
 * chokidar wrapper.
 *
 * Wraps a single FSWatcher per vault root, applies the ignore rules from the
 * spec, and exposes a per-path debounce so a flurry of writes coalesces into
 * one `upsert` event. The 250 ms window matches the spec; tests inject a
 * shorter window (the default still tests with real wall-clock waits since
 * the fixed budget is forgiving).
 *
 * Renames intentionally surface as `unlink` followed by `add`/`upsert` —
 * chokidar's default semantic. Letting them flow through unchanged keeps
 * the pipeline stateless.
 *
 * The watcher subscribes to chokidar's `error` event and surfaces the
 * latest error via `lastError()`; callers (the indexer facade) can poll
 * for and log them. Without this, EACCES/ENOSPC/etc. would silently break
 * the watcher with no observable signal.
 */

import { relative, sep } from "node:path";
import { type FSWatcher, watch } from "chokidar";
import type { Logger } from "../log.ts";
import { isMarkdownFile, shouldIgnorePath } from "./scanner.ts";

export type WatcherEventKind = "upsert" | "remove";

export interface WatcherEvent {
  readonly kind: WatcherEventKind;
  readonly absPath: string;
  readonly relPath: string;
}

export interface WatcherOptions {
  readonly debounceMs?: number;
  /** Override the chokidar watch factory — tests inject a fake. */
  readonly watchImpl?: typeof watch;
  /** Override `setTimeout`/`clearTimeout` — tests inject a fake clock. */
  readonly setTimer?: (cb: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
  /**
   * Optional logger — when supplied, chokidar `error` events are forwarded
   * via `logger.warn(...)`. The indexer facade always passes its logger
   * through; tests that don't care about the error path can omit it.
   */
  readonly logger?: Logger;
  /**
   * Optional callback invoked for every chokidar `error`. Tests use this
   * to assert the wiring; the indexer facade uses it to track
   * `lastError` for `/metrics` exposure.
   */
  readonly onError?: (err: Error) => void;
}

export interface WatcherHandle {
  /** Resolves once chokidar's "ready" event fires (initial scan finished). */
  ready(): Promise<void>;
  /** Most recent fs-watch error reported by chokidar, if any. */
  lastError(): Error | null;
  stop(): Promise<void>;
}

const DEFAULT_DEBOUNCE_MS = 250;

/**
 * Start watching `root`. Each emitted event is the *coalesced* tail of any
 * burst of writes/removes for the same path; the handler is called with the
 * latest decision.
 */
export function startWatcher(
  root: string,
  onEvent: (ev: WatcherEvent) => void,
  opts: WatcherOptions = {},
): WatcherHandle {
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const watchImpl = opts.watchImpl ?? watch;

  const fsw: FSWatcher = watchImpl(root, {
    ignoreInitial: true,
    persistent: true,
    // chokidar's `ignored` accepts a function — return true to skip. We
    // reuse the scanner's predicate so watcher and scanner stay in lock-
    // step on what counts as "indexable".
    ignored: (absPath: string): boolean => {
      const rel = relative(root, absPath);
      // chokidar will pass us the root itself as ".".
      if (rel === "" || rel === ".") return false;
      return shouldIgnorePath(rel);
    },
  });

  interface Pending {
    kind: WatcherEventKind;
    timer: unknown;
  }
  const pending = new Map<string, Pending>();

  const flush = (relPath: string, absPath: string): void => {
    const cur = pending.get(relPath);
    if (cur === undefined) return;
    pending.delete(relPath);
    onEvent({ kind: cur.kind, absPath, relPath });
  };

  const queue = (kind: WatcherEventKind, absPath: string): void => {
    const rel = relative(root, absPath).split(sep).join("/");
    if (!isMarkdownFile(rel)) return;
    const cur = pending.get(rel);
    if (cur !== undefined) clearTimer(cur.timer);
    const timer = setTimer(() => flush(rel, absPath), debounceMs);
    pending.set(rel, { kind, timer });
  };

  fsw.on("add", (p) => queue("upsert", p));
  fsw.on("change", (p) => queue("upsert", p));
  fsw.on("unlink", (p) => queue("remove", p));

  let lastError: Error | null = null;
  fsw.on("error", (err) => {
    const e = err instanceof Error ? err : new Error(String(err));
    lastError = e;
    if (opts.logger !== undefined) {
      opts.logger.warn("indexer: chokidar error", { error: e.message });
    }
    if (opts.onError !== undefined) opts.onError(e);
  });

  // Capture chokidar's `ready` synchronously — chokidar emits the event
  // exactly once, and if a caller's `ready()` listener attaches *after* the
  // emission, `once` will never fire. Subscribing here pre-resolves a
  // promise that all later `ready()` calls share.
  let resolveReady: () => void;
  const readyPromise = new Promise<void>((r) => {
    resolveReady = r;
  });
  fsw.once("ready", () => resolveReady());

  return {
    ready(): Promise<void> {
      return readyPromise;
    },
    lastError(): Error | null {
      return lastError;
    },
    async stop(): Promise<void> {
      // Fire any pending events before tearing down so a write that came
      // in during a graceful shutdown still gets indexed if the indexer's
      // pipeline still accepts it.
      for (const [rel, p] of pending.entries()) {
        clearTimer(p.timer);
        // Best-effort: we can't reconstruct absPath without re-joining, but
        // chokidar uses platform path separators, so do the same.
        onEvent({
          kind: p.kind,
          absPath: `${root}${sep}${rel.split("/").join(sep)}`,
          relPath: rel,
        });
      }
      pending.clear();
      await fsw.close();
    },
  };
}

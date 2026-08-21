/**
 * In-memory `WatchdogFs` plus a deterministic poll driver.
 *
 * The watchdog's whole job is reacting to filesystem conditions the real
 * world produces rarely and non-deterministically — ENOENT, EACCES, a
 * malformed `config.json`, a truncation landing between two polls. Driving
 * those through an injected surface is the only way to test them reliably;
 * `test/obsidian/watchdog.real.test.ts` pins the same behaviours against a
 * real `Bun.tmpdirSync()` tree so this fake cannot drift from `fs` semantics.
 */

import type { WatchdogFs, WatchdogStat } from "../../src/obsidian/watchdog.ts";

interface FakeFile {
  text: string;
  mtimeMs: number;
  inode: string;
}

export interface RangeCall {
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

export interface FakeWatchdogFs extends WatchdogFs {
  /** Register a directory's immediate entry names. */
  addDir(path: string, names: readonly string[]): void;
  /** Write a file, replacing any existing content but keeping its inode. */
  write(path: string, text: string, mtimeMs?: number): void;
  /** Append to a file, advancing its mtime. */
  append(path: string, text: string, mtimeMs?: number): void;
  /** Replace a file with a brand-new inode (rotation). */
  replaceFile(path: string, text: string, opts?: { mtimeMs?: number; inode?: string }): void;
  /** Delete a file so subsequent stats raise ENOENT. */
  remove(path: string): void;
  /** Make every operation on `path` throw `err` until `unfail`. */
  fail(path: string, err: Error): void;
  unfail(path: string): void;
  readonly rangeCalls: readonly RangeCall[];
}

export function errno(code: string, path: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: operation failed, '${path}'`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

export function createFakeWatchdogFs(): FakeWatchdogFs {
  const dirs = new Map<string, readonly string[]>();
  const files = new Map<string, FakeFile>();
  const failures = new Map<string, Error>();
  const rangeCalls: RangeCall[] = [];
  const encoder = new TextEncoder();
  let nextInode = 1;

  function guard(path: string): void {
    const err = failures.get(path);
    if (err !== undefined) throw err;
  }

  function bytesOf(file: FakeFile): Uint8Array {
    return encoder.encode(file.text);
  }

  function mustGet(path: string): FakeFile {
    const f = files.get(path);
    if (f === undefined) throw errno("ENOENT", path);
    return f;
  }

  const fs: FakeWatchdogFs = {
    rangeCalls,
    addDir(path, names): void {
      dirs.set(path, [...names]);
    },
    write(path, text, mtimeMs = 1_000): void {
      const existing = files.get(path);
      files.set(path, {
        text,
        mtimeMs,
        inode: existing?.inode ?? String(nextInode++),
      });
    },
    append(path, text, mtimeMs): void {
      const f = mustGet(path);
      f.text += text;
      if (mtimeMs !== undefined) f.mtimeMs = mtimeMs;
    },
    replaceFile(path, text, opts = {}): void {
      files.set(path, {
        text,
        mtimeMs: opts.mtimeMs ?? 1_000,
        inode: opts.inode ?? String(nextInode++),
      });
    },
    remove(path): void {
      files.delete(path);
    },
    fail(path, err): void {
      failures.set(path, err);
    },
    unfail(path): void {
      failures.delete(path);
    },
    async readDir(path): Promise<readonly string[]> {
      guard(path);
      const names = dirs.get(path);
      if (names === undefined) throw errno("ENOENT", path);
      return names;
    },
    async readJson(path): Promise<unknown> {
      guard(path);
      return JSON.parse(mustGet(path).text) as unknown;
    },
    async stat(path): Promise<WatchdogStat> {
      guard(path);
      const f = mustGet(path);
      return { size: bytesOf(f).length, mtimeMs: f.mtimeMs, inode: f.inode };
    },
    async readRange(path, start, end): Promise<Uint8Array> {
      guard(path);
      rangeCalls.push({ path, start, end });
      return bytesOf(mustGet(path)).slice(start, end);
    },
  };
  return fs;
}

export interface PollDriver {
  now(): number;
  advance(ms: number): void;
  sleep(ms: number): Promise<void>;
  /** Resolve once the poll loop is parked in `sleep`. */
  settle(): Promise<void>;
  /** Release the parked sleep and resolve once the next poll has parked. */
  nextPoll(): Promise<void>;
  /** Release the parked sleep without waiting for the loop to park again. */
  release(): void;
  readonly sleeps: readonly number[];
}

/**
 * Deterministic replacement for the poll loop's clock and sleep. No test
 * waits on real wall-clock time for a threshold; `advance()` is the only
 * thing that moves the clock.
 */
export function createPollDriver(): PollDriver {
  let now = 0;
  let parked: (() => void) | null = null;
  let onPark: (() => void) | null = null;
  const sleeps: number[] = [];

  function park(resolve: () => void): void {
    parked = resolve;
    const cb = onPark;
    onPark = null;
    cb?.();
  }

  async function settle(): Promise<void> {
    if (parked !== null) return;
    await new Promise<void>((resolve) => {
      onPark = resolve;
    });
  }

  function release(): void {
    const resume = parked;
    parked = null;
    resume?.();
  }

  return {
    sleeps,
    now: () => now,
    advance: (ms): void => {
      now += ms;
    },
    sleep: (ms): Promise<void> => {
      sleeps.push(ms);
      return new Promise<void>(park);
    },
    settle,
    release,
    async nextPoll(): Promise<void> {
      await settle();
      release();
      await settle();
    },
  };
}

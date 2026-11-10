/**
 * The grep scan (REST API › Grep), run inside a Bun `Worker`.
 *
 * `src/vault/grep.ts` validates the request on the main thread, then hands
 * the scan to a worker so a catastrophic `RegExp` evaluation never runs on
 * the request-serving event loop and the time budget is enforced by
 * terminating the worker rather than by a clock check between lines.
 *
 * Everything the worker computes is reported through *checkpoints*: one
 * message per batch of complete matches and one per file finished or
 * skipped, each carrying the matches found since the previous checkpoint and
 * the cumulative `filesScanned` / `filesSkipped` as of that moment. A file is
 * counted only once it has finished (or been skipped), so a mid-file
 * checkpoint carries complete matches from a file no counter counts yet. The
 * final checkpoint carries `done.reason` (`"limit"`, `"bytes"`, or `null`).
 *
 * Per file: the 0019 walk (ordering, hidden and symlink skipping exactly as
 * `GET /paths`), the `isTextPath` filter, a `guardedRead` (parent-chain check,
 * `O_NOFOLLOW` open, `fstat` regular-file check) bounded to `maxFileBytes`
 * plus one sentinel byte, the NUL sniff, UTF-8 decoding with replacement, and
 * line-by-line matching where each line is the whole input of one `exec`.
 *
 * A match is *complete* once the scan has reached each of its `context`
 * after-lines, or its file ended. Complete matches are posted before the next
 * line is matched, so a later line that never returns from `exec` cannot hold
 * back an earlier complete match. At most `context + 1` (≤ 6) matches can
 * complete at once, well inside the spec's 50-per-batch bound.
 *
 * The `limit + 1`-th match is a sentinel: it proves more matches exist and is
 * never posted or counted. The scan completes the `limit` matches it has from
 * the lines already in memory, counts the file as scanned, and stops.
 *
 * Coverage: Bun does not instrument code running inside a `Worker`, so the
 * module is written to be driven from the main thread too — `scan` and
 * `attach` are exported and the tests call them directly; the worker entry is
 * only the `attach(self)` line at the bottom.
 */

import { DocNotFoundError, InvalidPathError } from "../errors.ts";
import { isTextPath } from "./contentType.ts";
import { OversizeReadError, guardedRead } from "./guarded.ts";
import { walkVaultEntries } from "./paths.ts";

/** Longest `text` or context line returned, in code points. */
export const MAX_LINE_CHARS = 1000;

/** Why a scan ended on its own (the main thread adds `"time"`). */
export type ScanReason = "limit" | "bytes" | null;

/** Everything the worker needs; structured-clone safe. */
export interface ScanParams {
  /** Absolute root walked — the vault root, or a scoped session's scope root. */
  readonly root: string;
  readonly prefix: string;
  /** `RegExp` source; a literal pattern arrives already escaped. */
  readonly source: string;
  readonly flags: string;
  readonly limit: number;
  readonly context: number;
  /** Total file content searched before a `"bytes"` stop. */
  readonly byteBudget: number;
  /** Larger text files are skipped. */
  readonly maxFileBytes: number;
}

export interface GrepMatch {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
  readonly textStart: number;
  readonly before?: string[];
  readonly after?: string[];
}

export interface Checkpoint {
  readonly type: "checkpoint";
  /** Complete matches found since the previous checkpoint. */
  readonly matches: GrepMatch[];
  readonly filesScanned: number;
  readonly filesSkipped: number;
  /** Present on the last checkpoint only. */
  readonly done?: { readonly reason: ScanReason };
}

export interface ScanFailure {
  readonly type: "error";
  readonly message: string;
}

export type WorkerMessage = Checkpoint | ScanFailure;

/** Test seams, usable only when `scan` runs in-process. Production sets none. */
export interface ScanHooks {
  /** After the walk yielded a text file, immediately before its guarded read. */
  readonly beforeRead?: (path: string) => Promise<void>;
  /** After the opened descriptor's `fstat`, immediately before the read. */
  readonly afterStat?: (path: string) => Promise<void>;
  /** How many bytes the bounded read fetched. */
  readonly onRead?: (path: string, bytesRead: number) => void;
  /** Immediately before line `line` (1-based) is matched. */
  readonly beforeMatch?: (path: string, line: number) => Promise<void>;
}

/** The slice of a worker's global scope `attach` needs. */
export interface WorkerScope {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: WorkerMessage): void;
}

/** Split decoded text on `\n`, dropping one trailing `\r` per line. */
export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // A final terminator ends the last line; it does not start an empty one.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines.map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** A context line: its first `MAX_LINE_CHARS` code points. */
export function clipLine(line: string): string {
  // UTF-16 length bounds the code-point count from above.
  if (line.length <= MAX_LINE_CHARS) return line;
  const cps = Array.from(line);
  return cps.length <= MAX_LINE_CHARS ? line : cps.slice(0, MAX_LINE_CHARS).join("");
}

/**
 * A matching line, windowed to `MAX_LINE_CHARS` code points around the first
 * match's start (`at`, 0-based code points); `textStart` is the window's
 * 1-based start column, 1 for an unwindowed line.
 */
export function windowLine(line: string, at: number): { text: string; textStart: number } {
  if (line.length <= MAX_LINE_CHARS) return { text: line, textStart: 1 };
  const cps = Array.from(line);
  if (cps.length <= MAX_LINE_CHARS) return { text: line, textStart: 1 };
  // Centre the match where possible, never running past either end. `at` can
  // equal the line length (a zero-length match at its end), which the last
  // window still contains.
  const start = Math.max(0, Math.min(at - MAX_LINE_CHARS / 2, cps.length - MAX_LINE_CHARS));
  return { text: cps.slice(start, start + MAX_LINE_CHARS).join(""), textStart: start + 1 };
}

/** Mutable bookkeeping for one scan. */
interface ScanState {
  scanned: number;
  skipped: number;
  bytes: number;
  /** Matches found so far, the sentinel excluded. */
  found: number;
  /** Complete matches not yet posted. */
  pending: GrepMatch[];
}

/** A match still collecting its `after` lines. */
interface OpenMatch {
  readonly match: GrepMatch;
  readonly after: string[];
}

/**
 * Run one scan, posting checkpoints through `post`. Rejects only on an
 * unexpected filesystem error or an invalid `source`; the main thread
 * compiled `source` already, so the latter is a wiring bug.
 */
export async function scan(
  p: ScanParams,
  post: (message: WorkerMessage) => void,
  hooks: ScanHooks = {},
): Promise<void> {
  const re = new RegExp(p.source, p.flags);
  const st: ScanState = { scanned: 0, skipped: 0, bytes: 0, found: 0, pending: [] };
  const checkpoint = (reason?: ScanReason): void => {
    const matches = st.pending;
    st.pending = [];
    post({
      type: "checkpoint",
      matches,
      filesScanned: st.scanned,
      filesSkipped: st.skipped,
      ...(reason !== undefined && { done: { reason } }),
    });
  };
  // Enter a folder only on the way to, or inside, the prefix (as `listPaths`).
  const descend = (dir: string): boolean => {
    const d = `${dir}/`;
    return p.prefix.startsWith(d) || d.startsWith(p.prefix);
  };

  for await (const ent of walkVaultEntries(p.root, "", descend)) {
    if (ent.type !== "file" || !ent.rel.startsWith(p.prefix) || !isTextPath(ent.rel)) continue;
    const bytes = await readForScan(p, ent.rel, hooks);
    if (bytes === null) continue; // vanished since the walk: neither scanned nor skipped
    if (bytes === "skip" || bytes.includes(0)) {
      st.skipped++;
      checkpoint();
      continue;
    }
    // Stop before this file would take the total past the budget; it is not counted.
    if (st.bytes + bytes.byteLength > p.byteBudget) return checkpoint("bytes");
    st.bytes += bytes.byteLength;
    const lines = splitLines(new TextDecoder().decode(bytes));
    const limited = await searchLines(p, re, ent.rel, lines, st, checkpoint, hooks);
    st.scanned++;
    if (limited) return checkpoint("limit");
    checkpoint();
  }
  checkpoint(null);
}

/**
 * The guarded read: the file's bytes, `"skip"` for the containment and size
 * rules, `null` when it vanished.
 */
async function readForScan(
  p: ScanParams,
  rel: string,
  hooks: ScanHooks,
): Promise<Uint8Array | "skip" | null> {
  await hooks.beforeRead?.(rel);
  const { afterStat, onRead } = hooks;
  try {
    const read = await guardedRead(p.root, rel, {
      maxBytes: p.maxFileBytes,
      ...(afterStat !== undefined && { afterStat: () => afterStat(rel) }),
      ...(onRead !== undefined && { onRead: (n: number) => onRead(rel, n) }),
    });
    return read.bytes;
  } catch (e) {
    if (e instanceof DocNotFoundError) return null;
    if (e instanceof InvalidPathError || e instanceof OversizeReadError) return "skip";
    throw e;
  }
}

/**
 * Match `lines` of one file. Returns `true` when the sentinel match was found
 * (the `limit` stop), after completing every open match from `lines`.
 */
async function searchLines(
  p: ScanParams,
  re: RegExp,
  path: string,
  lines: readonly string[],
  st: ScanState,
  checkpoint: () => void,
  hooks: ScanHooks,
): Promise<boolean> {
  const open: OpenMatch[] = [];
  // The scan has reached line `j`: it joins every open match's `after`, and
  // the matches that now have all their context are complete.
  const reach = (j: number): void => {
    for (const o of open) o.after.push(clipLine(lines[j] as string));
    while (open.length > 0 && (open[0] as OpenMatch).after.length >= p.context) {
      st.pending.push((open.shift() as OpenMatch).match);
    }
  };
  for (let j = 0; j < lines.length; j++) {
    reach(j);
    // Post complete matches before matching a line that might never return.
    if (st.pending.length > 0) checkpoint();
    await hooks.beforeMatch?.(path, j + 1);
    const line = lines[j] as string;
    const m = re.exec(line);
    if (m === null) continue;
    if (st.found === p.limit) {
      // The sentinel: complete the open matches from the lines in memory.
      for (let k = j + 1; k < lines.length && open.length > 0; k++) reach(k);
      for (const o of open) st.pending.push(o.match);
      return true;
    }
    st.found++;
    const at = Array.from(line.slice(0, m.index)).length;
    const { text, textStart } = windowLine(line, at);
    const base = { path, line: j + 1, column: at + 1, text, textStart };
    if (p.context === 0) {
      st.pending.push(base);
      continue;
    }
    const before = lines.slice(Math.max(0, j - p.context), j).map(clipLine);
    const after: string[] = [];
    open.push({ match: { ...base, before, after }, after });
  }
  // End of file: every open match is complete with whatever context it got.
  for (const o of open) st.pending.push(o.match);
  return false;
}

/** Wire `scan` to a worker scope: one scan per received `ScanParams`. */
export function attach(scope: WorkerScope, hooks: ScanHooks = {}): void {
  scope.onmessage = (event: MessageEvent): void => {
    scan(event.data as ScanParams, (m) => scope.postMessage(m), hooks).catch((e: unknown) => {
      scope.postMessage({ type: "error", message: e instanceof Error ? e.message : String(e) });
    });
  };
}

// Worker entry. On the main thread (where the tests import this module) it
// does nothing.
if (!Bun.isMainThread) attach(globalThis as unknown as WorkerScope);

/**
 * Service-core tests for `grep` (REST API › Grep) against REAL on-disk
 * tmpdir vaults — no `fs` mocking.
 *
 * Two ways of running the scan:
 * - the real Bun `Worker` (the default `spawn`), for the scenarios and the
 *   end-to-end catastrophic-regex test;
 * - `inProcess`, which runs the same `scan` on the main thread behind the
 *   `GrepWorkerHandle` interface, so tests can hold back message delivery,
 *   hang a line's match (standing in for a regex that never returns), and
 *   act as a concurrent writer through the scan's hooks. The deadline is a
 *   manual timer, so no test waits on the wall clock for a cut-off.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidInputError, VaultNotFoundError } from "../../src/errors.ts";
import type { VaultServiceDeps } from "../../src/vault/files.ts";
import {
  GREP_MAX_FILE_BYTES,
  type GrepResult,
  type GrepRuntime,
  type GrepWorkerHandle,
  Semaphore,
  escapeLiteral,
  grep,
  grepSlots,
  spawnGrepWorker,
} from "../../src/vault/grep.ts";
import {
  type Checkpoint,
  type GrepMatch,
  type ScanHooks,
  type ScanParams,
  type WorkerMessage,
  type WorkerScope,
  attach,
  clipLine,
  scan,
  splitLines,
  windowLine,
} from "../../src/vault/grepWorker.ts";
import { makeVaultFixture } from "./helpers.ts";

function put(root: string, rel: string, content: string | Uint8Array): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function vault(files: Record<string, string | Uint8Array> = {}): {
  deps: VaultServiceDeps;
  root: string;
} {
  const fx = makeVaultFixture();
  for (const [rel, content] of Object.entries(files)) put(fx.root, rel, content);
  return { deps: fx.deps, root: fx.root };
}

const at = (ms: GrepMatch[]): string[] => ms.map((m) => `${m.path}:${m.line}:${m.column}`);

/** A deadline the test fires by hand. */
function manualTimer(): { set: NonNullable<GrepRuntime["setTimer"]>; fire(): void } {
  let fire: (() => void) | null = null;
  return {
    set: (_ms, f) => {
      fire = f;
      return () => {
        fire = null;
      };
    },
    fire: () => fire?.(),
  };
}

/** A promise the test resolves by hand. */
function gate(): { wait: Promise<void>; open(): void } {
  let open = (): void => {};
  const wait = new Promise<void>((r) => {
    open = r;
  });
  return { wait, open };
}

/** A promise that never settles: a line whose evaluation never returns. */
const forever = (): Promise<void> => new Promise<void>(() => {});

interface FakeWorker extends GrepWorkerHandle {
  /** Messages the scan posted and not yet delivered (hold mode). */
  readonly held: WorkerMessage[];
  /** Messages delivered to the main thread, in order. */
  readonly delivered: WorkerMessage[];
  /** Deliver the next `n` held messages. */
  deliver(n?: number): void;
  /** Settles when the scan itself finished (or failed). */
  readonly scanned: Promise<void>;
  terminated: boolean;
  fail(error: Error): void;
}

/**
 * In-process stand-in for the worker. `hold: true` queues every posted
 * message until `deliver`; otherwise each is delivered as it is posted.
 */
function inProcess(
  hooks: ScanHooks = {},
  opts: { hold?: boolean } = {},
): { spawn: () => GrepWorkerHandle; workers: FakeWorker[] } {
  const workers: FakeWorker[] = [];
  const spawn = (): GrepWorkerHandle => {
    let onMessage: (m: WorkerMessage) => void = () => {};
    let onError: (e: Error) => void = () => {};
    let exit = (): void => {};
    let scanDone = (): void => {};
    const scanned = new Promise<void>((r) => {
      scanDone = r;
    });
    const w: FakeWorker = {
      held: [],
      delivered: [],
      terminated: false,
      scanned,
      exited: new Promise<void>((r) => {
        exit = r;
      }),
      onMessage: (cb) => {
        onMessage = cb;
      },
      onError: (cb) => {
        onError = cb;
      },
      deliver: (n = Number.POSITIVE_INFINITY) => {
        for (let i = 0; i < n && w.held.length > 0; i++) {
          const m = w.held.shift() as WorkerMessage;
          w.delivered.push(m);
          onMessage(m);
        }
      },
      fail: (e) => onError(e),
      terminate: () => {
        w.terminated = true;
        exit();
      },
      start: (params: ScanParams) => {
        const post = (m: WorkerMessage): void => {
          if (w.terminated) return;
          w.held.push(m);
          if (opts.hold !== true) w.deliver();
        };
        scan(params, post, hooks).then(scanDone, (e: unknown) => {
          post({ type: "error", message: (e as Error).message });
          scanDone();
        });
      },
    };
    workers.push(w);
    return w;
  };
  return { spawn, workers };
}

const checkpoints = (ms: WorkerMessage[]): Checkpoint[] =>
  ms.filter((m): m is Checkpoint => m.type === "checkpoint");

/** What the main thread must answer on a `"time"` cut-off after `delivered`. */
function expectedCutoff(delivered: WorkerMessage[]): GrepResult {
  const cps = checkpoints(delivered);
  const last = cps[cps.length - 1];
  return {
    matches: cps.flatMap((c) => c.matches),
    truncated: true,
    reason: "time",
    filesScanned: last?.filesScanned ?? 0,
    filesSkipped: last?.filesSkipped ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Line primitives
// ---------------------------------------------------------------------------

describe("line primitives", () => {
  test("splitLines splits on \\n, drops one trailing \\r, and no phantom last line", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a")).toEqual(["a"]);
    expect(splitLines("a\n")).toEqual(["a"]);
    expect(splitLines("a\r\nb\r\n")).toEqual(["a", "b"]);
    expect(splitLines("a\n\nb")).toEqual(["a", "", "b"]);
    expect(splitLines("a\r\r\n")).toEqual(["a\r"]);
    expect(splitLines("\n")).toEqual([""]);
  });

  test("clipLine keeps the first 1000 code points", () => {
    expect(clipLine("short")).toBe("short");
    const astral = "😀".repeat(1000); // 2000 UTF-16 units, 1000 code points
    expect(clipLine(astral)).toBe(astral);
    expect(clipLine(`${"x".repeat(1000)}TAIL`)).toBe("x".repeat(1000));
    expect(Array.from(clipLine("😀".repeat(1001)))).toHaveLength(1000);
  });

  test("windowLine keeps the match inside a 1000-code-point window", () => {
    expect(windowLine("short", 2)).toEqual({ text: "short", textStart: 1 });
    const astral = "😀".repeat(1000);
    expect(windowLine(astral, 999)).toEqual({ text: astral, textStart: 1 });
    const long = `${"a".repeat(1500)}N${"b".repeat(1500)}`;
    expect(windowLine(long, 10).textStart).toBe(1);
    const mid = windowLine(long, 1500);
    expect(mid.text).toHaveLength(1000);
    expect(mid.text[1500 - (mid.textStart - 1)]).toBe("N");
    // A zero-length match just past the last character sits at the window's end.
    const end = windowLine(long, 3001);
    expect(end.textStart).toBe(3001 - 1000 + 1);
    expect(end.text).toBe(long.slice(2001));
  });

  test("escapeLiteral escapes every Unicode-mode syntax character", () => {
    const special = "\\^$.*+?()[]{}|/";
    const re = new RegExp(escapeLiteral(special), "u");
    expect(re.exec(`x${special}y`)?.index).toBe(1);
    expect(new RegExp(escapeLiteral("a-b"), "u").test("a-b")).toBe(true);
  });
});

/**
 * The scenario and limit suites run twice: through the real worker, and
 * in-process — the only way Bun's coverage sees the worker's code.
 */
const MODES: [string, (() => GrepWorkerHandle) | undefined][] = [
  ["worker", undefined],
  ["in-process", (): GrepWorkerHandle => inProcess().spawn()],
];

function inMode(spawn: (() => GrepWorkerHandle) | undefined): typeof grep {
  return (deps, slug, args, rt = {}) =>
    grepCore(deps, slug, args, spawn === undefined ? rt : { spawn, ...rt });
}

const grepCore = grep;

// ---------------------------------------------------------------------------
// Spec scenarios and line semantics
// ---------------------------------------------------------------------------

describe.each(MODES)("grep — scenarios (%s)", (_mode, spawn) => {
  const grep = inMode(spawn);

  test("literal grep finds exact text with line numbers; images are not searched", async () => {
    const { deps } = vault({
      "notes/a.md": "first\nsecond\nTODO: call the plumber\n",
      "img/logo.png": "TODO: in a png",
    });
    expect(await grep(deps, "v", { pattern: "TODO:" })).toEqual({
      matches: [
        { path: "notes/a.md", line: 3, column: 1, text: "TODO: call the plumber", textStart: 1 },
      ],
      truncated: false,
      reason: null,
      filesScanned: 1,
      filesSkipped: 0,
    });
  });

  test("regex special characters are literal by default", async () => {
    const { deps } = vault({ "a.md": "cost (est.) $5\ncost est $5\n" });
    const r = await grep(deps, "v", { pattern: "(est.) $5" });
    expect(at(r.matches)).toEqual(["a.md:1:6"]);
  });

  test("an invalid regex is invalid_input; a literal with the same text is fine", async () => {
    const { deps } = vault({ "a.md": "x([y\n" });
    await expect(grep(deps, "v", { pattern: "([", regex: true })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
    expect(at((await grep(deps, "v", { pattern: "([" })).matches)).toEqual(["a.md:1:2"]);
  });

  test("an unknown vault is vault_not_found", async () => {
    const { deps } = vault();
    await expect(grep(deps, "ghost", { pattern: "x" })).rejects.toBeInstanceOf(VaultNotFoundError);
  });

  test("one entry per matching line, at the first match", async () => {
    const { deps } = vault({ "a.md": "no\nab ab ab\n" });
    const r = await grep(deps, "v", { pattern: "ab" });
    expect(at(r.matches)).toEqual(["a.md:2:1"]);
    expect(r.matches[0]?.text).toBe("ab ab ab");
  });

  test("ignoreCase is Unicode case-insensitive in both modes; regex is Unicode mode", async () => {
    const { deps } = vault({ "a.md": "ÄPFEL\näpfel\nApfel\n" });
    expect(at((await grep(deps, "v", { pattern: "äpfel" })).matches)).toEqual(["a.md:2:1"]);
    expect(at((await grep(deps, "v", { pattern: "äpfel", ignoreCase: true })).matches)).toEqual([
      "a.md:1:1",
      "a.md:2:1",
    ]);
    const re = await grep(deps, "v", { pattern: "^\\p{Lu}{2}", regex: true, ignoreCase: false });
    expect(at(re.matches)).toEqual(["a.md:1:1"]);
    const rei = await grep(deps, "v", { pattern: "^ä", regex: true, ignoreCase: true });
    expect(at(rei.matches)).toEqual(["a.md:1:1", "a.md:2:1"]);
  });

  test("zero-length matches: ^$ only empty lines, a* every line at column 1, $ past the end", async () => {
    const { deps } = vault({ "a.md": "bab\n\naab\nxyz\n\n" });
    const empty = await grep(deps, "v", { pattern: "^$", regex: true });
    expect(at(empty.matches)).toEqual(["a.md:2:1", "a.md:5:1"]);
    const star = await grep(deps, "v", { pattern: "a*", regex: true });
    expect(at(star.matches)).toEqual(["a.md:1:1", "a.md:2:1", "a.md:3:1", "a.md:4:1", "a.md:5:1"]);
    const end = await grep(deps, "v", { pattern: "$", regex: true });
    expect(at(end.matches)).toEqual(["a.md:1:4", "a.md:2:1", "a.md:3:4", "a.md:4:4", "a.md:5:1"]);
  });

  test("anchors bind to the line, never across a line break", async () => {
    const { deps } = vault({ "a.md": "foo\nbar\n" });
    expect(at((await grep(deps, "v", { pattern: "^bar$", regex: true })).matches)).toEqual([
      "a.md:2:1",
    ]);
    expect((await grep(deps, "v", { pattern: "foo\\nbar", regex: true })).matches).toEqual([]);
  });

  test("CRLF files: the \\r is not part of the line", async () => {
    const { deps } = vault({ "a.txt": "one\r\ntwo\r\n" });
    const r = await grep(deps, "v", { pattern: "o$", regex: true, context: 1 });
    expect(r.matches).toEqual([
      { path: "a.txt", line: 2, column: 3, text: "two", textStart: 1, before: ["one"], after: [] },
    ]);
  });

  test("invalid UTF-8 is replaced, and columns count code points", async () => {
    const bytes = new Uint8Array([0xff, 0x41, 0x0a, 0xf0, 0x9f, 0x98, 0x80, 0x42, 0x0a]);
    const { deps } = vault({ "a.md": bytes });
    const r = await grep(deps, "v", { pattern: "B" });
    expect(r.matches).toEqual([{ path: "a.md", line: 2, column: 2, text: "😀B", textStart: 1 }]);
    const a = await grep(deps, "v", { pattern: "\uFFFDA" });
    expect(at(a.matches)).toEqual(["a.md:1:1"]);
  });

  test("context lines stop at file boundaries, never cross files, and are not merged", async () => {
    const { deps } = vault({
      "a.md": "x1\nl2\nx3\nl4\n",
      "b.md": "x1\n",
    });
    const r = await grep(deps, "v", { pattern: "x", context: 2 });
    expect(r.matches).toEqual([
      {
        path: "a.md",
        line: 1,
        column: 1,
        text: "x1",
        textStart: 1,
        before: [],
        after: ["l2", "x3"],
      },
      {
        path: "a.md",
        line: 3,
        column: 1,
        text: "x3",
        textStart: 1,
        before: ["x1", "l2"],
        after: ["l4"],
      },
      { path: "b.md", line: 1, column: 1, text: "x1", textStart: 1, before: [], after: [] },
    ]);
    // `before` / `after` are present iff context > 0.
    const bare = await grep(deps, "v", { pattern: "x", context: 0 });
    expect(bare.matches.every((m) => m.before === undefined && m.after === undefined)).toBe(true);
  });

  test("long lines: textStart windows a match beyond column 1000; context lines are clipped", async () => {
    const long = `${"a".repeat(1500)}NEEDLE${"b".repeat(1500)}`;
    const ctx = "c".repeat(1200);
    const { deps } = vault({ "a.md": `${ctx}\n${long}\nshort NEEDLE\n` });
    const r = await grep(deps, "v", { pattern: "NEEDLE", context: 1 });
    const [first, second] = r.matches as [GrepMatch, GrepMatch];
    expect(first.column).toBe(1501);
    expect(first.textStart).toBeGreaterThan(1);
    expect(first.text).toHaveLength(1000);
    expect(first.text.slice(first.column - first.textStart).startsWith("NEEDLE")).toBe(true);
    expect(first.before).toEqual(["c".repeat(1000)]);
    expect(first.after).toEqual(["short NEEDLE"]);
    expect(second).toMatchObject({ line: 3, column: 7, text: "short NEEDLE", textStart: 1 });
    expect(second.before).toEqual([long.slice(0, 1000)]);
  });

  test("hidden files, symlinks, PDFs, and binaries are never searched", async () => {
    const { deps, root } = vault({
      "a.md": "NEEDLE\n",
      ".hidden.md": "NEEDLE\n",
      ".obsidian/app.json": '{"NEEDLE":1}',
      "sub/.secret/x.md": "NEEDLE\n",
      "doc.pdf": "NEEDLE in a pdf",
      "blob.bin": "NEEDLE in a binary",
      "real/x.md": "NEEDLE\n",
      "data.json": '{"k":"NEEDLE"}',
    });
    symlinkSync(join(root, "a.md"), join(root, "link.md"));
    symlinkSync(join(root, "real"), join(root, "linkdir"));
    const r = await grep(deps, "v", { pattern: "NEEDLE" });
    expect(r.matches.map((m) => m.path)).toEqual(["a.md", "data.json", "real/x.md"]);
    expect(r.filesScanned).toBe(3);
    expect(r.filesSkipped).toBe(0);
  });

  test("files are searched in the listing's segment-wise order", async () => {
    const { deps } = vault({ "a-b.md": "N\n", "a/x.md": "N\n", "B.md": "N\n" });
    const r = await grep(deps, "v", { pattern: "N" });
    expect(r.matches.map((m) => m.path)).toEqual(["B.md", "a/x.md", "a-b.md"]);
  });

  test("prefix is literal: a folder, a partial name, empty, and traversal shapes", async () => {
    const { deps } = vault({
      "notes/a.md": "N\n",
      "notes2/b.md": "N\n",
      "other/c.md": "N\n",
    });
    const paths = async (prefix: string): Promise<string[]> =>
      (await grep(deps, "v", { pattern: "N", prefix })).matches.map((m) => m.path);
    expect(await paths("notes/")).toEqual(["notes/a.md"]);
    expect(await paths("notes")).toEqual(["notes/a.md", "notes2/b.md"]);
    expect(await paths("")).toEqual(["notes/a.md", "notes2/b.md", "other/c.md"]);
    expect(await paths("notes/a.md")).toEqual(["notes/a.md"]);
    expect(await paths("../")).toEqual([]);
    expect(await paths("../v/notes/")).toEqual([]);
    expect(await paths("/notes/")).toEqual([]);
  });

  test("a NUL byte or a size over 1 MiB skips the file and counts it", async () => {
    const { deps } = vault({
      "a.md": "NEEDLE\n",
      "big.txt": `NEEDLE\n${"x".repeat(GREP_MAX_FILE_BYTES)}`,
      "exact.txt": `NEEDLE\n${"x".repeat(GREP_MAX_FILE_BYTES - 7)}`,
      "nul.md": "NEEDLE\n\0\n",
    });
    const r = await grep(deps, "v", { pattern: "NEEDLE" });
    expect(r.matches.map((m) => m.path)).toEqual(["a.md", "exact.txt"]);
    expect(r).toMatchObject({ truncated: false, filesScanned: 2, filesSkipped: 2 });
  });
});

// ---------------------------------------------------------------------------
// Limits and counters
// ---------------------------------------------------------------------------

describe.each(MODES)("grep — limits and counters (%s)", (_mode, spawn) => {
  const grep = inMode(spawn);

  test("limit sentinel: two of three returned, reason limit, the sentinel's file scanned", async () => {
    const { deps } = vault({
      "a.md": "N1\nN2\n",
      "b.md": "N3\n",
      "c.md": "N4\n",
    });
    const r = await grep(deps, "v", { pattern: "N", limit: 2 });
    expect(at(r.matches)).toEqual(["a.md:1:1", "a.md:2:1"]);
    expect(r).toMatchObject({ truncated: true, reason: "limit", filesScanned: 2, filesSkipped: 0 });
  });

  test("exactly `limit` matches is not truncated", async () => {
    const { deps } = vault({ "a.md": "N1\nN2\n" });
    const r = await grep(deps, "v", { pattern: "N", limit: 2 });
    expect(r).toMatchObject({ truncated: false, reason: null, filesScanned: 1 });
    expect(r.matches).toHaveLength(2);
  });

  test("a limit stop completes the after-context of the matches it returns", async () => {
    const { deps } = vault({ "a.md": "N1\nl2\nN3\nl4\nl5\n" });
    const r = await grep(deps, "v", { pattern: "N", limit: 1, context: 3 });
    expect(r.matches).toEqual([
      {
        path: "a.md",
        line: 1,
        column: 1,
        text: "N1",
        textStart: 1,
        before: [],
        after: ["l2", "N3", "l4"],
      },
    ]);
    expect(r).toMatchObject({ truncated: true, reason: "limit", filesScanned: 1 });
  });

  test("the default limit is 100", async () => {
    const { deps } = vault({ "a.md": "N\n".repeat(101) });
    const r = await grep(deps, "v", { pattern: "N" });
    expect(r.matches).toHaveLength(100);
    expect(r.reason).toBe("limit");
  });

  test("bytes: the file that would pass the budget is neither searched nor counted", async () => {
    const { deps } = vault({
      "a.md": "N 456789\n", // 9 bytes
      "b.md": "N 456789\n",
      "c.md": "N 456789\n",
    });
    const r = await grep(deps, "v", { pattern: "N" }, { byteBudget: 20 });
    expect(at(r.matches)).toEqual(["a.md:1:1", "b.md:1:1"]);
    expect(r).toMatchObject({ truncated: true, reason: "bytes", filesScanned: 2, filesSkipped: 0 });
    // Exactly the budget is allowed.
    const exact = await grep(deps, "v", { pattern: "N" }, { byteBudget: 27 });
    expect(exact).toMatchObject({ truncated: false, filesScanned: 3 });
  });

  test("a completed scan counts every searched and every skipped file", async () => {
    const { deps } = vault({
      "a.md": "N\n",
      "b.md": "nothing\n",
      "c.md": "\0",
      "d.txt": "x".repeat(GREP_MAX_FILE_BYTES + 1),
      "e.png": "N",
    });
    const r = await grep(deps, "v", { pattern: "N" });
    expect(r).toMatchObject({ truncated: false, reason: null, filesScanned: 2, filesSkipped: 2 });
  });

  test("time cut-off in the middle of a file: that file counts in neither counter", async () => {
    const { deps } = vault({
      "a.md": "N\n",
      "b.md": "N1\nN2\nHANG\nN4\n",
      "c.md": "N\n",
    });
    const timer = manualTimer();
    const hung = gate();
    const fake = inProcess({
      beforeMatch: async (path, line) => {
        if (path === "b.md" && line === 3) {
          hung.open();
          await forever();
        }
      },
    });
    const pending = grep(deps, "v", { pattern: "N" }, { spawn: fake.spawn, setTimer: timer.set });
    await hung.wait;
    timer.fire();
    const r = await pending;
    expect(at(r.matches)).toEqual(["a.md:1:1", "b.md:1:1", "b.md:2:1"]);
    expect(r).toMatchObject({ truncated: true, reason: "time", filesScanned: 1, filesSkipped: 0 });
    expect(r).toEqual(expectedCutoff((fake.workers[0] as FakeWorker).delivered));
    expect((fake.workers[0] as FakeWorker).terminated).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

describe("grep — checkpoints", () => {
  test("a delayed delivery: matches accumulate, counters are the last delivered checkpoint's", async () => {
    const { deps } = vault({ "a.md": "x\nno\nx\n", "b.md": "x\n" });
    const timer = manualTimer();
    const fake = inProcess({}, { hold: true });
    const pending = grep(deps, "v", { pattern: "x" }, { spawn: fake.spawn, setTimer: timer.set });
    await Bun.sleep(0);
    const w = fake.workers[0] as FakeWorker;
    // The worker finished every file; the main thread has received nothing.
    await w.scanned;
    expect(checkpoints(w.held).map((c) => c.filesScanned)).toEqual([0, 1, 2, 2]);
    // Deliver only the first, mid-file checkpoint: its match is from a file
    // no counter counts yet.
    w.deliver(1);
    timer.fire();
    const r = await pending;
    expect(r).toEqual({
      matches: [{ path: "a.md", line: 1, column: 1, text: "x", textStart: 1 }],
      truncated: true,
      reason: "time",
      filesScanned: 0,
      filesSkipped: 0,
    });
    expect(r).toEqual(expectedCutoff(w.delivered));
    // Whatever arrives after the cut-off is ignored.
    w.deliver();
    expect(r.matches).toHaveLength(1);
  });

  test("a counters-only last checkpoint keeps the earlier matches", async () => {
    const { deps } = vault({ "a.md": "x\n", "b.md": "no\n", "c.md": "x\n" });
    const timer = manualTimer();
    const fake = inProcess({}, { hold: true });
    const pending = grep(deps, "v", { pattern: "x" }, { spawn: fake.spawn, setTimer: timer.set });
    await Bun.sleep(0);
    const w = fake.workers[0] as FakeWorker;
    await w.scanned;
    w.deliver(2);
    const last = checkpoints(w.delivered)[1] as Checkpoint;
    expect(last.matches).toEqual([]);
    expect(last.filesScanned).toBe(2);
    timer.fire();
    const r = await pending;
    expect(at(r.matches)).toEqual(["a.md:1:1"]);
    expect(r).toMatchObject({ reason: "time", filesScanned: 2, filesSkipped: 0 });
    expect(r).toEqual(expectedCutoff(w.delivered));
  });

  test("a later line that never returns: context 0 keeps every earlier match", async () => {
    const { deps } = vault({ "a.md": "x\nx\nHANG\nz\n" });
    const r = await hangAtLine3(deps, 0);
    expect(at(r.result.matches)).toEqual(["a.md:1:1", "a.md:2:1"]);
    expect(r.result).toEqual(expectedCutoff(r.delivered));
  });

  test("a later line that never returns: an incomplete context-2 match is left out", async () => {
    const { deps } = vault({ "a.md": "x\nx\nHANG\nz\n" });
    const r = await hangAtLine3(deps, 2);
    // Line 1's after-lines (2 and 3) were read before line 3 was matched;
    // line 2's second after-line (4) never was.
    expect(r.result.matches).toEqual([
      {
        path: "a.md",
        line: 1,
        column: 1,
        text: "x",
        textStart: 1,
        before: [],
        after: ["x", "HANG"],
      },
    ]);
    expect(r.result).toEqual(expectedCutoff(r.delivered));
  });
});

async function hangAtLine3(
  deps: VaultServiceDeps,
  context: number,
): Promise<{ result: GrepResult; delivered: WorkerMessage[] }> {
  const timer = manualTimer();
  const hung = gate();
  const fake = inProcess({
    beforeMatch: async (_path, line) => {
      if (line === 3) {
        hung.open();
        await forever();
      }
    },
  });
  const pending = grep(
    deps,
    "v",
    { pattern: "x", context },
    { spawn: fake.spawn, setTimer: timer.set },
  );
  await hung.wait;
  timer.fire();
  const result = await pending;
  return { result, delivered: (fake.workers[0] as FakeWorker).delivered };
}

// ---------------------------------------------------------------------------
// Read containment and size cap (concurrent writer via hooks)
// ---------------------------------------------------------------------------

describe("grep — containment and growth", () => {
  test("a parent swapped for a symlink to outside between walk and open is skipped", async () => {
    const { deps, root } = vault({ "notes/a.md": "inside\n", "z.md": "OUTSIDE? no\n" });
    const outside = mkdtempSync(join(tmpdir(), "ob-grep-outside-"));
    writeFileSync(join(outside, "a.md"), "SECRET OUTSIDE\n");
    const reads: string[] = [];
    const fake = inProcess({
      beforeRead: async (path) => {
        if (path !== "notes/a.md") return;
        renameSync(join(root, "notes"), join(root, "moved"));
        symlinkSync(outside, join(root, "notes"));
      },
      onRead: (path) => reads.push(path),
    });
    const r = await grep(deps, "v", { pattern: "SECRET" }, { spawn: fake.spawn });
    expect(r).toEqual({
      matches: [],
      truncated: false,
      reason: null,
      filesScanned: 1,
      filesSkipped: 1,
    });
    // Nothing was read through the swapped parent.
    expect(reads).toEqual(["z.md"]);
  });

  test("a file that grows past 1 MiB between open and read is skipped unsearched", async () => {
    const { deps, root } = vault({ "a.md": "NEEDLE\n", "b.md": "NEEDLE\n" });
    const fetched: number[] = [];
    const fake = inProcess({
      afterStat: async (path) => {
        if (path === "a.md")
          appendFileSync(join(root, "a.md"), "x".repeat(2 * GREP_MAX_FILE_BYTES));
      },
      onRead: (path, n) => {
        if (path === "a.md") fetched.push(n);
      },
    });
    const r = await grep(deps, "v", { pattern: "NEEDLE" }, { spawn: fake.spawn });
    expect(r.matches.map((m) => m.path)).toEqual(["b.md"]);
    expect(r).toMatchObject({ filesScanned: 1, filesSkipped: 1 });
    expect(fetched).toEqual([GREP_MAX_FILE_BYTES + 1]);
  });

  test("a file removed between walk and read is neither scanned nor skipped", async () => {
    const { deps, root } = vault({ "a.md": "N\n", "b.md": "N\n" });
    const fake = inProcess({
      beforeRead: async (path) => {
        if (path === "a.md") rmSync(join(root, "a.md"));
      },
    });
    const r = await grep(deps, "v", { pattern: "N" }, { spawn: fake.spawn });
    expect(at(r.matches)).toEqual(["b.md:1:1"]);
    expect(r).toMatchObject({ filesScanned: 1, filesSkipped: 0 });
  });

  test("an unexpected scan failure rejects the call", async () => {
    const { deps } = vault({ "a.md": "N\n" });
    // Thrown inside the guarded read, so it reaches the scan as an
    // unexpected read error rather than a skip.
    const fake = inProcess({
      afterStat: async () => {
        throw new Error("disk on fire");
      },
    });
    await expect(grep(deps, "v", { pattern: "N" }, { spawn: fake.spawn })).rejects.toThrow(
      "grep scan failed: disk on fire",
    );
    expect((fake.workers[0] as FakeWorker).terminated).toBe(true);
  });

  test("a worker-level error rejects the call", async () => {
    const { deps } = vault({ "a.md": "N\n" });
    const fake = inProcess({}, { hold: true });
    const pending = grep(deps, "v", { pattern: "N" }, { spawn: fake.spawn });
    await Bun.sleep(0);
    (fake.workers[0] as FakeWorker).fail(new Error("worker died"));
    await expect(pending).rejects.toThrow("worker died");
  });
});

// ---------------------------------------------------------------------------
// Concurrency cap, queue, and cancellation
// ---------------------------------------------------------------------------

describe("grep — concurrency and cancellation", () => {
  /** Two greps holding both slots until `release.open()`. */
  function twoRunning(deps: VaultServiceDeps, slots: Semaphore) {
    const release = gate();
    const started: string[] = [];
    const fake = inProcess({
      beforeMatch: async (path) => {
        started.push(path);
        await release.wait;
      },
    });
    const first = grep(deps, "v", { pattern: "N" }, { slots, spawn: fake.spawn });
    const second = grep(deps, "v", { pattern: "N" }, { slots, spawn: fake.spawn });
    return { release, fake, first, second, started };
  }

  test("a third grep waits behind two running ones and runs once a slot frees", async () => {
    const { deps } = vault({ "a.md": "N\n" });
    const slots = new Semaphore(2);
    const run = twoRunning(deps, slots);
    const third = inProcess();
    const pending = grep(deps, "v", { pattern: "N" }, { slots, spawn: third.spawn });
    await Bun.sleep(0);
    expect(slots.available).toBe(0);
    expect(slots.waiting).toBe(1);
    expect(third.workers).toHaveLength(0);
    run.release.open();
    expect((await run.first).matches).toHaveLength(1);
    expect((await run.second).matches).toHaveLength(1);
    const r = await pending;
    expect(at(r.matches)).toEqual(["a.md:1:1"]);
    expect(third.workers).toHaveLength(1);
    // Every slot comes back once the workers have exited.
    await Bun.sleep(0);
    expect(slots.available).toBe(2);
  });

  test("a budget that runs out in the queue returns the empty time result", async () => {
    const { deps } = vault({ "a.md": "N\n" });
    const slots = new Semaphore(2);
    const run = twoRunning(deps, slots);
    const timer = manualTimer();
    const third = inProcess();
    const pending = grep(
      deps,
      "v",
      { pattern: "N" },
      { slots, spawn: third.spawn, setTimer: timer.set },
    );
    await Bun.sleep(0);
    expect(slots.waiting).toBe(1);
    timer.fire();
    expect(await pending).toEqual({
      matches: [],
      truncated: true,
      reason: "time",
      filesScanned: 0,
      filesSkipped: 0,
    });
    expect(slots.waiting).toBe(0);
    expect(third.workers).toHaveLength(0);
    run.release.open();
    await Promise.all([run.first, run.second]);
  });

  test("a cancelled waiting call leaves the queue", async () => {
    const { deps } = vault({ "a.md": "N\n" });
    const slots = new Semaphore(2);
    const run = twoRunning(deps, slots);
    const ctl = new AbortController();
    const third = inProcess();
    const pending = grep(
      deps,
      "v",
      { pattern: "N", signal: ctl.signal },
      { slots, spawn: third.spawn },
    );
    await Bun.sleep(0);
    expect(slots.waiting).toBe(1);
    ctl.abort();
    expect((await pending).matches).toEqual([]);
    expect(slots.waiting).toBe(0);
    expect(third.workers).toHaveLength(0);
    run.release.open();
    await Promise.all([run.first, run.second]);
    await Bun.sleep(0);
    expect(slots.available).toBe(2);
  });

  test("a cancelled running call terminates its worker and frees its slot", async () => {
    const { deps } = vault({ "a.md": "N\n", "b.md": "N\n" });
    const slots = new Semaphore(2);
    const ctl = new AbortController();
    const hung = gate();
    const fake = inProcess({
      beforeMatch: async (path) => {
        if (path === "b.md") {
          hung.open();
          await forever();
        }
      },
    });
    const pending = grep(
      deps,
      "v",
      { pattern: "N", signal: ctl.signal },
      { slots, spawn: fake.spawn },
    );
    await hung.wait;
    expect(slots.available).toBe(1);
    ctl.abort();
    const r = await pending;
    expect(at(r.matches)).toEqual(["a.md:1:1"]);
    expect((fake.workers[0] as FakeWorker).terminated).toBe(true);
    await Bun.sleep(0);
    expect(slots.available).toBe(2);
  });

  test("an already-cancelled call never takes a slot", async () => {
    const { deps } = vault({ "a.md": "N\n" });
    const slots = new Semaphore(2);
    const fake = inProcess();
    const r = await grep(
      deps,
      "v",
      { pattern: "N", signal: AbortSignal.abort() },
      { slots, spawn: fake.spawn },
    );
    expect(r).toMatchObject({ matches: [], reason: "time" });
    expect(fake.workers).toHaveLength(0);
    expect(slots.available).toBe(2);
  });

  test("a call cancelled as its worker spawns never starts the scan", async () => {
    const { deps } = vault({ "a.md": "N\n" });
    const ctl = new AbortController();
    const fake = inProcess();
    const spawn = (): GrepWorkerHandle => {
      ctl.abort();
      return fake.spawn();
    };
    const slots = new Semaphore(1);
    const r = await grep(deps, "v", { pattern: "N", signal: ctl.signal }, { slots, spawn });
    expect(r).toMatchObject({ matches: [], reason: "time" });
    expect((fake.workers[0] as FakeWorker).terminated).toBe(true);
    expect((fake.workers[0] as FakeWorker).held).toEqual([]);
  });

  test("Semaphore: FIFO hand-off, idempotent release, abort removes only that waiter", async () => {
    const s = new Semaphore(1);
    const never = new AbortController().signal;
    const r1 = await s.acquire(never);
    const order: string[] = [];
    const ctl = new AbortController();
    const p2 = s.acquire(never).then((r) => {
      order.push("2");
      return r;
    });
    const p3 = s.acquire(ctl.signal).catch(() => {
      order.push("3 left");
    });
    const p4 = s.acquire(never).then((r) => {
      order.push("4");
      return r;
    });
    expect(s.waiting).toBe(3);
    ctl.abort();
    await p3;
    expect(s.waiting).toBe(2);
    r1();
    r1(); // a second call is a no-op
    const r2 = await p2;
    expect(s.waiting).toBe(1);
    r2();
    const r4 = await p4;
    expect(order).toEqual(["3 left", "2", "4"]);
    r4();
    expect(s.available).toBe(1);
    await expect(s.acquire(AbortSignal.abort())).rejects.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// The real worker
// ---------------------------------------------------------------------------

describe("grep — real worker", () => {
  // A slot is released only once its worker exited: wait for both, so the
  // cut-off evaluation does not keep running into later tests.
  afterEach(async () => {
    const never = new AbortController().signal;
    const held = await Promise.all([grepSlots.acquire(never), grepSlots.acquire(never)]);
    for (const release of held) release();
  });

  test("a catastrophic regex is cut off at the budget while the event loop keeps serving", async () => {
    // Several 10 000-character lines of `a` followed by `!`: each evaluation
    // of `(a+)+$` backtracks for far longer than the budget.
    const line = `${"a".repeat(10_000)}!\n`;
    const { deps } = vault({ "a.md": "found first\n", "cat.txt": line.repeat(50) });
    let ticks = 0;
    const iv = setInterval(() => ticks++, 10);
    const started = performance.now();
    const pending = grep(
      deps,
      "v",
      { pattern: "(a+)+$|found", regex: true },
      { timeBudgetMs: 1_000 },
    );
    // Another grep is answered while the catastrophic one runs.
    const other = await grep(deps, "v", { pattern: "found", prefix: "a.md" });
    const otherAt = performance.now() - started;
    const r = await pending;
    const elapsed = performance.now() - started;
    clearInterval(iv);
    expect(at(other.matches)).toEqual(["a.md:1:1"]);
    expect(otherAt).toBeLessThan(elapsed);
    expect(r.truncated).toBe(true);
    expect(r.reason).toBe("time");
    expect(at(r.matches)).toEqual(["a.md:1:1"]);
    expect(r.filesScanned).toBe(1);
    expect(elapsed).toBeLessThan(3_000);
    expect(ticks).toBeGreaterThan(5);
  });

  test("a worker that fails to load rejects the call", async () => {
    const { deps } = vault({ "a.md": "N\n" });
    const url = new URL("../fixtures/grep/failing-worker.ts", import.meta.url).href;
    await expect(
      grep(deps, "v", { pattern: "N" }, { spawn: () => spawnGrepWorker(url) }),
    ).rejects.toThrow("failing worker");
  });

  test("attach: runs one scan per message and posts a scan failure as an error", async () => {
    const { root } = vault({ "a.md": "N\n" });
    const posted: WorkerMessage[] = [];
    let done = (): void => {};
    const finished = new Promise<void>((r) => {
      done = r;
    });
    const scope: WorkerScope = {
      onmessage: null,
      postMessage: (m) => {
        posted.push(m);
        if (m.type === "error" || m.done !== undefined) done();
      },
    };
    attach(scope);
    const params: ScanParams = {
      root,
      prefix: "",
      source: "N",
      flags: "u",
      limit: 10,
      context: 0,
      byteBudget: 1024,
      maxFileBytes: 1024,
    };
    scope.onmessage?.(new MessageEvent("message", { data: params }));
    await finished;
    expect(checkpoints(posted).flatMap((c) => c.matches)).toHaveLength(1);
    posted.length = 0;
    const failed = new Promise<void>((r) => {
      done = r;
    });
    scope.onmessage?.(new MessageEvent("message", { data: { ...params, source: "([" } }));
    await failed;
    expect(posted).toHaveLength(1);
    expect(posted[0]?.type).toBe("error");
  });
});

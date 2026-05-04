import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createLogger } from "../src/log.ts";

interface CapturedLine {
  ts: string;
  level: string;
  msg: string;
  [k: string]: unknown;
}

function captureLogger(level: "trace" | "debug" | "info" | "warn" | "error") {
  const lines: CapturedLine[] = [];
  const log = createLogger({
    level,
    write: (line: string) => {
      lines.push(JSON.parse(line) as CapturedLine);
    },
    now: () => new Date("2026-01-02T03:04:05.000Z"),
  });
  return { log, lines };
}

describe("createLogger — JSON shape", () => {
  test("emits ts, level, msg with no fields", () => {
    const { log, lines } = captureLogger("trace");
    log.info("hello");
    expect(lines).toHaveLength(1);
    expect(lines[0]).toEqual({
      ts: "2026-01-02T03:04:05.000Z",
      level: "info",
      msg: "hello",
    });
  });

  test("merges arbitrary fields", () => {
    const { log, lines } = captureLogger("trace");
    log.warn("oops", { vault: "v", count: 3, nested: { a: 1 } });
    expect(lines[0]).toMatchObject({
      level: "warn",
      msg: "oops",
      vault: "v",
      count: 3,
      nested: { a: 1 },
    });
  });

  test("reserved keys ts/level/msg cannot be overridden by fields", () => {
    const { log, lines } = captureLogger("trace");
    log.info("real", { ts: "fake", level: "fake", msg: "fake", other: 1 });
    expect(lines[0]?.ts).toBe("2026-01-02T03:04:05.000Z");
    expect(lines[0]?.level).toBe("info");
    expect(lines[0]?.msg).toBe("real");
    expect(lines[0]?.other).toBe(1);
  });
});

describe("createLogger — level filtering", () => {
  test("level=info drops trace and debug", () => {
    const { log, lines } = captureLogger("info");
    log.trace("t");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines.map((l) => l.level)).toEqual(["info", "warn", "error"]);
  });

  test("level=error drops everything below error", () => {
    const { log, lines } = captureLogger("error");
    log.trace("t");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
    expect(lines.map((l) => l.level)).toEqual(["error"]);
  });

  test("level=trace allows everything", () => {
    const { log, lines } = captureLogger("trace");
    log.trace("a");
    log.debug("b");
    log.info("c");
    log.warn("d");
    log.error("e");
    expect(lines).toHaveLength(5);
  });
});

describe("createLogger — defaults", () => {
  let originalWrite: typeof process.stdout.write;
  beforeEach(() => {
    originalWrite = process.stdout.write.bind(process.stdout);
  });
  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  test("default write goes to process.stdout with newline; default now is real Date", () => {
    const captured: string[] = [];
    // Override stdout for this test only — `mock` returns a chainable mock fn.
    process.stdout.write = mock((chunk: string | Uint8Array): boolean => {
      captured.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as unknown as typeof process.stdout.write;

    const log = createLogger({ level: "info" });
    log.info("hi", { k: "v" });

    expect(captured).toHaveLength(1);
    const line = captured[0] ?? "";
    expect(line.endsWith("\n")).toBe(true);
    const parsed = JSON.parse(line.trim()) as Record<string, unknown>;
    expect(parsed.msg).toBe("hi");
    expect(parsed.k).toBe("v");
    expect(typeof parsed.ts).toBe("string");
    // ISO 8601 sanity check.
    expect(Number.isNaN(Date.parse(parsed.ts as string))).toBe(false);
  });
});

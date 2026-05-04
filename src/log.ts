/**
 * Tiny Pino-shaped JSON logger.
 *
 * Writes one JSON object per line to stdout. Each line carries `ts` (ISO 8601),
 * `level`, `msg`, and any caller-supplied fields (merged shallowly, with
 * top-level keys reserved for our own).
 */

import type { LogLevel } from "./config/index.ts";

export type LogFields = Record<string, unknown>;

export interface Logger {
  trace(msg: string, fields?: LogFields): void;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

interface LoggerOptions {
  readonly level: LogLevel;
  readonly write?: (line: string) => void;
  readonly now?: () => Date;
}

const LEVEL_RANK: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

const LEVELS: readonly LogLevel[] = ["trace", "debug", "info", "warn", "error"];

function defaultWrite(line: string): void {
  // process.stdout.write keeps a single syscall per line and avoids console's
  // "second arg as inspect target" stringification.
  process.stdout.write(`${line}\n`);
}

export function createLogger(opts: LoggerOptions): Logger {
  const minRank = LEVEL_RANK[opts.level];
  const write = opts.write ?? defaultWrite;
  const now = opts.now ?? (() => new Date());

  function emit(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] < minRank) return;
    const base: Record<string, unknown> = {
      ts: now().toISOString(),
      level,
      msg,
    };
    if (fields !== undefined) {
      for (const [k, v] of Object.entries(fields)) {
        // Reserve the top-level keys we own.
        if (k === "ts" || k === "level" || k === "msg") continue;
        base[k] = v;
      }
    }
    write(JSON.stringify(base));
  }

  const logger: Logger = {
    trace: (msg, fields) => emit("trace", msg, fields),
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
  };
  return logger;
}

export const __testing = { LEVEL_RANK, LEVELS };

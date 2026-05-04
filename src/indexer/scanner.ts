/**
 * Initial-scan walker.
 *
 * Walks the vault root in async generator fashion (no whole-tree-in-memory
 * load) yielding every Markdown file. The pipeline consumes the iterator and
 * applies its own concurrency cap (default 4). For each file it computes the
 * sha256 once and compares against what the store already has — if they
 * match, the file is skipped (no embedder call).
 *
 * Ignore rules mirror the watcher: the same paths should be filtered in both
 * code paths so a file that the watcher would never report on `change` is
 * also never picked up by the scanner.
 *
 * The scan owns no state of its own: it's a pure async iterator over the
 * filesystem plus a `processFile` helper the pipeline injects.
 */

import { createHash } from "node:crypto";
import { type Dirent, readdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";

const MARKDOWN_RE = /\.(?:md|markdown)$/i;

export function shouldIgnorePath(relPath: string): boolean {
  // Treat any segment whose basename starts with `.` (covers `.obsidian`,
  // `.trash`, `.DS_Store`) as ignored — Obsidian's own conventions, plus
  // a defensive match for editor scratch directories.
  // sep is platform-aware; tests on Linux always use `/`.
  const parts = relPath.split(sep);
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p.startsWith(".")) return true;
    if (p === "node_modules") return true;
  }
  return false;
}

export function isMarkdownFile(relPath: string): boolean {
  return MARKDOWN_RE.test(relPath);
}

export interface ScannerFile {
  readonly absPath: string;
  readonly relPath: string;
}

/** Yield every Markdown file under `root`, recursively, post-ignore-filter. */
export function* walkVault(root: string): Generator<ScannerFile> {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // The dir disappeared between root listing and this read — fine,
      // just skip it. The watcher will catch any race.
      continue;
    }
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      const rel = relative(root, abs);
      if (shouldIgnorePath(rel)) continue;
      if (entry.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!isMarkdownFile(rel)) continue;
      yield { absPath: abs, relPath: rel.split(sep).join("/") };
    }
  }
}

/**
 * Called for each file. Receives the file's content + sha256. The pipeline
 * implementation typically does: short-circuit on `prevSha === sha`, else
 * chunk → embed → store.upsert.
 */
export type ScanProcessor = (file: ScannerFile, content: string, sha256: string) => Promise<void>;

export interface ScanFingerprint {
  readonly mtimeMs: number;
  readonly sha256: string;
}

export interface ScanOptions {
  readonly concurrency?: number;
  /**
   * Lookup of the most-recent indexed `(mtime_ms, sha256)` pair for a
   * path. Returning `undefined` means "never indexed" — process the
   * file. If the on-disk mtime equals the stored mtime, the scanner
   * skips read+hash entirely. Only when mtime differs does the scanner
   * read the file and compare sha256, the slower-but-content-precise
   * gate.
   */
  readonly lookupFingerprint?: (relPath: string) => Promise<ScanFingerprint | undefined>;
  /** Override for `node:fs/promises#stat` — tests inject a fake. */
  readonly statMtimeMs?: (absPath: string) => Promise<number>;
  /** Bun.file by default; tests inject a fake. */
  readonly readFile?: (absPath: string) => Promise<string>;
  /** Inject a sha computation override (default: node:crypto sha256 hex). */
  readonly sha256?: (content: string) => string;
}

const DEFAULT_CONCURRENCY = 4;

function defaultSha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function defaultStatMtime(absPath: string): Promise<number> {
  const st = await stat(absPath);
  return st.mtimeMs;
}

/**
 * Run the scan to completion. Returns a summary that tells the caller how
 * many files were skipped vs reprocessed — exposed for `IndexerStatus`.
 */
export interface ScanSummary {
  readonly scanned: number;
  readonly skipped: number;
  readonly errors: number;
}

export async function scanVault(
  root: string,
  processFile: ScanProcessor,
  opts: ScanOptions = {},
): Promise<ScanSummary> {
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const lookup = opts.lookupFingerprint ?? (async () => undefined);
  const statMtime = opts.statMtimeMs ?? defaultStatMtime;
  const read = opts.readFile ?? ((p) => readFile(p, "utf8"));
  const shaFn = opts.sha256 ?? defaultSha;

  const iterator = walkVault(root)[Symbol.iterator]();
  let scanned = 0;
  let skipped = 0;
  let errors = 0;

  async function worker(): Promise<void> {
    while (true) {
      const next = iterator.next();
      if (next.done === true) return;
      const file = next.value;
      try {
        const prev = await lookup(file.relPath);
        // Cheap mtime gate: if both mtimes match, treat the file as
        // unchanged without reading or hashing it. Per spec this is the
        // primary reason `/readyz` doesn't scale with vault size on a
        // restart with no changes.
        if (prev !== undefined) {
          let onDiskMtime: number | undefined;
          try {
            onDiskMtime = await statMtime(file.absPath);
          } catch {
            // Stat failure → fall through to the read+hash path; the
            // file may have just been deleted (the watcher will follow
            // up) or unreadable (counts as an error below).
          }
          if (onDiskMtime !== undefined && onDiskMtime === prev.mtimeMs) {
            skipped++;
            continue;
          }
        }
        const content = await read(file.absPath);
        const sha = shaFn(content);
        // Content gate: even if mtime differs (touch with no change), a
        // matching sha means we already have the right rows.
        if (prev !== undefined && prev.sha256 === sha) {
          skipped++;
          continue;
        }
        await processFile(file, content, sha);
        scanned++;
      } catch {
        errors++;
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
  return { scanned, skipped, errors };
}

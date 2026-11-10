/**
 * Initial-scan walker.
 *
 * Walks the vault root in async generator fashion (no whole-tree-in-memory
 * load) yielding every Markdown file. The pipeline consumes the iterator and
 * applies its own concurrency cap (default 4). For each file it computes the
 * sha256 once and compares against what the store already has — if they
 * match, the file is skipped (no embedder call).
 *
 * Ignore rules are the one indexable-path rule (`isIndexablePath`), shared
 * with the watcher, the pipeline, and every direct reindex: directories are
 * pruned by segment (hidden, `node_modules`) and never followed through a
 * symlink, and each file the walk yields is admitted only if
 * `isIndexablePath` holds for it on the real vault root at that moment.
 *
 * The scan owns no state of its own: it's a pure async iterator over the
 * filesystem plus a `processFile` helper the pipeline injects.
 */

import { createHash } from "node:crypto";
import { type Dirent, readdirSync } from "node:fs";
import { constants } from "node:fs";
import { lstat, open, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { assertSafeRelativePath } from "../errors.ts";

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

/**
 * The one indexable-path rule (Vault Indexer › Indexable paths): `rel` is a
 * vault-relative path, judged against the REAL vault root `root` — never a
 * scoped root, which is why service code reaches this only through
 * `Indexer.isIndexable`.
 *
 * Lexical half: a safe relative path (no `..`, no leading `/`, no NUL) with a
 * `.md` / `.markdown` extension in any case and no hidden or `node_modules`
 * segment — the same `shouldIgnorePath` + `isMarkdownFile` pair the scanner
 * already applies. Filesystem half: an `lstat` of every component from the
 * first segment down to the leaf, never following a link — each parent must
 * be a real directory, the leaf a regular file, and none of them a symlink.
 *
 * Any filesystem failure (the path vanished, a parent is a file, EACCES) is
 * "not indexable": the drop guard that calls this then drops the rows, which
 * is the direction that can never leave content indexed that is not there.
 */
export async function isIndexablePath(root: string, rel: string): Promise<boolean> {
  try {
    assertSafeRelativePath(rel);
  } catch {
    return false;
  }
  if (shouldIgnorePath(rel) || !isMarkdownFile(rel)) return false;
  const segments = rel.split("/").filter((seg) => seg !== "" && seg !== ".");
  let current = root;
  try {
    for (let i = 0; i < segments.length; i++) {
      current = join(current, segments[i] as string);
      const st = await lstat(current);
      const isLeaf = i === segments.length - 1;
      if (isLeaf ? !st.isFile() : !st.isDirectory()) return false;
    }
  } catch {
    return false;
  }
  return true;
}

/** The read found something that is not an indexable regular file. */
export class NotIndexableReadError extends Error {
  // biome-ignore lint/complexity/noUselessConstructor: explicit ctor needed for Bun coverage tracking.
  constructor(path: string) {
    super(path);
  }
}

/**
 * A read failure that means "nothing indexable is there" rather than a
 * fault: the file is gone (`ENOENT`), a parent stopped being a directory
 * (`ENOTDIR`), the leaf is a symlink (`ELOOP` from `O_NOFOLLOW`), or it is
 * not a regular file.
 */
export function isNotIndexableRead(e: unknown): boolean {
  if (e instanceof NotIndexableReadError) return true;
  const code = (e as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

/**
 * Read a file as UTF-8 through a descriptor opened with `O_NOFOLLOW`, after
 * an `fstat` confirmed a regular file, so a leaf swapped for a symlink is
 * never followed and a non-file is never read.
 */
export async function readRegularNoFollow(absPath: string): Promise<string> {
  const handle = await open(absPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new NotIndexableReadError(absPath);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * The content of `rel` if it is indexable right now, else `null`: the
 * rule's parent-chain check (`isIndexablePath`) immediately followed by the
 * no-follow read. This is the one way the indexer reads note content
 * (the scan here, the pipeline through the same two steps).
 */
export async function readIndexable(root: string, rel: string): Promise<string | null> {
  try {
    if (!(await isIndexablePath(root, rel))) return null;
    return await readRegularNoFollow(join(root, rel));
  } catch (e) {
    if (isNotIndexableRead(e)) return null;
    throw e;
  }
}

export interface ScannerFile {
  readonly absPath: string;
  readonly relPath: string;
}

/**
 * Yield every file under `root` that passes the LEXICAL half of the
 * indexable-path rule, recursively. Directories are pruned by segment, and a
 * symlink `Dirent` is neither a file nor a directory, so nothing is reached
 * through a link. `scanVault` applies the full `isIndexablePath` to each
 * yielded file before it is processed.
 */
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
  /**
   * Read a file's content; `null` skips it. Default: `readIndexable` — the
   * chain check immediately followed by an `O_NOFOLLOW` regular-file read,
   * so a leaf or parent swapped for a symlink after the walk is never
   * followed. Tests inject a fake.
   */
  readonly readFile?: (absPath: string) => Promise<string | null>;
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
  const read =
    opts.readFile ?? ((abs) => readIndexable(root, relative(root, abs).split(sep).join("/")));
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
        // The full rule, filesystem half included, at the moment of the scan.
        if (!(await isIndexablePath(root, file.relPath))) continue;
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
        // No longer an indexable regular file (swapped, gone): not read, not processed.
        if (content === null) continue;
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

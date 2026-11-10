/**
 * Pipeline: file event → batched embed → store.upsert.
 *
 * The watcher and the initial scanner both feed this pipeline, so the same
 * batching policy applies regardless of source. The spec calls for chunks
 * arriving within a 100 ms window to coalesce into a single `embed()` call,
 * up to 32 chunks per call. `EmbedBatcher` implements that coalescing as a
 * small async aggregator the per-file `upsert` calls submit chunks into;
 * the next `embedder.embed()` call covers everything queued in the same
 * window.
 *
 * Errors per file are counted in `IndexerStatus.errors` and logged, and the
 * call that hit them REJECTS (Vault Indexer › Public surface: `reindex` must
 * reject when the rows could not be brought to the file's content). One bad
 * file still never halts the pipeline: the watcher and the initial scan
 * catch the rejection and carry on. LanceDB write errors retry 3× with
 * linear backoff before being surfaced.
 *
 * Indexable paths. With `root` set (production always sets it), `upsert`
 * re-checks the one indexable-path rule (`isIndexablePath`: chain `lstat`,
 * no symlink, a regular Markdown file outside hidden and `node_modules`
 * segments) immediately before reading, and reads with `O_NOFOLLOW` plus an
 * `fstat` regular-file check. A path that fails — or that is gone — has its
 * rows dropped instead and resolves `{ indexed: false }`, so no route into
 * the index admits a path another route would refuse.
 *
 * A per-path mutex (`pathLocks`) serialises writes for the same file so a
 * stale scan write that resolved after a watcher write can't overwrite the
 * fresher content. The mutex only re-orders work; if both writes are valid
 * the second one wins because it observes the freshest sha at the lock
 * acquisition point.
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import type { Embedder } from "../embeddings/index.ts";
import type { Logger } from "../log.ts";
import { type Chunk, chunkMarkdown } from "./chunker.ts";
import { isIndexablePath } from "./scanner.ts";
import type { PathFingerprint, StoreRow, VaultStore } from "./store.ts";

export interface PipelineCounters {
  errors: number;
  /** Set of paths that currently have at least one chunk in the store. */
  documents: Set<string>;
  /** Total chunks across `documents`. */
  chunks: number;
  lastIndexedAt: number | null;
}

export interface PipelineDeps {
  readonly slug: string;
  readonly store: VaultStore;
  readonly embedder: Embedder;
  readonly logger: Logger;
  /**
   * The REAL vault root. When set, every upsert re-checks `isIndexablePath`
   * on it immediately before reading. Production always sets it; pipeline
   * unit tests that feed content from memory leave it out.
   */
  readonly root?: string;
  /**
   * Read the file as UTF-8. Default: an `O_NOFOLLOW` open plus an `fstat`
   * regular-file check, so a leaf swapped for a symlink is never read.
   */
  readonly readFile?: (p: string) => Promise<string>;
  /** Resolve a file's mtimeMs. Default: `node:fs/promises#stat`. */
  readonly statMtimeMs?: (p: string) => Promise<number>;
  /** sha256-hex of the file contents. */
  readonly sha256?: (content: string) => string;
  /** Wall-clock for `lastIndexedAt`. */
  readonly now?: () => number;
}

const STORE_RETRY_MAX = 3;
const STORE_RETRY_BASE_MS = 200;

/** Default coalescing window — spec calls for 100 ms. */
export const EMBED_BATCH_WINDOW_MS = 100;
/** Default per-call chunk cap — spec calls for 32. */
export const EMBED_BATCH_MAX_CHUNKS = 32;

function defaultSha(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** The read found something that is not an indexable regular file. */
class NotIndexableReadError extends Error {
  // biome-ignore lint/complexity/noUselessConstructor: explicit ctor needed for Bun coverage tracking.
  constructor(path: string) {
    super(path);
  }
}

async function defaultReadFile(p: string): Promise<string> {
  const handle = await open(p, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new NotIndexableReadError(p);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * A read failure that means "nothing indexable is there" rather than a
 * fault: the file is gone (`ENOENT`), a parent stopped being a directory
 * (`ENOTDIR`), the leaf is a symlink (`ELOOP` from `O_NOFOLLOW`), or it is
 * not a regular file. Such a path has its rows dropped, never counted as an
 * error.
 */
function isNotIndexableRead(e: unknown): boolean {
  if (e instanceof NotIndexableReadError) return true;
  const code = (e as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

async function defaultStatMtime(p: string): Promise<number> {
  const st = await stat(p);
  return st.mtimeMs;
}

/**
 * Linear-backoff retry for LanceDB writes. Capped at 3 attempts per the
 * spec; on persistent failure the caller increments
 * `IndexerStatus.errors` and continues.
 */
async function withStoreRetry<T>(
  fn: () => Promise<T>,
  sleep: (ms: number) => Promise<void>,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < STORE_RETRY_MAX; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (attempt < STORE_RETRY_MAX - 1) {
        await sleep(STORE_RETRY_BASE_MS * (attempt + 1));
      }
    }
  }
  throw lastErr;
}

/** Options for a drop. */
export interface DropOptions {
  /** Keep the rows if an indexable note exists at the path when the drop runs. */
  readonly unlessIndexable?: boolean;
}

/** Outcome of an upsert: `indexed: false` means not indexable, rows dropped. */
export interface UpsertResult {
  readonly indexed: boolean;
}

export interface Pipeline {
  /**
   * Bring `relPath`'s rows to its current content: index an indexable file,
   * drop the rows of anything else. Rejects (after counting the error) when
   * a read, chunk, embed, or store step fails.
   */
  upsert(absPath: string, relPath: string): Promise<UpsertResult>;
  /**
   * Drop a file's chunks. Rejects on a store failure. With
   * `unlessIndexable`, the indexable-path rule is re-checked under the
   * path's lock first and the rows are kept if an indexable note is there
   * (the drop guard, atomic with every other pipeline write to the path).
   */
  remove(relPath: string, opts?: DropOptions): Promise<void>;
  /** Counter snapshot for `IndexerStatus`. */
  readonly counters: PipelineCounters;
  /**
   * Cooperative cancellation. After `markStopped()`, any in-flight upsert
   * that hasn't yet committed to the store will short-circuit and return
   * without writing. New calls also short-circuit. Promises in flight
   * still resolve so callers can `Promise.allSettled` them during
   * shutdown.
   */
  markStopped(): void;
  /**
   * Initialise counters from the store's persisted fingerprints. Called
   * once at indexer startup so a fully-indexed vault doesn't report
   * `documents=0 / chunks=0` after restart.
   */
  hydrateCounters(): Promise<void>;
}

export interface BuildPipelineOptions {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly batchWindowMs?: number;
  readonly batchMaxChunks?: number;
}

interface QueuedEmbed {
  readonly chunks: readonly Chunk[];
  resolve(vectors: Float32Array[]): void;
  reject(err: unknown): void;
}

/**
 * Coalescing batcher in front of the embedder. Per spec: chunks arriving
 * within `windowMs` (default 100 ms) coalesce into one `embed()` call;
 * any individual submission that would push the queued chunk total over
 * `maxChunks` (default 32) flushes immediately.
 */
export class EmbedBatcher {
  private readonly embedder: Embedder;
  private readonly windowMs: number;
  private readonly maxChunks: number;
  private queue: QueuedEmbed[] = [];
  private queuedChunks = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushing = false;

  constructor(embedder: Embedder, windowMs: number, maxChunks: number) {
    this.embedder = embedder;
    this.windowMs = windowMs;
    this.maxChunks = maxChunks;
  }

  /** Submit one file's chunks; resolves with the matching vectors. */
  submit(chunks: readonly Chunk[]): Promise<Float32Array[]> {
    if (chunks.length === 0) return Promise.resolve([]);
    return new Promise<Float32Array[]>((resolve, reject) => {
      this.queue.push({ chunks, resolve, reject });
      this.queuedChunks += chunks.length;
      if (this.queuedChunks >= this.maxChunks) {
        // Cap reached — flush now (drop the timer if pending).
        if (this.timer !== null) {
          clearTimeout(this.timer);
          this.timer = null;
        }
        void this.flush();
      } else if (this.timer === null) {
        this.armTimer();
      }
    });
  }

  /** Schedule a flush for after `windowMs`. Idempotent — caller checks. */
  private armTimer(): void {
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.windowMs);
  }

  /** Force-flush the pending queue. Used during shutdown. */
  async drain(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.flush();
  }

  private async flush(): Promise<void> {
    // Re-entrancy guard: if a timer fires while we're already flushing,
    // wait for the in-flight call to settle before processing the new
    // batch — the new batch will be queued for the next round trip.
    if (this.flushing) return;
    if (this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue;
    this.queue = [];
    this.queuedChunks = 0;
    try {
      const allTexts: string[] = [];
      for (const item of batch) {
        // Per change 0007: the embedder sees `embedText` (path + heading +
        // body), not the raw body. Display `text` is unchanged so REST/MCP
        // search snippets stay clean.
        for (const c of item.chunks) allTexts.push(c.embedText);
      }
      const vectors = await this.embedder.embed(allTexts);
      // Slice the result back to per-submission vectors. The embedder
      // contract is "one vector per input, in order".
      let cursor = 0;
      for (const item of batch) {
        const slice = vectors.slice(cursor, cursor + item.chunks.length);
        cursor += item.chunks.length;
        item.resolve(slice);
      }
    } catch (e) {
      for (const item of batch) item.reject(e);
    } finally {
      this.flushing = false;
      // If a new submission landed during the flush, kick the timer.
      if (this.queue.length > 0 && this.timer === null) {
        this.armTimer();
      }
    }
  }
}

/**
 * Per-path serialisation helper. Returns a promise that resolves with the
 * caller's result; the next caller for the same path queues behind it.
 */
/**
 * Per-path serialisation. Each `runLocked(path, tails, fn)` waits for the
 * previous caller for the same `path` to settle before invoking `fn`. We
 * use `await` rather than chained `.then` so the rejection-tolerance and
 * scheduling are obvious top-to-bottom.
 *
 * Implemented as a free function rather than a class to keep the
 * function-coverage surface tight: the implicit class constructor would
 * otherwise show up as an uncalled function in the per-file coverage
 * report.
 */
async function runLocked<T>(
  path: string,
  tails: Map<string, Promise<unknown>>,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = tails.get(path);
  let resolveTail!: () => void;
  const tail = new Promise<void>((r) => {
    resolveTail = r;
  });
  tails.set(path, tail);
  if (prev !== undefined) {
    try {
      await prev;
    } catch {
      // Intentionally swallowed — failed predecessors must not poison
      // the chain.
    }
  }
  try {
    return await fn();
  } finally {
    resolveTail();
    if (tails.get(path) === tail) tails.delete(path);
  }
}

/** Build the pipeline. Caller owns the deps' lifetimes (store/embedder/etc.). */
export function buildPipeline(deps: PipelineDeps, opts: BuildPipelineOptions = {}): Pipeline {
  const read = deps.readFile ?? defaultReadFile;
  const statMtime = deps.statMtimeMs ?? defaultStatMtime;
  const shaFn = deps.sha256 ?? defaultSha;
  const now = deps.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const windowMs = opts.batchWindowMs ?? EMBED_BATCH_WINDOW_MS;
  const maxChunks = opts.batchMaxChunks ?? EMBED_BATCH_MAX_CHUNKS;

  const counters: PipelineCounters = {
    errors: 0,
    chunks: 0,
    documents: new Set<string>(),
    lastIndexedAt: null,
  };

  const batcher = new EmbedBatcher(deps.embedder, windowMs, maxChunks);
  const lockTails = new Map<string, Promise<unknown>>();
  let stopped = false;

  /**
   * Recompute `chunks` from the store after a write so the count tracks
   * the persisted state — callers see the same number a fresh restart
   * would observe.
   */
  async function refreshChunkCount(): Promise<void> {
    try {
      counters.chunks = await deps.store.chunkCount();
    } catch {
      // Best-effort. A failed countRows() doesn't change correctness
      // since the next successful write will refresh it.
    }
  }

  /** Count, log, and rethrow: the caller's promise rejects with the cause. */
  function fail(msg: string, relPath: string, e: unknown, level: "warn" | "error" = "warn"): never {
    counters.errors++;
    deps.logger[level](msg, {
      vault: deps.slug,
      path: relPath,
      error: e instanceof Error ? e.message : String(e),
    });
    throw e;
  }

  /** The file's content, or `null` when nothing indexable is at the path. */
  async function readIndexable(absPath: string, relPath: string): Promise<string | null> {
    try {
      // Re-checked immediately before the read, on the real vault root.
      if (deps.root !== undefined && !(await isIndexablePath(deps.root, relPath))) return null;
      return await read(absPath);
    } catch (e) {
      if (isNotIndexableRead(e)) return null;
      return fail("indexer: read failed", relPath, e);
    }
  }

  const removeImpl = async (relPath: string): Promise<void> => {
    if (stopped) return;
    try {
      await withStoreRetry(() => deps.store.drop(relPath), sleep);
    } catch (e) {
      fail("indexer: store.drop failed after retries", relPath, e, "error");
    }
    counters.documents.delete(relPath);
    await refreshChunkCount();
    counters.lastIndexedAt = now();
  };

  const upsertImpl = async (absPath: string, relPath: string): Promise<UpsertResult> => {
    if (stopped) return { indexed: false };
    const content = await readIndexable(absPath, relPath);
    if (content === null) {
      // Not indexable (or gone): whatever rows the path still holds go.
      await removeImpl(relPath);
      return { indexed: false };
    }
    if (stopped) return { indexed: false };
    const sha = shaFn(content);
    let mtimeMs: number;
    try {
      mtimeMs = await statMtime(absPath);
    } catch {
      // If stat fails (file just deleted, EACCES) fall back to wall
      // clock — the row is still useful, just less precise for the
      // mtime gate. The watcher will catch up on the next change.
      mtimeMs = now();
    }
    let chunks: Chunk[];
    try {
      chunks = chunkMarkdown(content, relPath);
    } catch (e) {
      return fail("indexer: chunker failed", relPath, e);
    }
    if (stopped) return { indexed: false };
    let vectors: Float32Array[];
    try {
      vectors = await batcher.submit(chunks);
    } catch (e) {
      return fail("indexer: embed failed", relPath, e);
    }
    if (stopped) return { indexed: false };
    // Freshness re-check: between the time we hashed `content` and the
    // time we acquired the lock + finished embedding, another writer
    // (scan or watcher) may have already persisted a newer version. If
    // the store now reports a fingerprint that is not ours, drop the
    // stale write — the rows already reflect newer content.
    try {
      const fp = await deps.store.fingerprint(relPath);
      if (fp !== undefined && fp.sha256 !== sha && fp.mtimeMs > mtimeMs) {
        // The newer write already happened. Skip — committing here would
        // overwrite fresher content with our stale chunks.
        return { indexed: true };
      }
    } catch {
      // Fingerprint lookup is a best-effort optimisation; on failure,
      // proceed with the upsert so we don't drop work silently.
    }
    const rows: StoreRow[] = chunks.map((c, i) => ({
      path: relPath,
      chunkIndex: c.index,
      headingPath: c.headingPath,
      text: c.text,
      embedText: c.embedText,
      frontmatter: c.frontmatter,
      links: c.links,
      tags: c.tags,
      mtimeMs,
      sha256: sha,
      // The embedder MUST return one vector per chunk in the same order.
      // If a buggy embedder returns fewer, we fall back to a zero vector
      // so the row still goes in (better than dropping the file).
      vector: vectors[i] ?? new Float32Array(deps.embedder.dim),
    }));
    try {
      await withStoreRetry(() => deps.store.upsert(relPath, rows), sleep);
    } catch (e) {
      fail("indexer: store.upsert failed after retries", relPath, e, "error");
    }
    counters.documents.add(relPath);
    await refreshChunkCount();
    counters.lastIndexedAt = now();
    return { indexed: true };
  };

  const upsert = (absPath: string, relPath: string): Promise<UpsertResult> =>
    runLocked(relPath, lockTails, () => upsertImpl(absPath, relPath));
  const remove = (relPath: string, opts: DropOptions = {}): Promise<void> =>
    runLocked(relPath, lockTails, async () => {
      // The guard's check runs under the same per-path lock as every upsert,
      // so a writer's fresh rows can never be dropped by a stale decision.
      const keep =
        opts.unlessIndexable === true &&
        deps.root !== undefined &&
        (await isIndexablePath(deps.root, relPath));
      if (!keep) await removeImpl(relPath);
    });

  return {
    upsert,
    remove,
    counters,
    markStopped(): void {
      stopped = true;
      // Drain the batcher so any pending submissions either resolve or
      // reject; without this, the embed `submit()` promises would hang
      // forever on shutdown.
      void batcher.drain();
    },
    async hydrateCounters(): Promise<void> {
      try {
        const fps = await deps.store.fingerprints();
        counters.documents = new Set(fps.keys());
        counters.chunks = await deps.store.chunkCount();
      } catch {
        // First-run / new vault: store is empty, leave counters at 0.
      }
    },
  };
}

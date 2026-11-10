/**
 * Indexer facade.
 *
 * `startIndexer` opens one LanceDB table per configured vault, kicks off the
 * initial scan, and starts a chokidar watcher feeding the same pipeline. The
 * returned `Indexer` is the surface the HTTP/MCP layers depend on:
 *
 *   - `status(slug)` / `list()` — readiness & counters for `/readyz` &
 *     `/metrics`. Counters are hydrated from the persisted store on startup
 *     so a restart with no fs changes still reports the right document /
 *     chunk totals.
 *   - `search(slug, query, opts)` — embed query → vector search.
 *   - `tags(slug, opts)` — stored inline tags with distinct-document
 *     counts, for `GET /v1/vaults/:slug/tags` and `list_tags`.
 *   - `reindex(slug, path)` / `drop(slug, path)` — REST hooks bypassing the
 *     watcher debounce when the API itself is the writer. Both validate
 *     `path` via `assertSafeRelativePath` (rejects `..`, hidden segments,
 *     leading `/`, NUL bytes, etc.) before touching the filesystem.
 *   - `indexedPaths(slug, prefix)` — the distinct indexed paths under a
 *     literal prefix, so a recursive folder delete can drop every row under
 *     the folder, including rows for notes it never saw on disk.
 *   - `isIndexable(slug, path)` — `isIndexablePath` evaluated on the REAL
 *     vault root, the drop guard's question. Service code never evaluates the
 *     predicate against its own (possibly scoped) root.
 *   - `stop()` — idempotent; flips a stopped flag, drains in-flight
 *     pipeline work, then closes watchers + stores. The whole sequence is
 *     bounded by `STOP_TIMEOUT_MS` so a hung scan can't strand shutdown.
 *
 * The dimension-mismatch contract is enforced before opening any table: we
 * warm the embedder with a sentinel embed (`""`-equivalent) so its `dim`
 * getter is populated, then `openVaultStore` compares against the on-disk
 * schema and throws `StoreDimensionMismatchError` (whose message contains
 * BOTH dims, per spec). If the open of vault N fails after vault 1..N-1
 * already started their watchers, those earlier vaults' resources are
 * cleaned up via `Promise.allSettled` before re-throwing.
 */

import { join } from "node:path";
import type { Config, VaultConfig } from "../config/index.ts";
import { type Embedder, buildEmbedder } from "../embeddings/index.ts";
import { assertSafeRelativePath } from "../errors.ts";
import type { Logger } from "../log.ts";
import { type Pipeline, buildPipeline } from "./pipeline.ts";
import {
  DEFAULT_LAMBDA,
  DEFAULT_MAX_PER_PATH,
  DEFAULT_THRESHOLD,
  applyMmr,
  applyThreshold,
} from "./rank.ts";
import { isIndexablePath, scanVault } from "./scanner.ts";
import {
  type SearchHit,
  type SearchMode,
  StoreDimensionMismatchError,
  type VaultStore,
  openVaultStore,
  reconcilePipelineVersion,
} from "./store.ts";
import { type WatcherHandle, startWatcher } from "./watcher.ts";

export type IndexerState = "starting" | "scanning" | "ready" | "failed";

export interface IndexerStatus {
  readonly slug: string;
  readonly state: IndexerState;
  readonly documents: number;
  readonly chunks: number;
  readonly lastIndexedAt: number | null;
  readonly pending: number;
  readonly errors: number;
}

export interface SearchOptions {
  readonly limit?: number;
  readonly filter?: { readonly tag?: string; readonly pathPrefix?: string };
  /** Retrieval mode — `"hybrid"` (default), `"vector"`, or `"fts"`. */
  readonly mode?: SearchMode;
  /** Drop hits with score below this floor in `[0, 1]`. Default `0`. */
  readonly threshold?: number;
  /** MMR mixing constant in `[0, 1]`. Default `0.5`. */
  readonly mmrLambda?: number;
  /** Cap on returned hits per `path`. Default `3`. */
  readonly maxPerPath?: number;
}

export interface TagListingOptions {
  /** Count only documents whose path starts with this literal prefix. */
  readonly pathPrefix?: string;
  /** Maximum items returned, 1–1000. Default `DEFAULT_TAG_LIMIT`. */
  readonly limit?: number;
}

export interface TagListing {
  readonly items: { readonly tag: string; readonly count: number }[];
  /** Distinct tags before `limit` was applied. */
  readonly total: number;
}

/** Default `limit` for `Indexer.tags`. */
export const DEFAULT_TAG_LIMIT = 100;

export interface Indexer {
  status(slug: string): IndexerStatus | null;
  list(): IndexerStatus[];
  search(slug: string, query: string, opts?: SearchOptions): Promise<SearchHit[]>;
  reindex(slug: string, path: string): Promise<void>;
  drop(slug: string, path: string): Promise<void>;
  /**
   * Stored inline tags with distinct-document counts, ordered by count
   * descending then tag in code-point order. An unknown slug yields an
   * empty listing, as `search` yields no hits; the service core turns it
   * into `vault_not_found`.
   */
  tags(slug: string, opts?: TagListingOptions): Promise<TagListing>;
  /** Distinct indexed paths starting with the literal `prefix`; `[]` for an unknown vault. */
  indexedPaths(slug: string, prefix: string): Promise<string[]>;
  /** `isIndexablePath` on the real vault root; `false` for an unknown vault. */
  isIndexable(slug: string, path: string): Promise<boolean>;
  stop(): Promise<void>;
}

/**
 * Order two strings by Unicode code point. Plain `<` compares UTF-16 code
 * units, which puts an astral character (a surrogate pair, U+D800..) before
 * a BMP character above the surrogate range such as U+FF01.
 */
export function compareCodePoints(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(i) as number;
    if (ca !== cb) return ca - cb;
    // Equal code points have equal UTF-16 widths, so one index serves both.
    i += ca > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}

export interface IndexerDeps {
  readonly logger: Logger;
  /** Override the embedder factory — tests inject a fake. */
  readonly embedder?: Embedder;
  /** Override the store opener — tests inject a fake or a stub LanceDB. */
  readonly openStore?: (cfg: Config, vault: VaultConfig, dim: number) => Promise<VaultStore>;
  /** Override the watcher factory — tests inject a fake. */
  readonly startWatcher?: typeof startWatcher;
  /** Override `scanVault` — tests bypass the real fs walker. */
  readonly scanVault?: typeof scanVault;
  /** Override pipeline builder — used by the round-trip integration test. */
  readonly buildPipeline?: typeof buildPipeline;
  /** Inject a wall-clock for `lastIndexedAt`. */
  readonly now?: () => number;
  /** Override the per-vault stop timeout (default 10s). */
  readonly stopTimeoutMs?: number;
}

interface VaultRuntime {
  readonly slug: string;
  state: IndexerState;
  pending: number;
  readonly store: VaultStore;
  readonly pipeline: Pipeline;
  readonly watcher: WatcherHandle;
  /** Tracks every in-flight pipeline op so `stop()` can drain them. */
  readonly inFlight: Set<Promise<unknown>>;
  readyPromise: Promise<void>;
}

/**
 * Sentinel string used to warm the embedder before we open the LanceDB
 * tables. We need `embedder.dim` to be a real number for the dim-mismatch
 * check, and the easiest way to populate it is to do exactly one embed.
 */
const WARMUP_TEXT = "ob:embedder-dim-warmup";

/** Default per-vault stop timeout. Same budget as the server's shutdown. */
export const DEFAULT_STOP_TIMEOUT_MS = 10_000;

async function warmEmbedder(embedder: Embedder): Promise<number> {
  if (embedder.dim > 0) return embedder.dim;
  await embedder.embed([WARMUP_TEXT]);
  return embedder.dim;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function startIndexer(cfg: Config, deps: IndexerDeps): Promise<Indexer> {
  const log = deps.logger;
  // Embedder init and warmup MUST happen before pipeline-version
  // reconciliation. Reconciliation drops per-vault tables and bumps the
  // sidecar; if it ran first and embedder construction (or the warmup
  // probe) then failed, an older binary could no longer roll back —
  // the sidecar would already advertise the newer corpus shape. By
  // proving the embedder works first, we only commit to the destructive
  // rebuild once the rest of startup is plausibly going to succeed.
  const embedder = deps.embedder ?? buildEmbedder(cfg);
  const dim = await warmEmbedder(embedder);
  // Reconcile the pipeline-version sidecar BEFORE opening any per-vault
  // store: a sidecar bump from N → N+1 must drop every existing table so
  // the initial scanner re-chunks and re-embeds against the new corpus
  // shape. A sidecar that's *newer* than the binary errors out before we
  // touch any rows — the operator is running an older binary against a
  // newer data dir, and proceeding would corrupt their index.
  await reconcilePipelineVersion({
    dataDir: cfg.dataDir,
    slugs: cfg.vaults.map((v) => v.slug),
    logger: log,
  });
  const stopTimeoutMs = deps.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;

  const openStore =
    deps.openStore ??
    ((c, v, d): Promise<VaultStore> =>
      openVaultStore({ dataDir: c.dataDir, slug: v.slug, dim: d }));
  const startWatcherImpl = deps.startWatcher ?? startWatcher;
  const scanVaultImpl = deps.scanVault ?? scanVault;
  const buildPipelineImpl = deps.buildPipeline ?? buildPipeline;

  const runtimes = new Map<string, VaultRuntime>();
  const started: VaultRuntime[] = [];

  /**
   * Roll back partially-initialised vaults. Used both by the per-vault
   * init failure path and by the post-hoc `stop()` flow.
   */
  const teardownAll = async (): Promise<void> => {
    await Promise.allSettled(
      started.map(async (rt) => {
        rt.pipeline.markStopped();
        await rt.watcher.stop().catch(() => undefined);
        await Promise.allSettled(Array.from(rt.inFlight));
        try {
          rt.store.close();
        } catch {
          // store.close() is best-effort during teardown; LanceDB
          // sometimes throws if the table was never opened.
        }
      }),
    );
  };

  try {
    for (const vault of cfg.vaults) {
      const store = await openStore(cfg, vault, dim);

      const pipeline = buildPipelineImpl({
        slug: vault.slug,
        store,
        embedder,
        logger: log,
        ...(deps.now !== undefined ? { now: deps.now } : {}),
      });

      const root = join(cfg.dataDir, "vaults", vault.slug);
      const inFlight = new Set<Promise<unknown>>();

      const trackInFlight = (p: Promise<unknown>): Promise<unknown> => {
        inFlight.add(p);
        const settled = p.finally(() => {
          inFlight.delete(settled);
        });
        return settled;
      };

      // Pre-declare runtime so the watcher onEvent closure can refer to
      // `runtime` by reference (state mutation happens through the
      // closure, not via early binding).
      const runtime: VaultRuntime = {
        slug: vault.slug,
        state: "starting",
        pending: 0,
        store,
        pipeline,
        watcher: undefined as unknown as WatcherHandle,
        inFlight,
        readyPromise: undefined as unknown as Promise<void>,
      };

      // Watcher is started *before* the initial scan so we don't race with
      // a write that lands mid-scan. Its `ignoreInitial: true` config
      // means the scan still owns the first traversal.
      const watcher = startWatcherImpl(
        root,
        (ev) => {
          runtime.pending++;
          const task =
            ev.kind === "upsert"
              ? pipeline.upsert(ev.absPath, ev.relPath)
              : pipeline.remove(ev.relPath);
          trackInFlight(task).finally(() => {
            runtime.pending = Math.max(0, runtime.pending - 1);
          });
        },
        { logger: log },
      );
      (runtime as { watcher: WatcherHandle }).watcher = watcher;

      // Hydrate counters from persisted rows BEFORE the scan starts so
      // /readyz and /metrics report the real totals immediately on a
      // restart (otherwise they'd briefly read 0 documents / 0 chunks).
      await pipeline.hydrateCounters();

      runtime.readyPromise = (async (): Promise<void> => {
        try {
          await runtime.watcher.ready();
          runtime.state = "scanning";
          await scanVaultImpl(
            root,
            async (file, _content, _sha) => {
              // Submit the file to the pipeline. Track the promise so
              // stop() can drain in-flight scan writes alongside watcher
              // events. Errors are swallowed by the pipeline itself; the
              // scanner only counts errors that happen during its own
              // read/hash phase.
              await trackInFlight(pipeline.upsert(file.absPath, file.relPath));
            },
            {
              // Cheap mtime gate first; the pipeline's freshness re-check
              // covers the case where mtime changed but content didn't.
              lookupFingerprint: (relPath) => store.fingerprint(relPath),
            },
          );
          runtime.state = "ready";
        } catch (e) {
          runtime.state = "failed";
          log.error("indexer: scan failed", {
            vault: vault.slug,
            error: e instanceof Error ? e.message : String(e),
          });
        }
      })();
      runtimes.set(vault.slug, runtime);
      started.push(runtime);
    }
  } catch (e) {
    // Roll back anything that already started — we never want to leak a
    // chokidar watcher or a LanceDB handle on partial init failure.
    await teardownAll();
    throw e;
  }

  function snapshot(rt: VaultRuntime): IndexerStatus {
    return {
      slug: rt.slug,
      state: rt.state,
      documents: rt.pipeline.counters.documents.size,
      chunks: rt.pipeline.counters.chunks,
      lastIndexedAt: rt.pipeline.counters.lastIndexedAt,
      pending: rt.pending,
      errors: rt.pipeline.counters.errors,
    };
  }

  /**
   * Resolve `(slug, relPath)` to an absolute path inside the configured
   * vault root. Throws `InvalidPathError` for any traversal-unsafe input.
   */
  function resolveVaultPath(slug: string, relPath: string): { abs: string; rel: string } {
    const safe = assertSafeRelativePath(relPath);
    const root = join(cfg.dataDir, "vaults", slug);
    return { abs: join(root, safe), rel: safe };
  }

  let stopPromise: Promise<void> | undefined;

  const indexer: Indexer = {
    status(slug: string): IndexerStatus | null {
      const rt = runtimes.get(slug);
      return rt === undefined ? null : snapshot(rt);
    },
    list(): IndexerStatus[] {
      return Array.from(runtimes.values(), snapshot);
    },
    async search(slug: string, query: string, opts: SearchOptions = {}): Promise<SearchHit[]> {
      const rt = runtimes.get(slug);
      if (rt === undefined) return [];
      const [vec] = await embedder.embed([query]);
      if (vec === undefined) return [];
      const limit = opts.limit ?? 20;
      const mode = opts.mode ?? "hybrid";
      const lambda = opts.mmrLambda ?? DEFAULT_LAMBDA;
      const maxPerPath = opts.maxPerPath ?? DEFAULT_MAX_PER_PATH;
      const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
      // Fetch a wider candidate pool so MMR has room to diversify; the
      // store wraps `max(60, 3 × limit)` itself, but we mirror the
      // formula here so K passed to MMR matches.
      const topK = Math.max(60, 3 * limit);
      // `searchHybrid` returns hits already scored in (0, 1]. We then
      // apply MMR (over top K) → threshold → cut to limit, per the spec
      // ordering.
      const fused = await rt.store.searchHybrid(vec, query, {
        limit,
        mode,
        perArmCandidates: topK,
        ...(opts.filter !== undefined ? { filter: opts.filter } : {}),
      });
      const diversified = applyMmr(fused, { lambda, maxPerPath, topK });
      const filtered = applyThreshold(diversified, threshold);
      return filtered.slice(0, limit);
    },
    async reindex(slug: string, path: string): Promise<void> {
      const rt = runtimes.get(slug);
      if (rt === undefined) return;
      const { abs, rel } = resolveVaultPath(slug, path);
      await rt.pipeline.upsert(abs, rel);
    },
    async drop(slug: string, path: string): Promise<void> {
      const rt = runtimes.get(slug);
      if (rt === undefined) return;
      const { rel } = resolveVaultPath(slug, path);
      await rt.pipeline.remove(rel);
    },
    async tags(slug: string, opts: TagListingOptions = {}): Promise<TagListing> {
      const rt = runtimes.get(slug);
      if (rt === undefined) return { items: [], total: 0 };
      const counts = await rt.store.tagCounts(opts.pathPrefix);
      const items = Array.from(counts, ([tag, count]) => ({ tag, count }));
      items.sort((a, b) => b.count - a.count || compareCodePoints(a.tag, b.tag));
      return { items: items.slice(0, opts.limit ?? DEFAULT_TAG_LIMIT), total: items.length };
    },
    async indexedPaths(slug: string, prefix: string): Promise<string[]> {
      const rt = runtimes.get(slug);
      if (rt === undefined) return [];
      return rt.store.indexedPaths(prefix);
    },
    async isIndexable(slug: string, path: string): Promise<boolean> {
      if (!runtimes.has(slug)) return false;
      return isIndexablePath(join(cfg.dataDir, "vaults", slug), path);
    },
    stop(): Promise<void> {
      if (stopPromise !== undefined) return stopPromise;
      stopPromise = (async () => {
        // Two-phase shutdown:
        //  1. Mark every pipeline as stopped so newly-arriving watcher
        //     events short-circuit instead of starting work.
        //  2. Stop watchers (no new events arrive) → wait for in-flight
        //     to drain → close stores. Each phase is bounded by
        //     stopTimeoutMs so a hung scan can't strand shutdown.
        for (const rt of runtimes.values()) rt.pipeline.markStopped();
        await withTimeout(
          Promise.allSettled(
            Array.from(runtimes.values(), async (rt) => {
              await rt.watcher.stop();
              // Drain in-flight pipeline ops so we don't close the store
              // while LanceDB is mid-write. `inFlight` self-cleans via
              // `finally`, so we capture a snapshot here.
              await Promise.allSettled(Array.from(rt.inFlight));
              await rt.readyPromise;
              rt.store.close();
            }),
          ),
          stopTimeoutMs,
        );
      })();
      return stopPromise;
    },
  };

  return indexer;
}

export type { SearchHit } from "./store.ts";
export {
  PipelineVersionMismatchError,
  StoreDimensionMismatchError,
} from "./store.ts";
export { InvalidPathError } from "../errors.ts";

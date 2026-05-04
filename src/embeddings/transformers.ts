/**
 * Transformers.js (`@huggingface/transformers`) embedder.
 *
 * Default provider per spec: 384-dim `Xenova/all-MiniLM-L6-v2` running on CPU
 * inside the Bun process. The model file (~90 MB) is cached under
 * `<DATA_DIR>/models/` via the upstream `cache_dir` option AND the
 * `TRANSFORMERS_CACHE` / `HF_HOME` env vars (we set both, since which one wins
 * depends on the upstream env-detect order, which has changed across versions).
 *
 * The pipeline is loaded lazily on the first `embed()` call so:
 *   1. `startIndexer` returns quickly even when the model has to download.
 *   2. Tests that never trigger an `embed()` (e.g. config wiring tests) don't
 *      pay the loading cost.
 *
 * `loadPipeline` is injected so unit tests can avoid the real model entirely
 * — the E2E test (gated by `INDEXER_E2E=1`) drives the real path.
 */

import { type Embedder, EmbedderError } from "./index.ts";

export interface TransformersDeps {
  /**
   * Override the pipeline loader. Default uses the real
   * `@huggingface/transformers` pipeline. Returns a function that maps a
   * batch of strings to a 2-D Float32 tensor (`{ data: Float32Array; dims:
   * number[] }`-shaped).
   */
  readonly loadPipeline?: (model: string, cacheDir: string) => Promise<TransformersPipeline>;
  /** Override env mutation (tests inject a no-op). */
  readonly setCacheEnv?: (cacheDir: string) => void;
}

export type TransformersPipeline = (
  texts: string[],
  opts: { pooling: "mean"; normalize: true },
) => Promise<{ data: Float32Array; dims: readonly number[] }>;

export interface TransformersEmbedderInput {
  readonly model: string;
  readonly dataDir: string;
}

function setCacheEnv(cacheDir: string): void {
  // Upstream reads either of these depending on version. Setting both is
  // the cheap, correct option — they don't conflict with each other.
  if (process.env.TRANSFORMERS_CACHE === undefined) process.env.TRANSFORMERS_CACHE = cacheDir;
  if (process.env.HF_HOME === undefined) process.env.HF_HOME = cacheDir;
}

/**
 * The minimal shape we need from `@huggingface/transformers` for the real
 * loader. Extracted so unit tests can hand `realLoadPipeline` a fake
 * `import` without ever touching the model file.
 */
export interface TransformersModule {
  readonly env: { cacheDir?: string | null };
  readonly pipeline: (
    task: "feature-extraction",
    model: string,
    opts: { cache_dir: string; device: "cpu" },
  ) => Promise<unknown>;
}

export function realLoadPipeline(
  importImpl: () => Promise<TransformersModule>,
): (model: string, cacheDir: string) => Promise<TransformersPipeline> {
  return async (model: string, cacheDir: string): Promise<TransformersPipeline> => {
    // Dynamic import keeps the heavy dep out of the cold-start path for
    // code paths (e.g. unit tests for the OpenAI provider) that never
    // touch Transformers.js.
    const mod = await importImpl();
    // env.cacheDir is the upstream-recommended way to override the on-disk
    // cache; we set it in addition to the env vars above.
    mod.env.cacheDir = cacheDir;
    // Preferred device is CPU per spec.
    const pipe = await mod.pipeline("feature-extraction", model, {
      cache_dir: cacheDir,
      device: "cpu",
    });
    return ((texts, opts) =>
      // biome-ignore lint/suspicious/noExplicitAny: pipeline call signature is `(input, options) => Promise<Tensor>`; we coerce because upstream typings do not narrow on options.
      (pipe as any)(texts, opts) as Promise<{
        data: Float32Array;
        dims: readonly number[];
      }>) as TransformersPipeline;
  };
}

/**
 * Default upstream import. Exported so tests can invoke the arrow directly
 * without going through the heavyweight `pipeline()` call (and the
 * resulting model download). The `as unknown as ...` is the cheapest way
 * to narrow the upstream module's loose `env.cacheDir` typing into the
 * shape `realLoadPipeline` actually uses.
 */
export function importTransformers(): Promise<TransformersModule> {
  return import("@huggingface/transformers") as unknown as Promise<TransformersModule>;
}

const defaultRealLoadPipeline = realLoadPipeline(importTransformers);

export function buildTransformersEmbedder(
  input: TransformersEmbedderInput,
  deps: TransformersDeps = {},
): Embedder {
  const cacheDir = `${input.dataDir.replace(/\/+$/, "")}/models`;
  (deps.setCacheEnv ?? setCacheEnv)(cacheDir);

  const loadPipeline = deps.loadPipeline ?? defaultRealLoadPipeline;

  let pipelinePromise: Promise<TransformersPipeline> | null = null;
  let dim = 0;

  function getPipeline(): Promise<TransformersPipeline> {
    if (pipelinePromise === null) {
      pipelinePromise = loadPipeline(input.model, cacheDir).catch((e) => {
        // Reset the cache on failure so the next call retries the load
        // — otherwise a transient network blip during cold-start would
        // permanently break the embedder for the lifetime of the process.
        pipelinePromise = null;
        const msg = e instanceof Error ? e.message : String(e);
        throw new EmbedderError(`failed to load transformers pipeline ${input.model}: ${msg}`);
      });
    }
    return pipelinePromise;
  }

  return {
    get dim(): number {
      // Pipeline must be exercised once for `dim` to be known. The indexer
      // does this during open by feeding a sentinel string; tests drive it
      // explicitly.
      return dim;
    },
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const pipe = await getPipeline();
      const out = await pipe(texts, { pooling: "mean", normalize: true });
      if (out.dims.length < 2) {
        throw new EmbedderError(
          `transformers output had unexpected shape ${JSON.stringify(out.dims)}`,
        );
      }
      const last = out.dims[out.dims.length - 1];
      if (typeof last !== "number") {
        throw new EmbedderError("transformers output dims missing trailing axis");
      }
      const vectorDim = last;
      // Refuse to slice if the underlying buffer is shorter than
      // `texts.length * vectorDim`. Without this guard, a buggy upstream
      // pipeline returning a truncated buffer would silently emit short
      // (and therefore wrong-length) Float32Arrays — the indexer would
      // then store malformed vectors that fail vector search at query
      // time. Surface the mismatch immediately as a typed error so the
      // pipeline's per-file error counter and logger can record it.
      const expected = texts.length * vectorDim;
      if (out.data.length !== expected) {
        throw new EmbedderError(
          `transformers tensor size mismatch: expected ${expected} (texts=${texts.length}*dim=${vectorDim}), got ${out.data.length}`,
        );
      }
      if (dim === 0) dim = vectorDim;
      const result: Float32Array[] = [];
      for (let i = 0; i < texts.length; i++) {
        const slice = out.data.slice(i * vectorDim, (i + 1) * vectorDim);
        result.push(slice);
      }
      return result;
    },
  };
}

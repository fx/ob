import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EmbedderError } from "../../src/embeddings/index.ts";
import {
  type TransformersModule,
  type TransformersPipeline,
  buildTransformersEmbedder,
  importTransformers,
  realLoadPipeline,
} from "../../src/embeddings/transformers.ts";

const E2E = process.env.INDEXER_E2E === "1";

/** Build a pipeline that returns deterministic vectors of the given dim. */
function fakePipeline(dim: number): TransformersPipeline {
  return async (texts) => {
    const data = new Float32Array(texts.length * dim);
    for (let i = 0; i < texts.length; i++) {
      for (let j = 0; j < dim; j++) {
        data[i * dim + j] = (i + 1) * (j + 1) * 0.01;
      }
    }
    return { data, dims: [texts.length, dim] };
  };
}

describe("buildTransformersEmbedder (unit)", () => {
  // Snapshot env so we can restore in afterEach.
  const originalCache = process.env.TRANSFORMERS_CACHE;
  const originalHfHome = process.env.HF_HOME;

  beforeEach(() => {
    process.env.TRANSFORMERS_CACHE = undefined;
    process.env.HF_HOME = undefined;
  });
  afterEach(() => {
    process.env.TRANSFORMERS_CACHE = originalCache;
    process.env.HF_HOME = originalHfHome;
  });

  test("lazy-loads pipeline on first embed call", async () => {
    let loadCount = 0;
    const e = buildTransformersEmbedder(
      { model: "m", dataDir: "/tmp/data" },
      {
        loadPipeline: async () => {
          loadCount++;
          return fakePipeline(8);
        },
        setCacheEnv: () => undefined,
      },
    );
    expect(loadCount).toBe(0);
    await e.embed(["x"]);
    expect(loadCount).toBe(1);
    await e.embed(["y"]);
    expect(loadCount).toBe(1);
  });

  test("dim is exposed after first embed", async () => {
    const e = buildTransformersEmbedder(
      { model: "m", dataDir: "/tmp/data" },
      { loadPipeline: async () => fakePipeline(384), setCacheEnv: () => undefined },
    );
    expect(e.dim).toBe(0);
    await e.embed(["x"]);
    expect(e.dim).toBe(384);
  });

  test("returns one vector per input", async () => {
    const e = buildTransformersEmbedder(
      { model: "m", dataDir: "/tmp/data" },
      { loadPipeline: async () => fakePipeline(4), setCacheEnv: () => undefined },
    );
    const out = await e.embed(["a", "b", "c"]);
    expect(out).toHaveLength(3);
    for (const v of out) expect(v.length).toBe(4);
  });

  test("empty input array short-circuits without loading the pipeline", async () => {
    let loadCount = 0;
    const e = buildTransformersEmbedder(
      { model: "m", dataDir: "/tmp/data" },
      {
        loadPipeline: async () => {
          loadCount++;
          return fakePipeline(4);
        },
        setCacheEnv: () => undefined,
      },
    );
    const out = await e.embed([]);
    expect(out).toEqual([]);
    expect(loadCount).toBe(0);
  });

  test("setCacheEnv is invoked with <dataDir>/models", () => {
    let observed = "";
    buildTransformersEmbedder(
      { model: "m", dataDir: "/some/where/" },
      {
        loadPipeline: async () => fakePipeline(4),
        setCacheEnv: (d) => {
          observed = d;
        },
      },
    );
    expect(observed).toBe("/some/where/models");
  });

  test("default setCacheEnv writes both TRANSFORMERS_CACHE and HF_HOME when unset", () => {
    buildTransformersEmbedder(
      { model: "m", dataDir: "/tmp/foo" },
      { loadPipeline: async () => fakePipeline(4) },
    );
    expect(process.env.TRANSFORMERS_CACHE).toBe("/tmp/foo/models");
    expect(process.env.HF_HOME).toBe("/tmp/foo/models");
  });

  test("default setCacheEnv leaves pre-existing env vars untouched", () => {
    process.env.TRANSFORMERS_CACHE = "/already/set";
    process.env.HF_HOME = "/already/hf";
    buildTransformersEmbedder(
      { model: "m", dataDir: "/tmp/foo" },
      { loadPipeline: async () => fakePipeline(4) },
    );
    expect(process.env.TRANSFORMERS_CACHE).toBe("/already/set");
    expect(process.env.HF_HOME).toBe("/already/hf");
  });

  test("loadPipeline failure surfaces as EmbedderError and retries on next call", async () => {
    let attempts = 0;
    const e = buildTransformersEmbedder(
      { model: "m", dataDir: "/tmp/data" },
      {
        loadPipeline: async () => {
          attempts++;
          if (attempts === 1) throw new Error("offline");
          return fakePipeline(4);
        },
        setCacheEnv: () => undefined,
      },
    );
    let err: unknown;
    try {
      await e.embed(["x"]);
    } catch (e2) {
      err = e2;
    }
    expect(err).toBeInstanceOf(EmbedderError);
    expect((err as Error).message).toContain("offline");
    // Second attempt re-tries the load; we won't actually crash on succeed.
    await e.embed(["x"]);
    expect(attempts).toBe(2);
  });

  test("non-Error thrown from loader stringifies into EmbedderError", async () => {
    const e = buildTransformersEmbedder(
      { model: "m", dataDir: "/tmp/data" },
      {
        loadPipeline: async () => {
          // eslint-disable-next-line no-throw-literal -- testing non-Error path
          throw "bad string";
        },
        setCacheEnv: () => undefined,
      },
    );
    let err: unknown;
    try {
      await e.embed(["x"]);
    } catch (e2) {
      err = e2;
    }
    expect(err).toBeInstanceOf(EmbedderError);
    expect((err as Error).message).toContain("bad string");
  });

  test("rejects when tensor data is shorter than texts.length * dim (LDnr)", async () => {
    const e = buildTransformersEmbedder(
      { model: "m", dataDir: "/tmp/data" },
      {
        loadPipeline: async () => async () => ({
          // dims claim 3×4 but data only contains 2×4 floats — exactly
          // the truncation case the regression covers.
          data: new Float32Array(8),
          dims: [3, 4],
        }),
        setCacheEnv: () => undefined,
      },
    );
    let err: unknown;
    try {
      await e.embed(["a", "b", "c"]);
    } catch (e2) {
      err = e2;
    }
    expect(err).toBeInstanceOf(EmbedderError);
    expect((err as Error).message).toContain("size mismatch");
    expect((err as Error).message).toContain("12");
    expect((err as Error).message).toContain("8");
  });

  test("rejects when tensor data is longer than texts.length * dim", async () => {
    // Too-large data is just as wrong as too-small — both indicate the
    // pipeline returned a different shape than `dims` advertised.
    const e = buildTransformersEmbedder(
      { model: "m", dataDir: "/tmp/data" },
      {
        loadPipeline: async () => async () => ({
          data: new Float32Array(20),
          dims: [3, 4],
        }),
        setCacheEnv: () => undefined,
      },
    );
    let err: unknown;
    try {
      await e.embed(["a", "b", "c"]);
    } catch (e2) {
      err = e2;
    }
    expect(err).toBeInstanceOf(EmbedderError);
    expect((err as Error).message).toContain("size mismatch");
  });

  test("rejects when pipeline returns an unexpected dims shape (1-D)", async () => {
    const e = buildTransformersEmbedder(
      { model: "m", dataDir: "/tmp/data" },
      {
        loadPipeline: async () => async () => ({
          data: new Float32Array(4),
          dims: [4],
        }),
        setCacheEnv: () => undefined,
      },
    );
    let err: unknown;
    try {
      await e.embed(["x"]);
    } catch (e2) {
      err = e2;
    }
    expect(err).toBeInstanceOf(EmbedderError);
    expect((err as Error).message).toContain("[4]");
  });

  test("rejects when pipeline output's trailing dim is not numeric", async () => {
    const e = buildTransformersEmbedder(
      { model: "m", dataDir: "/tmp/data" },
      {
        loadPipeline: async () => async () => ({
          data: new Float32Array(0),
          // biome-ignore lint/suspicious/noExplicitAny: synthetic non-numeric dim to exercise the guard branch.
          dims: [1, undefined as any],
        }),
        setCacheEnv: () => undefined,
      },
    );
    let err: unknown;
    try {
      await e.embed(["x"]);
    } catch (e2) {
      err = e2;
    }
    expect(err).toBeInstanceOf(EmbedderError);
    expect((err as Error).message).toContain("trailing axis");
  });
});

describe("realLoadPipeline", () => {
  test("importTransformers resolves the real upstream module without invoking pipeline", async () => {
    // Invoking the default importer covers the lazy-load arrow that would
    // otherwise only run when the upstream model is actually requested.
    const mod = await importTransformers();
    expect(typeof mod.pipeline).toBe("function");
  });

  test("delegates to the injected import and configures env.cacheDir", async () => {
    const mod: TransformersModule & { lastInvoked?: { task: string; model: string } } = {
      env: { cacheDir: null },
      pipeline: async (task, model, opts) => {
        // Sanity-check the args we care about; opts.cache_dir / device come
        // from buildTransformersEmbedder.
        expect(task).toBe("feature-extraction");
        expect(model).toBe("Xenova/all-MiniLM-L6-v2");
        expect(opts.device).toBe("cpu");
        expect(opts.cache_dir).toBe("/tmp/realload/models");
        // Return a 1-D pipeline that emits 4-dim vectors.
        return async (texts: string[]) => ({
          data: new Float32Array(texts.length * 4),
          dims: [texts.length, 4],
        });
      },
    };
    const loader = realLoadPipeline(async () => mod);
    const pipe = await loader("Xenova/all-MiniLM-L6-v2", "/tmp/realload/models");
    expect(mod.env.cacheDir).toBe("/tmp/realload/models");
    const out = await pipe(["x"], { pooling: "mean", normalize: true });
    expect(out.data.length).toBe(4);
    expect(Array.from(out.dims)).toEqual([1, 4]);
  });
});

// E2E test — gated. Downloads ~90 MB the first run.
describe.if(E2E)("buildTransformersEmbedder (e2e)", () => {
  test("real pipeline returns 384-dim vector for default model", async () => {
    const dataDir = `/tmp/ob-transformers-e2e-${Date.now()}`;
    const e = buildTransformersEmbedder({
      model: "Xenova/all-MiniLM-L6-v2",
      dataDir,
    });
    const [v] = await e.embed(["hello world"]);
    if (v === undefined) throw new Error("no vec");
    expect(v.length).toBe(384);
    expect(e.dim).toBe(384);
  }, 600_000);
});

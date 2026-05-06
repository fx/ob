import { describe, expect, test } from "bun:test";
import type { Config } from "../../src/config/index.ts";
import { EmbedderError, buildEmbedder } from "../../src/embeddings/index.ts";

function baseConfig(over: Partial<Config> = {}): Config {
  const cfg: Config = {
    obsidianAuthToken: undefined,
    vaults: [{ name: "v", slug: "v" }],
    dataDir: "/tmp/ob-embeddings-test",
    httpPort: 0,
    httpHost: "127.0.0.1",
    embeddingProvider: "transformers",
    embeddingModel: "Xenova/all-MiniLM-L6-v2",
    logLevel: "error",
    syncConfigEnv: {},
    ...over,
  };
  return cfg;
}

describe("buildEmbedder", () => {
  test("transformers provider — uses injected loadPipeline", async () => {
    let called = false;
    const e = buildEmbedder(baseConfig(), {
      transformers: {
        loadPipeline: async () => {
          called = true;
          return async () => ({ data: new Float32Array(4), dims: [1, 4] });
        },
        setCacheEnv: () => undefined,
      },
    });
    await e.embed(["x"]);
    expect(called).toBe(true);
    expect(e.dim).toBe(4);
  });

  test("openai provider — uses injected fetch", async () => {
    let url = "";
    const e = buildEmbedder(
      baseConfig({
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
        openaiApiKey: "sk-test",
      }),
      {
        openai: {
          fetch: async (input: string | URL | Request) => {
            url = typeof input === "string" ? input : input.toString();
            return new Response(JSON.stringify({ data: [{ embedding: [1, 2] }] }), {
              status: 200,
            });
          },
          sleep: async () => undefined,
        },
      },
    );
    await e.embed(["x"]);
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    expect(e.dim).toBe(2);
  });

  test("openai provider with custom base URL", async () => {
    let url = "";
    const e = buildEmbedder(
      baseConfig({
        embeddingProvider: "openai",
        embeddingModel: "m",
        openaiApiKey: "sk",
        openaiBaseUrl: "https://api.example.org/llm/",
      }),
      {
        openai: {
          fetch: async (input: string | URL | Request) => {
            url = typeof input === "string" ? input : input.toString();
            return new Response(JSON.stringify({ data: [{ embedding: [1] }] }), {
              status: 200,
            });
          },
          sleep: async () => undefined,
        },
      },
    );
    await e.embed(["x"]);
    expect(url).toBe("https://api.example.org/llm/v1/embeddings");
  });

  test("openai without API key throws EmbedderError", () => {
    let err: unknown;
    try {
      buildEmbedder(
        baseConfig({
          embeddingProvider: "openai",
          embeddingModel: "m",
          // openaiApiKey intentionally absent
        }),
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EmbedderError);
    expect((err as Error).message).toContain("OPENAI_API_KEY");
  });
});

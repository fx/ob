import { describe, expect, test } from "bun:test";
import { EmbedderError } from "../../src/embeddings/index.ts";
import {
  OPENAI_BACKOFF,
  OPENAI_BATCH_LIMIT,
  backoffDelay,
  batchInputs,
  buildOpenAIEmbedder,
} from "../../src/embeddings/openai.ts";

function jsonOk(vectors: number[][]): Response {
  return new Response(JSON.stringify({ data: vectors.map((embedding) => ({ embedding })) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("backoffDelay", () => {
  test("matches the documented schedule", () => {
    // 1s, 2s, 4s, 8s, 16s — under cap
    expect(backoffDelay(0)).toBe(1_000);
    expect(backoffDelay(1)).toBe(2_000);
    expect(backoffDelay(2)).toBe(4_000);
    expect(backoffDelay(3)).toBe(8_000);
    expect(backoffDelay(4)).toBe(16_000);
  });

  test("caps at 30s", () => {
    expect(backoffDelay(10)).toBe(OPENAI_BACKOFF.capMs);
    expect(backoffDelay(100)).toBe(OPENAI_BACKOFF.capMs);
  });
});

describe("batchInputs", () => {
  test("splits at the OpenAI 96 cap", () => {
    const arr = Array.from({ length: 250 }, (_, i) => `s${i}`);
    const batches = batchInputs(arr);
    expect(batches.length).toBe(3);
    expect(batches[0]?.length).toBe(OPENAI_BATCH_LIMIT);
    expect(batches[1]?.length).toBe(OPENAI_BATCH_LIMIT);
    expect(batches[2]?.length).toBe(250 - 2 * OPENAI_BATCH_LIMIT);
  });

  test("custom limit honoured", () => {
    expect(batchInputs(["a", "b", "c", "d"], 2)).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  test("empty input → empty batches", () => {
    expect(batchInputs([])).toEqual([]);
  });
});

describe("buildOpenAIEmbedder", () => {
  test("posts to /v1/embeddings with bearer auth and json body", async () => {
    let captured: { url: string; init: RequestInit | undefined } | undefined;
    const fakeFetch: typeof fetch = async (input, init) => {
      captured = {
        url: typeof input === "string" ? input : input.toString(),
        init,
      };
      return jsonOk([[0.1, 0.2, 0.3, 0.4]]);
    };
    const e = buildOpenAIEmbedder(
      { apiKey: "sk-test", model: "text-embedding-3-small", baseUrl: "https://example.com/" },
      { fetch: fakeFetch, sleep: async () => undefined },
    );
    const [v] = await e.embed(["hello"]);
    expect(v).toBeInstanceOf(Float32Array);
    expect(captured?.url).toBe("https://example.com/v1/embeddings");
    const headers = captured?.init?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer sk-test");
    expect(captured?.init?.method).toBe("POST");
    const body = JSON.parse(String(captured?.init?.body));
    expect(body.input).toEqual(["hello"]);
    expect(body.model).toBe("text-embedding-3-small");
    expect(e.dim).toBe(4);
  });

  test("default base URL is https://api.openai.com when none provided", async () => {
    let url = "";
    const fakeFetch: typeof fetch = async (input) => {
      url = typeof input === "string" ? input : input.toString();
      return jsonOk([[1, 0]]);
    };
    const e = buildOpenAIEmbedder(
      { apiKey: "sk-test", model: "text-embedding-3-small" },
      { fetch: fakeFetch, sleep: async () => undefined },
    );
    await e.embed(["a"]);
    expect(url).toBe("https://api.openai.com/v1/embeddings");
  });

  test("batches inputs at ≤ 96 per request", async () => {
    let calls = 0;
    const sizes: number[] = [];
    const fakeFetch: typeof fetch = async (_, init) => {
      calls++;
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      sizes.push(body.input.length);
      return jsonOk(body.input.map(() => [0, 1]));
    };
    const e = buildOpenAIEmbedder(
      { apiKey: "k", model: "m" },
      { fetch: fakeFetch, sleep: async () => undefined },
    );
    const inputs = Array.from({ length: 250 }, (_, i) => `t${i}`);
    const out = await e.embed(inputs);
    expect(out.length).toBe(250);
    expect(calls).toBe(3);
    expect(sizes).toEqual([96, 96, 58]);
  });

  test("retries 429 with documented schedule", async () => {
    let attempts = 0;
    const sleepDelays: number[] = [];
    const fakeFetch: typeof fetch = async () => {
      attempts++;
      if (attempts < 3) return new Response("rate limited", { status: 429 });
      return jsonOk([[1, 0]]);
    };
    const e = buildOpenAIEmbedder(
      { apiKey: "k", model: "m" },
      {
        fetch: fakeFetch,
        sleep: async (ms: number): Promise<void> => {
          sleepDelays.push(ms);
        },
      },
    );
    await e.embed(["x"]);
    expect(attempts).toBe(3);
    // Two retries → two backoff sleeps before the success: 1s, 2s.
    expect(sleepDelays).toEqual([1_000, 2_000]);
  });

  test("retries 500 then succeeds", async () => {
    let attempts = 0;
    const fakeFetch: typeof fetch = async () => {
      attempts++;
      if (attempts === 1) return new Response("oops", { status: 500 });
      return jsonOk([[1]]);
    };
    const e = buildOpenAIEmbedder(
      { apiKey: "k", model: "m" },
      { fetch: fakeFetch, sleep: async () => undefined },
    );
    await e.embed(["x"]);
    expect(attempts).toBe(2);
  });

  test("non-retryable status (400) errors out immediately", async () => {
    let attempts = 0;
    const fakeFetch: typeof fetch = async () => {
      attempts++;
      return new Response("bad request", { status: 400 });
    };
    const e = buildOpenAIEmbedder(
      { apiKey: "k", model: "m" },
      { fetch: fakeFetch, sleep: async () => undefined },
    );
    let err: unknown;
    try {
      await e.embed(["x"]);
    } catch (e2) {
      err = e2;
    }
    expect(err).toBeInstanceOf(EmbedderError);
    expect((err as Error).message).toContain("400");
    expect(attempts).toBe(1);
  });

  test("gives up after max attempts on persistent 503", async () => {
    let attempts = 0;
    const fakeFetch: typeof fetch = async () => {
      attempts++;
      return new Response("down", { status: 503 });
    };
    const e = buildOpenAIEmbedder(
      { apiKey: "k", model: "m" },
      { fetch: fakeFetch, sleep: async () => undefined },
    );
    let err: unknown;
    try {
      await e.embed(["x"]);
    } catch (e2) {
      err = e2;
    }
    expect(err).toBeInstanceOf(EmbedderError);
    expect(attempts).toBe(OPENAI_BACKOFF.maxAttempts);
  });

  test("unreadable error response body still surfaces typed error", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller): void {
            controller.error(new Error("body broken"));
          },
        }),
        { status: 400 },
      );
    const e = buildOpenAIEmbedder(
      { apiKey: "k", model: "m" },
      { fetch: fakeFetch, sleep: async () => undefined },
    );
    let err: unknown;
    try {
      await e.embed(["x"]);
    } catch (e2) {
      err = e2;
    }
    expect(err).toBeInstanceOf(EmbedderError);
    expect((err as Error).message).toContain("<unreadable>");
  });

  test("network throw is retried as 5xx-equivalent then fails", async () => {
    let attempts = 0;
    const fakeFetch: typeof fetch = async () => {
      attempts++;
      throw new Error("ECONNRESET");
    };
    const e = buildOpenAIEmbedder(
      { apiKey: "k", model: "m" },
      { fetch: fakeFetch, sleep: async () => undefined },
    );
    let err: unknown;
    try {
      await e.embed(["x"]);
    } catch (e2) {
      err = e2;
    }
    expect(err).toBeInstanceOf(EmbedderError);
    expect((err as Error).message).toContain("ECONNRESET");
    expect(attempts).toBe(OPENAI_BACKOFF.maxAttempts);
  });

  test("network throw retried then succeeds (covers retry-then-200 path)", async () => {
    let attempts = 0;
    const fakeFetch: typeof fetch = async () => {
      attempts++;
      if (attempts === 1) throw new Error("temp");
      return jsonOk([[1, 1]]);
    };
    const e = buildOpenAIEmbedder(
      { apiKey: "k", model: "m" },
      { fetch: fakeFetch, sleep: async () => undefined },
    );
    await e.embed(["x"]);
    expect(attempts).toBe(2);
  });

  test("response with mismatched vector count rejects with EmbedderError", async () => {
    const fakeFetch: typeof fetch = async () => jsonOk([[1, 2]]);
    const e = buildOpenAIEmbedder(
      { apiKey: "k", model: "m" },
      { fetch: fakeFetch, sleep: async () => undefined },
    );
    let err: unknown;
    try {
      await e.embed(["a", "b"]);
    } catch (e2) {
      err = e2;
    }
    expect(err).toBeInstanceOf(EmbedderError);
    expect((err as Error).message).toContain("1");
    expect((err as Error).message).toContain("2");
  });

  test("embed([]) short-circuits before any HTTP call (LDn3)", async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = async () => {
      calls++;
      return jsonOk([[1]]);
    };
    const e = buildOpenAIEmbedder(
      { apiKey: "k", model: "m" },
      { fetch: fakeFetch, sleep: async () => undefined },
    );
    expect(await e.embed([])).toEqual([]);
    expect(calls).toBe(0);
  });

  test("response with fewer vectors than inputs rejects with EmbedderError", async () => {
    // The actual empty-response branch in the production code: server
    // returns 0 vectors for 1 input. `out.length !== batch.length` fires.
    const fakeFetch: typeof fetch = async () => jsonOk([]);
    const e = buildOpenAIEmbedder(
      { apiKey: "k", model: "m" },
      { fetch: fakeFetch, sleep: async () => undefined },
    );
    let err: unknown;
    try {
      await e.embed(["a"]);
    } catch (e2) {
      err = e2;
    }
    expect(err).toBeInstanceOf(EmbedderError);
    expect((err as Error).message).toContain("0");
    expect((err as Error).message).toContain("1");
  });

  test("uses default sleep when none injected (covers defaultSleep)", async () => {
    let attempts = 0;
    const fakeFetch: typeof fetch = async () => {
      attempts++;
      if (attempts === 1) return new Response("rate", { status: 429 });
      return jsonOk([[1, 2, 3]]);
    };
    // Override OPENAI_BACKOFF.initialMs implicitly by using attempt 0 → 1s
    // — too long for a unit test. Instead, stub `setTimeout` globally so
    // backoffDelay still computes 1000 but the actual wait is microseconds.
    const realSetTimeout = globalThis.setTimeout;
    // biome-ignore lint/suspicious/noExplicitAny: stubbing global timer for the duration of the call.
    (globalThis as any).setTimeout = (cb: () => void): unknown => realSetTimeout(cb, 1);
    try {
      const e = buildOpenAIEmbedder({ apiKey: "k", model: "m" }, { fetch: fakeFetch });
      await e.embed(["x"]);
    } finally {
      globalThis.setTimeout = realSetTimeout;
    }
    expect(attempts).toBe(2);
  });

  test("dim is set on first response and stays stable", async () => {
    const fakeFetch: typeof fetch = async (_, init) => {
      const body = JSON.parse(String(init?.body)) as { input: string[] };
      return jsonOk(body.input.map(() => [1, 2, 3, 4, 5]));
    };
    const e = buildOpenAIEmbedder(
      { apiKey: "k", model: "m" },
      { fetch: fakeFetch, sleep: async () => undefined },
    );
    expect(e.dim).toBe(0);
    await e.embed(["hello"]);
    expect(e.dim).toBe(5);
    await e.embed(["bye"]);
    expect(e.dim).toBe(5);
  });
});

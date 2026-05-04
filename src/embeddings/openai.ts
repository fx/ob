/**
 * OpenAI-compatible HTTP embedder.
 *
 * POSTs `{ input: string[], model }` to `${baseUrl}/v1/embeddings` with
 * `Authorization: Bearer ${apiKey}`. Inputs are batched at ≤ 96 per request
 * (OpenAI's documented per-call cap; many compatible servers — Ollama, vLLM —
 * impose their own caps below 100). Failures on 429/5xx are retried with
 * exponential backoff: initial 1 s, factor ×2, cap 30 s, max 5 attempts.
 *
 * `fetch` and `sleep` are injected so tests exercise the backoff schedule
 * without timer wall-clock waits and without a real network call.
 *
 * Dimension is discovered on the first successful response and cached. We
 * deliberately do NOT hard-code a per-model dim table — the OpenAI catalog
 * grows monthly and `text-embedding-3-large` admits a `dimensions` parameter
 * that overrides the default. Reading the response is the only honest source.
 */

import { type Embedder, EmbedderError } from "./index.ts";

export const OPENAI_BATCH_LIMIT = 96;

export const OPENAI_BACKOFF = {
  initialMs: 1_000,
  factor: 2,
  capMs: 30_000,
  maxAttempts: 5,
} as const;

export interface OpenAIDeps {
  /** `globalThis.fetch` by default. */
  readonly fetch?: typeof fetch;
  /** `setTimeout`-backed sleep by default. */
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface OpenAIEmbedderInput {
  readonly apiKey: string;
  readonly model: string;
  readonly baseUrl?: string;
}

interface EmbeddingResponse {
  readonly data: ReadonlyArray<{ readonly embedding: readonly number[] }>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Compute the i-th retry delay (i = 0..maxAttempts-2). */
export function backoffDelay(attemptIndex: number): number {
  const raw = OPENAI_BACKOFF.initialMs * OPENAI_BACKOFF.factor ** attemptIndex;
  return Math.min(raw, OPENAI_BACKOFF.capMs);
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

/** Slice a longer input list into ≤ 96-sized batches. */
export function batchInputs(texts: readonly string[], limit = OPENAI_BATCH_LIMIT): string[][] {
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += limit) {
    batches.push(texts.slice(i, i + limit));
  }
  return batches;
}

export function buildOpenAIEmbedder(input: OpenAIEmbedderInput, deps: OpenAIDeps = {}): Embedder {
  const fetchImpl = deps.fetch ?? fetch;
  const sleep = deps.sleep ?? defaultSleep;
  const baseUrl = (input.baseUrl ?? "https://api.openai.com").replace(/\/+$/, "");
  const url = `${baseUrl}/v1/embeddings`;

  // Resolved on the first successful call. We treat dim as "frozen on first
  // response" — switching `EMBEDDING_MODEL` between two providers with
  // different dims requires a process restart, which is exactly the
  // mismatch-detection contract documented in the spec.
  let dim = 0;

  async function embedBatch(batch: readonly string[]): Promise<Float32Array[]> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < OPENAI_BACKOFF.maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${input.apiKey}`,
          },
          body: JSON.stringify({ input: batch, model: input.model }),
        });
      } catch (e) {
        lastErr = e;
        // Network-layer failure (DNS, refused, abort). Retry with backoff —
        // this is what 5xx already buys us at the HTTP layer; treat the
        // network as "5xx-equivalent" so a flaky network doesn't take down
        // the indexer on the first hiccup.
        if (attempt < OPENAI_BACKOFF.maxAttempts - 1) {
          await sleep(backoffDelay(attempt));
          continue;
        }
        break;
      }
      if (res.ok) {
        const json = (await res.json()) as EmbeddingResponse;
        const out = json.data.map((d) => Float32Array.from(d.embedding));
        if (out.length !== batch.length) {
          throw new EmbedderError(
            `OpenAI embeddings response had ${out.length} vectors for ${batch.length} inputs`,
          );
        }
        // `batch.length > 0` is enforced by the caller (`embed` filters empty
        // input). `out.length === batch.length` therefore guarantees `out[0]`
        // exists, and we can safely read its dim once on the first response.
        if (dim === 0) {
          // biome-ignore lint/style/noNonNullAssertion: out.length === batch.length > 0 enforced above.
          dim = out[0]!.length;
        }
        return out;
      }
      const bodyText = await res.text().catch(() => "<unreadable>");
      lastErr = new EmbedderError(`OpenAI embeddings ${res.status}: ${bodyText}`);
      if (!isRetryableStatus(res.status)) break;
      if (attempt < OPENAI_BACKOFF.maxAttempts - 1) {
        await sleep(backoffDelay(attempt));
      }
    }
    if (lastErr instanceof EmbedderError) throw lastErr;
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new EmbedderError(`OpenAI embeddings failed after retries: ${msg}`);
  }

  const embedder: Embedder = {
    get dim(): number {
      // Until the first call, we don't know the model's dim. Indexer always
      // performs a 1-input embed of the empty/sentinel string before opening
      // tables, so this getter is reached only after that warm-up.
      return dim;
    },
    async embed(texts: string[]): Promise<Float32Array[]> {
      if (texts.length === 0) return [];
      const out: Float32Array[] = [];
      for (const batch of batchInputs(texts)) {
        const vecs = await embedBatch(batch);
        out.push(...vecs);
      }
      return out;
    },
  };
  return embedder;
}

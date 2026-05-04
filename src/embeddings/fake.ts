/**
 * Deterministic fake embedder.
 *
 * Used by ranking tests so the same input always maps to the same vector and
 * search results are stable across runs. Two flavours:
 *
 * - `buildHashEmbedder(dim)` — hashes each input string into a fixed-length
 *   unit vector. Different strings → different vectors with extremely low
 *   collision probability for the small vocabularies tests use.
 * - `buildMapEmbedder(map, dim)` — caller supplies an explicit `string →
 *   number[]` mapping for the hits/misses they want to assert; any input not
 *   in the map gets the zero vector.
 *
 * Lives in `src/` (not `test/`) so the indexer's own integration tests can
 * import it without crossing the test/source boundary, and so coverage can
 * see it.
 */

import { type Embedder, EmbedderError } from "./index.ts";

/**
 * djb2-style 32-bit hash. Pure function, no side effects, used to seed the
 * fake's vector generator. Picked over a crypto hash because we just need
 * "different strings → different numbers" and don't care about preimage
 * resistance.
 */
function hash32(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0; // h * 33 + c, keep i32
  }
  return h >>> 0;
}

/** xorshift32 PRNG — deterministic, seedable. */
function xorshift32(seed: number): () => number {
  let state = seed === 0 ? 1 : seed;
  return (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0xff_ff_ff_ff;
  };
}

function l2normalize(v: Float32Array): Float32Array {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm === 0) return v;
  for (let i = 0; i < v.length; i++) {
    // `noUncheckedIndexedAccess` widens v[i] to `number | undefined`, but
    // the bounds are statically guaranteed by the loop condition. We use a
    // local read with a !-narrow rather than disabling the rule.
    const x = v[i] as number;
    v[i] = x / norm;
  }
  return v;
}

/** Hash-seeded fake. Ideal for "two distinct queries should rank differently". */
export function buildHashEmbedder(dim: number): Embedder {
  if (dim <= 0) {
    throw new EmbedderError(`fake embedder dim must be > 0, got ${dim}`);
  }
  return {
    dim,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t) => {
        const rand = xorshift32(hash32(t));
        const v = new Float32Array(dim);
        for (let i = 0; i < dim; i++) v[i] = rand() * 2 - 1;
        return l2normalize(v);
      });
    },
  };
}

/**
 * Map-backed fake. Tests asserting "query 'coffee' beats query 'tea'" register
 * the exact vectors they want; unknown inputs get the zero vector so the
 * scorer falls back to a tie that's clearly not a match.
 */
export function buildMapEmbedder(map: Map<string, number[]>, dim: number): Embedder {
  if (dim <= 0) {
    throw new EmbedderError(`fake embedder dim must be > 0, got ${dim}`);
  }
  for (const [k, v] of map.entries()) {
    if (v.length !== dim) {
      throw new EmbedderError(
        `map embedder: vector for "${k}" has length ${v.length}, expected ${dim}`,
      );
    }
  }
  return {
    dim,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((t) => {
        const v = map.get(t);
        if (v !== undefined) return Float32Array.from(v);
        return new Float32Array(dim);
      });
    },
  };
}

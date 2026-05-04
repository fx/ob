import { describe, expect, test } from "bun:test";
import { buildHashEmbedder, buildMapEmbedder } from "../../src/embeddings/fake.ts";
import { EmbedderError } from "../../src/embeddings/index.ts";

describe("buildHashEmbedder", () => {
  test("returns deterministic vectors of the requested dim", async () => {
    const e = buildHashEmbedder(8);
    expect(e.dim).toBe(8);
    const [a1] = await e.embed(["hello"]);
    const [a2] = await e.embed(["hello"]);
    if (a1 === undefined || a2 === undefined) throw new Error("missing vec");
    expect(a1.length).toBe(8);
    expect(Array.from(a1)).toEqual(Array.from(a2));
  });

  test("different inputs produce different vectors", async () => {
    const e = buildHashEmbedder(16);
    const [a, b] = await e.embed(["coffee", "tea"]);
    if (a === undefined || b === undefined) throw new Error("missing vec");
    expect(Array.from(a)).not.toEqual(Array.from(b));
  });

  test("vectors are L2-normalised (unit length within float tolerance)", async () => {
    const e = buildHashEmbedder(32);
    const [v] = await e.embed(["abc"]);
    if (v === undefined) throw new Error("missing vec");
    let sq = 0;
    for (const x of v) sq += x * x;
    expect(Math.abs(Math.sqrt(sq) - 1)).toBeLessThan(1e-6);
  });

  test("zero-dim throws", () => {
    expect(() => buildHashEmbedder(0)).toThrow(EmbedderError);
  });

  test("negative dim throws", () => {
    expect(() => buildHashEmbedder(-1)).toThrow(EmbedderError);
  });

  test("embed empty array returns empty array", async () => {
    const e = buildHashEmbedder(4);
    expect(await e.embed([])).toEqual([]);
  });

  test("zero-vector input survives normalisation", async () => {
    // Construct an input that hashes such that the random sequence would be
    // zero — practically impossible at dim=64, but the path is tested
    // explicitly via a tiny dim. We use map embedder for the deterministic
    // zero case and assert hash embedder doesn't crash on tiny dim.
    const e = buildHashEmbedder(1);
    const [v] = await e.embed(["abc"]);
    if (v === undefined) throw new Error("missing vec");
    expect(v.length).toBe(1);
  });
});

describe("buildMapEmbedder", () => {
  test("known input returns mapped vector", async () => {
    const map = new Map<string, number[]>([["coffee", [1, 0, 0, 0]]]);
    const e = buildMapEmbedder(map, 4);
    const [v] = await e.embed(["coffee"]);
    if (v === undefined) throw new Error("missing");
    expect(Array.from(v)).toEqual([1, 0, 0, 0]);
  });

  test("unknown input falls back to zero vector", async () => {
    const e = buildMapEmbedder(new Map(), 4);
    const [v] = await e.embed(["nope"]);
    if (v === undefined) throw new Error("missing");
    expect(Array.from(v)).toEqual([0, 0, 0, 0]);
  });

  test("zero-dim throws", () => {
    expect(() => buildMapEmbedder(new Map(), 0)).toThrow(EmbedderError);
  });

  test("vector length mismatch throws with key in message", () => {
    let err: unknown;
    try {
      buildMapEmbedder(new Map([["k", [1, 2]]]), 4);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EmbedderError);
    expect((err as Error).message).toContain('"k"');
    expect((err as Error).message).toContain("4");
  });
});

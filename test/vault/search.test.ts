import { describe, expect, test } from "bun:test";
import { VaultNotFoundError } from "../../src/errors.ts";
import { search } from "../../src/vault/search.ts";
import { makeVaultFixture } from "./helpers.ts";

describe("search", () => {
  test("forwards query + opts to indexer.search", async () => {
    const fx = makeVaultFixture();
    fx.setHits([
      {
        path: "x.md",
        chunkIndex: 0,
        headingPath: ["#"],
        text: "x",
        score: 0.9,
        frontmatter: {},
        links: [],
        tags: [],
      },
    ]);
    const result = await search(fx.deps, fx.slug, {
      query: "coffee",
      limit: 5,
      filter: { tag: "todo" },
    });
    expect(result.hits.length).toBe(1);
    expect(fx.calls.search).toEqual([{ slug: fx.slug, query: "coffee" }]);
  });

  test("works without optional opts", async () => {
    const fx = makeVaultFixture();
    fx.setHits([]);
    const result = await search(fx.deps, fx.slug, { query: "x" });
    expect(result.hits).toEqual([]);
  });

  test("VaultNotFoundError on unknown slug", async () => {
    const fx = makeVaultFixture();
    await expect(search(fx.deps, "missing", { query: "x" })).rejects.toBeInstanceOf(
      VaultNotFoundError,
    );
  });

  test("forwards limit alone", async () => {
    const fx = makeVaultFixture();
    fx.setHits([]);
    await search(fx.deps, fx.slug, { query: "x", limit: 7 });
    expect(fx.calls.search.length).toBe(1);
  });
});

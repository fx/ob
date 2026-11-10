import { describe, expect, test } from "bun:test";
import { VaultNotFoundError } from "../../src/errors.ts";
import { listTags } from "../../src/vault/tags.ts";
import { makeVaultFixture } from "./helpers.ts";

describe("listTags", () => {
  test("forwards prefix and limit to indexer.tags and returns its listing", async () => {
    const fx = makeVaultFixture();
    const listing = { items: [{ tag: "todo", count: 2 }], total: 5 };
    fx.setTags(listing);
    expect(await listTags(fx.deps, fx.slug, { prefix: "work/", limit: 1 })).toEqual(listing);
    expect(fx.calls.tags).toEqual([{ slug: fx.slug, opts: { pathPrefix: "work/", limit: 1 } }]);
  });

  test("omits absent options rather than passing undefined", async () => {
    const fx = makeVaultFixture();
    await listTags(fx.deps, fx.slug);
    await listTags(fx.deps, fx.slug, {});
    expect(fx.calls.tags).toEqual([
      { slug: fx.slug, opts: {} },
      { slug: fx.slug, opts: {} },
    ]);
  });

  test("VaultNotFoundError on unknown slug, without calling the indexer", async () => {
    const fx = makeVaultFixture();
    await expect(listTags(fx.deps, "missing")).rejects.toBeInstanceOf(VaultNotFoundError);
    expect(fx.calls.tags).toEqual([]);
  });
});

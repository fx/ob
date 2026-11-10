/**
 * Path routes (`GET /v1/vaults/:slug/paths`, `DELETE /v1/vaults/:slug/paths/*path`)
 * through the real Hono app (`app.fetch` via `app.request`), the real
 * `safeJoin`, and a real indexer (fake embedder, real LanceDB) on a tmpdir
 * vault, so index effects are asserted on the real store. Also pins that the
 * removed per-type list and delete routes fall through to the JSON 404.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type HttpFixture, makeHttpFixture, waitFor } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

async function fixture(label: string): Promise<HttpFixture> {
  const fx = await makeHttpFixture(label);
  cleanup.push(fx.stop);
  await waitFor(() => fx.indexer.status("v")?.state === "ready");
  return fx;
}

function put(root: string, rel: string, content = "x"): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

interface Page {
  items: { type: string; path: string; size?: number; sha256?: string; contentType?: string }[];
  nextCursor: string | null;
}

describe("GET /v1/vaults/:slug/paths", () => {
  test("files and folders in one ordered listing", async () => {
    const fx = await fixture("paths-ls");
    put(fx.vaultRoot, "a/x.md", "# x");
    mkdirSync(join(fx.vaultRoot, "a", "empty"));
    put(fx.vaultRoot, "a-b.md");
    const res = await fx.app.request("/v1/vaults/v/paths");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Page;
    expect(body.items.map((i) => `${i.type}:${i.path}`)).toEqual([
      "folder:a",
      "folder:a/empty",
      "file:a/x.md",
      "file:a-b.md",
    ]);
    expect(body.items[2]).toMatchObject({ size: 3, contentType: "text/markdown; charset=utf-8" });
    expect(Object.keys(body.items[0] ?? {}).sort()).toEqual(["mtimeMs", "path", "type"]);
    expect(body.nextCursor).toBeNull();
  });

  test("pagination does not skip a sibling that sorts between a folder's descendants", async () => {
    const fx = await fixture("paths-page");
    put(fx.vaultRoot, "a/x.md");
    mkdirSync(join(fx.vaultRoot, "a", "empty"));
    put(fx.vaultRoot, "a-b.md");
    const first = (await (await fx.app.request("/v1/vaults/v/paths?limit=3")).json()) as Page;
    expect(first.items.at(-1)?.path).toBe("a/x.md");
    const second = (await (
      await fx.app.request(
        `/v1/vaults/v/paths?limit=3&cursor=${encodeURIComponent(first.nextCursor as string)}`,
      )
    ).json()) as Page;
    expect(second.items.map((i) => i.path)).toEqual(["a-b.md"]);
    expect(second.nextCursor).toBeNull();
  });

  test("type, recursive and prefix query parameters", async () => {
    const fx = await fixture("paths-q");
    put(fx.vaultRoot, "notes/a.md");
    put(fx.vaultRoot, "notes/sub/b.md");
    put(fx.vaultRoot, "top.md");
    mkdirSync(join(fx.vaultRoot, "scratch"));
    const shallow = (await (
      await fx.app.request("/v1/vaults/v/paths?prefix=notes/&recursive=false")
    ).json()) as Page;
    expect(shallow.items.map((i) => i.path)).toEqual(["notes/a.md", "notes/sub"]);
    const deep = (await (
      await fx.app.request("/v1/vaults/v/paths?prefix=notes/&recursive=true&type=file")
    ).json()) as Page;
    expect(deep.items.map((i) => i.path)).toEqual(["notes/a.md", "notes/sub/b.md"]);
    const folders = (await (await fx.app.request("/v1/vaults/v/paths?type=folder")).json()) as Page;
    expect(folders.items.map((i) => i.path)).toEqual(["notes", "notes/sub", "scratch"]);
  });

  test("an unknown parameter or a bad value is 400 invalid_query", async () => {
    const fx = await fixture("paths-badq");
    for (const q of [
      "limit=0",
      "limit=1001",
      "limit=abc",
      "type=symlink",
      "recursive=yes",
      "bogus=1",
      `prefix=${encodeURIComponent("é".repeat(513))}`,
    ]) {
      const res = await fx.app.request(`/v1/vaults/v/paths?${q}`);
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("invalid_query");
    }
  });

  test("an unknown vault is 404 vault_not_found", async () => {
    const fx = await fixture("paths-nov");
    const res = await fx.app.request("/v1/vaults/nope/paths");
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("vault_not_found");
  });
});

describe("DELETE /v1/vaults/:slug/paths/*path", () => {
  test("deletes a file and its index rows", async () => {
    const fx = await fixture("paths-rm");
    put(fx.vaultRoot, "notes/x.md", "# x\n\nbody");
    await fx.indexer.reindex("v", "notes/x.md");
    expect(await fx.indexer.indexedPaths("v", "notes/x.md")).toEqual(["notes/x.md"]);
    const res = await fx.app.request("/v1/vaults/v/paths/notes/x.md", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(existsSync(join(fx.vaultRoot, "notes/x.md"))).toBe(false);
    expect(await fx.indexer.indexedPaths("v", "notes/x.md")).toEqual([]);
  });

  test("refuses a non-empty folder without recursive and drops nothing", async () => {
    const fx = await fixture("paths-rm-409");
    put(fx.vaultRoot, "projects/alpha/intro.md", "# intro");
    await fx.indexer.reindex("v", "projects/alpha/intro.md");
    const res = await fx.app.request("/v1/vaults/v/paths/projects/alpha", { method: "DELETE" });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("folder_not_empty");
    expect(readFileSync(join(fx.vaultRoot, "projects/alpha/intro.md"), "utf8")).toBe("# intro");
    expect(await fx.indexer.indexedPaths("v", "projects/")).toEqual(["projects/alpha/intro.md"]);
  });

  test("recursive delete removes the tree and every index row under it, nothing beside it", async () => {
    const fx = await fixture("paths-rm-r");
    put(fx.vaultRoot, "archive/2024/jan.md", "# jan");
    put(fx.vaultRoot, "archive/2024-old.md", "# old");
    put(fx.vaultRoot, "archive/2024/cover.png");
    await fx.indexer.reindex("v", "archive/2024/jan.md");
    await fx.indexer.reindex("v", "archive/2024-old.md");
    const res = await fx.app.request("/v1/vaults/v/paths/archive/2024?recursive=true", {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(existsSync(join(fx.vaultRoot, "archive/2024"))).toBe(false);
    expect(await fx.indexer.indexedPaths("v", "archive/2024/")).toEqual([]);
    expect(await fx.indexer.indexedPaths("v", "archive/")).toEqual(["archive/2024-old.md"]);
  });

  test("an empty folder, a trailing slash, and recursive=false", async () => {
    const fx = await fixture("paths-rm-empty");
    mkdirSync(join(fx.vaultRoot, "empty"));
    const res = await fx.app.request("/v1/vaults/v/paths/empty/?recursive=false", {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(existsSync(join(fx.vaultRoot, "empty"))).toBe(false);
  });

  test("a missing path is 404 not_found", async () => {
    const fx = await fixture("paths-rm-404");
    const res = await fx.app.request("/v1/vaults/v/paths/notes/missing.md", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
  });

  test("a bad or unknown query parameter is 400 invalid_query and removes nothing", async () => {
    const fx = await fixture("paths-rm-badq");
    put(fx.vaultRoot, "d/x.md");
    for (const q of ["recursive=yes", "force=true"]) {
      const res = await fx.app.request(`/v1/vaults/v/paths/d?${q}`, { method: "DELETE" });
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("invalid_query");
    }
    expect(existsSync(join(fx.vaultRoot, "d/x.md"))).toBe(true);
  });

  describe("path validation: each case is rejected and removes nothing", () => {
    /** Everything the vault holds before the request, for the "nothing removed" check. */
    function seed(fx: HttpFixture): string[] {
      put(fx.vaultRoot, "keep.md");
      put(fx.vaultRoot, "real/keep.md");
      put(fx.vaultRoot, ".obsidian/app.json");
      put(fx.vaultRoot, "notes/.hidden.md");
      symlinkSync(join(fx.vaultRoot, "real"), join(fx.vaultRoot, "link"));
      put(join(fx.vaultRoot, "..", ".."), "sentinel");
      return [
        join(fx.vaultRoot, "keep.md"),
        join(fx.vaultRoot, "real/keep.md"),
        join(fx.vaultRoot, ".obsidian/app.json"),
        join(fx.vaultRoot, "notes/.hidden.md"),
        join(fx.vaultRoot, "link"),
        join(fx.vaultRoot, "..", "..", "sentinel"),
      ];
    }

    test.each([
      ["a `..` traversal", "..%2F..%2Fsentinel?recursive=true", 400, "invalid_path"],
      ["an absolute path", "%2Fetc%2Fpasswd", 400, "invalid_path"],
      ["a hidden folder", ".obsidian?recursive=true", 400, "invalid_path"],
      ["a hidden file", "notes/.hidden.md", 400, "invalid_path"],
      ["a NUL byte", "keep.md%00", 400, "invalid_path"],
      ["an over-length path", `${"a".repeat(1100)}.md`, 400, "invalid_path"],
      ["a symlink in the chain", "link/keep.md", 400, "invalid_path"],
      ["a symlink as the target", "link?recursive=true", 400, "invalid_path"],
      // The URL parser resolves an (encoded) single-dot segment away, so this
      // reaches no route at all.
      ["the vault root as `.`", "%2E?recursive=true", 404, "not_found"],
      ["the vault root as `./.`", "%2E%2F%2E", 400, "invalid_path"],
      ["the vault root as `./`", "%2E%2F?recursive=true", 400, "invalid_path"],
      ["the vault root as the empty path", "?recursive=true", 404, "not_found"],
    ])("%s", async (_label, tail, status, code) => {
      const fx = await fixture("paths-rm-guard");
      const kept = seed(fx);
      const res = await fx.app.request(`/v1/vaults/v/paths/${tail}`, { method: "DELETE" });
      expect(res.status).toBe(status);
      expect(await errorCode(res)).toBe(code);
      for (const abs of kept) expect(existsSync(abs)).toBe(true);
    });
  });
});

describe("removed per-type routes", () => {
  test.each([
    ["GET", "/v1/vaults/v/files"],
    ["GET", "/v1/vaults/v/folders"],
    ["DELETE", "/v1/vaults/v/files/x.md"],
    ["DELETE", "/v1/vaults/v/folders/d"],
  ])("%s %s falls through to the JSON 404 and removes nothing", async (method, url) => {
    const fx = await fixture("paths-gone");
    put(fx.vaultRoot, "x.md");
    mkdirSync(join(fx.vaultRoot, "d"));
    const res = await fx.app.request(url, { method });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe("not_found");
    expect(existsSync(join(fx.vaultRoot, "x.md"))).toBe(true);
    expect(existsSync(join(fx.vaultRoot, "d"))).toBe(true);
  });
});

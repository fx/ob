/**
 * Folder routes through the real Hono app (`app.fetch` via `app.request`),
 * real `safeJoin`, and a tmpdir vault. A fake indexer records `drop` calls so
 * the recursive-delete and non-recursive scenarios can assert index behavior
 * precisely (the fake supervisor + fake indexer pattern from 0003/0004).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { promises as fs, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { Config } from "../../src/config/index.ts";
import { buildHttpApp } from "../../src/http/index.ts";
import type { Indexer, IndexerStatus } from "../../src/indexer/index.ts";
import type { Logger } from "../../src/log.ts";
import type { Supervisor, VaultStatus } from "../../src/obsidian/index.ts";

function silent(): Logger {
  return {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

interface FolderHttpFixture {
  readonly app: Hono;
  readonly vaultRoot: string;
  readonly drops: { slug: string; path: string }[];
}

function makeFixture(label: string): FolderHttpFixture {
  const dataDir = mkdtempSync(join(tmpdir(), `ob-${label}-`));
  const slug = "v";
  const vaultRoot = join(dataDir, "vaults", slug);
  mkdirSync(vaultRoot, { recursive: true });

  const cfg: Config = {
    obsidianAuthToken: undefined,
    vaults: [{ name: slug, slug }],
    dataDir,
    httpPort: 0,
    httpHost: "127.0.0.1",
    embeddingProvider: "transformers",
    embeddingModel: "x",
    logLevel: "error",
    syncConfigEnv: {},
  };

  const ready: IndexerStatus = {
    slug,
    state: "ready",
    documents: 0,
    chunks: 0,
    lastIndexedAt: null,
    pending: 0,
    errors: 0,
  };
  const drops: { slug: string; path: string }[] = [];
  const indexer: Indexer = {
    status: () => ready,
    list: () => [ready],
    search: async () => [],
    reindex: async () => undefined,
    drop: async (s, p) => {
      drops.push({ slug: s, path: p });
    },
    stop: async () => undefined,
  };

  const statuses: VaultStatus[] = [
    { slug, name: slug, state: "running", pid: 1, restarts: 0, lastError: null },
  ];
  const supervisor: Supervisor = {
    list: () => statuses.slice(),
    get: (s) => statuses.find((x) => x.slug === s) ?? null,
    stop: async () => undefined,
  };

  const app = buildHttpApp({ supervisor, indexer, config: cfg, logger: silent() });
  return { app, vaultRoot, drops };
}

const roots: string[] = [];
afterEach(async () => {
  while (roots.length > 0) {
    const r = roots.pop();
    // `r` is `<dataDir>/vaults/v`; remove the whole tmp dataDir.
    if (r !== undefined) await fs.rm(join(r, "..", ".."), { recursive: true, force: true });
  }
});

function track(fx: FolderHttpFixture): FolderHttpFixture {
  roots.push(fx.vaultRoot);
  return fx;
}

describe("GET /v1/vaults/:slug/folders", () => {
  test("lists folders under a prefix in lexicographic order", async () => {
    const fx = track(makeFixture("folders-list"));
    await fs.mkdir(join(fx.vaultRoot, "social-graphs/people/peter-thiel"), { recursive: true });
    await fs.mkdir(join(fx.vaultRoot, "social-graphs/people/sam-altman"), { recursive: true });
    await fs.mkdir(join(fx.vaultRoot, "social-graphs/places"), { recursive: true });
    writeFileSync(join(fx.vaultRoot, "social-graphs/people/sam-altman/note.md"), "n");

    const res = await fx.app.request("/v1/vaults/v/folders?prefix=social-graphs%2Fpeople%2F");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { path: string }[]; nextCursor: string | null };
    expect(body.items.map((i) => i.path)).toEqual([
      "social-graphs/people/peter-thiel",
      "social-graphs/people/sam-altman",
    ]);
    expect(body.items.map((i) => i.path)).not.toContain("social-graphs/places");
  });

  test("empty folders are visible to /folders but not /files", async () => {
    const fx = track(makeFixture("folders-empty-vis"));
    await fs.mkdir(join(fx.vaultRoot, "notes/scratchpad"), { recursive: true });

    const folders = await fx.app.request("/v1/vaults/v/folders");
    const foldersBody = (await folders.json()) as { items: { path: string }[] };
    expect(foldersBody.items.map((i) => i.path)).toContain("notes/scratchpad");

    const files = await fx.app.request("/v1/vaults/v/files");
    expect(await files.json()).toEqual({ items: [], nextCursor: null });
  });

  test("invalid query param → 400 invalid_query", async () => {
    const fx = track(makeFixture("folders-badquery"));
    const res = await fx.app.request("/v1/vaults/v/folders?limit=abc");
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_query");
  });
});

describe("PUT /v1/vaults/:slug/folders/*path", () => {
  test("create is idempotent and does not touch the folder on replay", async () => {
    const fx = track(makeFixture("folders-idempotent"));
    const first = await fx.app.request("/v1/vaults/v/folders/archive/2026", { method: "PUT" });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { created: boolean; mtimeMs: number };
    expect(firstBody.created).toBe(true);

    const second = await fx.app.request("/v1/vaults/v/folders/archive/2026", { method: "PUT" });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { created: boolean; mtimeMs: number };
    expect(secondBody.created).toBe(false);
    expect(secondBody.mtimeMs).toBe(firstBody.mtimeMs);
  });

  test("a request body is ignored (folders have no content)", async () => {
    const fx = track(makeFixture("folders-put-body"));
    const res = await fx.app.request("/v1/vaults/v/folders/withbody", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ anything: "ignored" }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { created: boolean }).created).toBe(true);
  });

  test("a trailing slash on the path is tolerated and stripped", async () => {
    const fx = track(makeFixture("folders-trailing"));
    const res = await fx.app.request("/v1/vaults/v/folders/archive/2026/", { method: "PUT" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { path: string }).path).toBe("archive/2026");
  });

  test("empty path does not match PUT (404)", async () => {
    const fx = track(makeFixture("folders-put-empty"));
    const res = await fx.app.request("/v1/vaults/v/folders/", { method: "PUT" });
    expect(res.status).toBe(404);
  });

  test("conflict with an existing file → 400 invalid_path, file unchanged", async () => {
    const fx = track(makeFixture("folders-conflict"));
    await fs.mkdir(join(fx.vaultRoot, "notes"), { recursive: true });
    writeFileSync(join(fx.vaultRoot, "notes/x.md"), "keep");
    const res = await fx.app.request("/v1/vaults/v/folders/notes/x.md", { method: "PUT" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_path");
    expect(await fs.readFile(join(fx.vaultRoot, "notes/x.md"), "utf8")).toBe("keep");
  });

  test("path traversal is blocked (400) and nothing is created outside the vault", async () => {
    const fx = track(makeFixture("folders-traversal"));
    // Encoded slashes keep the `..` inside a single path segment so the URL
    // parser does not normalize the traversal away before routing.
    const res = await fx.app.request("/v1/vaults/v/folders/..%2F..%2Fetc%2Fpasswd", {
      method: "PUT",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_path");
    // Nothing landed outside the vault root.
    expect(await exists(join(fx.vaultRoot, "..", "..", "etc", "passwd"))).toBe(false);
  });
});

describe("DELETE /v1/vaults/:slug/folders/*path", () => {
  test("non-empty folder without recursive → 409 folder_not_empty, no drops", async () => {
    const fx = track(makeFixture("folders-del-409"));
    await fs.mkdir(join(fx.vaultRoot, "social-graphs/people/peter-thiel"), { recursive: true });
    writeFileSync(join(fx.vaultRoot, "social-graphs/people/peter-thiel/intro.md"), "hi");
    const res = await fx.app.request("/v1/vaults/v/folders/social-graphs/people/peter-thiel", {
      method: "DELETE",
    });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("folder_not_empty");
    expect(
      await fs.readFile(join(fx.vaultRoot, "social-graphs/people/peter-thiel/intro.md"), "utf8"),
    ).toBe("hi");
    expect(fx.drops).toEqual([]);
  });

  test("recursive delete drops Markdown entries only and removes the tree", async () => {
    const fx = track(makeFixture("folders-del-recursive"));
    await fs.mkdir(join(fx.vaultRoot, "archive/2024"), { recursive: true });
    writeFileSync(join(fx.vaultRoot, "archive/2024/jan.md"), "# jan");
    writeFileSync(join(fx.vaultRoot, "archive/2024/cover.png"), new Uint8Array([0x89]));
    const res = await fx.app.request("/v1/vaults/v/folders/archive/2024?recursive=true", {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    expect(fx.drops).toEqual([{ slug: "v", path: "archive/2024/jan.md" }]);
    expect(await exists(join(fx.vaultRoot, "archive/2024"))).toBe(false);
  });

  test("empty folder deletes with 204 (no recursive needed)", async () => {
    const fx = track(makeFixture("folders-del-empty"));
    await fs.mkdir(join(fx.vaultRoot, "empty"), { recursive: true });
    const res = await fx.app.request("/v1/vaults/v/folders/empty", { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(await exists(join(fx.vaultRoot, "empty"))).toBe(false);
  });

  test("delete is type-aware: a file → 400 invalid_path, file unchanged", async () => {
    const fx = track(makeFixture("folders-del-file"));
    writeFileSync(join(fx.vaultRoot, "x.md"), "keep");
    const res = await fx.app.request("/v1/vaults/v/folders/x.md", { method: "DELETE" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_path");
    expect(await fs.readFile(join(fx.vaultRoot, "x.md"), "utf8")).toBe("keep");
  });

  test("missing folder → 404 not_found", async () => {
    const fx = track(makeFixture("folders-del-404"));
    const res = await fx.app.request("/v1/vaults/v/folders/nope", { method: "DELETE" });
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  test("invalid recursive query value → 400 invalid_query", async () => {
    const fx = track(makeFixture("folders-del-badquery"));
    await fs.mkdir(join(fx.vaultRoot, "d"), { recursive: true });
    const res = await fx.app.request("/v1/vaults/v/folders/d?recursive=yes", { method: "DELETE" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_query");
  });

  test("empty path does not match DELETE (404)", async () => {
    const fx = track(makeFixture("folders-del-emptypath"));
    const res = await fx.app.request("/v1/vaults/v/folders/", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  test("path traversal is blocked (400) and nothing outside the vault is removed", async () => {
    const fx = track(makeFixture("folders-del-traversal"));
    const outside = join(fx.vaultRoot, "..", "..", "sentinel");
    writeFileSync(outside, "keep");
    try {
      const res = await fx.app.request("/v1/vaults/v/folders/..%2F..%2Fsentinel", {
        method: "DELETE",
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("invalid_path");
      expect(await fs.readFile(outside, "utf8")).toBe("keep");
    } finally {
      await fs.rm(outside, { force: true });
    }
  });
});

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.lstat(abs);
    return true;
  } catch {
    return false;
  }
}

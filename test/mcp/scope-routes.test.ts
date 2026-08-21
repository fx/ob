/**
 * Route-level tests for the scoped MCP mount (`docs/changes/0014-mcp-folder-scoping.md`).
 *
 * Everything here drives the REAL Hono app (`app.fetch` via `app.request`)
 * and the REAL MCP SDK transport, exactly as `test/mcp/transport.test.ts`
 * does — no handler is called directly and no `fs` is mocked. Every
 * containment scenario asserts BOTH the returned envelope AND the on-disk
 * effect, against real tmpdirs.
 *
 * The only doubles are the supervisor (a process-level service with no
 * filesystem semantics) and a pass-through recorder around the real indexer,
 * which delegates every call and records the arguments the scope wrapper
 * produced. The indexer underneath is the real one, so search hits come from
 * a real LanceDB store over real files.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import type { Config } from "../../src/config/index.ts";
import { buildHashEmbedder } from "../../src/embeddings/fake.ts";
import { buildHttpApp } from "../../src/http/index.ts";
import { type Indexer, type SearchOptions, startIndexer } from "../../src/indexer/index.ts";
import type { Logger } from "../../src/log.ts";
import {
  type McpRoutesDeps,
  SCOPE_SURFACE_CACHE_MAX,
  buildMcpRoutes,
} from "../../src/mcp/index.ts";
import { SCOPED_INSTRUCTIONS, VAULT_WIDE_COUNTS_NOTE } from "../../src/mcp/scope-tools.ts";
import type { Supervisor } from "../../src/obsidian/index.ts";
import type { VaultDescriptor } from "../../src/vault/files.ts";
import { TEST_WATCHDOG_OFF, makeVaultStatus } from "../helpers/vaultStatus.ts";
import { waitFor } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

function silent(): Logger {
  return {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function fakeSupervisor(slugs: readonly string[]): Supervisor {
  const statuses = slugs.map((slug) => makeVaultStatus({ slug }));
  return {
    list: () => statuses.slice(),
    get: (slug) => statuses.find((s) => s.slug === slug) ?? null,
    stop: async () => undefined,
  };
}

interface IndexerCalls {
  readonly reindex: { slug: string; path: string }[];
  readonly drop: { slug: string; path: string }[];
  readonly search: { slug: string; query: string; opts: SearchOptions | undefined }[];
}

interface ScopeFixture {
  readonly app: Hono;
  readonly calls: IndexerCalls;
  /** Absolute root of a configured vault. */
  root(slug: string): string;
  /** Index a file through the RAW indexer so setup never pollutes `calls`. */
  index(slug: string, path: string): Promise<void>;
  /** Forget every recorded call — run after fixture setup. */
  reset(): void;
  readonly stop: () => Promise<void>;
}

async function makeScopeFixture(
  label: string,
  slugs: readonly string[] = ["v"],
): Promise<ScopeFixture> {
  const dataDir = mkdtempSync(join(tmpdir(), `ob-${label}-`));
  for (const s of slugs) mkdirSync(join(dataDir, "vaults", s), { recursive: true });

  const cfg: Config = {
    obsidianAuthToken: undefined,
    vaults: slugs.map((s) => ({ name: s, slug: s })),
    dataDir,
    httpPort: 0,
    httpHost: "127.0.0.1",
    embeddingProvider: "transformers",
    embeddingModel: "x",
    logLevel: "error",
    syncConfigEnv: {},
    syncWatchdog: TEST_WATCHDOG_OFF,
  };

  const real = await startIndexer(cfg, { logger: silent(), embedder: buildHashEmbedder(8) });
  const calls: IndexerCalls = { reindex: [], drop: [], search: [] };
  // Pass-through recorder: the adapter sees a full `Indexer`, and every call
  // reaches the real one, so hits and counts are real.
  const indexer: Indexer = {
    status: (s) => real.status(s),
    list: () => real.list(),
    stop: () => real.stop(),
    reindex: async (s, p) => {
      calls.reindex.push({ slug: s, path: p });
      await real.reindex(s, p);
    },
    drop: async (s, p) => {
      calls.drop.push({ slug: s, path: p });
      await real.drop(s, p);
    },
    search: async (s, q, opts) => {
      calls.search.push({ slug: s, query: q, opts });
      return real.search(s, q, opts);
    },
  };

  const app = buildHttpApp({
    supervisor: fakeSupervisor(slugs),
    indexer,
    config: cfg,
    logger: silent(),
  });
  for (const s of slugs) await waitFor(() => real.status(s)?.state === "ready");

  return {
    app,
    calls,
    root: (slug) => join(dataDir, "vaults", slug),
    index: (slug, path) => real.reindex(slug, path),
    reset: () => {
      calls.reindex.length = 0;
      calls.drop.length = 0;
      calls.search.length = 0;
    },
    stop: async () => {
      await real.stop();
    },
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers (real transport, real app)
// ---------------------------------------------------------------------------

const ACCEPT = "application/json, text/event-stream";

let nextRpcId = 1;

async function post(app: Hono, path: string, body: unknown, sid?: string): Promise<Response> {
  const headers: Record<string, string> = { accept: ACCEPT, "content-type": "application/json" };
  if (sid !== undefined) headers["mcp-session-id"] = sid;
  return app.request(path, { method: "POST", headers, body: JSON.stringify(body) });
}

interface RpcError {
  jsonrpc: "2.0";
  id: number | null;
  error: { code: number; message: string };
}

function initializeBody(): unknown {
  return {
    jsonrpc: "2.0",
    id: nextRpcId++,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    },
  };
}

interface InitResult {
  res: Response;
  sid: string;
  result: { instructions?: string } | undefined;
  error: RpcError["error"] | undefined;
}

async function initialize(app: Hono, path: string): Promise<InitResult> {
  const res = await post(app, path, initializeBody());
  const body = (await res.json()) as {
    result?: { instructions?: string };
    error?: RpcError["error"];
  };
  return {
    res,
    sid: res.headers.get("mcp-session-id") ?? "",
    result: body.result,
    error: body.error,
  };
}

/** Initialize + the spec-mandated `notifications/initialized`, returning the id. */
async function openSession(app: Hono, path: string): Promise<string> {
  const init = await initialize(app, path);
  expect(init.res.status).toBe(200);
  expect(init.sid).not.toBe("");
  const notice = await post(
    app,
    path,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    init.sid,
  );
  expect([200, 202]).toContain(notice.status);
  return init.sid;
}

interface ToolCall {
  status: number;
  isError: boolean;
  parsed: unknown;
}

async function callTool(
  app: Hono,
  path: string,
  sid: string,
  name: string,
  args: unknown,
): Promise<ToolCall> {
  const res = await post(
    app,
    path,
    { jsonrpc: "2.0", id: nextRpcId++, method: "tools/call", params: { name, arguments: args } },
    sid,
  );
  const body = (await res.json()) as {
    result?: { isError?: boolean; content: { type: string; text: string }[] };
  };
  const text = body.result?.content[0]?.text ?? "null";
  return {
    status: res.status,
    isError: body.result?.isError === true,
    parsed: JSON.parse(text),
  };
}

async function rpc<T>(
  app: Hono,
  path: string,
  sid: string,
  method: string,
  params: unknown = {},
): Promise<T> {
  const res = await post(app, path, { jsonrpc: "2.0", id: nextRpcId++, method, params }, sid);
  const body = (await res.json()) as { result: T };
  return body.result;
}

interface ErrPayload {
  code: string;
  message: string;
}

function asError(parsed: unknown): ErrPayload {
  return parsed as ErrPayload;
}

interface FileItem {
  path: string;
}

interface Hit {
  path: string;
  text: string;
}

function write(root: string, rel: string, content: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

// ---------------------------------------------------------------------------
// Raw-target accessor (adapter level)
// ---------------------------------------------------------------------------

describe("raw request-target accessor", () => {
  /**
   * The scope MUST be parsed from the raw, un-normalized request target. This
   * pins WHICH accessor delivers that on this runtime — the choice
   * `src/mcp/index.ts` documents — by observing all three candidates through
   * a Hono sub-app mounted exactly the way the MCP routes are.
   */
  function probeApp(seen: Record<string, string>[]): Hono {
    const sub = new Hono();
    sub.post("/:slug/:prefix{.+}", (c) => {
      seen.push({
        reqUrl: c.req.url,
        reqPath: c.req.path,
        urlPathname: new URL(c.req.url).pathname,
        paramPrefix: c.req.param("prefix"),
        routePath: c.req.routePath,
      });
      return c.json({ ok: true });
    });
    const app = new Hono();
    app.route("/mcp", sub);
    return app;
  }

  async function probe(target: string): Promise<Record<string, string>> {
    const seen: Record<string, string>[] = [];
    const res = await probeApp(seen).request(target, { method: "POST" });
    expect(res.status).toBe(200);
    return seen[0] as Record<string, string>;
  }

  test("c.req.url preserves %2F and %252e%252e; c.req.path does not", async () => {
    const encodedSeparator = await probe("/mcp/v/agents/%2Fetc");
    // The chosen accessor keeps the escape intact, so `parseScope`'s single
    // decode sees a segment containing "/" and rejects it.
    expect(encodedSeparator.reqUrl).toContain("/mcp/v/agents/%2Fetc");
    // `c.req.param` has already folded the escape into path structure — the
    // separator is undetectable by the time it is read.
    expect(encodedSeparator.paramPrefix).toBe("agents//etc");

    const doubleEncoded = await probe("/mcp/v/agents/%252e%252e");
    expect(doubleEncoded.reqUrl).toContain("/mcp/v/agents/%252e%252e");
    expect(doubleEncoded.reqUrl?.endsWith("/mcp/v/agents/%252e%252e")).toBe(true);
    // `c.req.param` decoded it once already, so a second decode downstream
    // would turn a literal folder name into a traversal.
    expect(doubleEncoded.paramPrefix).toBe("agents/%2e%2e");

    const encodedTraversal = await probe("/mcp/v/agents/%2e%2e%2fetc");
    expect(encodedTraversal.reqUrl).toContain("/mcp/v/agents/%2e%2e%2fetc");
    // Hono derives `c.req.path` as `decodeURI` over the raw path, which is a
    // PARTIAL decode: the dots are gone, the separator is not. It is
    // therefore already-decoded text, and `parseScope` decodes exactly once
    // more — one decode too many for a value that is not the raw target.
    expect(encodedTraversal.reqPath).toBe("/mcp/v/agents/..%2fetc");
    expect((await probe("/mcp/v/agents/%5Cetc")).reqPath).toBe("/mcp/v/agents/\\etc");
  });

  test("routePath carries the mount prefix, so the accessor can strip it", async () => {
    const seen = await probe("/mcp/v/agents/a");
    expect(seen.routePath).toBe("/mcp/:slug/:prefix{.+}");
    expect(seen.reqUrl?.endsWith("/mcp/v/agents/a")).toBe(true);
  });

  test("a bare %2e%2e segment is collapsed by the runtime before any accessor", () => {
    // Documented runtime behavior, not a property of this code: Bun's WHATWG
    // URL parser resolves single- and double-dot segments — including their
    // percent-encoded spellings — while constructing the `Request`. So a bare
    // `%2e%2e` segment never reaches ANY accessor, and the traversal it would
    // have expressed is resolved outward into a different (or unroutable)
    // URL rather than into an escape. `%2e%2e%2f`, which the change document
    // uses, is not a dot segment to the parser and does survive intact.
    expect(new Request("http://h/mcp/v/agents/%2e%2e/x").url).toBe("http://h/mcp/v/x");
    expect(new Request("http://h/mcp/v/agents/%2e%2e%2fetc").url).toBe(
      "http://h/mcp/v/agents/%2e%2e%2fetc",
    );
  });
});

// ---------------------------------------------------------------------------
// Scope rejection — no session, no allocation
// ---------------------------------------------------------------------------

describe("scope rejection", () => {
  const badScopes: readonly [string, string][] = [
    ["percent-encoded traversal", "/mcp/v/agents/%2e%2e%2fetc"],
    ["hidden segment", "/mcp/v/.obsidian"],
    ["encoded forward separator", "/mcp/v/agents/%2Fetc"],
    ["encoded backslash separator", "/mcp/v/agents/%5Cetc"],
    ["malformed percent escape", "/mcp/v/agents/%ZZ"],
    ["NUL byte", "/mcp/v/agents/a%00b"],
  ];

  for (const [label, path] of badScopes) {
    test(`${label} is 400 with no session and nothing on disk`, async () => {
      const fx = await makeScopeFixture(`sc-bad-${label.replace(/\W+/g, "")}`);
      cleanup.push(fx.stop);
      const init = await initialize(fx.app, path);
      expect(init.res.status).toBe(400);
      expect(init.error?.code).toBe(-32000);
      expect(init.error?.message).toBe("Bad Request: invalid MCP scope");
      expect(init.res.headers.get("mcp-session-id")).toBeNull();
      // Nothing was created for the rejected scope.
      expect(existsSync(join(fx.root("v"), "agents"))).toBe(false);
      // A subsequent initialize on a valid scope still succeeds.
      const ok = await initialize(fx.app, "/mcp/v/agents/a");
      expect(ok.res.status).toBe(200);
      expect(ok.sid).not.toBe("");
    });
  }

  test("a double-encoded segment is a literal folder name, not traversal", async () => {
    const fx = await makeScopeFixture("sc-dbl");
    cleanup.push(fx.stop);
    // Exactly ONE decode: `%252e%252e` becomes the literal name `%2e%2e`.
    const sid = await openSession(fx.app, "/mcp/v/%252e%252e");
    const r = await callTool(fx.app, "/mcp/v/%252e%252e", sid, "write_file", {
      path: "memory.md",
      content: "hello",
    });
    expect(r.isError).toBe(false);
    expect(existsSync(join(fx.root("v"), "%2e%2e", "memory.md"))).toBe(true);
    // A second decode would have written to the vault's parent.
    expect(existsSync(join(fx.root("v"), "..", "memory.md"))).toBe(false);
  });

  test("an unknown vault is 404 with the same envelope shape", async () => {
    const fx = await makeScopeFixture("sc-nov");
    cleanup.push(fx.stop);
    const init = await initialize(fx.app, "/mcp/nope/agents/a");
    expect(init.res.status).toBe(404);
    expect(init.error?.code).toBe(-32000);
    expect(init.error?.message).toBe('Not Found: unknown vault "nope"');
    expect(init.res.headers.get("mcp-session-id")).toBeNull();

    const bare = await initialize(fx.app, "/mcp/nope");
    expect(bare.res.status).toBe(404);
    expect(bare.error?.message).toBe('Not Found: unknown vault "nope"');
  });

  test("a symlinked scope root is refused at bind", async () => {
    const fx = await makeScopeFixture("sc-sym");
    cleanup.push(fx.stop);
    mkdirSync(join(fx.root("v"), "agents"), { recursive: true });
    symlinkSync("/etc", join(fx.root("v"), "agents", "evil"));
    const init = await initialize(fx.app, "/mcp/v/agents/evil");
    expect(init.res.status).toBe(400);
    expect(init.error?.code).toBe(-32000);
    expect(init.res.headers.get("mcp-session-id")).toBeNull();
  });

  test("a query string on a scoped URL is not part of the scope", async () => {
    const fx = await makeScopeFixture("sc-qs");
    cleanup.push(fx.stop);
    const sid = await openSession(fx.app, "/mcp/v/agents/a?trace=1");
    const r = await callTool(fx.app, "/mcp/v/agents/a?trace=1", sid, "write_file", {
      path: "memory.md",
      content: "hi",
    });
    expect(r.isError).toBe(false);
    expect(existsSync(join(fx.root("v"), "agents", "a", "memory.md"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Containment
// ---------------------------------------------------------------------------

describe("scoped containment", () => {
  test("a scoped write lands under the prefix and reindexes the full path", async () => {
    const fx = await makeScopeFixture("sc-write");
    cleanup.push(fx.stop);
    fx.reset();
    const sid = await openSession(fx.app, "/mcp/v/agents/a");
    // No `vault` argument at all — the URL already fixed it.
    const r = await callTool(fx.app, "/mcp/v/agents/a", sid, "write_file", {
      path: "memory.md",
      content: "hello",
    });
    expect(r.isError).toBe(false);
    expect((r.parsed as FileItem).path).toBe("memory.md");
    expect(readFileSync(join(fx.root("v"), "agents", "a", "memory.md"), "utf8")).toBe("hello");
    expect(fx.calls.reindex).toEqual([{ slug: "v", path: "agents/a/memory.md" }]);
  });

  test("traversal out of the scope is rejected and leaks no path", async () => {
    const fx = await makeScopeFixture("sc-trav");
    cleanup.push(fx.stop);
    write(fx.root("v"), "agents/b/secret.md", "TOP SECRET");
    mkdirSync(join(fx.root("v"), "agents", "a"), { recursive: true });
    const sid = await openSession(fx.app, "/mcp/v/agents/a");
    const r = await callTool(fx.app, "/mcp/v/agents/a", sid, "read_file", {
      path: "../b/secret.md",
    });
    expect(r.isError).toBe(true);
    const err = asError(r.parsed);
    expect(err.code).toBe("invalid_path");
    expect(err.message).not.toContain("agents/a");
    expect(err.message).not.toContain(fx.root("v"));
    expect(JSON.stringify(r.parsed)).not.toContain("TOP SECRET");
    // The sibling file is untouched.
    expect(readFileSync(join(fx.root("v"), "agents/b/secret.md"), "utf8")).toBe("TOP SECRET");
  });

  test("sibling scopes are mutually invisible", async () => {
    const fx = await makeScopeFixture("sc-sib");
    cleanup.push(fx.stop);
    write(fx.root("v"), "agents/a/note.md", "a");
    write(fx.root("v"), "agents/b/note.md", "b");
    const sid = await openSession(fx.app, "/mcp/v/agents/a");
    const r = await callTool(fx.app, "/mcp/v/agents/a", sid, "list_files", {});
    expect(r.isError).toBe(false);
    const page = r.parsed as { items: FileItem[]; nextCursor: string | null };
    expect(page.items.map((i) => i.path)).toEqual(["note.md"]);

    // And the other direction, from a session on the sibling.
    const sidB = await openSession(fx.app, "/mcp/v/agents/b");
    const rb = await callTool(fx.app, "/mcp/v/agents/b", sidB, "read_file", { path: "note.md" });
    expect(rb.isError).toBe(false);
    expect((rb.parsed as { content: string }).content).toBe("b");
    const cross = await callTool(fx.app, "/mcp/v/agents/b", sidB, "read_file", {
      path: "../a/note.md",
    });
    expect(cross.isError).toBe(true);
    expect(asError(cross.parsed).code).toBe("invalid_path");
  });

  test("the prefix boundary is not a string prefix (agents/a vs agents/ab)", async () => {
    const fx = await makeScopeFixture("sc-bound");
    cleanup.push(fx.stop);
    write(fx.root("v"), "agents/a/note.md", "# alpha coffee note");
    write(fx.root("v"), "agents/ab/other.md", "# alpha coffee other");
    await fx.index("v", "agents/a/note.md");
    await fx.index("v", "agents/ab/other.md");
    fx.reset();

    const sid = await openSession(fx.app, "/mcp/v/agents/a");
    const listed = await callTool(fx.app, "/mcp/v/agents/a", sid, "list_files", {});
    const page = listed.parsed as { items: FileItem[] };
    expect(page.items.map((i) => i.path)).toEqual(["note.md"]);

    const searched = await callTool(fx.app, "/mcp/v/agents/a", sid, "search", {
      query: "alpha coffee",
      limit: 20,
    });
    expect(searched.isError).toBe(false);
    const { hits } = searched.parsed as { hits: Hit[] };
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(h.path).toBe("note.md");
      expect(h.text).not.toContain("other");
    }
    // The forced filter carries the trailing slash — that is the difference
    // between `agents/a/` and a `starts_with` match on `agents/ab/`.
    expect(fx.calls.search[0]?.opts?.filter?.pathPrefix).toBe("agents/a/");
  });

  test("search is confined, scope-relative, and forces the prefix filter", async () => {
    const fx = await makeScopeFixture("sc-search");
    cleanup.push(fx.stop);
    write(fx.root("v"), "agents/a/coffee.md", "# Coffee brewing methods for pour over");
    write(fx.root("v"), "notes/coffee.md", "# Coffee brewing methods for pour over");
    await fx.index("v", "agents/a/coffee.md");
    await fx.index("v", "notes/coffee.md");
    fx.reset();

    const sid = await openSession(fx.app, "/mcp/v/agents/a");
    const r = await callTool(fx.app, "/mcp/v/agents/a", sid, "search", {
      query: "how do I make pour over",
      limit: 20,
    });
    expect(r.isError).toBe(false);
    const { hits } = r.parsed as { hits: Hit[] };
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) expect(h.path).toBe("coffee.md");
    expect(fx.calls.search).toHaveLength(1);
    expect(fx.calls.search[0]?.opts?.filter?.pathPrefix).toBe("agents/a/");
  });

  test("a caller-supplied search filter nests under the scope", async () => {
    const fx = await makeScopeFixture("sc-filter");
    cleanup.push(fx.stop);
    mkdirSync(join(fx.root("v"), "agents", "a"), { recursive: true });
    fx.reset();
    const sid = await openSession(fx.app, "/mcp/v/agents/a");

    const nested = await callTool(fx.app, "/mcp/v/agents/a", sid, "search", {
      query: "anything",
      filter: { pathPrefix: "journal" },
    });
    expect(nested.isError).toBe(false);
    expect(fx.calls.search[0]?.opts?.filter?.pathPrefix).toBe("agents/a/journal");

    const escaping = await callTool(fx.app, "/mcp/v/agents/a", sid, "search", {
      query: "anything",
      filter: { pathPrefix: "../b" },
    });
    expect(escaping.isError).toBe(true);
    expect(asError(escaping.parsed).code).toBe("invalid_path");
    // The rejected filter never reached the indexer.
    expect(fx.calls.search).toHaveLength(1);
  });

  test("an empty scope is usable immediately and is not created eagerly", async () => {
    const fx = await makeScopeFixture("sc-empty");
    cleanup.push(fx.stop);
    const sid = await openSession(fx.app, "/mcp/v/agents/new");
    // Binding alone must not materialize the folder.
    expect(existsSync(join(fx.root("v"), "agents", "new"))).toBe(false);

    const listed = await callTool(fx.app, "/mcp/v/agents/new", sid, "list_files", {});
    expect(listed.isError).toBe(false);
    expect(listed.parsed).toEqual({ items: [], nextCursor: null });
    expect(existsSync(join(fx.root("v"), "agents", "new"))).toBe(false);

    const written = await callTool(fx.app, "/mcp/v/agents/new", sid, "write_file", {
      path: "memory.md",
      content: "first",
    });
    expect(written.isError).toBe(false);
    expect(readFileSync(join(fx.root("v"), "agents/new/memory.md"), "utf8")).toBe("first");
  });

  test("a scope root swapped for a symlink mid-session is refused", async () => {
    const fx = await makeScopeFixture("sc-swap");
    cleanup.push(fx.stop);
    const scopeRoot = join(fx.root("v"), "agents", "a");
    mkdirSync(scopeRoot, { recursive: true });
    const sid = await openSession(fx.app, "/mcp/v/agents/a");
    // Works while the root is a real directory.
    const before = await callTool(fx.app, "/mcp/v/agents/a", sid, "list_files", {});
    expect(before.isError).toBe(false);

    rmSync(scopeRoot, { recursive: true });
    symlinkSync("/etc", scopeRoot);

    const read = await callTool(fx.app, "/mcp/v/agents/a", sid, "read_file", { path: "passwd" });
    expect(read.isError).toBe(true);
    expect(asError(read.parsed).code).toBe("invalid_path");
    // Nothing outside the vault was read.
    expect(JSON.stringify(read.parsed)).not.toContain("root:");

    // `resources/list` walks the root itself, so it is guarded too.
    const listed = await callTool(fx.app, "/mcp/v/agents/a", sid, "list_files", {});
    expect(listed.isError).toBe(true);
    expect(asError(listed.parsed).code).toBe("invalid_path");
    const resErr = await post(
      fx.app,
      "/mcp/v/agents/a",
      { jsonrpc: "2.0", id: nextRpcId++, method: "resources/list", params: {} },
      sid,
    );
    const resBody = (await resErr.json()) as { error?: { code: number } };
    expect(resBody.error?.code).toBe(-32002);
  });
});

// ---------------------------------------------------------------------------
// Vault visibility + implicit vault argument
// ---------------------------------------------------------------------------

describe("scoped vault visibility", () => {
  test("only the scoped vault is visible", async () => {
    const fx = await makeScopeFixture("sc-vis", ["v", "w"]);
    cleanup.push(fx.stop);
    mkdirSync(join(fx.root("v"), "agents", "a"), { recursive: true });
    const sid = await openSession(fx.app, "/mcp/v/agents/a");

    const vaults = await callTool(fx.app, "/mcp/v/agents/a", sid, "list_vaults", {});
    expect(vaults.isError).toBe(false);
    const list = vaults.parsed as { slug: string }[];
    expect(list).toHaveLength(1);
    expect(list[0]?.slug).toBe("v");

    const otherStatus = await callTool(fx.app, "/mcp/v/agents/a", sid, "vault_status", {
      vault: "w",
    });
    expect(otherStatus.isError).toBe(true);
    expect(asError(otherStatus.parsed).code).toBe("vault_not_found");

    const otherRead = await callTool(fx.app, "/mcp/v/agents/a", sid, "read_file", {
      vault: "w",
      path: "x.md",
    });
    expect(otherRead.isError).toBe(true);
    expect(asError(otherRead.parsed).code).toBe("vault_not_found");
  });

  test("the vault argument is optional, matching is accepted, mismatching is not", async () => {
    const fx = await makeScopeFixture("sc-vaultarg", ["v", "w"]);
    cleanup.push(fx.stop);
    write(fx.root("v"), "agents/a/note.md", "n");
    const path = "/mcp/v/agents/a";
    const sid = await openSession(fx.app, path);

    const omitted = await callTool(fx.app, path, sid, "read_file", { path: "note.md" });
    expect(omitted.isError).toBe(false);
    const matching = await callTool(fx.app, path, sid, "read_file", {
      vault: "v",
      path: "note.md",
    });
    expect(matching.isError).toBe(false);
    expect(matching.parsed).toEqual(omitted.parsed);
    const mismatched = await callTool(fx.app, path, sid, "read_file", {
      vault: "w",
      path: "note.md",
    });
    expect(mismatched.isError).toBe(true);
    expect(asError(mismatched.parsed).code).toBe("vault_not_found");
  });

  test("scoped tools/list drops vault from required and notes vault-wide counts", async () => {
    const fx = await makeScopeFixture("sc-schema");
    cleanup.push(fx.stop);
    mkdirSync(join(fx.root("v"), "agents", "a"), { recursive: true });
    const scopedSid = await openSession(fx.app, "/mcp/v/agents/a");
    const plainSid = await openSession(fx.app, "/mcp");

    interface ToolInfo {
      name: string;
      description: string;
      inputSchema: { required?: string[] } & Record<string, unknown>;
    }
    const scoped = await rpc<{ tools: ToolInfo[] }>(
      fx.app,
      "/mcp/v/agents/a",
      scopedSid,
      "tools/list",
    );
    const plain = await rpc<{ tools: ToolInfo[] }>(fx.app, "/mcp", plainSid, "tools/list");
    expect(scoped.tools.map((t) => t.name)).toEqual(plain.tools.map((t) => t.name));

    for (const [i, tool] of scoped.tools.entries()) {
      const base = plain.tools[i] as ToolInfo;
      const { required: scopedReq, ...scopedRest } = tool.inputSchema;
      const { required: plainReq, ...plainRest } = base.inputSchema;
      // Everything except `required` is identical — the Zod schemas are never
      // forked, only the advertised `required` array is transformed.
      expect(scopedRest).toEqual(plainRest);
      expect(scopedReq ?? []).not.toContain("vault");
      // The scoped `required` is the unscoped one minus exactly "vault".
      expect((scopedReq ?? []).slice().sort()).toEqual(
        (plainReq ?? []).filter((k) => k !== "vault").sort(),
      );
    }

    const scopedStatus = scoped.tools.find((t) => t.name === "vault_status") as ToolInfo;
    const plainStatus = plain.tools.find((t) => t.name === "vault_status") as ToolInfo;
    expect(scopedStatus.description).toBe(`${plainStatus.description} ${VAULT_WIDE_COUNTS_NOTE}`);
    // Only `vault_status` carries the note.
    const others = scoped.tools.filter((t) => t.name !== "vault_status");
    for (const t of others) expect(t.description).not.toContain(VAULT_WIDE_COUNTS_NOTE);
  });

  test("a scoped initialize carries instructions; an unscoped one does not", async () => {
    const fx = await makeScopeFixture("sc-instr");
    cleanup.push(fx.stop);
    mkdirSync(join(fx.root("v"), "agents", "a"), { recursive: true });
    const scoped = await initialize(fx.app, "/mcp/v/agents/a");
    expect(scoped.result?.instructions).toBe(SCOPED_INSTRUCTIONS);
    const plain = await initialize(fx.app, "/mcp");
    expect(plain.result?.instructions).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Session binding
// ---------------------------------------------------------------------------

describe("session scope binding", () => {
  test("a session id cannot hop to a sibling scope", async () => {
    const fx = await makeScopeFixture("sc-hop");
    cleanup.push(fx.stop);
    mkdirSync(join(fx.root("v"), "agents", "a"), { recursive: true });
    const sid = await openSession(fx.app, "/mcp/v/agents/a");

    const res = await post(
      fx.app,
      "/mcp/v/agents/b",
      {
        jsonrpc: "2.0",
        id: nextRpcId++,
        method: "tools/call",
        params: { name: "write_file", arguments: { path: "pwned.md", content: "x" } },
      },
      sid,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as RpcError;
    expect(body.error.code).toBe(-32001);
    // The call was not executed.
    expect(existsSync(join(fx.root("v"), "agents", "b"))).toBe(false);
    expect(existsSync(join(fx.root("v"), "agents", "a", "pwned.md"))).toBe(false);
  });

  test("a scoped session id is rejected on the unscoped mount and vice versa", async () => {
    const fx = await makeScopeFixture("sc-cross");
    cleanup.push(fx.stop);
    mkdirSync(join(fx.root("v"), "agents", "a"), { recursive: true });
    const scopedSid = await openSession(fx.app, "/mcp/v/agents/a");
    const plainSid = await openSession(fx.app, "/mcp");

    const onPlain = await post(
      fx.app,
      "/mcp",
      { jsonrpc: "2.0", id: nextRpcId++, method: "tools/list", params: {} },
      scopedSid,
    );
    expect(onPlain.status).toBe(404);
    expect(((await onPlain.json()) as RpcError).error.code).toBe(-32001);

    const onScoped = await post(
      fx.app,
      "/mcp/v/agents/a",
      { jsonrpc: "2.0", id: nextRpcId++, method: "tools/list", params: {} },
      plainSid,
    );
    expect(onScoped.status).toBe(404);
    expect(((await onScoped.json()) as RpcError).error.code).toBe(-32001);

    // A vault-root scope is a distinct scope from a prefixed one, too.
    const onRoot = await post(
      fx.app,
      "/mcp/v",
      { jsonrpc: "2.0", id: nextRpcId++, method: "tools/list", params: {} },
      scopedSid,
    );
    expect(onRoot.status).toBe(404);
  });

  test("URL aliases of one scope share a session", async () => {
    const fx = await makeScopeFixture("sc-alias");
    cleanup.push(fx.stop);
    write(fx.root("v"), "agents/a/note.md", "n");
    const sid = await openSession(fx.app, "/mcp/v/agents/a");
    for (const alias of ["/mcp/v/agents/a/", "/mcp/v/agents/./a", "/mcp/v//agents/a"]) {
      const r = await callTool(fx.app, alias, sid, "read_file", { path: "note.md" });
      expect(r.isError).toBe(false);
      expect((r.parsed as { content: string }).content).toBe("n");
    }
  });

  test("GET and DELETE honor the scope binding", async () => {
    const fx = await makeScopeFixture("sc-getdel");
    cleanup.push(fx.stop);
    mkdirSync(join(fx.root("v"), "agents", "a"), { recursive: true });
    const sid = await openSession(fx.app, "/mcp/v/agents/a");

    const noSid = await fx.app.request("/mcp/v/agents/a", { method: "GET" });
    expect(noSid.status).toBe(400);
    expect(((await noSid.json()) as RpcError).error.code).toBe(-32000);

    const wrongScope = await fx.app.request("/mcp/v/agents/b", {
      method: "GET",
      headers: { accept: "text/event-stream", "mcp-session-id": sid },
    });
    expect(wrongScope.status).toBe(404);

    const badScope = await fx.app.request("/mcp/v/agents/%ZZ", {
      method: "DELETE",
      headers: { "mcp-session-id": sid },
    });
    expect(badScope.status).toBe(400);

    const sse = await fx.app.request("/mcp/v/agents/a", {
      method: "GET",
      headers: { accept: "text/event-stream", "mcp-session-id": sid },
    });
    expect(sse.status).toBe(200);
    await sse.body?.cancel();

    const delWrong = await fx.app.request("/mcp/v/agents/b", {
      method: "DELETE",
      headers: { "mcp-session-id": sid },
    });
    expect(delWrong.status).toBe(404);

    const del = await fx.app.request("/mcp/v/agents/a", {
      method: "DELETE",
      headers: { "mcp-session-id": sid },
    });
    expect([200, 204]).toContain(del.status);
    const after = await callTool(fx.app, "/mcp/v/agents/a", sid, "list_files", {});
    expect(after.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

describe("scoped resource surface", () => {
  test("resources/list paginates only the scoped vault, scope-relative", async () => {
    const fx = await makeScopeFixture("sc-res", ["v", "w"]);
    cleanup.push(fx.stop);
    write(fx.root("v"), "agents/a/mine.md", "mine");
    write(fx.root("v"), "outside.md", "outside");
    write(fx.root("w"), "other.md", "other");
    const path = "/mcp/v/agents/a";
    const sid = await openSession(fx.app, path);

    const listed = await rpc<{ resources: { uri: string; name: string }[]; nextCursor?: string }>(
      fx.app,
      path,
      sid,
      "resources/list",
    );
    expect(listed.resources.map((r) => r.uri)).toEqual(["obvault://v/mine.md"]);
    expect(listed.resources[0]?.name).toBe("mine.md");
    // The second vault must NOT be paged into: the slug provider returns only
    // the scoped slug.
    expect(listed.nextCursor).toBeUndefined();

    const read = await rpc<{ contents: { uri: string; text: string }[] }>(
      fx.app,
      path,
      sid,
      "resources/read",
      { uri: "obvault://v/mine.md" },
    );
    expect(read.contents[0]?.text).toBe("mine");

    // Scope-relative only: the vault-relative path is not addressable.
    const outside = await post(
      fx.app,
      path,
      {
        jsonrpc: "2.0",
        id: nextRpcId++,
        method: "resources/read",
        params: { uri: "obvault://v/agents/a/mine.md" },
      },
      sid,
    );
    expect(((await outside.json()) as { error: { code: number } }).error.code).toBe(-32002);

    const otherVault = await post(
      fx.app,
      path,
      {
        jsonrpc: "2.0",
        id: nextRpcId++,
        method: "resources/read",
        params: { uri: "obvault://w/other.md" },
      },
      sid,
    );
    expect(((await otherVault.json()) as { error: { code: number } }).error.code).toBe(-32002);
  });
});

// ---------------------------------------------------------------------------
// Vault-root scope + unscoped mount
// ---------------------------------------------------------------------------

describe("vault-root scope", () => {
  test("/mcp/v behaves like the unscoped mount narrowed to one vault", async () => {
    const fx = await makeScopeFixture("sc-root", ["v", "w"]);
    cleanup.push(fx.stop);
    write(fx.root("v"), "agents/a/note.md", "# alpha coffee note");
    write(fx.root("v"), "notes/coffee.md", "# alpha coffee brew");
    write(fx.root("w"), "elsewhere.md", "# alpha coffee elsewhere");
    await fx.index("v", "agents/a/note.md");
    await fx.index("v", "notes/coffee.md");
    await fx.index("w", "elsewhere.md");
    fx.reset();

    const rootSid = await openSession(fx.app, "/mcp/v");
    const plainSid = await openSession(fx.app, "/mcp");

    const scopedList = await callTool(fx.app, "/mcp/v", rootSid, "list_files", {});
    const plainList = await callTool(fx.app, "/mcp", plainSid, "list_files", { vault: "v" });
    expect(scopedList.parsed).toEqual(plainList.parsed);
    expect((scopedList.parsed as { items: FileItem[] }).items.map((i) => i.path).sort()).toEqual([
      "agents/a/note.md",
      "notes/coffee.md",
    ]);

    const args = { query: "alpha coffee", limit: 20 } as const;
    const scopedSearch = await callTool(fx.app, "/mcp/v", rootSid, "search", args);
    const plainSearch = await callTool(fx.app, "/mcp", plainSid, "search", { vault: "v", ...args });
    expect(scopedSearch.parsed).toEqual(plainSearch.parsed);
    // No forced filter in the vault-root scope — a literal "/" prefix would
    // match nothing and silently empty every search.
    expect(fx.calls.search[0]?.opts?.filter?.pathPrefix).toBeUndefined();

    const other = await callTool(fx.app, "/mcp/v", rootSid, "vault_status", { vault: "w" });
    expect(other.isError).toBe(true);
    expect(asError(other.parsed).code).toBe("vault_not_found");
  });

  test("the unscoped mount still requires an explicit vault", async () => {
    const fx = await makeScopeFixture("sc-unscoped");
    cleanup.push(fx.stop);
    write(fx.root("v"), "note.md", "n");
    const sid = await openSession(fx.app, "/mcp");
    const missing = await callTool(fx.app, "/mcp", sid, "read_file", { path: "note.md" });
    expect(missing.isError).toBe(true);
    expect(asError(missing.parsed).code).toBe("invalid_input");
    const ok = await callTool(fx.app, "/mcp", sid, "read_file", { vault: "v", path: "note.md" });
    expect(ok.isError).toBe(false);
    expect((ok.parsed as { content: string }).content).toBe("n");
  });
});

// ---------------------------------------------------------------------------
// Per-scope memo
// ---------------------------------------------------------------------------

describe("per-scope surface memo", () => {
  /**
   * The memo is not client-observable by design — an evicted surface is just
   * rebuilt. It IS observable through `deps.vault`, though: resolving a scope
   * costs two lookups (the `parseScope` predicate plus the descriptor), and
   * BUILDING a surface costs a third (inside `scopeDeps`). So a third lookup
   * on a repeat request means "rebuilt", and exactly two means "memo hit".
   */
  function countingApp(): { app: Hono; lookups: string[]; vaultRoot: string } {
    const vaultRoot = mkdtempSync(join(tmpdir(), "ob-sc-lru-"));
    const lookups: string[] = [];
    const indexer: Indexer = {
      status: () => null,
      list: () => [],
      search: async () => [],
      reindex: async () => undefined,
      drop: async () => undefined,
      stop: async () => undefined,
    };
    const deps: McpRoutesDeps = {
      vault: (slug: string): VaultDescriptor | null => {
        lookups.push(slug);
        return slug === "v" ? { slug: "v", name: "v", root: vaultRoot } : null;
      },
      indexer,
      supervisor: fakeSupervisor(["v"]),
      logger: silent(),
    };
    const app = new Hono();
    app.route("/mcp", buildMcpRoutes(deps));
    return { app, lookups, vaultRoot };
  }

  test("surfaces are memoized per scope and evicted least-recently-used first", async () => {
    const { app, lookups, vaultRoot } = countingApp();
    cleanup.push(async () => rmSync(vaultRoot, { recursive: true, force: true }));

    const cost = async (prefix: string): Promise<number> => {
      const before = lookups.length;
      const init = await initialize(app, `/mcp/v/${prefix}`);
      expect(init.res.status).toBe(200);
      return lookups.length - before;
    };

    expect(await cost("s0")).toBe(3); // resolve (2) + build (1)
    expect(await cost("s0")).toBe(2); // memo hit

    // Fill the memo to exactly the cap.
    for (let i = 1; i < SCOPE_SURFACE_CACHE_MAX; i++) expect(await cost(`s${i}`)).toBe(3);
    // Touch the oldest entry so it becomes the MOST recently used.
    expect(await cost("s0")).toBe(2);

    // One past the cap evicts the least recently used — `s1`, not `s0`.
    expect(await cost(`s${SCOPE_SURFACE_CACHE_MAX}`)).toBe(3);
    expect(await cost("s1")).toBe(3); // was evicted, rebuilt
    expect(await cost("s0")).toBe(2); // still cached: LRU, not FIFO
  });
});

/**
 * Unit tests for `src/mcp/scope.ts`.
 *
 * Every containment assertion drives the REAL `safeJoin` /
 * `assertSafeRelativePath` / `assertNotSymlinkEscape` against REAL on-disk
 * tmpdirs — no `fs` mocking — matching `test/vault/files.test.ts`. The only
 * doubles here are the supervisor and the indexer, which are process-level
 * services with no filesystem semantics of their own.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { InvalidPathError, MAX_PATH_BYTES, OBError } from "../../src/errors.ts";
import type { Indexer, IndexerStatus, SearchHit, SearchOptions } from "../../src/indexer/index.ts";
import type { McpRoutesDeps } from "../../src/mcp/index.ts";
import type { ResourceHandler } from "../../src/mcp/resources.ts";
import {
  type McpScope,
  type ScopeParseResult,
  assertScopeRootSafe,
  guardResourceHandler,
  guardToolDefinition,
  parseScope,
  scopeDeps,
  scopeKey,
  scopeRootPath,
  scopeStatusDeps,
} from "../../src/mcp/scope.ts";
import { tool } from "../../src/mcp/tool.ts";
import { listVaultsTool } from "../../src/mcp/tools/list_vaults.ts";
import { vaultStatusTool } from "../../src/mcp/tools/vault_status.ts";
import type { Supervisor, VaultStatus } from "../../src/obsidian/index.ts";
import { listFiles, readFile, writeFile } from "../../src/vault/files.ts";
import type { VaultDescriptor } from "../../src/vault/files.ts";
import { type StatusDeps, listVaults, vaultStatus } from "../../src/vault/status.ts";
import { makeVaultStatus } from "../helpers/vaultStatus.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface IndexerCalls {
  readonly reindex: { slug: string; path: string }[];
  readonly drop: { slug: string; path: string }[];
  readonly search: { slug: string; query: string; opts: SearchOptions | undefined }[];
  readonly status: string[];
  readonly list: number[];
  readonly stop: number[];
}

function emptyCalls(): IndexerCalls {
  return { reindex: [], drop: [], search: [], status: [], list: [], stop: [] };
}

function idxStatus(slug: string): IndexerStatus {
  return {
    slug,
    state: "ready",
    documents: 3,
    chunks: 9,
    lastIndexedAt: 1,
    pending: 0,
    errors: 0,
  };
}

function syncStatus(slug: string): VaultStatus {
  return makeVaultStatus({ slug });
}

function hit(path: string, over: Partial<SearchHit> = {}): SearchHit {
  return {
    path,
    chunkIndex: 0,
    headingPath: ["H"],
    text: "body",
    score: 0.5,
    frontmatter: { a: 1 },
    links: ["Other Note"],
    tags: ["t"],
    ...over,
  };
}

interface ScopeFixture {
  readonly deps: McpRoutesDeps;
  readonly statusDeps: StatusDeps;
  readonly dataDir: string;
  readonly calls: IndexerCalls;
  /** Absolute root of a configured vault. */
  root(slug: string): string;
  setHits(hits: readonly SearchHit[]): void;
}

/**
 * Build real vault roots under a tmpdir plus a recording supervisor/indexer.
 * `slugs[0]` is the vault the tests scope into.
 */
function makeScopeFixture(slugs: readonly string[] = ["v"]): ScopeFixture {
  const dataDir = mkdtempSync(join(tmpdir(), "ob-scope-"));
  for (const s of slugs) mkdirSync(join(dataDir, "vaults", s), { recursive: true });
  const root = (slug: string): string => join(dataDir, "vaults", slug);

  const calls = emptyCalls();
  let hits: readonly SearchHit[] = [];

  const indexer: Indexer = {
    status: (s) => {
      calls.status.push(s);
      return slugs.includes(s) ? idxStatus(s) : null;
    },
    list: () => {
      calls.list.push(1);
      return slugs.map(idxStatus);
    },
    stop: async () => {
      calls.stop.push(1);
    },
    reindex: async (s, p) => {
      calls.reindex.push({ slug: s, path: p });
    },
    drop: async (s, p) => {
      calls.drop.push({ slug: s, path: p });
    },
    search: async (s, q, opts) => {
      calls.search.push({ slug: s, query: q, opts });
      return hits.slice();
    },
  };

  const supervisor: Supervisor = {
    list: () => slugs.map(syncStatus),
    get: (s) => (slugs.includes(s) ? syncStatus(s) : null),
    stop: async () => undefined,
  };

  const deps: McpRoutesDeps = {
    vault: (s): VaultDescriptor | null =>
      slugs.includes(s) ? { slug: s, name: s, root: root(s) } : null,
    indexer,
    supervisor,
  };

  return {
    deps,
    statusDeps: { supervisor, indexer },
    dataDir,
    calls,
    root,
    setHits: (h): void => {
      hits = h;
    },
  };
}

/** Every configured slug in the fixtures below. */
const hasV = (s: string): boolean => s === "v";

/**
 * A path component past POSIX `NAME_MAX` (255). `lstat` on it fails
 * ENAMETOOLONG on every filesystem and for every user, which makes it the one
 * deterministic way to drive `assertNotSymlinkEscape`'s raw-rethrow branch —
 * a `chmod 000` EACCES fixture would silently stop failing when the suite runs
 * as root.
 */
const LONG_SEGMENT = "a".repeat(300);

function expectOk(result: ReturnType<typeof parseScope>): McpScope {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.rejection)}`);
  return result.scope;
}

// ---------------------------------------------------------------------------
// parseScope
// ---------------------------------------------------------------------------

describe("parseScope", () => {
  test("resolves slug + multi-segment prefix", () => {
    const scope = expectOk(parseScope(["v", "agents", "a"], hasV));
    expect(scope).toEqual({ slug: "v", prefix: "agents/a" });
  });

  test("accepts an empty prefix as the vault-root scope", () => {
    const scope = expectOk(parseScope(["v"], hasV));
    expect(scope).toEqual({ slug: "v", prefix: "" });
  });

  test("a prefix of only `.` and empty segments is the vault-root scope", () => {
    // `assertSafeRelativePath` rejects `""`, so the vault-root scope must
    // never be routed through it.
    const scope = expectOk(parseScope(["v", ".", "", "."], hasV));
    expect(scope.prefix).toBe("");
  });

  test("no segments at all is a malformed scope, not an empty slug", () => {
    expect(parseScope([], hasV)).toEqual({ ok: false, rejection: { kind: "invalid_prefix" } });
  });

  test("URL aliases of one scope produce one scope key", () => {
    const keys = new Set(
      [
        ["v", "agents", "a"],
        ["v", "agents", "a", ""],
        ["v", "agents", ".", "a"],
        ["v", "agents", "", "a"],
      ].map((segs) => scopeKey(expectOk(parseScope(segs, hasV)))),
    );
    expect(keys.size).toBe(1);
    expect([...keys]).toEqual(["v\0agents/a"]);
  });

  test("the vault-root scope key is distinct from any prefixed scope", () => {
    expect(scopeKey({ slug: "v", prefix: "" })).toBe("v\0");
    expect(scopeKey({ slug: "v", prefix: "agents/a" })).not.toBe(
      scopeKey({ slug: "v", prefix: "" }),
    );
  });

  test("scope keys distinguish a prefix from a longer one sharing its bytes", () => {
    // The boundary case a per-scope registry memo actually has to survive:
    // `agents/a` and `agents/ab` share a byte prefix and must not share a key.
    expect(scopeKey({ slug: "v", prefix: "agents/a" })).not.toBe(
      scopeKey({ slug: "v", prefix: "agents/ab" }),
    );
  });

  test("no reachable scope can put NUL in either key field", () => {
    // The NUL separator is unambiguous only because neither field can contain
    // it. It is worth being precise about what that does and does NOT mean:
    // `scopeKey({slug:"v",prefix:"a"})` and `scopeKey({slug:"v\0a",prefix:""})`
    // ARE equal — the guarantee is that the second is unreachable, not that
    // the two keys differ. Assert the reachability side directly.
    //
    // Prefix half: this module owns it — `assertSafeRelativePath` rejects NUL.
    expect(parseScope(["v", "a\0b"], hasV)).toEqual({
      ok: false,
      rejection: { kind: "invalid_prefix" },
    });
    // Slug half: owned by `src/config/index.ts`, whose `slugify` reduces every
    // configured slug to `[a-z0-9-]`. A NUL-bearing slug is therefore never a
    // configured vault, which `parseScope` reports as `unknown_vault` — it
    // never reaches `scopeKey` at all.
    expect(parseScope(["v\0a"], hasV)).toEqual({
      ok: false,
      rejection: { kind: "unknown_vault", slug: "v\0a" },
    });
  });

  describe("rejects", () => {
    const invalid: ScopeParseResult = { ok: false, rejection: { kind: "invalid_prefix" } };

    test("a literal parent-directory segment", () => {
      expect(parseScope(["v", "..", "etc"], hasV)).toEqual(invalid);
    });

    test("a percent-encoded parent-directory segment", () => {
      expect(parseScope(["v", "%2e%2e"], hasV)).toEqual(invalid);
    });

    test("a percent-encoded traversal carrying its own separator", () => {
      // `%2e%2e%2f` decodes to `../` — caught by the separator rule before
      // normalization ever sees it.
      expect(parseScope(["v", "agents", "%2e%2e%2fetc"], hasV)).toEqual(invalid);
    });

    test("an encoded forward slash", () => {
      expect(parseScope(["v", "%2Fetc"], hasV)).toEqual(invalid);
    });

    test("an encoded backslash", () => {
      expect(parseScope(["v", "%5Cetc"], hasV)).toEqual(invalid);
    });

    test("an encoded separator inside the SLUG segment", () => {
      expect(parseScope(["v%2Fw", "agents"], hasV)).toEqual(invalid);
    });

    test("a malformed percent escape", () => {
      expect(parseScope(["v", "%ZZ"], hasV)).toEqual(invalid);
    });

    test("a truncated percent escape", () => {
      expect(parseScope(["v", "%2"], hasV)).toEqual(invalid);
    });

    test("a hidden segment", () => {
      expect(parseScope(["v", ".obsidian"], hasV)).toEqual(invalid);
    });

    test("a NUL byte", () => {
      expect(parseScope(["v", "a%00b"], hasV)).toEqual(invalid);
    });

    test("an over-length prefix", () => {
      expect(parseScope(["v", "x".repeat(MAX_PATH_BYTES + 1)], hasV)).toEqual(invalid);
    });

    test("a Windows drive prefix", () => {
      // The separator rule fires first for `C:\` and `C:/` alike, so a drive
      // prefix can only reach `assertSafeRelativePath` in encoded form — which
      // is also a separator. Both spellings are refused.
      expect(parseScope(["v", "C%3A%5Cwindows"], hasV)).toEqual(invalid);
      expect(parseScope(["v", "C%3A%2Fwindows"], hasV)).toEqual(invalid);
    });

    test("a leading separator, which can only arrive encoded", () => {
      // Empty segments collapse, so the normalized prefix can never begin with
      // a separator — `assertSafeRelativePath`'s leading-separator check is a
      // backstop, and the segment-level rule is the primary gate.
      expect(parseScope(["v", "", "agents", "a"], hasV).ok).toBe(true);
      expect(parseScope(["v", "%2Fagents", "a"], hasV)).toEqual(invalid);
    });
  });

  test("decodes exactly once, so a double-encoded traversal stays literal", () => {
    // `%252e%252e` decodes ONCE to the harmless literal `%2e%2e`. A second
    // decode would turn it into `..` after validation had already passed.
    const scope = expectOk(parseScope(["v", "%252e%252e"], hasV));
    expect(scope.prefix).toBe("%2e%2e");
    expect(scope.prefix).not.toBe("..");
  });

  test("rejects an unknown vault", () => {
    expect(parseScope(["w", "agents", "a"], hasV)).toEqual({
      ok: false,
      rejection: { kind: "unknown_vault", slug: "w" },
    });
  });

  test("validates the prefix BEFORE looking the slug up", () => {
    // Otherwise a scan of the URL space could distinguish "bad prefix on a
    // real vault" from "bad prefix on a fake one".
    expect(parseScope(["w", ".."], hasV)).toEqual({
      ok: false,
      rejection: { kind: "invalid_prefix" },
    });
  });

  test("does not consult the vault predicate when the prefix is invalid", () => {
    const seen: string[] = [];
    parseScope(["v", ".."], (s) => {
      seen.push(s);
      return true;
    });
    expect(seen).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// scopeRootPath / assertScopeRootSafe
// ---------------------------------------------------------------------------

describe("scopeRootPath", () => {
  test("joins the prefix onto the vault root", () => {
    expect(scopeRootPath("/vaults/v", { slug: "v", prefix: "agents/a" })).toBe(
      "/vaults/v/agents/a",
    );
  });

  test("collapses the vault-root scope to the vault root itself", () => {
    expect(scopeRootPath("/vaults/v", { slug: "v", prefix: "" })).toBe("/vaults/v");
  });
});

describe("assertScopeRootSafe", () => {
  test("accepts a real directory", async () => {
    const fx = makeScopeFixture();
    const root = fx.root("v");
    mkdirSync(join(root, "agents", "a"), { recursive: true });
    await assertScopeRootSafe(join(root, "agents", "a"), root);
  });

  test("accepts the vault-root scope", async () => {
    const fx = makeScopeFixture();
    await assertScopeRootSafe(fx.root("v"), fx.root("v"));
  });

  test("accepts a scope root that does not exist yet", async () => {
    // A missing root is an empty scope, not a rejection — creation is deferred
    // to the first write.
    const fx = makeScopeFixture();
    const root = fx.root("v");
    await assertScopeRootSafe(join(root, "agents", "new"), root);
  });

  test("rejects a symlinked scope root without leaking the prefix", async () => {
    const fx = makeScopeFixture();
    const root = fx.root("v");
    mkdirSync(join(root, "agents"), { recursive: true });
    const outside = mkdtempSync(join(tmpdir(), "ob-outside-"));
    symlinkSync(outside, join(root, "agents", "evil"));

    const err = await assertScopeRootSafe(join(root, "agents", "evil"), root).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InvalidPathError);
    const typed = err as InvalidPathError;
    expect(typed.code).toBe("invalid_path");
    expect(typed.path).toBe(".");
    expect(typed.message).not.toContain("agents");
    expect(typed.message).not.toContain(root);
    expect(typed.message).not.toContain(outside);
  });

  test("rejects a scope root nested under a symlinked ancestor", async () => {
    const fx = makeScopeFixture();
    const root = fx.root("v");
    const outside = mkdtempSync(join(tmpdir(), "ob-outside-"));
    symlinkSync(outside, join(root, "agents"));
    await expect(assertScopeRootSafe(join(root, "agents", "a"), root)).rejects.toBeInstanceOf(
      InvalidPathError,
    );
  });

  test("surfaces an operational failure as an internal error, not invalid_path", async () => {
    // A path component past NAME_MAX makes `lstat` fail ENAMETOOLONG — an
    // operational error `assertNotSymlinkEscape` rethrows raw, standing in for
    // the EACCES / EPERM / EIO family. It is the client's fault only in this
    // synthetic fixture; the classification must not depend on that.
    const fx = makeScopeFixture();
    const root = fx.root("v");
    const err = await assertScopeRootSafe(join(root, LONG_SEGMENT), root).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(OBError);
    // The raw error's message embeds the ABSOLUTE path; the replacement must
    // carry neither it nor the prefix.
    const typed = err as Error;
    expect(typed.message).toBe("scope root check failed");
    expect(typed.message).not.toContain(root);
    expect(typed.message).not.toContain(LONG_SEGMENT);
  });

  test("logs the original operational failure when a logger is supplied", async () => {
    const fx = makeScopeFixture();
    const root = fx.root("v");
    const logged: { msg: string; fields?: Record<string, unknown> }[] = [];
    const logger = {
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (msg: string, fields?: Record<string, unknown>) => {
        logged.push({ msg, fields });
      },
    };
    await expect(
      assertScopeRootSafe(join(root, LONG_SEGMENT), root, logger),
    ).rejects.toBeInstanceOf(Error);
    expect(logged.length).toBe(1);
    // The operator DOES get the detail the client is denied — that is the
    // whole point of routing it here instead of dropping it.
    expect(String(logged[0]?.fields?.err)).toContain("ENAMETOOLONG");
  });

  test("does not log a containment rejection as an operational failure", async () => {
    const fx = makeScopeFixture();
    const root = fx.root("v");
    mkdirSync(join(root, "agents"), { recursive: true });
    symlinkSync(mkdtempSync(join(tmpdir(), "ob-outside-")), join(root, "agents", "evil"));
    const logged: string[] = [];
    const logger = {
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (msg: string) => {
        logged.push(msg);
      },
    };
    await expect(
      assertScopeRootSafe(join(root, "agents", "evil"), root, logger),
    ).rejects.toBeInstanceOf(InvalidPathError);
    expect(logged).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// guard wrappers
// ---------------------------------------------------------------------------

function echoTool(seen: unknown[]) {
  return tool("echo", "echo the input", z.object({ path: z.string() }).strict(), async (args) => {
    seen.push(args);
    return { path: args.path };
  });
}

describe("guardToolDefinition", () => {
  test("preserves the tool's advertised surface", () => {
    const wrapped = guardToolDefinition(echoTool([]), async () => undefined);
    expect(wrapped.name).toBe("echo");
    expect(wrapped.description).toBe("echo the input");
    expect(wrapped.inputSchema).toEqual(echoTool([]).inputSchema);
  });

  test("delegates when the check passes", async () => {
    const seen: unknown[] = [];
    let checks = 0;
    const wrapped = guardToolDefinition(echoTool(seen), async () => {
      checks++;
    });
    const result = (await wrapped.call({ path: "memory.md" })) as {
      isError?: boolean;
      content: readonly { text: string }[];
    };
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0]?.text ?? "")).toEqual({ path: "memory.md" });
    expect(checks).toBe(1);
    expect(seen).toEqual([{ path: "memory.md" }]);
  });

  test("maps a failing check to the invalid_path envelope and never calls the tool", async () => {
    const seen: unknown[] = [];
    const wrapped = guardToolDefinition(echoTool(seen), async () => {
      throw new InvalidPathError(".", "scope root is not a directory inside the vault");
    });
    const result = (await wrapped.call({ path: "memory.md" })) as {
      isError?: boolean;
      content: readonly { text: string }[];
    };
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]?.text ?? "") as { code: string; message: string };
    expect(body.code).toBe("invalid_path");
    expect(seen).toEqual([]);
  });

  test("maps an operational check failure to the internal envelope", async () => {
    const fx = makeScopeFixture();
    const root = fx.root("v");
    const seen: unknown[] = [];
    const wrapped = guardToolDefinition(echoTool(seen), () =>
      assertScopeRootSafe(join(root, LONG_SEGMENT), root),
    );
    const result = (await wrapped.call({ path: "memory.md" })) as {
      isError?: boolean;
      content: readonly { text: string }[];
    };
    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]?.text ?? "") as { code: string; message: string };
    // NOT `invalid_path` — an I/O fault is the server's problem, not a bad
    // path from the client. `mapErrorToMcpResult` also discards the message
    // for any non-`OBError`, so the envelope is path-free by construction.
    expect(body.code).toBe("internal");
    expect(body.message).toBe("internal server error");
    expect(seen).toEqual([]);
  });

  test("catches a scope root swapped for a symlink after bind", async () => {
    const fx = makeScopeFixture();
    const root = fx.root("v");
    const scopeRoot = join(root, "agents", "a");
    mkdirSync(scopeRoot, { recursive: true });
    const seen: unknown[] = [];
    const wrapped = guardToolDefinition(echoTool(seen), () => assertScopeRootSafe(scopeRoot, root));

    // Bind-time shape: a real directory, so the call goes through.
    const before = (await wrapped.call({ path: "memory.md" })) as { isError?: boolean };
    expect(before.isError).toBeUndefined();

    // Someone (ob sync pulling a crafted tree, say) swaps it mid-session.
    const outside = mkdtempSync(join(tmpdir(), "ob-outside-"));
    writeFileSync(join(outside, "passwd"), "secret");
    rmSync(scopeRoot, { recursive: true });
    symlinkSync(outside, scopeRoot);

    const after = (await wrapped.call({ path: "passwd" })) as {
      isError?: boolean;
      content: readonly { text: string }[];
    };
    expect(after.isError).toBe(true);
    const body = JSON.parse(after.content[0]?.text ?? "") as { code: string; message: string };
    expect(body.code).toBe("invalid_path");
    expect(body.message).not.toContain("agents");
    expect(body.message).not.toContain(outside);
    expect(seen).toEqual([{ path: "memory.md" }]);
  });
});

interface RecordingResources extends ResourceHandler {
  readonly listed: (string | undefined)[];
  readonly read_: string[];
}

function recordingResources(): RecordingResources {
  const listed: (string | undefined)[] = [];
  const read_: string[] = [];
  return {
    listed,
    read_,
    list: async (cursor) => {
      listed.push(cursor);
      return { resources: [] };
    },
    read: async (uri) => {
      read_.push(uri);
      return { contents: [{ uri, mimeType: "text/markdown", text: "hi" }] };
    },
  };
}

describe("guardResourceHandler", () => {
  test("delegates list and read when the check passes", async () => {
    const inner = recordingResources();
    let checks = 0;
    const wrapped = guardResourceHandler(inner, async () => {
      checks++;
    });
    expect(await wrapped.list("cur")).toEqual({ resources: [] });
    expect(await wrapped.read("obvault://v/note.md")).toEqual({
      contents: [{ uri: "obvault://v/note.md", mimeType: "text/markdown", text: "hi" }],
    });
    expect(inner.listed).toEqual(["cur"]);
    expect(inner.read_).toEqual(["obvault://v/note.md"]);
    expect(checks).toBe(2);
  });

  test("surfaces a failing check on list as not_found, leaking nothing", async () => {
    const inner = recordingResources();
    const wrapped = guardResourceHandler(inner, async () => {
      throw new InvalidPathError("agents/a", "path traverses a symbolic link");
    });
    const err = await wrapped.list(undefined).then(
      () => null,
      (e: unknown) => e,
    );
    const typed = err as { message: string; data?: { code?: string; uri?: string } };
    expect(typed.data?.code).toBe("not_found");
    expect(typed.message).not.toContain("agents/a");
    expect(typed.data?.uri).not.toContain("agents/a");
    expect(inner.listed).toEqual([]);
  });

  test("surfaces a failing check on read as not_found for the requested uri", async () => {
    const inner = recordingResources();
    const wrapped = guardResourceHandler(inner, async () => {
      throw new InvalidPathError("agents/a", "path traverses a symbolic link");
    });
    const err = await wrapped.read("obvault://v/note.md").then(
      () => null,
      (e: unknown) => e,
    );
    const typed = err as { message: string; data?: { code?: string; uri?: string } };
    expect(typed.data?.code).toBe("not_found");
    expect(typed.data?.uri).toBe("obvault://v/note.md");
    expect(typed.message).not.toContain("agents/a");
    expect(inner.read_).toEqual([]);
  });

  test("catches a scope root swapped for a symlink after bind", async () => {
    const fx = makeScopeFixture();
    const root = fx.root("v");
    const scopeRoot = join(root, "agents", "a");
    mkdirSync(scopeRoot, { recursive: true });
    const inner = recordingResources();
    const wrapped = guardResourceHandler(inner, () => assertScopeRootSafe(scopeRoot, root));

    await wrapped.list(undefined);
    expect(inner.listed.length).toBe(1);

    rmSync(scopeRoot, { recursive: true });
    symlinkSync(mkdtempSync(join(tmpdir(), "ob-outside-")), scopeRoot);
    await expect(wrapped.list(undefined)).rejects.toThrow();
    expect(inner.listed.length).toBe(1);
  });

  test("propagates an operational check failure instead of calling it not_found", async () => {
    // "Not found" is a routine, unalarming answer. An I/O fault reported that
    // way disappears; it has to reach the SDK as a server error.
    const fx = makeScopeFixture();
    const root = fx.root("v");
    const inner = recordingResources();
    const wrapped = guardResourceHandler(inner, () =>
      assertScopeRootSafe(join(root, LONG_SEGMENT), root),
    );
    const err = await wrapped.read("obvault://v/note.md").then(
      () => null,
      (e: unknown) => e,
    );
    const typed = err as Error & { data?: { code?: string } };
    expect(typed.data?.code).toBeUndefined();
    expect(typed.message).toBe("scope root check failed");
    expect(typed.message).not.toContain(root);
    expect(inner.read_).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// scopeDeps — vault lookup
// ---------------------------------------------------------------------------

const AGENTS_A: McpScope = { slug: "v", prefix: "agents/a" };
const ROOT_SCOPE: McpScope = { slug: "v", prefix: "" };

describe("scopeDeps vault lookup", () => {
  test("re-roots the scoped vault and keeps slug/name", () => {
    const fx = makeScopeFixture();
    const scoped = scopeDeps(fx.deps, AGENTS_A);
    expect(scoped.vault("v")).toEqual({
      slug: "v",
      name: "v",
      root: join(fx.root("v"), "agents", "a"),
    });
  });

  test("the vault-root scope keeps the vault root unchanged", () => {
    const fx = makeScopeFixture();
    expect(scopeDeps(fx.deps, ROOT_SCOPE).vault("v")?.root).toBe(fx.root("v"));
  });

  test("returns null for every other slug", () => {
    const fx = makeScopeFixture(["v", "w"]);
    const scoped = scopeDeps(fx.deps, AGENTS_A);
    expect(scoped.vault("w")).toBe(null);
    expect(fx.deps.vault("w")).not.toBe(null);
  });

  test("throws loudly when the scope names a vault the deps do not know", () => {
    const fx = makeScopeFixture();
    expect(() => scopeDeps(fx.deps, { slug: "nope", prefix: "" })).toThrow(
      'scope references unknown vault "nope"',
    );
  });

  test("confines the real file surface to the scope root", async () => {
    const fx = makeScopeFixture();
    const root = fx.root("v");
    mkdirSync(join(root, "agents", "a"), { recursive: true });
    mkdirSync(join(root, "agents", "b"), { recursive: true });
    mkdirSync(join(root, "agents", "ab"), { recursive: true });
    writeFileSync(join(root, "agents", "a", "note.md"), "mine");
    writeFileSync(join(root, "agents", "b", "secret.md"), "theirs");
    writeFileSync(join(root, "agents", "ab", "other.md"), "neighbour");
    writeFileSync(join(root, "top.md"), "outside");

    const scoped = scopeDeps(fx.deps, AGENTS_A);

    // Sibling scopes are mutually invisible, and `agents/ab` is NOT a string
    // prefix match for `agents/a`.
    const page = await listFiles(scoped, "v", {});
    expect(page.items.map((i) => i.path)).toEqual(["note.md"]);

    // Traversal out of the scope is refused by the real `safeJoin`.
    const err = await readFile(scoped, "v", "../b/secret.md").then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(InvalidPathError);
    expect((err as InvalidPathError).message).not.toContain("agents/a");
    expect((err as InvalidPathError).message).not.toContain(root);

    // Another vault is unreachable through the scoped deps.
    await expect(readFile(scoped, "w", "x.md")).rejects.toMatchObject({
      code: "vault_not_found",
    });
  });

  test("writes land under the prefix with a scope-relative path in the result", async () => {
    const fx = makeScopeFixture();
    const scoped = scopeDeps(fx.deps, { slug: "v", prefix: "agents/new" });
    const result = await writeFile(scoped, "v", "memory.md", {
      kind: "markdown",
      content: "hello",
    });
    expect(result.path).toBe("memory.md");
    const onDisk = await Bun.file(join(fx.root("v"), "agents", "new", "memory.md")).text();
    expect(onDisk).toContain("hello");
    expect(fx.calls.reindex).toEqual([{ slug: "v", path: "agents/new/memory.md" }]);
  });
});

// ---------------------------------------------------------------------------
// scopeDeps — indexer translation
// ---------------------------------------------------------------------------

describe("scopeDeps indexer", () => {
  test("delegates status / list / stop unchanged", async () => {
    const fx = makeScopeFixture(["v", "w"]);
    const scoped = scopeDeps(fx.deps, AGENTS_A);
    expect(scoped.indexer.status("w")).toEqual(idxStatus("w"));
    expect(scoped.indexer.list().map((s) => s.slug)).toEqual(["v", "w"]);
    await scoped.indexer.stop();
    expect(fx.calls.status).toEqual(["w"]);
    expect(fx.calls.list.length).toBe(1);
    expect(fx.calls.stop.length).toBe(1);
  });

  test("prepends the prefix to reindex and drop", async () => {
    const fx = makeScopeFixture();
    const scoped = scopeDeps(fx.deps, AGENTS_A);
    await scoped.indexer.reindex("v", "memory.md");
    await scoped.indexer.drop("v", "sub/old.md");
    expect(fx.calls.reindex).toEqual([{ slug: "v", path: "agents/a/memory.md" }]);
    expect(fx.calls.drop).toEqual([{ slug: "v", path: "agents/a/sub/old.md" }]);
  });

  test("the vault-root scope prepends nothing", async () => {
    const fx = makeScopeFixture();
    const scoped = scopeDeps(fx.deps, ROOT_SCOPE);
    await scoped.indexer.reindex("v", "memory.md");
    await scoped.indexer.drop("v", "memory.md");
    expect(fx.calls.reindex).toEqual([{ slug: "v", path: "memory.md" }]);
    expect(fx.calls.drop).toEqual([{ slug: "v", path: "memory.md" }]);
  });

  test("forces filter.pathPrefix WITH a trailing slash", async () => {
    const fx = makeScopeFixture();
    await scopeDeps(fx.deps, AGENTS_A).indexer.search("v", "coffee");
    expect(fx.calls.search[0]?.opts?.filter?.pathPrefix).toBe("agents/a/");
  });

  test("preserves unrelated search options and the caller's tag filter", async () => {
    const fx = makeScopeFixture();
    await scopeDeps(fx.deps, AGENTS_A).indexer.search("v", "coffee", {
      limit: 5,
      mode: "fts",
      filter: { tag: "journal" },
    });
    expect(fx.calls.search[0]?.opts).toEqual({
      limit: 5,
      mode: "fts",
      filter: { tag: "journal", pathPrefix: "agents/a/" },
    });
  });

  test("does not mutate the caller's options object", async () => {
    const fx = makeScopeFixture();
    const opts: SearchOptions = { limit: 5, filter: { tag: "journal" } };
    await scopeDeps(fx.deps, AGENTS_A).indexer.search("v", "coffee", opts);
    expect(opts).toEqual({ limit: 5, filter: { tag: "journal" } });
  });

  test("nests a caller-supplied pathPrefix under the scope, without a trailing slash", async () => {
    const fx = makeScopeFixture();
    await scopeDeps(fx.deps, AGENTS_A).indexer.search("v", "coffee", {
      filter: { pathPrefix: "journal" },
    });
    expect(fx.calls.search[0]?.opts?.filter?.pathPrefix).toBe("agents/a/journal");
  });

  test("rejects a traversing caller-supplied pathPrefix", async () => {
    const fx = makeScopeFixture();
    const scoped = scopeDeps(fx.deps, AGENTS_A);
    await expect(
      scoped.indexer.search("v", "coffee", { filter: { pathPrefix: "../b" } }),
    ).rejects.toBeInstanceOf(InvalidPathError);
    expect(fx.calls.search).toEqual([]);
  });

  test("the vault-root scope forces no filter at all", async () => {
    const fx = makeScopeFixture();
    await scopeDeps(fx.deps, ROOT_SCOPE).indexer.search("v", "coffee");
    expect(fx.calls.search[0]?.opts).toEqual({});
    expect(fx.calls.search[0]?.opts?.filter).toBeUndefined();
  });

  test("the vault-root scope validates and passes a caller pathPrefix through unchanged", async () => {
    const fx = makeScopeFixture();
    const scoped = scopeDeps(fx.deps, ROOT_SCOPE);
    await scoped.indexer.search("v", "coffee", { filter: { pathPrefix: "notes" } });
    expect(fx.calls.search[0]?.opts?.filter?.pathPrefix).toBe("notes");
    await expect(
      scoped.indexer.search("v", "coffee", { filter: { pathPrefix: "../b" } }),
    ).rejects.toBeInstanceOf(InvalidPathError);
    expect(fx.calls.search.length).toBe(1);
  });

  test("strips the prefix from hits and drops out-of-scope ones", async () => {
    const fx = makeScopeFixture();
    fx.setHits([
      hit("agents/a/coffee.md"),
      hit("agents/a/sub/tea.md"),
      // Defensive drops: a stale index entry outside the scope, and the
      // boundary case a bare `starts_with` filter would have let through.
      hit("notes/coffee.md"),
      hit("agents/ab/other.md"),
      hit("agents/a"),
    ]);
    const hits = await scopeDeps(fx.deps, AGENTS_A).indexer.search("v", "coffee");
    expect(hits.map((h) => h.path)).toEqual(["coffee.md", "sub/tea.md"]);
  });

  test("passes note content through unchanged while translating the path", async () => {
    const fx = makeScopeFixture();
    fx.setHits([
      hit("agents/a/coffee.md", {
        text: "see [[Other Note]] in agents/a",
        frontmatter: { title: "Coffee" },
        tags: ["drinks"],
        links: ["Other Note"],
      }),
    ]);
    const [h] = await scopeDeps(fx.deps, AGENTS_A).indexer.search("v", "coffee");
    expect(h).toEqual({
      path: "coffee.md",
      chunkIndex: 0,
      headingPath: ["H"],
      text: "see [[Other Note]] in agents/a",
      score: 0.5,
      frontmatter: { title: "Coffee" },
      links: ["Other Note"],
      tags: ["drinks"],
    });
  });

  test("the vault-root scope strips nothing and drops nothing", async () => {
    const fx = makeScopeFixture();
    fx.setHits([hit("agents/a/coffee.md"), hit("notes/coffee.md")]);
    const hits = await scopeDeps(fx.deps, ROOT_SCOPE).indexer.search("v", "coffee");
    expect(hits.map((h) => h.path)).toEqual(["agents/a/coffee.md", "notes/coffee.md"]);
  });
});

// ---------------------------------------------------------------------------
// scopeStatusDeps
// ---------------------------------------------------------------------------

describe("scopeStatusDeps", () => {
  test("listVaults reports only the scoped vault in a two-vault deployment", () => {
    const fx = makeScopeFixture(["v", "w"]);
    expect(listVaults(fx.statusDeps).map((s) => s.slug)).toEqual(["v", "w"]);
    const scoped = scopeStatusDeps(fx.statusDeps, AGENTS_A);
    const summaries = listVaults(scoped);
    expect(summaries.map((s) => s.slug)).toEqual(["v"]);
    // Counts remain VAULT-wide — there is no per-prefix accounting.
    expect(summaries[0]?.indexer.documents).toBe(3);
  });

  test("vaultStatus resolves the scoped slug and refuses every other one", () => {
    const fx = makeScopeFixture(["v", "w"]);
    const scoped = scopeStatusDeps(fx.statusDeps, AGENTS_A);
    expect(vaultStatus(scoped, "v")?.slug).toBe("v");
    expect(vaultStatus(scoped, "w")).toBe(null);
    expect(vaultStatus(fx.statusDeps, "w")?.slug).toBe("w");
  });

  test("filters both indexer accessors to the scoped slug", () => {
    const fx = makeScopeFixture(["v"]);
    const scoped = scopeStatusDeps(fx.statusDeps, AGENTS_A);
    expect(scoped.indexer.status("v")).toEqual(idxStatus("v"));
    expect(scoped.indexer.status("w")).toBe(null);
    expect(scoped.indexer.list().map((i) => i.slug)).toEqual(["v"]);
  });

  test("listVaults falls back to the empty indexer status when the indexer has no entry", () => {
    // Startup race: the supervisor knows the vault but the indexer has not
    // registered it yet. Filtering an already-empty indexer listing keeps it
    // empty, so `listVaults` must still report the scoped vault — with the
    // `starting` placeholder from `src/vault/status.ts` — rather than dropping
    // it or throwing.
    const fx = makeScopeFixture(["v"]);
    const racing: StatusDeps = {
      supervisor: fx.statusDeps.supervisor,
      indexer: { list: () => [], status: () => null },
    };
    const summaries = listVaults(scopeStatusDeps(racing, AGENTS_A));
    expect(summaries.map((s) => s.slug)).toEqual(["v"]);
    expect(summaries[0]?.indexer).toEqual({
      slug: "v",
      state: "starting",
      documents: 0,
      chunks: 0,
      lastIndexedAt: null,
      pending: 0,
      errors: 0,
    });
  });

  test("delegates supervisor.stop", async () => {
    const fx = makeScopeFixture();
    await scopeStatusDeps(fx.statusDeps, AGENTS_A).supervisor.stop();
  });

  test("the real status tools see one vault and refuse the other", async () => {
    const fx = makeScopeFixture(["v", "w"]);
    const scoped = scopeStatusDeps(fx.statusDeps, AGENTS_A);

    const list = (await listVaultsTool(scoped).call({})) as {
      isError?: boolean;
      content: readonly { text: string }[];
    };
    expect(list.isError).toBeUndefined();
    const vaults = JSON.parse(list.content[0]?.text ?? "") as { slug: string }[];
    expect(vaults.map((v) => v.slug)).toEqual(["v"]);

    const status = vaultStatusTool(scoped);
    const own = (await status.call({ vault: "v" })) as { isError?: boolean };
    expect(own.isError).toBeUndefined();

    const other = (await status.call({ vault: "w" })) as {
      isError?: boolean;
      content: readonly { text: string }[];
    };
    expect(other.isError).toBe(true);
    expect(JSON.parse(other.content[0]?.text ?? "")).toMatchObject({ code: "vault_not_found" });
  });
});

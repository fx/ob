/**
 * MCP HTTP transport routes.
 *
 * Mounts the Streamable HTTP transport from `@modelcontextprotocol/sdk` on a
 * Hono sub-app handling `POST`, `GET`, and `DELETE`. The SDK itself decides
 * per request whether to respond with `application/json` (a one-shot result)
 * or `text/event-stream` (a streamed result/notification); we just forward
 * the `Request` and return the SDK's `Response`.
 *
 * Three route shapes share those handlers (see
 * `docs/changes/0014-mcp-folder-scoping.md`):
 *
 * | Route | Meaning |
 * |---|---|
 * | `/mcp` | Unscoped. Byte-identical to the pre-scoping server. |
 * | `/mcp/:slug` | Scoped to one vault, prefix empty (the vault-root scope). |
 * | `/mcp/:slug/:prefix{.+}` | Scoped to one vault and one folder prefix. |
 *
 * A scoped session sees its prefix as if it were the vault root: every path
 * it sends and every path it receives is relative to that prefix, and it is
 * never told what the prefix is. All of the confinement is done by wrapping
 * the service dependencies (`scopeDeps` / `scopeStatusDeps` in `./scope.ts`)
 * — nothing in `src/vault/` changes. Scoping is NOT an auth boundary: the
 * server has no auth, so the same files stay reachable through `/mcp`.
 *
 * Each session pairs one `Server` instance with one transport — the SDK
 * takes ownership of the transport, so we keep them together in a
 * `Map<sessionId, SessionPair>` and tear BOTH down on session close. The
 * server itself is stateless apart from the per-session client-capability
 * cache, so creating one per session is cheap.
 *
 * Session lifecycle:
 * - First `POST /mcp` (an `initialize` request with no `Mcp-Session-Id`)
 *   creates a fresh transport with `sessionIdGenerator: () => randomUUID()`.
 *   The SDK populates `Mcp-Session-Id` on the response and we remember the
 *   pair under that id, together with the scope key it was bound to.
 * - Subsequent `POST /mcp` and `GET /mcp` calls look up the pair by
 *   `Mcp-Session-Id`. Unknown / missing session ids short-circuit before
 *   any allocation — see `rejectMissingSession` / `rejectUnknownSession`
 *   below — so a flood of bad requests can't pin the event loop on
 *   transport+server construction. A KNOWN session id presented on a
 *   different scope path is rejected identically and is NOT served from the
 *   stored pair, so a leaked id cannot re-scope an in-flight session.
 * - `DELETE /mcp` lets the client end the session; the SDK fires the
 *   `onsessionclosed` callback we register, which closes the per-session
 *   server (so its tool-handler closures and protocol state can be GC'd)
 *   and drops the pair from the map.
 *
 * Backpressure (per change-doc default): the SDK manages its own SSE buffer
 * per stream; the bounded-buffer-then-close behavior described in the spec
 * is the SDK's built-in behavior — we don't need to layer our own queue on
 * top.
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { type Context, Hono } from "hono";
import type { Indexer } from "../indexer/index.ts";
import type { Logger } from "../log.ts";
import type { Supervisor } from "../obsidian/index.ts";
import type { VaultServiceDeps } from "../vault/files.ts";
import type { StatusDeps } from "../vault/status.ts";
import { type ResourceHandler, buildResourceHandler } from "./resources.ts";
import { SCOPED_INSTRUCTIONS, VAULT_WIDE_COUNTS_NOTE, scopeToolDefinition } from "./scope-tools.ts";
import {
  type McpScope,
  assertScopeRootSafe,
  guardResourceHandler,
  guardToolDefinition,
  parseScope,
  scopeDeps,
  scopeKey,
  scopeRootPath,
  scopeStatusDeps,
} from "./scope.ts";
import { type ToolRegistry, buildMcpServer, createToolRegistry } from "./server.ts";
import type { ToolDefinition } from "./tool.ts";
import { appendFileTool } from "./tools/append_file.ts";
import { createFolderTool } from "./tools/create_folder.ts";
import { deleteFileTool } from "./tools/delete_file.ts";
import { deleteFolderTool } from "./tools/delete_folder.ts";
import { listFilesTool } from "./tools/list_files.ts";
import { listFoldersTool } from "./tools/list_folders.ts";
import { listVaultsTool } from "./tools/list_vaults.ts";
import { patchFileTool } from "./tools/patch_file.ts";
import { readFileTool } from "./tools/read_file.ts";
import { searchTool } from "./tools/search.ts";
import { vaultStatusTool } from "./tools/vault_status.ts";
import { writeFileTool } from "./tools/write_file.ts";

/** Wiring needed to construct the registry + resource handler. */
export interface McpRoutesDeps extends VaultServiceDeps {
  readonly supervisor: Supervisor;
  readonly indexer: Indexer;
  readonly logger?: Logger;
  /**
   * Override session-id generation — tests pass a deterministic UUID factory
   * so they can assert the header without parsing the SDK's `randomUUID`.
   */
  readonly randomUUID?: () => string;
}

/**
 * Build a fresh registry pre-populated with all tools. Exported so
 * tool tests can use a clean registry without going through the route
 * handler.
 */
export function buildToolRegistry(deps: McpRoutesDeps): ToolRegistry {
  const registry = createToolRegistry();
  const statusDeps = { supervisor: deps.supervisor, indexer: deps.indexer };
  registry.register(listVaultsTool(statusDeps));
  registry.register(vaultStatusTool(statusDeps));
  registry.register(listFilesTool(deps));
  registry.register(readFileTool(deps));
  registry.register(writeFileTool(deps));
  registry.register(patchFileTool(deps));
  registry.register(appendFileTool(deps));
  registry.register(deleteFileTool(deps));
  registry.register(listFoldersTool(deps));
  registry.register(createFolderTool(deps));
  registry.register(deleteFolderTool(deps));
  registry.register(searchTool(deps));
  return registry;
}

/**
 * Path patterns the two scoped route shapes are registered under, longest
 * first. Also used to recover the sub-app's mount prefix from
 * `c.req.routePath` (which Hono reports as `mount + pattern`), so the
 * handlers keep working no matter where the sub-app is mounted.
 */
const SCOPE_ROUTE_PATTERNS = ["/:slug/:prefix{.+}", "/:slug"] as const;

/**
 * Maximum number of distinct scopes whose tool registry + resource handler
 * stay memoized. The memo key is client-controlled URL text, so the map MUST
 * be bounded; beyond this cap the least-recently-used entry is evicted and
 * simply rebuilt on its next request (registry construction is pure object
 * wiring — no I/O, no session state). Sized for far more concurrently active
 * agents than a single-process deployment is expected to carry.
 */
export const SCOPE_SURFACE_CACHE_MAX = 64;

/**
 * Extract the request target's path by SLICING the URL string — never by
 * parsing it.
 *
 * `new URL(c.req.url).pathname` is explicitly not acceptable: the WHATWG URL
 * parser resolves dot segments, including percent-encoded ones (`%2e%2e` is a
 * double-dot segment per the URL standard), so the inputs scope validation
 * exists to reject would be collapsed before the validator saw them.
 *
 * `c.req.path` is not the raw target either, for a subtler reason pinned by
 * `test/mcp/scope-routes.test.ts`: Hono derives it by running `decodeURI`
 * over the raw path, which is a PARTIAL decode — `%2e%2e%2f` arrives as
 * `..%2f`, `%5C` as `\`. Handing already-decoded text to the single
 * `decodeURIComponent` in `parseScope` is one decode too many, and the
 * change document's "exactly one decode, on the RAW segment" rule exists so
 * that containment does not rest on which escapes today's `decodeURI` (and
 * Hono's `%25` pre-escaping around it) happens to leave alone.
 *
 * `c.req.url` is the raw target as the runtime received it, so we cut the
 * path out of it directly: everything from the first `/` after the authority
 * up to the first `?` or `#`.
 */
function rawRequestPath(url: string): string {
  const authority = url.indexOf("://") + 3;
  const start = url.indexOf("/", authority);
  // An absolute URL with no path at all. `Request` always normalizes the
  // empty path to "/", so this is a defensive floor rather than a live case.
  if (start < 0) return "/";
  const cuts = [url.indexOf("?", start), url.indexOf("#", start)].filter((i) => i >= 0);
  return url.slice(start, cuts.length === 0 ? url.length : Math.min(...cuts));
}

/**
 * RAW, still-percent-encoded path segments after the sub-app's mount prefix.
 * `rawSegments[0]` is the vault slug; the rest form the folder prefix.
 * `parseScope` owns every decode, normalization, and validation step from
 * here on — this function must not interpret the segments at all.
 */
function rawScopeSegments(c: Context): readonly string[] {
  const routePath = c.req.routePath;
  const pattern = SCOPE_ROUTE_PATTERNS.find((p) => routePath.endsWith(p));
  // Only the scoped routes reach here and both are registered from
  // `SCOPE_ROUTE_PATTERNS`, so a miss is a wiring bug. Returning no segments
  // makes `parseScope` reject; falling back to the whole path would hand the
  // mount prefix to the validator as if it were scope text.
  if (pattern === undefined) return [];
  const mount = routePath.slice(0, routePath.length - pattern.length);
  // `"/mcp".split("/")` → `["", "mcp"]`; `"".split("/")` → `[""]`.
  const mountDepth = mount.split("/").length - 1;
  // The leading "/" always yields one empty leading element, which is dropped
  // along with the mount's own segments.
  return rawRequestPath(c.req.url)
    .split("/")
    .slice(1 + mountDepth);
}

/** A scope plus the UNSCOPED vault root the scope-root guard walks up to. */
interface ResolvedScope {
  readonly scope: McpScope;
  readonly vaultRoot: string;
}

/** The per-scope (or process-wide, when unscoped) MCP surface. */
interface McpSurface {
  readonly registry: ToolRegistry;
  readonly resources: ResourceHandler;
  /** SDK `instructions`; `undefined` for the unscoped mount. */
  readonly instructions: string | undefined;
}

/**
 * Per-session bookkeeping. Both transport AND server live here so
 * `onsessionclosed` / `onclose` can tear the server down explicitly — the
 * SDK only owns the transport, not the protocol object, so without an
 * explicit `server.close()` the per-session handler closures would leak
 * until GC ran.
 */
interface SessionPair {
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly server: Server;
  /**
   * Canonical scope key the session was bound to at `initialize`, or
   * `undefined` for the unscoped mount. Compared against the scope derived
   * from every later request's OWN URL.
   */
  readonly scopeKey: string | undefined;
}

/**
 * JSON-RPC error shapes for the fast-path rejections, matching the bytes
 * the SDK would emit if we let the orphan request through `handleRequest`.
 * Keeping the shapes byte-identical keeps the SDK an interchangeable
 * dependency: a future SDK version can switch routes between fast and slow
 * paths without observable wire changes for clients.
 */
function rejectMissingSession(c: Context): Response {
  return c.json(
    {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: Mcp-Session-Id header is required" },
      id: null,
    },
    400,
  );
}

function rejectUnknownSession(c: Context): Response {
  return c.json(
    {
      jsonrpc: "2.0",
      error: { code: -32001, message: "Session not found" },
      id: null,
    },
    404,
  );
}

/**
 * A scope whose prefix does not validate — traversal, an encoded separator, a
 * malformed escape, a hidden segment — or whose root is (or sits under) a
 * symlink out of the vault. No transport and no server is allocated for it.
 */
function rejectInvalidScope(c: Context): Response {
  return c.json(
    {
      jsonrpc: "2.0",
      error: { code: -32000, message: "Bad Request: invalid MCP scope" },
      id: null,
    },
    400,
  );
}

/**
 * A well-formed scope naming a vault that is not configured. Deliberately the
 * same envelope SHAPE as `rejectInvalidScope`, so scanning the URL space
 * yields no more information than the already-public `GET /v1/vaults`.
 */
function rejectUnknownVault(c: Context, slug: string): Response {
  return c.json(
    {
      jsonrpc: "2.0",
      error: { code: -32000, message: `Not Found: unknown vault "${slug}"` },
      id: null,
    },
    404,
  );
}

/**
 * Build a Hono sub-app exposing `POST/GET/DELETE /mcp`. Mount on the main
 * app via `app.route("/mcp", buildMcpRoutes(deps))`.
 */
export function buildMcpRoutes(deps: McpRoutesDeps): Hono {
  const registry = buildToolRegistry(deps);
  const slugs = (): readonly string[] => deps.supervisor.list().map((s) => s.slug);
  const resources = buildResourceHandler(deps, slugs);
  const unscopedSurface: McpSurface = { registry, resources, instructions: undefined };
  const sessions = new Map<string, SessionPair>();
  const newSessionId = deps.randomUUID ?? ((): string => crypto.randomUUID());
  /** LRU-ordered by insertion: the first key is the least recently used. */
  const scopeSurfaces = new Map<string, McpSurface>();

  /**
   * Resolve the scope carried by THIS request's URL, or the rejection
   * `Response` it earns. Nothing is allocated for a rejected scope.
   */
  function resolveScope(c: Context): ResolvedScope | Response {
    const parsed = parseScope(rawScopeSegments(c), (slug) => deps.vault(slug) !== null);
    if (!parsed.ok) {
      return parsed.rejection.kind === "unknown_vault"
        ? rejectUnknownVault(c, parsed.rejection.slug)
        : rejectInvalidScope(c);
    }
    // Second lookup, this time for the descriptor `parseScope`'s boolean
    // predicate could not carry back. A vault that stopped resolving between
    // the two calls is reported as unknown, not as a 500.
    const vault = deps.vault(parsed.scope.slug);
    if (vault === null) return rejectUnknownVault(c, parsed.scope.slug);
    return { scope: parsed.scope, vaultRoot: vault.root };
  }

  /**
   * Build the scoped tool registry + resource handler for one scope.
   *
   * Two wrappers compose around every tool, and the ORDER is deliberate:
   * `guardToolDefinition` goes OUTERMOST, so the scope-root containment
   * re-check runs before any client-controlled argument is touched
   * (`scopeToolDefinition`'s implicit-`vault` injection included) — fail
   * closed first. It also spreads the definition it wraps and overrides only
   * `call`, so the scoped `inputSchema` and `description` survive intact.
   */
  function buildScopedSurface(resolved: ResolvedScope): McpSurface {
    const { scope, vaultRoot } = resolved;
    const scopeRoot = scopeRootPath(vaultRoot, scope);
    const check = (): Promise<void> => assertScopeRootSafe(scopeRoot, vaultRoot, deps.logger);
    const scoped = scopeDeps(deps, scope);
    const statusDeps: StatusDeps = scopeStatusDeps(
      { supervisor: deps.supervisor, indexer: deps.indexer },
      scope,
    );
    const scopedRegistry = createToolRegistry();
    const add = (t: ToolDefinition, descriptionSuffix?: string): void => {
      scopedRegistry.register(
        guardToolDefinition(scopeToolDefinition(t, scope.slug, descriptionSuffix), check),
      );
    };
    // Status tools take `StatusDeps`; everything else takes the full scoped
    // `McpRoutesDeps`. Mirrors `buildToolRegistry`, one substitution deeper.
    add(listVaultsTool(statusDeps));
    add(vaultStatusTool(statusDeps), VAULT_WIDE_COUNTS_NOTE);
    add(listFilesTool(scoped));
    add(readFileTool(scoped));
    add(writeFileTool(scoped));
    add(patchFileTool(scoped));
    add(appendFileTool(scoped));
    add(deleteFileTool(scoped));
    add(listFoldersTool(scoped));
    add(createFolderTool(scoped));
    add(deleteFolderTool(scoped));
    add(searchTool(scoped));
    return {
      registry: scopedRegistry,
      // A slug provider returning ONLY the scoped slug. The deps wrapper does
      // not reach the unscoped `slugs()` closure, so without this
      // `resources/list` would paginate across every configured vault even
      // though every tool is confined.
      resources: guardResourceHandler(
        buildResourceHandler(scoped, () => [scope.slug]),
        check,
      ),
      instructions: SCOPED_INSTRUCTIONS,
    };
  }

  /**
   * Memoized `buildScopedSurface`, keyed by the canonical scope key so URL
   * aliases of one scope share one surface. Bounded and LRU-evicting: the key
   * is client-controlled URL text, so an unbounded map would be an unbounded
   * allocation.
   */
  function scopedSurface(resolved: ResolvedScope): McpSurface {
    const key = scopeKey(resolved.scope);
    const cached = scopeSurfaces.get(key);
    if (cached !== undefined) {
      // `Map` iterates in insertion order, so re-inserting moves the entry to
      // the young end and makes "first key" mean "least recently used".
      scopeSurfaces.delete(key);
      scopeSurfaces.set(key, cached);
      return cached;
    }
    const built = buildScopedSurface(resolved);
    scopeSurfaces.set(key, built);
    for (const oldest of scopeSurfaces.keys()) {
      if (scopeSurfaces.size <= SCOPE_SURFACE_CACHE_MAX) break;
      scopeSurfaces.delete(oldest);
    }
    return built;
  }

  /**
   * Fire-and-forget server teardown. The SDK doesn't await our
   * `onsessionclosed` callback's return value before closing the transport,
   * and `Protocol.close()` is async, so we kick it off and log any failure
   * — there's no caller to surface the error to.
   */
  function disposeServer(server: Server): void {
    void server.close().catch((e: unknown) => {
      deps.logger?.warn("mcp server.close failed", {
        error: e instanceof Error ? e.message : String(e),
      });
    });
  }

  /**
   * Create a fresh transport + server pair, register it under its session
   * id once `onsessioninitialized` fires, and bind the cleanup callbacks.
   * The pair is held in `sessions` until the SDK fires `onsessionclosed`
   * (DELETE) or `onclose` (transport-level teardown), at which point the
   * server is closed and the entry dropped.
   */
  async function createPair(
    resolved: ResolvedScope | undefined,
    key: string | undefined,
  ): Promise<WebStandardStreamableHTTPServerTransport> {
    const surface = resolved === undefined ? unscopedSurface : scopedSurface(resolved);
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: newSessionId,
      // V1 has no streaming tool responses — every tool returns a single
      // payload — so JSON one-shots are the simpler shape for both adapters
      // (REST already returns JSON, parity tests don't have to parse SSE).
      // The SDK still opens SSE streams for `GET /mcp` and for any future
      // server-initiated notification.
      enableJsonResponse: true,
      onsessioninitialized: (id: string): void => {
        sessions.set(id, { transport, server, scopeKey: key });
      },
      onsessionclosed: (id: string): void => {
        const pair = sessions.get(id);
        if (pair !== undefined) disposeServer(pair.server);
        sessions.delete(id);
      },
    });
    transport.onclose = (): void => {
      // `sessionId` is set on the transport once initialization completes; if
      // the transport closes before that (e.g. an error before the first
      // response) there's nothing in the map to drop and no separate server
      // cleanup to do — the unbound `server` reference will be GC'd.
      if (transport.sessionId === undefined) return;
      const pair = sessions.get(transport.sessionId);
      if (pair !== undefined) disposeServer(pair.server);
      sessions.delete(transport.sessionId);
    };
    transport.onerror = (e: Error): void => {
      deps.logger?.warn("mcp transport error", { error: e.message });
    };
    const server = buildMcpServer(surface.registry, surface.resources, surface.instructions);
    await server.connect(transport);
    return transport;
  }

  /**
   * Look up the pair for `sid` only if it was bound to THIS request's scope.
   * A known id presented on a different scope path — or on `/mcp` when it was
   * bound to a scoped mount, and vice versa — is rejected exactly like an
   * unknown session and is never served from the stored pair.
   */
  function pairFor(sid: string, key: string | undefined): SessionPair | undefined {
    const pair = sessions.get(sid);
    if (pair === undefined || pair.scopeKey !== key) return undefined;
    return pair;
  }

  // POST — JSON-RPC entry. The SDK decides one-shot JSON vs SSE.
  async function handlePost(c: Context, resolved: ResolvedScope | undefined): Promise<Response> {
    const key = resolved === undefined ? undefined : scopeKey(resolved.scope);
    const sid = c.req.header("mcp-session-id");
    if (sid !== undefined) {
      // Stale, unknown, or wrong-scope session id: short-circuit before
      // allocating a fresh transport+server just to let the SDK 4xx. Matches
      // the SDK's own 404 / `-32001` shape.
      const pair = pairFor(sid, key);
      if (pair === undefined) return rejectUnknownSession(c);
      return pair.transport.handleRequest(c.req.raw);
    }
    if (resolved !== undefined) {
      try {
        // Bind-time containment check on the scope root itself — the one span
        // `safeJoin` never walks, because it stops at the root it is handed.
        // The same check runs again before every scoped operation (see
        // `buildScopedSurface`), so a root swapped for a symlink mid-session
        // is caught on the next call.
        await assertScopeRootSafe(
          scopeRootPath(resolved.vaultRoot, resolved.scope),
          resolved.vaultRoot,
          deps.logger,
        );
      } catch {
        // Both the containment rejection and an operational failure land
        // here. At BIND time they mean the same thing to the caller — this
        // scope cannot be accepted — and `assertScopeRootSafe` has already
        // logged the operational detail, so one envelope covers both.
        return rejectInvalidScope(c);
      }
    }
    // No session id → assume `initialize`. We can't cheaply discriminate
    // here without parsing the body, so we let the slow path through; if
    // the body isn't `initialize` the SDK returns its 400 "Server not
    // initialized" envelope on the freshly created transport.
    const transport = await createPair(resolved, key);
    return transport.handleRequest(c.req.raw);
  }

  /**
   * GET (server-initiated SSE) and DELETE (explicit teardown). Both require
   * an existing session bound to this request's scope.
   */
  async function handleSession(c: Context, resolved: ResolvedScope | undefined): Promise<Response> {
    const sid = c.req.header("mcp-session-id");
    if (sid === undefined) return rejectMissingSession(c);
    const key = resolved === undefined ? undefined : scopeKey(resolved.scope);
    const pair = pairFor(sid, key);
    if (pair === undefined) return rejectUnknownSession(c);
    return pair.transport.handleRequest(c.req.raw);
  }

  /** Resolve the scope first; a rejection never reaches the handler. */
  function scoped(
    handler: (c: Context, resolved: ResolvedScope) => Promise<Response>,
  ): (c: Context) => Promise<Response> {
    return async (c: Context): Promise<Response> => {
      const resolved = resolveScope(c);
      if (resolved instanceof Response) return resolved;
      return handler(c, resolved);
    };
  }

  const app = new Hono();

  app.post("/", (c) => handlePost(c, undefined));
  app.get("/", (c) => handleSession(c, undefined));
  app.delete("/", (c) => handleSession(c, undefined));

  for (const pattern of SCOPE_ROUTE_PATTERNS) {
    app.post(pattern, scoped(handlePost));
    app.get(pattern, scoped(handleSession));
    app.delete(pattern, scoped(handleSession));
  }

  return app;
}

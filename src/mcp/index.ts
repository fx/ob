/**
 * MCP HTTP transport routes.
 *
 * Mounts the Streamable HTTP transport from `@modelcontextprotocol/sdk` on a
 * single Hono path (`/mcp`) handling `POST`, `GET`, and `DELETE`. The SDK
 * itself decides per request whether to respond with `application/json` (a
 * one-shot result) or `text/event-stream` (a streamed result/notification);
 * we just forward the `Request` and return the SDK's `Response`.
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
 *   pair under that id.
 * - Subsequent `POST /mcp` and `GET /mcp` calls look up the pair by
 *   `Mcp-Session-Id`. Unknown / missing session ids short-circuit before
 *   any allocation — see `rejectMissingSession` / `rejectUnknownSession`
 *   below — so a flood of bad requests can't pin the event loop on
 *   transport+server construction.
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
import { buildResourceHandler } from "./resources.ts";
import { type ToolRegistry, buildMcpServer, createToolRegistry } from "./server.ts";
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
 * Per-session bookkeeping. Both transport AND server live here so
 * `onsessionclosed` / `onclose` can tear the server down explicitly — the
 * SDK only owns the transport, not the protocol object, so without an
 * explicit `server.close()` the per-session handler closures would leak
 * until GC ran.
 */
interface SessionPair {
  readonly transport: WebStandardStreamableHTTPServerTransport;
  readonly server: Server;
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
 * Build a Hono sub-app exposing `POST/GET/DELETE /mcp`. Mount on the main
 * app via `app.route("/mcp", buildMcpRoutes(deps))`.
 */
export function buildMcpRoutes(deps: McpRoutesDeps): Hono {
  const registry = buildToolRegistry(deps);
  const slugs = (): readonly string[] => deps.supervisor.list().map((s) => s.slug);
  const resources = buildResourceHandler(deps, slugs);
  const sessions = new Map<string, SessionPair>();
  const newSessionId = deps.randomUUID ?? ((): string => crypto.randomUUID());

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
  async function createPair(): Promise<WebStandardStreamableHTTPServerTransport> {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: newSessionId,
      // V1 has no streaming tool responses — every tool returns a single
      // payload — so JSON one-shots are the simpler shape for both adapters
      // (REST already returns JSON, parity tests don't have to parse SSE).
      // The SDK still opens SSE streams for `GET /mcp` and for any future
      // server-initiated notification.
      enableJsonResponse: true,
      onsessioninitialized: (id: string): void => {
        sessions.set(id, { transport, server });
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
    const server = buildMcpServer(registry, resources);
    await server.connect(transport);
    return transport;
  }

  const app = new Hono();

  // POST /mcp — JSON-RPC entry. The SDK decides one-shot JSON vs SSE.
  app.post("/", async (c) => {
    const sid = c.req.header("mcp-session-id");
    if (sid !== undefined) {
      const pair = sessions.get(sid);
      // Stale or unknown session id: short-circuit before allocating a fresh
      // transport+server just to let the SDK 4xx. Matches the SDK's own
      // 404 / `-32001` shape.
      if (pair === undefined) return rejectUnknownSession(c);
      return pair.transport.handleRequest(c.req.raw);
    }
    // No session id → assume `initialize`. We can't cheaply discriminate
    // here without parsing the body, so we let the slow path through; if
    // the body isn't `initialize` the SDK returns its 400 "Server not
    // initialized" envelope on the freshly created transport.
    const transport = await createPair();
    return transport.handleRequest(c.req.raw);
  });

  // GET /mcp — server-initiated SSE. Requires a valid session id.
  app.get("/", async (c) => {
    const sid = c.req.header("mcp-session-id");
    if (sid === undefined) return rejectMissingSession(c);
    const pair = sessions.get(sid);
    if (pair === undefined) return rejectUnknownSession(c);
    return pair.transport.handleRequest(c.req.raw);
  });

  // DELETE /mcp — explicit teardown.
  app.delete("/", async (c) => {
    const sid = c.req.header("mcp-session-id");
    if (sid === undefined) return rejectMissingSession(c);
    const pair = sessions.get(sid);
    if (pair === undefined) return rejectUnknownSession(c);
    return pair.transport.handleRequest(c.req.raw);
  });

  return app;
}

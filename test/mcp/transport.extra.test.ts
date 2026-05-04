/**
 * Extra transport tests covering the orphan-session branches in
 * `buildMcpRoutes`: GET / DELETE without `Mcp-Session-Id` AND with an
 * unknown id. These keep `src/mcp/index.ts` at 100% line + function
 * coverage.
 */

import { afterEach, expect, test } from "bun:test";
import { makeMcpFixture } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

const ACCEPT = "application/json, text/event-stream";

test("GET /mcp without a session id → 400 -32000", async () => {
  const fx = await makeMcpFixture({ label: "tx-get-nosid" });
  cleanup.push(fx.stop);
  const r = await fx.app.request("/mcp", {
    method: "GET",
    headers: { accept: "text/event-stream" },
  });
  expect(r.status).toBe(400);
  const body = (await r.json()) as { error: { code: number } };
  expect(body.error.code).toBe(-32000);
});

test("GET /mcp with an unknown session id → 404 -32001", async () => {
  const fx = await makeMcpFixture({ label: "tx-get-stale" });
  cleanup.push(fx.stop);
  const r = await fx.app.request("/mcp", {
    method: "GET",
    headers: { accept: "text/event-stream", "mcp-session-id": "ghost-id" },
  });
  expect(r.status).toBe(404);
  const body = (await r.json()) as { error: { code: number } };
  expect(body.error.code).toBe(-32001);
});

test("DELETE /mcp without a session id → 400 -32000", async () => {
  const fx = await makeMcpFixture({ label: "tx-del-nosid" });
  cleanup.push(fx.stop);
  const r = await fx.app.request("/mcp", { method: "DELETE" });
  expect(r.status).toBe(400);
  const body = (await r.json()) as { error: { code: number } };
  expect(body.error.code).toBe(-32000);
});

test("DELETE /mcp with an unknown session id → 404 -32001", async () => {
  const fx = await makeMcpFixture({ label: "tx-del-stale" });
  cleanup.push(fx.stop);
  const r = await fx.app.request("/mcp", {
    method: "DELETE",
    headers: { "mcp-session-id": "ghost-id" },
  });
  expect(r.status).toBe(404);
  const body = (await r.json()) as { error: { code: number } };
  expect(body.error.code).toBe(-32001);
});

test("stale Mcp-Session-Id short-circuits without allocating a new session", async () => {
  // The fast-path for unknown / missing session ids must NOT call
  // `randomUUID` — that would imply a fresh transport+server got built
  // just to let the SDK 4xx. Use the randomUUID override as a probe; if
  // it's never invoked the fast path held.
  const { buildMcpRoutes } = await import("../../src/mcp/index.ts");
  const fx = await makeMcpFixture({ label: "tx-fast-path" });
  cleanup.push(fx.stop);
  let uuidCalls = 0;
  const sub = buildMcpRoutes({
    ...fx.serviceDeps,
    supervisor: { list: () => [], get: () => null, stop: async () => undefined },
    indexer: fx.indexer,
    randomUUID: () => {
      uuidCalls++;
      return "00000000-0000-0000-0000-000000000000";
    },
  });
  const { Hono } = await import("hono");
  const app = new Hono();
  app.route("/mcp", sub);
  // Stale POST sid → fast-path 404, no allocation.
  const stalePost = await app.request("/mcp", {
    method: "POST",
    headers: { accept: ACCEPT, "content-type": "application/json", "mcp-session-id": "ghost" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  expect(stalePost.status).toBe(404);
  const staleBody = (await stalePost.json()) as { error: { code: number; message: string } };
  expect(staleBody.error.code).toBe(-32001);
  expect(staleBody.error.message).toBe("Session not found");

  // GET without sid → fast-path 400, no allocation.
  const noGet = await app.request("/mcp", { method: "GET" });
  expect(noGet.status).toBe(400);
  const noGetBody = (await noGet.json()) as { error: { code: number } };
  expect(noGetBody.error.code).toBe(-32000);

  // DELETE with stale sid → fast-path 404, no allocation.
  const delStale = await app.request("/mcp", {
    method: "DELETE",
    headers: { "mcp-session-id": "ghost" },
  });
  expect(delStale.status).toBe(404);
  expect(uuidCalls).toBe(0);
});

test("randomUUID override is exercised by the route deps shape", async () => {
  // The route-builder accepts a `randomUUID` override (used for
  // deterministic tests). Confirm by initialising with a stub generator and
  // asserting the generated session id matches.
  const { buildMcpRoutes } = await import("../../src/mcp/index.ts");
  const fx = await makeMcpFixture({ label: "tx-rid" });
  cleanup.push(fx.stop);
  const sub = buildMcpRoutes({
    ...fx.serviceDeps,
    supervisor: { list: () => [], get: () => null, stop: async () => undefined },
    indexer: fx.indexer,
    randomUUID: () => "deadbeef-deadbeef-deadbeef-deadbeefdead",
  });
  const { Hono } = await import("hono");
  const app = new Hono();
  app.route("/mcp", sub);
  const r = await app.request("/mcp", {
    method: "POST",
    headers: { accept: ACCEPT, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "t", version: "0" },
      },
    }),
  });
  expect(r.status).toBe(200);
  expect(r.headers.get("mcp-session-id")).toBe("deadbeef-deadbeef-deadbeef-deadbeefdead");
});

test("transport.onerror logs to the configured logger", async () => {
  // Trigger a transport error by sending an unparseable JSON body. The SDK
  // calls `onerror` which logs; we capture the warn line via a fixture
  // logger.
  const { buildMcpRoutes } = await import("../../src/mcp/index.ts");
  const { Hono } = await import("hono");
  const fx = await makeMcpFixture({ label: "tx-onerr" });
  cleanup.push(fx.stop);
  const warns: string[] = [];
  const sub = buildMcpRoutes({
    ...fx.serviceDeps,
    supervisor: { list: () => [], get: () => null, stop: async () => undefined },
    indexer: fx.indexer,
    logger: {
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: (m: string) => warns.push(m),
      error: () => undefined,
    },
  });
  const app = new Hono();
  app.route("/mcp", sub);
  const r = await app.request("/mcp", {
    method: "POST",
    headers: { accept: ACCEPT, "content-type": "application/json" },
    body: "not json",
  });
  // SDK returns 400 with JSON-RPC parse-error -32700 when the body is
  // unparseable. Pin both so a future SDK upgrade has to acknowledge any
  // change.
  expect(r.status).toBe(400);
  const body = (await r.json()) as { error: { code: number } };
  expect(body.error.code).toBe(-32700);
  expect(warns.some((w) => w.includes("mcp transport error"))).toBe(true);
});

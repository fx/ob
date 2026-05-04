/**
 * End-to-end transport test: drive `POST /mcp` `initialize`, follow up with
 * `tools/call`, then `DELETE /mcp` to terminate the session. Asserts the
 * SDK populates `Mcp-Session-Id`, the capabilities body advertises tools
 * AND resources, and the session-id is required on every subsequent
 * request.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { makeMcpFixture } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

const ACCEPT = "application/json, text/event-stream";

interface JsonRpc<T = unknown> {
  jsonrpc: "2.0";
  id: number;
  result: T;
}

async function postInitialize(app: import("hono").Hono): Promise<{
  res: Response;
  body: JsonRpc<{
    capabilities: { tools?: object; resources?: object };
    serverInfo: { name: string; version: string };
  }>;
  sid: string;
}> {
  const res = await app.request("/mcp", {
    method: "POST",
    headers: { accept: ACCEPT, "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    }),
  });
  const sid = res.headers.get("mcp-session-id") ?? "";
  return {
    res,
    body: (await res.json()) as JsonRpc<{
      capabilities: { tools?: object; resources?: object };
      serverInfo: { name: string; version: string };
    }>,
    sid,
  };
}

describe("MCP transport", () => {
  test("initialize returns 200 with Mcp-Session-Id and capabilities", async () => {
    const fx = await makeMcpFixture({ label: "tx-init" });
    cleanup.push(fx.stop);
    const { res, body, sid } = await postInitialize(fx.app);
    expect(res.status).toBe(200);
    expect(sid).not.toBe("");
    expect(body.result.serverInfo.name).toBe("ob");
    expect(body.result.serverInfo.version).toBeDefined();
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.capabilities.resources).toBeDefined();
  });

  test("tools/call works after initialize with the same session id", async () => {
    const fx = await makeMcpFixture({ label: "tx-call" });
    cleanup.push(fx.stop);
    const { sid } = await postInitialize(fx.app);
    // Send the `notifications/initialized` notification per the spec.
    const initNotice = await fx.app.request("/mcp", {
      method: "POST",
      headers: { accept: ACCEPT, "content-type": "application/json", "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect([200, 202]).toContain(initNotice.status);

    const callRes = await fx.app.request("/mcp", {
      method: "POST",
      headers: { accept: ACCEPT, "content-type": "application/json", "mcp-session-id": sid },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "list_vaults", arguments: {} },
      }),
    });
    expect(callRes.status).toBe(200);
    const callBody = (await callRes.json()) as JsonRpc<{
      content: { type: string; text: string }[];
      isError?: boolean;
    }>;
    expect(callBody.result.isError).not.toBe(true);
    const text = callBody.result.content[0]?.text ?? "";
    // `list_vaults` returns a bare `VaultSummary[]` for REST parity.
    const parsed = JSON.parse(text) as { slug: string }[];
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.slug).toBe("v");
  });

  test("DELETE /mcp tears down the session", async () => {
    const fx = await makeMcpFixture({ label: "tx-del" });
    cleanup.push(fx.stop);
    const { sid } = await postInitialize(fx.app);
    const del = await fx.app.request("/mcp", {
      method: "DELETE",
      headers: { "mcp-session-id": sid },
    });
    // SDK returns 200 on a successful teardown.
    expect([200, 204]).toContain(del.status);

    // After teardown, a follow-up tools/call with the same session id must
    // fail (the SDK's `validateSession` will reject — 404 per spec).
    const after = await fx.app.request("/mcp", {
      method: "POST",
      headers: { accept: ACCEPT, "content-type": "application/json", "mcp-session-id": sid },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "tools/call",
        params: { name: "list_vaults", arguments: {} },
      }),
    });
    expect([400, 404]).toContain(after.status);
  });

  test("GET /mcp opens an SSE stream with the SDK headers", async () => {
    const fx = await makeMcpFixture({ label: "tx-get" });
    cleanup.push(fx.stop);
    const { sid } = await postInitialize(fx.app);
    const sse = await fx.app.request("/mcp", {
      method: "GET",
      headers: { accept: "text/event-stream", "mcp-session-id": sid },
    });
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type") ?? "").toContain("text/event-stream");
    expect(sse.headers.get("cache-control") ?? "").toContain("no-cache");
    expect((sse.headers.get("connection") ?? "").toLowerCase()).toContain("keep-alive");
    // Cancel the stream so the test doesn't dangle.
    await sse.body?.cancel();
  });
});

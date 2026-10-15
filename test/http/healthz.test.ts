/**
 * `/healthz` reflects persistent sync failure — and nothing else does.
 *
 * Liveness fails when a vault's sync is down, but request handling must keep
 * working: a vault whose sync is down still serves REST and MCP reads and
 * writes, on the assumption that sync recovers (or the pod restarts) and
 * carries the changes up. These tests drive the full app — real indexer,
 * real vault directory — through `app.request`, which is `app.fetch`.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { makeHttpFixture, waitFor } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

const ACCEPT = "application/json, text/event-stream";

async function mcpPost(app: import("hono").Hono, body: unknown, sid?: string): Promise<Response> {
  return app.request("/mcp", {
    method: "POST",
    headers: {
      accept: ACCEPT,
      "content-type": "application/json",
      ...(sid !== undefined ? { "mcp-session-id": sid } : {}),
    },
    body: JSON.stringify(body),
  });
}

describe("a vault whose sync is down", () => {
  test("fails /healthz while REST and MCP keep reading and writing it", async () => {
    const fx = await makeHttpFixture("healthz-down", {
      state: "failed",
      pid: null,
      consecutiveFailures: 99,
      lastError: "sync stall-loop: 3 stall kills within 3600000ms",
    });
    cleanup.push(fx.stop);
    await waitFor(() => fx.indexer.status("v")?.state === "ready");

    const health = await fx.app.request("/healthz");
    expect(health.status).toBe(503);
    expect(await health.json()).toEqual({
      ok: false,
      unhealthy: [
        {
          slug: "v",
          reason: "failed",
          state: "failed",
          consecutiveFailures: 99,
          lastError: "sync stall-loop: 3 stall kills within 3600000ms",
        },
      ],
    });

    // REST: write, read back, and the vault's own status.
    const put = await fx.app.request("/v1/vaults/v/files/a.md", {
      method: "PUT",
      headers: { "content-type": "text/markdown" },
      body: "# still writable",
    });
    expect(put.status).toBe(200);
    const get = await fx.app.request("/v1/vaults/v/files/a.md");
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("# still writable");
    const vault = await fx.app.request("/v1/vaults/v");
    expect(vault.status).toBe(200);

    // MCP over the same app: initialize, then read the file back.
    const init = await mcpPost(fx.app, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    });
    expect(init.status).toBe(200);
    const sid = init.headers.get("mcp-session-id") ?? "";
    expect(sid).not.toBe("");
    await mcpPost(fx.app, { jsonrpc: "2.0", method: "notifications/initialized" }, sid);
    const call = await mcpPost(
      fx.app,
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "read_file", arguments: { vault: "v", path: "a.md" } },
      },
      sid,
    );
    expect(call.status).toBe(200);
    const body = (await call.json()) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    expect(body.result.isError).not.toBe(true);
    const parsed = JSON.parse(body.result.content[0]?.text ?? "") as { content: string };
    expect(parsed.content).toBe("# still writable");
  });
});

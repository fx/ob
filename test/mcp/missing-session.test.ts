/**
 * Spec: a `tools/call` POST without `Mcp-Session-Id` after a session had
 * been established MUST be rejected with the SDK's documented missing-
 * session 4xx. The SDK currently returns 400 with JSON-RPC error code
 * `-32000` and message containing "Bad Request".
 *
 * This test pins down the SDK behavior so a later SDK upgrade that
 * changes it gets caught by CI.
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

test("tools/call without session id is a 4xx with JSON-RPC error", async () => {
  const fx = await makeMcpFixture({ label: "missing-sid" });
  cleanup.push(fx.stop);
  // Establish a session first so we can be sure the rejection isn't because
  // the server has never seen any client.
  const init = await fx.app.request("/mcp", {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
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
  expect(init.status).toBe(200);

  const res = await fx.app.request("/mcp", {
    method: "POST",
    headers: { accept: "application/json, text/event-stream", "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "list_vaults", arguments: {} },
    }),
  });
  // SDK 1.29.0 returns 400 with a JSON-RPC error envelope. Pin both so a
  // future SDK upgrade has to acknowledge any change.
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: { code: number; message: string } };
  // SDK error code is the generic application-defined `-32000`. The message
  // is "Bad Request: Server not initialized" — the fresh per-route transport
  // we route the orphan POST through hasn't completed initialize, so the SDK
  // refuses any non-initialize call. We pin the message so a future SDK
  // upgrade that reshapes it has to be acknowledged here.
  expect(body.error.code).toBe(-32000);
  expect(body.error.message.toLowerCase()).toContain("not initialized");
});

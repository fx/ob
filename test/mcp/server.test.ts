/**
 * Server / registry plumbing tests. Drives `tools/list` and the unknown-tool
 * `tools/call` path through the HTTP transport (in-process via the Hono
 * fixture), and exercises the registry's duplicate-name guard directly.
 */

import { afterEach, expect, test } from "bun:test";
import { z } from "zod";
import {
  SERVER_NAME,
  SERVER_VERSION,
  buildMcpServer,
  createToolRegistry,
} from "../../src/mcp/server.ts";
import { tool } from "../../src/mcp/tool.ts";
import { makeMcpFixture } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

const ACCEPT = "application/json, text/event-stream";

async function init(app: import("hono").Hono): Promise<string> {
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
  return r.headers.get("mcp-session-id") ?? "";
}

test("SERVER_NAME and SERVER_VERSION are set", () => {
  expect(SERVER_NAME).toBe("ob");
  expect(typeof SERVER_VERSION).toBe("string");
});

test("createToolRegistry: register/list/get + duplicate-name guard", () => {
  const r = createToolRegistry();
  const t = tool("a", "x", z.object({}).strict(), async () => ({ ok: true }));
  r.register(t);
  expect(r.list()).toHaveLength(1);
  expect(r.get("a")).toBe(t);
  expect(r.get("missing")).toBeUndefined();
  expect(() => r.register(t)).toThrow();
});

test("buildMcpServer constructs a Server (smoke; verified via tools/list end-to-end)", () => {
  const r = createToolRegistry();
  const s = buildMcpServer(r, {
    list: async () => ({ resources: [] }),
    read: async () => ({ contents: [{ uri: "x", mimeType: "text/markdown", text: "" }] }),
  });
  expect(s).toBeDefined();
});

test("tools/list over HTTP returns every registered tool", async () => {
  const fx = await makeMcpFixture({ label: "srv-list" });
  cleanup.push(fx.stop);
  const sid = await init(fx.app);
  const res = await fx.app.request("/mcp", {
    method: "POST",
    headers: { accept: ACCEPT, "content-type": "application/json", "mcp-session-id": sid },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result: { tools: { name: string; inputSchema: object }[] };
  };
  const names = body.result.tools.map((t) => t.name).sort();
  expect(names).toEqual(
    [
      "append_file",
      "delete_file",
      "list_files",
      "list_vaults",
      "patch_file",
      "read_file",
      "search",
      "vault_status",
      "write_file",
    ].sort(),
  );
  // Every tool advertises `inputSchema` as a JSON Schema object with type=object.
  for (const t of body.result.tools) {
    expect((t.inputSchema as { type: string }).type).toBe("object");
  }
});

test("tools/call with an unknown name surfaces the not_found isError envelope", async () => {
  const fx = await makeMcpFixture({ label: "srv-unknown" });
  cleanup.push(fx.stop);
  const sid = await init(fx.app);
  const res = await fx.app.request("/mcp", {
    method: "POST",
    headers: { accept: ACCEPT, "content-type": "application/json", "mcp-session-id": sid },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "no_such_tool", arguments: {} },
    }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    result: { isError: true; content: { text: string }[] };
  };
  expect(body.result.isError).toBe(true);
  const text = body.result.content[0]?.text ?? "";
  const parsed = JSON.parse(text) as { code: string };
  expect(parsed.code).toBe("not_found");
});

test("resources/list and resources/read over HTTP transport", async () => {
  const fx = await makeMcpFixture({ label: "srv-resources" });
  cleanup.push(fx.stop);
  const { writeFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  writeFileSync(join(fx.vaultRoot, "x.md"), "# hi");
  const sid = await init(fx.app);
  const list = await fx.app.request("/mcp", {
    method: "POST",
    headers: { accept: ACCEPT, "content-type": "application/json", "mcp-session-id": sid },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "resources/list" }),
  });
  expect(list.status).toBe(200);
  const listBody = (await list.json()) as {
    result: { resources: { uri: string }[] };
  };
  expect(listBody.result.resources.map((r) => r.uri)).toContain("obvault://v/x.md");

  const read = await fx.app.request("/mcp", {
    method: "POST",
    headers: { accept: ACCEPT, "content-type": "application/json", "mcp-session-id": sid },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "resources/read",
      params: { uri: "obvault://v/x.md" },
    }),
  });
  const readBody = (await read.json()) as {
    result: { contents: { text: string }[] };
  };
  expect(readBody.result.contents[0]?.text).toBe("# hi");
});

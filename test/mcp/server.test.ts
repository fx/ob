/**
 * Server / registry plumbing tests. Drives `tools/list` and the unknown-tool
 * `tools/call` path through the HTTP transport (in-process via the Hono
 * fixture), and exercises the registry's duplicate-name guard directly.
 */

import { afterEach, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
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

test("tools/call hands the tool the request's abort signal, which a client cancel aborts", async () => {
  const r = createToolRegistry();
  let aborted = (): void => {};
  const sawAbort = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  let entered = (): void => {};
  const running = new Promise<void>((resolve) => {
    entered = resolve;
  });
  r.register(
    tool("probe", "x", z.object({}).strict(), async (_args, extra) => {
      extra.signal?.addEventListener("abort", () => aborted(), { once: true });
      entered();
      await sawAbort;
      return { ok: true };
    }),
  );
  const server = buildMcpServer(r, {
    list: async () => ({ resources: [] }),
    read: async () => ({ contents: [{ uri: "x", mimeType: "text/markdown", text: "" }] }),
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(clientSide);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  const ctl = new AbortController();
  const call = client.callTool({ name: "probe", arguments: {} }, undefined, {
    signal: ctl.signal,
  });
  await running;
  ctl.abort();
  await expect(call).rejects.toBeDefined();
  // The server-side signal aborted: the tool saw the cancellation.
  await sawAbort;
});

test("tools/call stamps its arrival on the given clock before the tool and its wrappers run", async () => {
  let t = 100;
  const seen: (number | undefined)[] = [];
  const inner = tool("probe", "x", z.object({}).strict(), async (_args, extra) => {
    seen.push(extra.arrivedAt);
    return { ok: true };
  });
  const r = createToolRegistry();
  // A wrapper that takes time before delegating, like the scope guard.
  r.register({
    ...inner,
    call: async (raw, extra) => {
      t += 6_000;
      return inner.call(raw, extra);
    },
  });
  const server = buildMcpServer(
    r,
    {
      list: async () => ({ resources: [] }),
      read: async () => ({ contents: [{ uri: "x", mimeType: "text/markdown", text: "" }] }),
    },
    undefined,
    () => t,
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(clientSide);
  cleanup.push(async () => {
    await client.close();
    await server.close();
  });
  await client.callTool({ name: "probe", arguments: {} });
  expect(seen).toEqual([100]);
  expect(t).toBe(6_100);
});

test("buildMcpServer constructs a Server (smoke; verified via tools/list end-to-end)", () => {
  const r = createToolRegistry();
  const s = buildMcpServer(r, {
    list: async () => ({ resources: [] }),
    read: async () => ({ contents: [{ uri: "x", mimeType: "text/markdown", text: "" }] }),
  });
  expect(s).toBeDefined();
});

test("tool(): inputSchema is the plain input-side JSON Schema of the Zod schema", () => {
  const t = tool(
    "shape",
    "x",
    z
      .object({
        vault: z.string().min(1).describe("vault slug"),
        format: z.enum(["text", "binary"]).default("text"),
        limit: z.number().int().min(1).max(100).optional(),
      })
      .strict(),
    async () => ({ ok: true }),
  );
  // No `$schema` / `$defs` noise; a `.default()` field is optional for the
  // caller (input side), not required as it would be on the output side.
  expect(t.inputSchema).toEqual({
    type: "object",
    properties: {
      vault: { type: "string", minLength: 1, description: "vault slug" },
      format: { type: "string", enum: ["text", "binary"], default: "text" },
      limit: { type: "integer", minimum: 1, maximum: 100 },
    },
    required: ["vault"],
    additionalProperties: false,
  });
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
    result: {
      tools: { name: string; inputSchema: object; annotations?: { readOnlyHint?: boolean } }[];
    };
  };
  const names = body.result.tools.map((t) => t.name).sort();
  expect(names).toEqual(
    [
      "append_file",
      "create_folder",
      "delete",
      "grep",
      "list",
      "list_tags",
      "list_vaults",
      "patch_file",
      "read_file",
      "search",
      "vault_status",
      "write_file",
    ].sort(),
  );
  // No per-type duplicate of a path tool survives (MCP › Tool design rules).
  for (const gone of ["list_files", "list_folders", "delete_file", "delete_folder"]) {
    expect(names).not.toContain(gone);
  }
  // Every tool advertises `inputSchema` as a JSON Schema object with type=object.
  for (const t of body.result.tools) {
    expect((t.inputSchema as { type: string }).type).toBe("object");
  }
  // Exactly the read tools advertise `readOnlyHint`, always as `true`, so
  // clients (e.g. Claude Code in plan mode) can call them without a permission
  // prompt. Selecting on "defined" rather than "=== true" also catches a write
  // tool that advertises `readOnlyHint: false`.
  const hinted = body.result.tools.filter((t) => t.annotations?.readOnlyHint !== undefined);
  expect(hinted.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  expect(hinted.map((t) => t.name).sort()).toEqual([
    "grep",
    "list",
    "list_tags",
    "list_vaults",
    "read_file",
    "search",
    "vault_status",
  ]);
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

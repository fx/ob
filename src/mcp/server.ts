/**
 * MCP server factory.
 *
 * Creates a fresh `@modelcontextprotocol/sdk` `Server` instance per session,
 * pre-wired with the four request handlers we care about (`tools/list`,
 * `tools/call`, `resources/list`, `resources/read`). The `Server` instance
 * itself is per-session because the SDK's `Protocol.connect(transport)`
 * takes ownership of the transport — sharing a single server across multiple
 * concurrent transports is explicitly unsupported. The set of tools and the
 * resource handler are pure values, however, so they're built once per
 * process and re-bound onto each new server.
 *
 * The bootstrap exposes `register(tool)` so callers can extend the registry
 * before opening sessions; in production the registry is fixed at startup
 * and `register` is just the wiring used by `buildAllTools` / tests.
 *
 * Capabilities advertise `tools.listChanged: true` (vault membership today
 * never changes after startup, but the hook is required by the spec) and
 * `resources.listChanged: false`. `serverInfo.name = "ob"` and
 * `serverInfo.version` is read from `package.json` so a release bump
 * automatically propagates.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import pkg from "../../package.json" with { type: "json" };
import type { ResourceHandler } from "./resources.ts";
import type { ToolDefinition } from "./tool.ts";

/**
 * Logical name advertised in `serverInfo.name`. Pulled out so tests can
 * assert it without importing the SDK constants.
 */
export const SERVER_NAME = "ob" as const;

/** Read at import-time so the build can tree-shake the rest of `package.json`. */
export const SERVER_VERSION: string = (pkg as { version: string }).version;

/**
 * Mutable tool registry shared by every per-session server. The bootstrap
 * builds one of these at startup; each `buildMcpServer(deps)` call binds the
 * current snapshot onto a freshly created `Server` instance.
 */
export interface ToolRegistry {
  /** Add a tool. Throws if the name is already taken — duplicate names are a bug. */
  register(tool: ToolDefinition): void;
  /** Return the currently registered tools (used by `tools/list`). */
  list(): readonly ToolDefinition[];
  /** Look up a tool by name (used by `tools/call`). `undefined` if not present. */
  get(name: string): ToolDefinition | undefined;
}

/** Create a fresh, empty registry. */
export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDefinition>();
  return {
    register(t: ToolDefinition): void {
      if (tools.has(t.name)) {
        throw new Error(`tool "${t.name}" already registered`);
      }
      tools.set(t.name, t);
    },
    list(): readonly ToolDefinition[] {
      return Array.from(tools.values());
    },
    get(name: string): ToolDefinition | undefined {
      return tools.get(name);
    },
  };
}

/**
 * Build a fresh `Server` instance with the given registry + resource handler
 * bound. Call once per session.
 */
export function buildMcpServer(registry: ToolRegistry, resources: ResourceHandler): Server {
  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: false },
      },
    },
  );

  // The SDK's request-handler return type is the union of every possible
  // server response result; TS picks the wrong member when narrowing our
  // structural shape. We cast to `unknown` first as the recommended escape
  // hatch — the wire shape is exactly what the SDK validates against in its
  // outgoing-message Zod parser.
  server.setRequestHandler(
    ListToolsRequestSchema,
    // biome-ignore lint/suspicious/noExplicitAny: SDK return-type union resolves to a different concrete `Result` shape; the wire payload is validated by the SDK's outgoing Zod parser.
    async (): Promise<any> => ({
      tools: registry.list().map((t) => ({
        name: t.name,
        description: t.description,
        // The SDK validates `inputSchema` on the wire as `{ type: "object",
        // properties?, required? }`. zodToJsonSchema in `tool.ts` already
        // produces that exact shape.
        inputSchema: t.inputSchema,
      })),
    }),
  );

  server.setRequestHandler(
    CallToolRequestSchema,
    // biome-ignore lint/suspicious/noExplicitAny: SDK's `ServerResult` union resolves to a sampling `Result` here; the actual `CallToolResult` shape is enforced by the SDK's outgoing Zod parser.
    async (req): Promise<any> => {
      const tool = registry.get(req.params.name);
      if (tool === undefined) {
        // Unknown tool name → emit the canonical `isError` shape directly.
        // We don't go through `mapErrorToMcpResult` because the closed-set codes
        // in `src/errors.ts` don't carry a "tool name" concept; the per-tool
        // handler is the only place that knows whether the tool exists.
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                code: "not_found",
                message: `tool "${req.params.name}" not found`,
                details: { tool: req.params.name },
              }),
            },
          ],
        };
      }
      return tool.call(req.params.arguments ?? {});
    },
  );

  server.setRequestHandler(
    ListResourcesRequestSchema,
    // biome-ignore lint/suspicious/noExplicitAny: same reason as the tools/list handler — the SDK's `ServerResult` union resolves to a different concrete shape; the wire payload is validated by the SDK's outgoing Zod parser.
    async (req): Promise<any> => resources.list(req.params?.cursor),
  );
  server.setRequestHandler(
    ReadResourceRequestSchema,
    // biome-ignore lint/suspicious/noExplicitAny: same reason as the tools/list handler — the SDK's `ServerResult` union resolves to a different concrete shape; the wire payload is validated by the SDK's outgoing Zod parser.
    async (req): Promise<any> => resources.read(req.params.uri),
  );

  return server;
}

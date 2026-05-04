/**
 * Test helpers for the MCP adapter.
 *
 * `makeMcpFixture` builds a real Hono app via `buildHttpApp` so the same
 * fixture can drive both the REST and MCP adapters (parity tests rely on
 * this). It also exposes the in-process tool registry directly so tool
 * tests can drive `tool.call(input)` without going through HTTP transport
 * — that path matches the change-doc requirement that tool tests "drive
 * the registered MCP server through its in-process JSON-RPC handler — not
 * through HTTP".
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import type { Config } from "../../src/config/index.ts";
import { buildHashEmbedder } from "../../src/embeddings/fake.ts";
import { buildHttpApp } from "../../src/http/index.ts";
import { type Indexer, startIndexer } from "../../src/indexer/index.ts";
import type { Logger } from "../../src/log.ts";
import { buildToolRegistry } from "../../src/mcp/index.ts";
import { type ResourceHandler, buildResourceHandler } from "../../src/mcp/resources.ts";
import { type ToolRegistry, buildMcpServer } from "../../src/mcp/server.ts";
import type { ToolDefinition } from "../../src/mcp/tool.ts";
import type { Supervisor, VaultStatus } from "../../src/obsidian/index.ts";
import type { VaultDescriptor, VaultServiceDeps } from "../../src/vault/files.ts";

function silent(): Logger {
  return {
    trace: () => undefined,
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
}

function fakeSupervisor(statuses: VaultStatus[]): Supervisor {
  return {
    list: () => statuses.slice(),
    get: (slug) => statuses.find((s) => s.slug === slug) ?? null,
    stop: async () => undefined,
  };
}

export interface McpFixture {
  readonly app: Hono;
  readonly indexer: Indexer;
  readonly dataDir: string;
  readonly slug: string;
  readonly vaultRoot: string;
  readonly registry: ToolRegistry;
  readonly resources: ResourceHandler;
  readonly serviceDeps: VaultServiceDeps;
  readonly stop: () => Promise<void>;
  /**
   * Convenience accessor: invoke a registered tool by name. Always parses
   * the result content as JSON so callers can pattern-match on `code` etc.
   */
  callTool(name: string, args: unknown): Promise<{ isError?: boolean; parsed: unknown }>;
}

export interface McpFixtureOptions {
  readonly label?: string;
  readonly slugs?: readonly string[];
}

export async function makeMcpFixture(opts: McpFixtureOptions = {}): Promise<McpFixture> {
  const label = opts.label ?? "mcp";
  const dataDir = mkdtempSync(join(tmpdir(), `ob-${label}-`));
  const slugs = opts.slugs ?? ["v"];
  const slug = slugs[0] ?? "";
  for (const s of slugs) mkdirSync(join(dataDir, "vaults", s), { recursive: true });
  // For the empty-slugs fixture there is no real vault root; use the dataDir
  // as a sentinel so callers that touch it on the no-vault path get a
  // recognisable failure rather than `undefined.toString()`.
  const vaultRoot = slug === "" ? dataDir : join(dataDir, "vaults", slug);

  const cfg: Config = {
    obsidianAuthToken: undefined,
    vaults: slugs.map((s) => ({ name: s, slug: s })),
    dataDir,
    httpPort: 0,
    httpHost: "127.0.0.1",
    embeddingProvider: "transformers",
    embeddingModel: "x",
    logLevel: "error",
  };

  const indexer = await startIndexer(cfg, {
    logger: silent(),
    embedder: buildHashEmbedder(8),
  });

  const supervisor = fakeSupervisor(
    slugs.map((s) => ({
      slug: s,
      name: s,
      state: "running",
      pid: 1,
      restarts: 0,
      lastError: null,
    })),
  );

  const app = buildHttpApp({ supervisor, indexer, config: cfg, logger: silent() });

  // Pre-build the same VaultServiceDeps used inside the route mount so tests
  // can exercise tools and the registry directly.
  const lookup = (s: string): VaultDescriptor | null => {
    if (!slugs.includes(s)) return null;
    return { slug: s, name: s, root: join(dataDir, "vaults", s) };
  };
  const serviceDeps: VaultServiceDeps = { vault: lookup, indexer, logger: silent() };
  const registry = buildToolRegistry({
    ...serviceDeps,
    supervisor,
    indexer,
    logger: silent(),
  });
  const resources = buildResourceHandler(serviceDeps, () => slugs);

  return {
    app,
    indexer,
    dataDir,
    slug,
    vaultRoot,
    registry,
    resources,
    serviceDeps,
    stop: async (): Promise<void> => {
      await indexer.stop();
    },
    callTool: async (
      name: string,
      args: unknown,
    ): Promise<{ isError?: boolean; parsed: unknown }> => {
      const t = registry.get(name);
      if (t === undefined) throw new Error(`tool ${name} not registered`);
      const r = (await t.call(args)) as {
        isError?: boolean;
        content: readonly { type: string; text: string }[];
      };
      const text = r.content[0]?.text ?? "";
      return r.isError === true
        ? { isError: true, parsed: JSON.parse(text) }
        : { parsed: JSON.parse(text) };
    },
  };
}

export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  pollMs = 25,
): Promise<void> {
  const start = Date.now();
  while (true) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise<void>((r) => setTimeout(r, pollMs));
  }
}

/**
 * Build a stand-alone MCP `Server` bound to a fixture's registry +
 * resources. Used by transport tests that want to drive the SDK directly.
 */
export function serverFor(fx: McpFixture): ReturnType<typeof buildMcpServer> {
  return buildMcpServer(fx.registry, fx.resources);
}

/** Re-export commonly used types so tests don't reach into src/. */
export type { ToolDefinition };

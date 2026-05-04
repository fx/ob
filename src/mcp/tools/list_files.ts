/**
 * MCP tool: `list_files`. Mirrors `GET /v1/vaults/:slug/files`.
 */

import { z } from "zod";
import { type VaultServiceDeps, listFiles } from "../../vault/files.ts";
import { type ToolDefinition, tool } from "../tool.ts";

const Input = z
  .object({
    vault: z.string().min(1),
    prefix: z.string().max(1024).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    cursor: z.string().optional(),
  })
  .strict();

export function listFilesTool(deps: VaultServiceDeps): ToolDefinition {
  return tool(
    "list_files",
    "Page through files in a vault. Returns `{ items, nextCursor }`; an opaque cursor advances the next call. Mirrors REST GET /v1/vaults/:slug/files.",
    Input,
    async (args) => {
      const opts: { prefix?: string; limit?: number; cursor?: string } = {};
      if (args.prefix !== undefined) opts.prefix = args.prefix;
      if (args.limit !== undefined) opts.limit = args.limit;
      if (args.cursor !== undefined) opts.cursor = args.cursor;
      return listFiles(deps, args.vault, opts);
    },
  );
}

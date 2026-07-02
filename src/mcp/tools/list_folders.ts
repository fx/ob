/**
 * MCP tool: `list_folders`. Mirrors `GET /v1/vaults/:slug/folders`.
 */

import { ListFoldersInput } from "../../schemas/index.ts";
import type { VaultServiceDeps } from "../../vault/files.ts";
import { listFolders } from "../../vault/folders.ts";
import { type ToolDefinition, tool } from "../tool.ts";

export function listFoldersTool(deps: VaultServiceDeps): ToolDefinition {
  return tool(
    "list_folders",
    "Page through folders in a vault. Complements list_files: this is the only way to see folders that contain no files (list_files yields files only, so empty folders are invisible to it). Returns `{ items, nextCursor }`; an opaque cursor advances the next call. Mirrors REST GET /v1/vaults/:slug/folders.",
    ListFoldersInput,
    async (args) => {
      const opts: { prefix?: string; limit?: number; cursor?: string } = {};
      if (args.prefix !== undefined) opts.prefix = args.prefix;
      if (args.limit !== undefined) opts.limit = args.limit;
      if (args.cursor !== undefined) opts.cursor = args.cursor;
      return listFolders(deps, args.vault, opts);
    },
  );
}

/**
 * MCP tool: `create_folder`. Mirrors `PUT /v1/vaults/:slug/folders/*path`.
 */

import { CreateFolderInput } from "../../schemas/index.ts";
import type { VaultServiceDeps } from "../../vault/files.ts";
import { createFolder } from "../../vault/folders.ts";
import { type ToolDefinition, tool } from "../tool.ts";

export function createFolderTool(deps: VaultServiceDeps): ToolDefinition {
  return tool(
    "create_folder",
    "Create a folder (and any missing parents). Idempotent, like `mkdir -p`: creating an existing folder is a no-op that returns `created: false`. Returns `{ path, mtimeMs, created }`. Mirrors REST PUT /v1/vaults/:slug/folders/*path.",
    CreateFolderInput,
    async (args) => createFolder(deps, args.vault, args.path),
  );
}

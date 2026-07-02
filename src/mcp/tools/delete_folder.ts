/**
 * MCP tool: `delete_folder`. Mirrors `DELETE /v1/vaults/:slug/folders/*path`.
 */

import { DeleteFolderInput } from "../../schemas/index.ts";
import type { VaultServiceDeps } from "../../vault/files.ts";
import { deleteFolder } from "../../vault/folders.ts";
import { type ToolDefinition, tool } from "../tool.ts";

export function deleteFolderTool(deps: VaultServiceDeps): ToolDefinition {
  return tool(
    "delete_folder",
    "Delete a folder. By default this refuses a non-empty folder (returns a folder_not_empty error); pass `recursive: true` to opt into removing the folder and everything under it. Recursive deletes drop the index entry of every Markdown descendant. Returns `{ deleted: true }`. Mirrors REST DELETE /v1/vaults/:slug/folders/*path.",
    DeleteFolderInput,
    async (args) => {
      const opts: { recursive?: boolean } = {};
      if (args.recursive !== undefined) opts.recursive = args.recursive;
      await deleteFolder(deps, args.vault, args.path, opts);
      return { deleted: true };
    },
  );
}

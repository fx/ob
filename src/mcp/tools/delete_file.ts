/**
 * MCP tool: `delete_file`. Mirrors `DELETE /v1/vaults/:slug/files/*path`.
 */

import { z } from "zod";
import { type VaultServiceDeps, deleteFile } from "../../vault/files.ts";
import { type ToolDefinition, tool } from "../tool.ts";

const Input = z.object({ vault: z.string().min(1), path: z.string().min(1) }).strict();

export function deleteFileTool(deps: VaultServiceDeps): ToolDefinition {
  return tool(
    "delete_file",
    "Delete a file. Markdown deletes drop the index entry; binary deletes do not touch the index. Mirrors REST DELETE /v1/vaults/:slug/files/*path.",
    Input,
    async (args) => {
      await deleteFile(deps, args.vault, args.path);
      return { deleted: true };
    },
  );
}

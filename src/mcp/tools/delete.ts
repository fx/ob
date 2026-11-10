/**
 * MCP tool: `delete` (`rm` / `rm -r`). Mirrors `DELETE /v1/vaults/:slug/paths/*path`.
 */

import { DeletePathInput } from "../../schemas/index.ts";
import type { VaultServiceDeps } from "../../vault/files.ts";
import { deletePath } from "../../vault/paths.ts";
import { type ToolDefinition, tool } from "../tool.ts";

export function deleteTool(deps: VaultServiceDeps): ToolDefinition {
  return tool(
    "delete",
    "Delete a file or a folder alike (like `rm`). A file is always removed. An empty folder is " +
      "removed; a non-empty folder is refused with a folder_not_empty error unless you pass " +
      "`recursive: true` (like `rm -r`), which removes the folder and everything under it. The " +
      "removed paths' search-index entries are dropped. A missing path is a not_found error. " +
      "Returns `{ deleted: true }`. Mirrors REST DELETE /v1/vaults/:slug/paths/*path.",
    DeletePathInput,
    async ({ vault, path, recursive }) => {
      await deletePath(deps, vault, path, { recursive });
      return { deleted: true };
    },
  );
}

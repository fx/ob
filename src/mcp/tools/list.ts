/**
 * MCP tool: `list` (`ls`). Mirrors `GET /v1/vaults/:slug/paths`.
 */

import { ListPathsInput } from "../../schemas/index.ts";
import type { VaultServiceDeps } from "../../vault/files.ts";
import { listPaths } from "../../vault/paths.ts";
import { type ToolDefinition, tool } from "../tool.ts";

export function listTool(deps: VaultServiceDeps): ToolDefinition {
  return tool(
    "list",
    "List files and folders alike in one ordered walk (like `ls`). Every entry carries `type: " +
      '"file"` or `"folder"`; file entries add `size`, `sha256`, and `contentType`. Empty folders ' +
      'are listed. Pass `type: "file"` or `type: "folder"` to return only that type (applied ' +
      "before `limit`). `recursive` defaults to `true`; with `recursive: false` only the direct " +
      'children of the prefix\'s folder are returned (`prefix: "notes/"` lists what is directly ' +
      'in `notes`, `prefix: ""` the top level). `prefix` is matched literally against the start ' +
      "of each path. Returns `{ items, nextCursor }`; pass `nextCursor` as `cursor` for the next " +
      "page (`null` on the last). Mirrors REST GET /v1/vaults/:slug/paths.",
    ListPathsInput,
    async ({ vault, ...opts }) => listPaths(deps, vault, opts),
    { readOnlyHint: true },
  );
}

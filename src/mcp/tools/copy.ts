/**
 * MCP tool: `copy` (`cp -T`, `cp -r -T`). Mirrors `POST /v1/vaults/:slug/paths/*path:copy`.
 */

import { CopyInput } from "../../schemas/index.ts";
import { copyPath } from "../../vault/copy.ts";
import type { VaultServiceDeps } from "../../vault/files.ts";
import { type ToolDefinition, tool } from "../tool.ts";

export function copyTool(deps: VaultServiceDeps): ToolDefinition {
  return tool(
    "copy",
    "Copy a path; works on files and folders alike (like `cp -T`) to the exact path `destination`; missing " +
      "parent folders are created. A folder needs `recursive: true` (like `cp -r`); it is " +
      "copied whole or not at all, hidden entries and symlinks are not copied and are counted " +
      "in `skipped`. An existing destination is refused with an already_exists error unless " +
      "you pass `overwrite: true`, which replaces an existing destination FILE only (a folder " +
      "copy never merges). Content is copied byte for byte and links are NOT rewritten. " +
      "`indexed` is `true` only when at least one copied note was indexed and every index " +
      "update succeeded. Returns `{ path, destination, type, overwritten, indexed, files, " +
      "skipped }`. Mirrors REST POST /v1/vaults/:slug/paths/*path:copy.",
    CopyInput,
    async ({ vault, path, ...opts }) => copyPath(deps, vault, path, opts),
  );
}

/**
 * MCP tool: `move` (`mv -T`). Mirrors `POST /v1/vaults/:slug/paths/*path:move`.
 */

import { MoveInput } from "../../schemas/index.ts";
import type { VaultServiceDeps } from "../../vault/files.ts";
import { movePath } from "../../vault/paths.ts";
import { type ToolDefinition, tool } from "../tool.ts";

export function moveTool(deps: VaultServiceDeps): ToolDefinition {
  return tool(
    "move",
    "Move or rename a path; works on files and folders alike (like `mv -T`). `destination` is the exact new " +
      "path, never a folder to move into; missing parent folders are created. An existing " +
      "destination is refused with an already_exists error unless you pass `overwrite: true`, " +
      "which replaces an existing destination FILE and never applies to folders (a folder " +
      "never replaces or merges). Internal links pointing at the moved files (wikilinks, " +
      "embeds, and relative Markdown links) are rewritten to keep pointing at them unless you " +
      "pass `updateLinks: false`; the result's `links.updated` lists each rewritten note with " +
      "its own `indexed`, and `links.failed` the notes that could not be rewritten (left " +
      "unchanged; retry them with patch_file). The top-level `indexed` covers the moved paths " +
      "only — a moved note that was also rewritten counts among them, rewritten notes that did " +
      "not move report only in their own entry — and is `true` only when at least one moved " +
      "note was indexed and every index update of moved paths succeeded. In a session scoped " +
      "to a folder, only notes inside the scope are rewritten, so links from notes outside it " +
      "to the moved files can break and are not reported. Returns `{ path, destination, type, " +
      "overwritten, indexed, links }` (`links` is null with `updateLinks: false`). Mirrors " +
      "REST POST /v1/vaults/:slug/paths/*path:move.",
    MoveInput,
    async ({ vault, path, ...opts }) => movePath(deps, vault, path, opts),
  );
}

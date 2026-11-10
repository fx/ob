/**
 * MCP tool: `list_tags`. Mirrors `GET /v1/vaults/:slug/tags`.
 */

import { ListTagsInput } from "../../schemas/index.ts";
import type { VaultServiceDeps } from "../../vault/files.ts";
import { listTags } from "../../vault/tags.ts";
import { type ToolDefinition, tool } from "../tool.ts";

const DESCRIPTION = [
  "List the inline tags (`#tag`, without the `#`) in a vault's search index,",
  "with the number of documents carrying each. Nested tags are NOT rolled up",
  "into their parents: a note tagged only `#project/alpha` counts toward",
  "`project/alpha`, not `project`. Every listed tag can be passed to `search`",
  "as `filter.tag`, which then finds exactly that many documents. Tags in",
  "frontmatter are not listed. Ordered by count, then tag; `prefix` counts",
  "only documents whose path starts with it; `limit` (default 100, max 1000)",
  "caps `items` and `total` is the number of distinct tags before the cap.",
  "Mirrors REST GET /v1/vaults/:slug/tags.",
].join(" ");

export function listTagsTool(deps: VaultServiceDeps): ToolDefinition {
  return tool(
    "list_tags",
    DESCRIPTION,
    ListTagsInput,
    async (args) => {
      const opts: { prefix?: string; limit?: number } = {};
      if (args.prefix !== undefined) opts.prefix = args.prefix;
      if (args.limit !== undefined) opts.limit = args.limit;
      return listTags(deps, args.vault, opts);
    },
    { readOnlyHint: true },
  );
}

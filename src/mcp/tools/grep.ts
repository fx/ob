/**
 * MCP tool: `grep`. Mirrors `POST /v1/vaults/:slug/grep`. The call's abort
 * signal (MCP cancellation) is passed through, so a cancelled grep leaves the
 * queue or terminates its worker.
 */

import { GrepInput } from "../../schemas/index.ts";
import type { VaultServiceDeps } from "../../vault/files.ts";
import { grep } from "../../vault/grep.ts";
import { type ToolDefinition, tool } from "../tool.ts";

const DESCRIPTION = [
  "Find exact text in a vault's files on disk, line by line: `pattern` is a",
  "literal substring by default, or an ECMAScript regular expression (Unicode",
  "mode) with `regex: true`; `ignoreCase: true` matches case-insensitively.",
  "Searches text files only (Markdown and other text formats); PDFs and binary",
  "files are NOT searched, nor are hidden files or files over 1 MiB. One match",
  "per matching line: `{ path, line, column, text, textStart }` (1-based; long",
  "lines are windowed to 1000 characters starting at column `textStart`), plus",
  "`before` / `after` lines when `context` (0-5) is set. `prefix` limits the",
  "search to paths starting with it. Results are capped: at most `limit`",
  "(default 100, max 1000) matches, 64 MiB read, and 5 seconds; a capped",
  'response has `truncated: true` and `reason` ("limit", "bytes", or "time"),',
  "and its matches are the first ones in path and line order — narrow with",
  "`prefix` to see more. To find notes by meaning rather than exact text, use",
  "`search`. Mirrors REST POST /v1/vaults/:slug/grep.",
].join(" ");

export function grepTool(deps: VaultServiceDeps): ToolDefinition {
  return tool(
    "grep",
    DESCRIPTION,
    GrepInput,
    async ({ vault, ...args }, extra) => grep(deps, vault, { ...args, signal: extra.signal }),
    { readOnlyHint: true },
  );
}

/**
 * MCP tool: `search`. Mirrors `POST /v1/vaults/:slug/search`. Ranks Markdown
 * content only — binaries are not embedded in v1.
 */

import { z } from "zod";
import type { VaultServiceDeps } from "../../vault/files.ts";
import { search } from "../../vault/search.ts";
import { type ToolDefinition, tool } from "../tool.ts";

const Input = z
  .object({
    vault: z.string().min(1),
    query: z.string().min(1).max(4096),
    limit: z.number().int().min(1).max(100).optional(),
    filter: z
      .object({
        tag: z.string().optional(),
        pathPrefix: z.string().optional(),
      })
      .strict()
      .optional(),
    mode: z.enum(["hybrid", "vector", "fts"]).optional(),
    threshold: z.number().min(0).max(1).optional(),
    mmrLambda: z.number().min(0).max(1).optional(),
    maxPerPath: z.number().int().min(1).max(100).optional(),
  })
  .strict();

const DESCRIPTION = [
  "Natural-language search over Markdown content in a vault. Binary files",
  "are not indexed in v1. Mirrors REST POST /v1/vaults/:slug/search.",
  "",
  "Mode: `hybrid` (vector + FTS, RRF-fused) is the right default for almost",
  "every query. `vector` is for semantics-only evaluation; `fts` is for",
  "exact-phrase or proper-noun queries — use `fts` ONLY when semantics are",
  "NOT needed (e.g. you've confirmed a literal lexical match is what you",
  "want). The other knobs (`threshold`, `mmrLambda`, `maxPerPath`) are",
  "tuning levers and the defaults are good.",
].join(" ");

export function searchTool(deps: VaultServiceDeps): ToolDefinition {
  return tool("search", DESCRIPTION, Input, async (args) => {
    const opts: {
      query: string;
      limit?: number;
      filter?: typeof args.filter;
      mode?: typeof args.mode;
      threshold?: number;
      mmrLambda?: number;
      maxPerPath?: number;
    } = {
      query: args.query,
    };
    if (args.limit !== undefined) opts.limit = args.limit;
    if (args.filter !== undefined) opts.filter = args.filter;
    if (args.mode !== undefined) opts.mode = args.mode;
    if (args.threshold !== undefined) opts.threshold = args.threshold;
    if (args.mmrLambda !== undefined) opts.mmrLambda = args.mmrLambda;
    if (args.maxPerPath !== undefined) opts.maxPerPath = args.maxPerPath;
    return search(deps, args.vault, opts);
  });
}

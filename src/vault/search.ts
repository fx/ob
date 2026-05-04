/**
 * Service core: natural-language search over a single vault.
 *
 * Thin wrapper over `indexer.search(slug, query, opts)` so adapter handlers
 * can do parse → call → respond without reaching into the indexer module.
 */

import { VaultNotFoundError } from "../errors.ts";
import type { SearchHit } from "../indexer/index.ts";
import type { SearchMode } from "../indexer/store.ts";
import type { VaultServiceDeps } from "./files.ts";

export interface SearchArgs {
  readonly query: string;
  readonly limit?: number;
  readonly filter?: { readonly tag?: string; readonly pathPrefix?: string };
  readonly mode?: SearchMode;
  readonly threshold?: number;
  readonly mmrLambda?: number;
  readonly maxPerPath?: number;
}

export interface SearchResult {
  readonly hits: SearchHit[];
}

export async function search(
  deps: VaultServiceDeps,
  slug: string,
  args: SearchArgs,
): Promise<SearchResult> {
  // Reject unknown slugs explicitly so the adapter can map this to 404 — the
  // indexer.search itself silently returns [] for unknown slugs.
  if (deps.vault(slug) === null) throw new VaultNotFoundError(slug);
  const opts: {
    limit?: number;
    filter?: SearchArgs["filter"];
    mode?: SearchMode;
    threshold?: number;
    mmrLambda?: number;
    maxPerPath?: number;
  } = {};
  if (args.limit !== undefined) opts.limit = args.limit;
  if (args.filter !== undefined) opts.filter = args.filter;
  if (args.mode !== undefined) opts.mode = args.mode;
  if (args.threshold !== undefined) opts.threshold = args.threshold;
  if (args.mmrLambda !== undefined) opts.mmrLambda = args.mmrLambda;
  if (args.maxPerPath !== undefined) opts.maxPerPath = args.maxPerPath;
  const hits = await deps.indexer.search(slug, args.query, opts);
  return { hits };
}

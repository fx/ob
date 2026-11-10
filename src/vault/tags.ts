/**
 * Service core: tag listing for a single vault.
 *
 * Thin wrapper over `indexer.tags(slug, opts)` so both adapters (REST
 * `GET /v1/vaults/:slug/tags` and MCP `list_tags`) share one code path.
 * Which tags are reported, how documents are counted, and the order are the
 * indexer's (Vault Indexer spec › Tag listing).
 */

import { VaultNotFoundError } from "../errors.ts";
import type { TagListing, TagListingOptions } from "../indexer/index.ts";
import type { VaultServiceDeps } from "./files.ts";

export interface ListTagsArgs {
  /** Literal path prefix; only documents under it are counted. */
  readonly prefix?: string;
  readonly limit?: number;
}

export async function listTags(
  deps: VaultServiceDeps,
  slug: string,
  args: ListTagsArgs = {},
): Promise<TagListing> {
  // `indexer.tags` returns an empty listing for an unknown slug, exactly as
  // `indexer.search` returns no hits; reject it here so both adapters map
  // it to `vault_not_found`.
  if (deps.vault(slug) === null) throw new VaultNotFoundError(slug);
  const opts: { pathPrefix?: string; limit?: number } = {};
  if (args.prefix !== undefined) opts.pathPrefix = args.prefix;
  if (args.limit !== undefined) opts.limit = args.limit;
  return deps.indexer.tags(slug, opts satisfies TagListingOptions);
}

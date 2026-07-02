/**
 * Shared route-parameter helper. Hono's `c.req.param(name)` is typed as
 * `string | undefined`; every route wants the empty string for a missing
 * param so the service core sees a canonical value and rejects it uniformly.
 */

import type { Context } from "hono";

export function getParam(c: Context, name: string): string {
  const v = c.req.param(name);
  return typeof v === "string" ? v : "";
}

/** Shared list options for the paginated `list_files` / `list_folders` routes. */
export interface ListOpts {
  prefix?: string;
  limit?: number;
  cursor?: string;
}

/**
 * Build the service-core list options from a parsed query, omitting `prefix` /
 * `cursor` when absent (rather than passing `undefined`) so the core sees a
 * canonical shape. Shared by the file and folder list routes, which parse
 * structurally identical query schemas.
 */
export function buildListOpts(data: {
  prefix?: string;
  limit?: number;
  cursor?: string;
}): ListOpts {
  const opts: ListOpts = { limit: data.limit };
  if (data.prefix !== undefined) opts.prefix = data.prefix;
  if (data.cursor !== undefined) opts.cursor = data.cursor;
  return opts;
}

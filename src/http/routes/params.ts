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

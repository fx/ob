/**
 * Route: `GET /v1/vaults/:slug/tags`. Query validated against
 * `ListTagsQuery` — every behavior lives in `src/vault/tags.ts` and the
 * indexer it calls.
 */

import type { Hono } from "hono";
import { InvalidQueryError } from "../../errors.ts";
import { ListTagsQuery } from "../../schemas/index.ts";
import { listTags } from "../../vault/tags.ts";
import { getParam } from "./params.ts";
import type { RouteDeps } from "./types.ts";

export function mountTagRoutes(app: Hono, deps: RouteDeps): void {
  app.get("/v1/vaults/:slug/tags", async (c) => {
    const parsed = ListTagsQuery.safeParse(c.req.query());
    if (!parsed.success) {
      throw new InvalidQueryError("invalid list-tags query", { issues: parsed.error.issues });
    }
    const result = await listTags(deps, getParam(c, "slug"), {
      limit: parsed.data.limit,
      ...(parsed.data.prefix !== undefined ? { prefix: parsed.data.prefix } : {}),
    });
    return c.json(result);
  });
}

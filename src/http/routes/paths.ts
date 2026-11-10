/**
 * Routes: type-agnostic path operations (REST API › Path operations) — list
 * and delete over files and folders alike.
 *
 * Same parse → call → respond shape as the other route modules; all behavior
 * lives in `src/vault/paths.ts`. A query string that fails its schema is
 * `invalid_query`. The `:path{.+}` wildcard does not match the empty path, so
 * the vault root can never be addressed through `DELETE`.
 */

import type { Hono } from "hono";
import { InvalidQueryError } from "../../errors.ts";
import { DeletePathQuery, ListPathsQuery } from "../../schemas/index.ts";
import { deletePath, listPaths } from "../../vault/paths.ts";
import { getParam } from "./params.ts";
import type { RouteDeps } from "./types.ts";

/** Mount the path routes on `app` under `/v1/vaults/:slug/paths`. */
export function mountPathRoutes(app: Hono, deps: RouteDeps): void {
  // GET /v1/vaults/:slug/paths — list files and folders in one walk.
  app.get("/v1/vaults/:slug/paths", async (c) => {
    const parsed = ListPathsQuery.safeParse(c.req.query());
    if (!parsed.success) {
      throw new InvalidQueryError("invalid list-paths query", { issues: parsed.error.issues });
    }
    return c.json(await listPaths(deps, getParam(c, "slug"), parsed.data));
  });

  // DELETE /v1/vaults/:slug/paths/*path — `?recursive=true` for `rm -r`.
  app.delete("/v1/vaults/:slug/paths/:path{.+}", async (c) => {
    const parsed = DeletePathQuery.safeParse(c.req.query());
    if (!parsed.success) {
      throw new InvalidQueryError("invalid delete-path query", { issues: parsed.error.issues });
    }
    await deletePath(deps, getParam(c, "slug"), getParam(c, "path"), parsed.data);
    return new Response(null, { status: 204 });
  });
}

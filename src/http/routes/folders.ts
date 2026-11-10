/**
 * Route: folder create (change 0012) — the one folder-only operation.
 *
 * Sibling of `src/http/routes/files.ts`, same parse → call → respond shape.
 * All behavior lives in `src/vault/folders.ts`. Listing and deleting folders
 * are path operations (`./paths.ts`), shared with files.
 *
 * The `:path{.+}` wildcard does not match the empty path, so
 * `/v1/vaults/:slug/folders/` falls through to the JSON 404. A trailing slash
 * on the wildcard tail is tolerated — the service core canonicalizes to the
 * no-trailing-slash form (so REST and MCP stay in parity).
 */

import type { Hono } from "hono";
import { createFolder } from "../../vault/folders.ts";
import { getParam } from "./params.ts";
import type { RouteDeps } from "./types.ts";

/** Mount the folder route on `app` under `/v1/vaults/:slug/folders`. */
export function mountFolderRoutes(app: Hono, deps: RouteDeps): void {
  // PUT /v1/vaults/:slug/folders/*path — idempotent create. Any body ignored.
  app.put("/v1/vaults/:slug/folders/:path{.+}", async (c) => {
    const slug = getParam(c, "slug");
    const result = await createFolder(deps, slug, getParam(c, "path"));
    return c.json(result);
  });
}

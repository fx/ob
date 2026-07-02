/**
 * Routes: folder list / create / delete (change 0012).
 *
 * Sibling of `src/http/routes/files.ts`, same parse → call → respond shape.
 * All behavior (path resolution, idempotent mkdir, recursive drop + rm) lives
 * in `src/vault/folders.ts`.
 *
 * The `PUT` and `DELETE` routes use the `:path{.+}` wildcard, so the empty
 * path (`/v1/vaults/:slug/folders/`) does not match them — only the path-less
 * list endpoint (`GET /v1/vaults/:slug/folders`) handles a request with no
 * path. A trailing slash on the wildcard tail is tolerated — the service core
 * canonicalizes to the no-trailing-slash form (so REST and MCP stay in parity).
 */

import type { Hono } from "hono";
import { InvalidQueryError } from "../../errors.ts";
import { DeleteFolderQuery, ListFoldersQuery } from "../../schemas/index.ts";
import { createFolder, deleteFolder, listFolders } from "../../vault/folders.ts";
import { buildListOpts, getParam } from "./params.ts";
import type { RouteDeps } from "./types.ts";

/** Mount folder routes on `app` under `/v1/vaults/:slug/folders`. */
export function mountFolderRoutes(app: Hono, deps: RouteDeps): void {
  // GET /v1/vaults/:slug/folders — list.
  app.get("/v1/vaults/:slug/folders", async (c) => {
    const parsed = ListFoldersQuery.safeParse(c.req.query());
    if (!parsed.success) {
      throw new InvalidQueryError("invalid list-folders query", {
        issues: parsed.error.issues,
      });
    }
    const slug = getParam(c, "slug");
    const result = await listFolders(deps, slug, buildListOpts(parsed.data));
    return c.json(result);
  });

  // PUT /v1/vaults/:slug/folders/*path — idempotent create. Any body ignored.
  app.put("/v1/vaults/:slug/folders/:path{.+}", async (c) => {
    const slug = getParam(c, "slug");
    const result = await createFolder(deps, slug, getParam(c, "path"));
    return c.json(result);
  });

  // DELETE /v1/vaults/:slug/folders/*path — `?recursive=true` opts into
  // recursive removal; otherwise a non-empty folder yields 409.
  app.delete("/v1/vaults/:slug/folders/:path{.+}", async (c) => {
    const parsed = DeleteFolderQuery.safeParse(c.req.query());
    if (!parsed.success) {
      throw new InvalidQueryError("invalid delete-folder query", {
        issues: parsed.error.issues,
      });
    }
    const slug = getParam(c, "slug");
    await deleteFolder(deps, slug, getParam(c, "path"), {
      recursive: parsed.data.recursive === "true",
    });
    return new Response(null, { status: 204 });
  });
}

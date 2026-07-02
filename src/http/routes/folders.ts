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
 * path. A trailing slash on the wildcard tail is tolerated and stripped so the
 * service core always sees the canonical no-trailing-slash form.
 */

import type { Hono } from "hono";
import { InvalidQueryError } from "../../errors.ts";
import { DeleteFolderQuery, ListFoldersQuery } from "../../schemas/index.ts";
import { createFolder, deleteFolder, listFolders } from "../../vault/folders.ts";
import { getParam } from "./params.ts";
import type { RouteDeps } from "./types.ts";

/** Strip trailing slashes so `archive/2026/` and `archive/2026` are the same. */
function stripTrailingSlash(path: string): string {
  return path.replace(/\/+$/, "");
}

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
    const opts: { prefix?: string; limit?: number; cursor?: string } = {
      limit: parsed.data.limit,
    };
    if (parsed.data.prefix !== undefined) opts.prefix = parsed.data.prefix;
    if (parsed.data.cursor !== undefined) opts.cursor = parsed.data.cursor;
    const result = await listFolders(deps, slug, opts);
    return c.json(result);
  });

  // PUT /v1/vaults/:slug/folders/*path — idempotent create. Any body ignored.
  app.put("/v1/vaults/:slug/folders/:path{.+}", async (c) => {
    const slug = getParam(c, "slug");
    const path = stripTrailingSlash(getParam(c, "path"));
    const result = await createFolder(deps, slug, path);
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
    const path = stripTrailingSlash(getParam(c, "path"));
    await deleteFolder(deps, slug, path, { recursive: parsed.data.recursive === "true" });
    return new Response(null, { status: 204 });
  });
}

/**
 * Routes: type-agnostic path operations (REST API › Path operations) — list,
 * delete, move, and copy over files and folders alike.
 *
 * Same parse → call → respond shape as the other route modules; all behavior
 * lives in `src/vault/paths.ts`. A query string that fails its schema is
 * `invalid_query`. The `:path{.+}` wildcard does not match the empty path, so
 * the vault root can never be addressed through `DELETE`. `:move` and `:copy`
 * strip their suffix as the `:append` file route does and take an
 * `application/json` body: another content type is `unsupported_media_type`,
 * unparseable JSON `invalid_body`, and a schema failure `invalid_input`.
 */

import type { Context, Hono } from "hono";
import type { ZodType, z } from "zod";
import { InvalidBodyError, InvalidQueryError, UnsupportedMediaTypeError } from "../../errors.ts";
import { CopyBody, DeletePathQuery, ListPathsQuery, MoveBody } from "../../schemas/index.ts";
import { copyPath } from "../../vault/copy.ts";
import { deletePath, listPaths, movePath } from "../../vault/paths.ts";
import { getParam } from "./params.ts";
import type { RouteDeps } from "./types.ts";
import { zodIssuesToInvalidInput } from "./zod.ts";

/** Parse an `application/json` body against `schema`, with the documented error codes. */
async function jsonBody<S extends ZodType>(
  c: Context,
  path: string,
  schema: S,
): Promise<z.infer<S>> {
  const ct = c.req.header("content-type") ?? "";
  if (!ct.toLowerCase().includes("application/json")) {
    throw new UnsupportedMediaTypeError("this route requires application/json", path);
  }
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new InvalidBodyError("body is not valid JSON");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw zodIssuesToInvalidInput(parsed.error);
  return parsed.data;
}

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

  // POST /v1/vaults/:slug/paths/*path:move — `mv -T` to an exact destination.
  app.post("/v1/vaults/:slug/paths/:path{.+:move}", async (c) => {
    const path = getParam(c, "path").replace(/:move$/, "");
    const body = await jsonBody(c, path, MoveBody);
    return c.json(await movePath(deps, getParam(c, "slug"), path, body));
  });

  // POST /v1/vaults/:slug/paths/*path:copy — `cp -T`, or `cp -r -T` with `recursive`.
  app.post("/v1/vaults/:slug/paths/:path{.+:copy}", async (c) => {
    const path = getParam(c, "path").replace(/:copy$/, "");
    const body = await jsonBody(c, path, CopyBody);
    return c.json(await copyPath(deps, getParam(c, "slug"), path, body));
  });
}

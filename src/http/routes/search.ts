/**
 * Route: `POST /v1/vaults/:slug/search`. Body validated against `SearchBody`
 * — every behavior lives in `src/vault/search.ts`.
 */

import type { Hono } from "hono";
import { InvalidBodyError } from "../../errors.ts";
import { SearchBody } from "../../schemas/index.ts";
import { search } from "../../vault/search.ts";
import type { RouteDeps } from "./types.ts";
import { zodIssuesToInvalidInput } from "./zod.ts";

export function mountSearchRoutes(app: Hono, deps: RouteDeps): void {
  app.post("/v1/vaults/:slug/search", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new InvalidBodyError("body is not valid JSON");
    }
    const parsed = SearchBody.safeParse(raw);
    if (!parsed.success) throw zodIssuesToInvalidInput(parsed.error);
    const slug = c.req.param("slug");
    const slugStr = typeof slug === "string" ? slug : "";
    const args = {
      query: parsed.data.query,
      limit: parsed.data.limit,
      ...(parsed.data.filter !== undefined ? { filter: parsed.data.filter } : {}),
      ...(parsed.data.mode !== undefined ? { mode: parsed.data.mode } : {}),
      ...(parsed.data.threshold !== undefined ? { threshold: parsed.data.threshold } : {}),
      ...(parsed.data.mmrLambda !== undefined ? { mmrLambda: parsed.data.mmrLambda } : {}),
      ...(parsed.data.maxPerPath !== undefined ? { maxPerPath: parsed.data.maxPerPath } : {}),
    };
    const result = await search(deps, slugStr, args);
    return c.json(result);
  });
}

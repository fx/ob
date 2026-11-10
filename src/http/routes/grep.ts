/**
 * Route: `POST /v1/vaults/:slug/grep`. Body validated against `GrepBody` —
 * every behavior lives in `src/vault/grep.ts`. The request's abort signal is
 * passed through, so a client that disconnects stops the grep's wait or its
 * worker. The arrival time is taken before the body is read, so a slowly
 * streamed body counts against grep's budget.
 */

import type { Hono } from "hono";
import { InvalidBodyError } from "../../errors.ts";
import { GrepBody } from "../../schemas/index.ts";
import { monotonicNow } from "../../vault/files.ts";
import { grep } from "../../vault/grep.ts";
import { getParam } from "./params.ts";
import type { RouteDeps } from "./types.ts";
import { zodIssuesToInvalidInput } from "./zod.ts";

export function mountGrepRoutes(app: Hono, deps: RouteDeps): void {
  app.post("/v1/vaults/:slug/grep", async (c) => {
    // Ingress: the budget counts time spent receiving the body.
    const arrivedAt = (deps.clock ?? monotonicNow)();
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      throw new InvalidBodyError("body is not valid JSON");
    }
    const parsed = GrepBody.safeParse(raw);
    if (!parsed.success) throw zodIssuesToInvalidInput(parsed.error);
    const result = await grep(deps, getParam(c, "slug"), {
      ...parsed.data,
      signal: c.req.raw.signal,
      arrivedAt,
    });
    return c.json(result);
  });
}

/**
 * Routes: `GET /v1/vaults` and `GET /v1/vaults/:slug` (vault metadata only).
 */

import type { Hono } from "hono";
import { listVaults, vaultStatus } from "../../vault/status.ts";
import type { RouteDeps } from "./types.ts";

export function mountVaultRoutes(app: Hono, deps: RouteDeps): void {
  app.get("/v1/vaults", (c) => c.json(listVaults(deps)));
  app.get("/v1/vaults/:slug", (c) => {
    const slug = c.req.param("slug");
    const slugStr = typeof slug === "string" ? slug : "";
    const status = vaultStatus(deps, slugStr);
    if (status === null) {
      return c.json(
        { error: { code: "vault_not_found", message: `vault "${slugStr}" not found` } },
        404,
      );
    }
    return c.json(status);
  });
}

/**
 * HTTP adapter — Hono app construction.
 *
 * Health endpoints:
 *   - `GET /healthz` — liveness; 200 once the listener is up.
 *   - `GET /readyz`  — readiness AND the aggregate status surface; 200 only
 *                      when at least one vault is configured, every
 *                      supervised vault is `running`, and every configured
 *                      vault's indexer is in state `ready`. Otherwise 503.
 *                      The body (`{ok, vaults, indexers}`) is identical in
 *                      shape on both paths.
 *
 * Versioned API:
 *   - `GET /v1/vaults` and `GET /v1/vaults/:slug` — vault listing & status
 *   - File CRUD + patch + append under `/v1/vaults/:slug/files`
 *   - Search at `POST /v1/vaults/:slug/search`
 *
 * Errors thrown by routes are translated to JSON envelopes by `app.onError`,
 * driven from the closed-set table in `src/http/errors.ts`. Unmatched URLs
 * fall through to `app.notFound` which returns the same envelope shape with
 * `code: "not_found"`.
 */

import { join } from "node:path";
import { Hono } from "hono";
import type { Config } from "../config/index.ts";
import type { Indexer, IndexerStatus } from "../indexer/index.ts";
import { type Logger, createLogger } from "../log.ts";
import { buildMcpRoutes } from "../mcp/index.ts";
import { type Supervisor, isAllRunning } from "../obsidian/index.ts";
import type { VaultDescriptor, VaultServiceDeps } from "../vault/files.ts";
import { startingIndexerStatus } from "../vault/status.ts";
import { mapErrorToHttp } from "./errors.ts";
import { logMiddleware } from "./middleware/log.ts";
import { getRequestId, requestIdMiddleware } from "./middleware/requestId.ts";
import { mountFileRoutes } from "./routes/files.ts";
import { mountFolderRoutes } from "./routes/folders.ts";
import { mountSearchRoutes } from "./routes/search.ts";
import type { RouteDeps } from "./routes/types.ts";
import { mountVaultRoutes } from "./routes/vaults.ts";

export interface HttpAppDeps {
  /**
   * Optional during 0001 (pre-supervisor); required for `/v1/*`. The
   * `/healthz` and `/readyz` endpoints still work without it (an absent
   * supervisor reports an empty list, which forces 503).
   */
  readonly supervisor?: Supervisor;
  /** Per spec: `/readyz` 200 requires every indexer in `ready`. */
  readonly indexer?: Indexer;
  /** Required for `/v1/*` because routes resolve vault roots from cfg. */
  readonly config?: Config;
  /** Override default logger (tests). */
  readonly logger?: Logger;
}

function buildVaultLookup(cfg: Config): (slug: string) => VaultDescriptor | null {
  // Pre-build the slug → descriptor map so every request is an O(1) lookup;
  // the configured set is fixed at process start.
  const map = new Map<string, VaultDescriptor>();
  for (const v of cfg.vaults) {
    map.set(v.slug, {
      slug: v.slug,
      name: v.name,
      root: join(cfg.dataDir, "vaults", v.slug),
    });
  }
  return (slug): VaultDescriptor | null => map.get(slug) ?? null;
}

/** No-op log writer used when callers don't supply their own logger. */
function silentWrite(_line: string): void {
  /* deliberately empty */
}

export function buildHttpApp(deps: HttpAppDeps = {}): Hono {
  const app = new Hono();
  const logger = deps.logger ?? createLogger({ level: "error", write: silentWrite });

  // Request id + access log run for every request, including health checks
  // — operators rely on the consistent shape when grepping logs.
  app.use("*", requestIdMiddleware());
  app.use("*", logMiddleware({ logger }));

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.get("/readyz", (c) => {
    const sup = deps.supervisor;
    const vaults = sup === undefined ? [] : sup.list();
    const idx = deps.indexer;
    const registered = new Map<string, IndexerStatus>();
    if (idx !== undefined) {
      for (const s of idx.list()) registered.set(s.slug, s);
    }
    // Exactly one indexer entry per configured vault, in configuration order,
    // so the two arrays are positionally correlatable. A vault the indexer
    // has not registered yet is synthesized as `starting` rather than omitted
    // — an omitted component cannot hold the response at 503 when it is
    // unhealthy, which is the failure mode this contract exists to prevent.
    const indexers = vaults.map((v) => registered.get(v.slug) ?? startingIndexerStatus(v.slug));
    const ok = isAllRunning(vaults) && indexers.every((s) => s.state === "ready");
    return c.json({ ok, vaults, indexers }, ok ? 200 : 503);
  });

  if (deps.supervisor !== undefined && deps.indexer !== undefined && deps.config !== undefined) {
    const supervisor = deps.supervisor;
    const indexer = deps.indexer;
    const lookup = buildVaultLookup(deps.config);
    const serviceDeps: VaultServiceDeps = {
      vault: lookup,
      indexer,
      logger,
    };
    const routeDeps: RouteDeps = { ...serviceDeps, supervisor, indexer };
    mountVaultRoutes(app, routeDeps);
    mountFileRoutes(app, routeDeps);
    mountFolderRoutes(app, routeDeps);
    mountSearchRoutes(app, routeDeps);
    // Mount BEFORE the catch-all error handler / notFound below.
    app.route("/mcp", buildMcpRoutes({ ...routeDeps, logger }));
  }

  app.onError((err, c) => {
    const requestId = getRequestId(c);
    const env = mapErrorToHttp(err, requestId);
    if (env.status >= 500) {
      // Hono guarantees `err` is an `Error` (it wraps non-Error throws),
      // so `.message` is always present.
      logger.error("http error", {
        requestId,
        method: c.req.method,
        path: c.req.path,
        error: err.message,
      });
    }
    return c.json(env.body, env.status as 400 | 404 | 415 | 409 | 502 | 500);
  });
  app.notFound((c) =>
    c.json({ error: { code: "not_found", message: `route ${c.req.path} not found` } }, 404),
  );

  return app;
}

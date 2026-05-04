/**
 * Access-log middleware.
 *
 * Logs `{ method, path, status, durationMs, requestId }` at info-level after
 * each request. Body logging is intentionally NOT done here — the spec
 * forbids logging request bodies above debug level, and Hono doesn't expose
 * a clean post-handler body hook anyway. When `LOG_LEVEL=debug` the caller
 * can wire body capture at the route layer; for v1 this middleware sticks
 * to the metadata.
 */

import type { MiddlewareHandler } from "hono";
import type { Logger } from "../../log.ts";
import { getRequestId } from "./requestId.ts";

export interface LogMiddlewareOptions {
  readonly logger: Logger;
  readonly now?: () => number;
}

export function logMiddleware(opts: LogMiddlewareOptions): MiddlewareHandler {
  const now = opts.now ?? ((): number => Date.now());
  return async (c, next): Promise<void> => {
    const start = now();
    await next();
    const durationMs = now() - start;
    opts.logger.info("http request", {
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs,
      requestId: getRequestId(c),
    });
  };
}

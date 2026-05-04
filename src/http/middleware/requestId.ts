/**
 * Request-ID middleware.
 *
 * Assigns a UUID to every incoming request, sets `x-request-id` on the
 * response, and stores the value on the Hono context under `requestId` so
 * downstream middleware (logging) and route handlers can include it in logs
 * and error envelopes. If the client already sent an `x-request-id` header,
 * we honour it — useful for distributed tracing where an upstream proxy has
 * already minted a trace id.
 */

import type { Context, MiddlewareHandler } from "hono";

export interface RequestIdOptions {
  readonly generate?: () => string;
  readonly header?: string;
}

const DEFAULT_HEADER = "x-request-id";

export function requestIdMiddleware(opts: RequestIdOptions = {}): MiddlewareHandler {
  const header = opts.header ?? DEFAULT_HEADER;
  const generate = opts.generate ?? ((): string => crypto.randomUUID());
  return async (c, next): Promise<void> => {
    const incoming = c.req.header(header);
    const id = incoming !== undefined && incoming !== "" ? incoming : generate();
    c.set("requestId", id);
    c.header(header, id);
    await next();
  };
}

/** Helper for handlers that need the assigned request id. */
export function getRequestId(c: Context): string {
  const id = c.get("requestId");
  return typeof id === "string" ? id : "";
}

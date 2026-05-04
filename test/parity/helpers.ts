/**
 * Helpers for REST↔MCP parity tests. The fixture builds a single Hono app
 * (so REST + MCP route the same supervisor + indexer + service deps) plus a
 * standalone tool registry the parity tests use to drive the MCP adapter
 * in process.
 */

export { makeMcpFixture as makeParityFixture, waitFor } from "../mcp/helpers.ts";

/**
 * Helpers to invoke a registered MCP tool with the same input shape the
 * REST handler would receive. Each one returns the parsed JSON success body
 * or, on failure, the canonical `{ code, message, details? }` payload.
 */
export interface ParityResult {
  isError: boolean;
  body: unknown;
}

import type { McpFixture } from "../mcp/helpers.ts";

export async function callMcp(fx: McpFixture, name: string, args: unknown): Promise<ParityResult> {
  const r = await fx.callTool(name, args);
  return { isError: r.isError === true, body: r.parsed };
}

/**
 * Drive the REST adapter and return the parsed JSON envelope. Mirrors the
 * `callMcp` shape so parity tests can assert structurally identical bodies.
 */
export async function callRestJson(
  fx: McpFixture,
  method: string,
  url: string,
  init: RequestInit = {},
): Promise<ParityResult & { status: number; raw: Response }> {
  const headers = new Headers(init.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  const res = await fx.app.request(url, { ...init, method, headers });
  const status = res.status;
  if (status >= 400) {
    const body = (await res.json()) as {
      error?: { code: string; message: string; details?: unknown };
    };
    return {
      isError: true,
      status,
      raw: res,
      body: body.error ?? body,
    };
  }
  if (status === 204) {
    return { isError: false, status, raw: res, body: null };
  }
  return { isError: false, status, raw: res, body: await res.json() };
}

/**
 * Drive a REST request that returns binary (raw) bytes — used by the
 * read-binary parity test. Returns the bytes and the response so callers
 * can also assert headers.
 */
export async function callRestBytes(
  fx: McpFixture,
  url: string,
): Promise<{ status: number; bytes: Uint8Array; res: Response }> {
  const res = await fx.app.request(url);
  const buf = await res.arrayBuffer();
  return { status: res.status, bytes: new Uint8Array(buf), res };
}

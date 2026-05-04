/**
 * Error → MCP `isError` envelope mapper.
 *
 * Mirrors `src/http/errors.ts` for the MCP adapter: every typed error in
 * `src/errors.ts` (plus `EmbedderError`) is translated into the MCP
 * `CallToolResult` shape that carries `isError: true` and a single text
 * content block whose body is the JSON `{ code, message, details? }`. The
 * canonical `code` field is read straight off the typed-error class — same
 * source of truth as the REST mapper, so adding a new code is a one-place
 * edit in `src/errors.ts`.
 *
 * Anything else falls through to `code: "internal"` with a generic message.
 * The original error is intentionally NOT echoed back so MCP clients can't
 * read internals; the per-process logger is responsible for surfacing it.
 */

import { EmbedderError } from "../embeddings/index.ts";
import { type ErrorCode, OBError } from "../errors.ts";

/** Shape returned to the MCP SDK as a tool result on the failure path. */
export interface McpErrorResult {
  readonly isError: true;
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
}

/**
 * Build the JSON body the MCP client sees for a typed error. Kept private so
 * the adapter has only one entry point (`mapErrorToMcpResult`) and the JSON
 * shape is impossible to drift between call sites.
 */
function payload(code: ErrorCode, message: string, details?: Record<string, unknown>): string {
  const body: { code: ErrorCode; message: string; details?: Record<string, unknown> } = {
    code,
    message,
  };
  if (details !== undefined) body.details = details;
  return JSON.stringify(body);
}

/**
 * Translate a thrown value into the MCP `isError` envelope.
 *
 * - `OBError` subclasses → use their canonical `code` and `details`.
 * - `EmbedderError` → `embedder_failed` (matches REST 502 mapping).
 * - Anything else → `internal` with a generic, sanitized message.
 */
export function mapErrorToMcpResult(error: unknown): McpErrorResult {
  if (error instanceof OBError) {
    return {
      isError: true,
      content: [{ type: "text", text: payload(error.code, error.message, error.details) }],
    };
  }
  if (error instanceof EmbedderError) {
    return {
      isError: true,
      content: [{ type: "text", text: payload("embedder_failed", error.message) }],
    };
  }
  return {
    isError: true,
    content: [{ type: "text", text: payload("internal", "internal server error") }],
  };
}

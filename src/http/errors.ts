/**
 * Error → HTTP envelope mapper.
 *
 * Translates the closed set of typed errors from `src/errors.ts` (plus
 * `EmbedderError` from `src/embeddings/`) into the JSON shape documented in
 * the REST API spec:
 *
 *     { error: { code, message, details? } }
 *
 * Anything else falls through to a 500 / `internal` envelope carrying
 * `requestId` (from middleware) so operators can correlate logs.
 *
 * The mapper is the only place the closed-set table lives; route handlers
 * never branch on error class. The MCP adapter (0005) imports these same
 * codes via the shared error classes — only the transport envelope differs.
 */

import { EmbedderError } from "../embeddings/index.ts";
import {
  DocNotFoundError,
  type ErrorCode,
  InvalidBodyError,
  InvalidInputError,
  InvalidPathError,
  InvalidQueryError,
  type OBError,
  PatchAmbiguousError,
  PatchNoMatchError,
  UnsupportedMediaTypeError,
  VaultNotFoundError,
} from "../errors.ts";
import { PdfExtractionError } from "../vault/pdfText.ts";

export interface HttpErrorEnvelope {
  readonly status: number;
  readonly body: {
    readonly error: {
      readonly code: ErrorCode;
      readonly message: string;
      readonly details?: Record<string, unknown>;
    };
  };
}

/**
 * Map a thrown value into the documented HTTP error envelope.
 *
 * `requestId` is included in `details` for the 500 / unknown path so callers
 * can correlate with server logs. Typed errors do not get a synthesised
 * requestId — their `details` shape is part of the API contract and adding a
 * field would be a breaking change.
 */
export function mapErrorToHttp(error: unknown, requestId?: string): HttpErrorEnvelope {
  if (error instanceof VaultNotFoundError) return envelope(404, error);
  if (error instanceof DocNotFoundError) return envelope(404, error);
  if (error instanceof InvalidPathError) return envelope(400, error);
  if (error instanceof InvalidInputError) return envelope(400, error);
  if (error instanceof InvalidBodyError) return envelope(400, error);
  if (error instanceof InvalidQueryError) return envelope(400, error);
  if (error instanceof UnsupportedMediaTypeError) return envelope(415, error);
  if (error instanceof PatchNoMatchError) return envelope(409, error);
  if (error instanceof PatchAmbiguousError) return envelope(409, error);
  if (error instanceof PdfExtractionError) return envelope(422, error);
  if (error instanceof EmbedderError) {
    return {
      status: 502,
      body: { error: { code: "embedder_failed", message: error.message } },
    };
  }
  // Any other thrown value (Error or non-Error) — surface a generic
  // `internal` payload. The message is intentionally NOT echoed to the
  // client to avoid leaking internals; it lives in the log line instead.
  const details: Record<string, unknown> = {};
  if (requestId !== undefined) details.requestId = requestId;
  return {
    status: 500,
    body: {
      error: {
        code: "internal",
        message: "internal server error",
        ...(Object.keys(details).length > 0 ? { details } : {}),
      },
    },
  };
}

function envelope(status: number, error: OBError): HttpErrorEnvelope {
  const body: HttpErrorEnvelope["body"] = {
    error: {
      code: error.code,
      message: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    },
  };
  return { status, body };
}

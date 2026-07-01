import { describe, expect, test } from "bun:test";
import { EmbedderError } from "../../src/embeddings/index.ts";
import {
  DocNotFoundError,
  InvalidBodyError,
  InvalidInputError,
  InvalidPathError,
  InvalidQueryError,
  PatchAmbiguousError,
  PatchNoMatchError,
  UnsupportedMediaTypeError,
  VaultNotFoundError,
} from "../../src/errors.ts";
import { mapErrorToHttp } from "../../src/http/errors.ts";
import { PdfExtractionError } from "../../src/vault/pdfText.ts";

describe("mapErrorToHttp", () => {
  test("VaultNotFoundError → 404 vault_not_found", () => {
    const env = mapErrorToHttp(new VaultNotFoundError("v"));
    expect(env.status).toBe(404);
    expect(env.body.error.code).toBe("vault_not_found");
    expect(env.body.error.details).toEqual({ slug: "v" });
  });

  test("DocNotFoundError → 404 not_found", () => {
    const env = mapErrorToHttp(new DocNotFoundError("p"));
    expect(env.status).toBe(404);
    expect(env.body.error.code).toBe("not_found");
  });

  test("InvalidPathError → 400 invalid_path", () => {
    const env = mapErrorToHttp(new InvalidPathError("p", "r"));
    expect(env.status).toBe(400);
    expect(env.body.error.code).toBe("invalid_path");
  });

  test("InvalidInputError → 400 invalid_input", () => {
    const env = mapErrorToHttp(new InvalidInputError("m"));
    expect(env.status).toBe(400);
    expect(env.body.error.code).toBe("invalid_input");
  });

  test("InvalidBodyError → 400 invalid_body", () => {
    expect(mapErrorToHttp(new InvalidBodyError("m")).body.error.code).toBe("invalid_body");
  });

  test("InvalidQueryError → 400 invalid_query", () => {
    expect(mapErrorToHttp(new InvalidQueryError("m")).body.error.code).toBe("invalid_query");
  });

  test("UnsupportedMediaTypeError → 415", () => {
    const env = mapErrorToHttp(new UnsupportedMediaTypeError("m"));
    expect(env.status).toBe(415);
    expect(env.body.error.code).toBe("unsupported_media_type");
  });

  test("PatchNoMatchError → 409 patch_no_match with editIndex", () => {
    const env = mapErrorToHttp(new PatchNoMatchError(2));
    expect(env.status).toBe(409);
    expect(env.body.error.code).toBe("patch_no_match");
    expect(env.body.error.details).toEqual({ editIndex: 2 });
  });

  test("PatchAmbiguousError → 409 patch_ambiguous with editIndex + occurrences", () => {
    const env = mapErrorToHttp(new PatchAmbiguousError(1, 4));
    expect(env.status).toBe(409);
    expect(env.body.error.code).toBe("patch_ambiguous");
    expect(env.body.error.details).toEqual({ editIndex: 1, occurrences: 4 });
  });

  test("EmbedderError → 502 embedder_failed", () => {
    const env = mapErrorToHttp(new EmbedderError("provider down"));
    expect(env.status).toBe(502);
    expect(env.body.error.code).toBe("embedder_failed");
  });

  test("PdfExtractionError → 422 extraction_failed", () => {
    const env = mapErrorToHttp(new PdfExtractionError("bad pdf"));
    expect(env.status).toBe(422);
    expect(env.body.error.code).toBe("extraction_failed");
  });

  test("any other Error → 500 internal with requestId", () => {
    const env = mapErrorToHttp(new Error("kaboom"), "abc-123");
    expect(env.status).toBe(500);
    expect(env.body.error.code).toBe("internal");
    expect(env.body.error.details).toEqual({ requestId: "abc-123" });
    expect(env.body.error.message).toBe("internal server error");
  });

  test("non-Error thrown value → 500 internal", () => {
    const env = mapErrorToHttp("string error");
    expect(env.status).toBe(500);
    expect(env.body.error.code).toBe("internal");
    // No requestId provided → no `details`.
    expect(env.body.error.details).toBeUndefined();
  });
});

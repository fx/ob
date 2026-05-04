/**
 * Direct unit tests for `mapErrorToMcpResult`. Tool tests only exercise the
 * `OBError` path (every typed service-core error is an `OBError`); these
 * tests cover the `EmbedderError` and unknown-error branches.
 */

import { expect, test } from "bun:test";
import { EmbedderError } from "../../src/embeddings/index.ts";
import { InvalidInputError } from "../../src/errors.ts";
import { mapErrorToMcpResult } from "../../src/mcp/errors.ts";

function parse(r: ReturnType<typeof mapErrorToMcpResult>): Record<string, unknown> {
  return JSON.parse(r.content[0].text) as Record<string, unknown>;
}

test("OBError → typed code + details", () => {
  const r = mapErrorToMcpResult(new InvalidInputError("bad", { issues: [{ path: ["x"] }] }));
  const body = parse(r);
  expect(r.isError).toBe(true);
  expect(body.code).toBe("invalid_input");
  expect(body.message).toBe("bad");
  expect(body.details).toEqual({ issues: [{ path: ["x"] }] });
});

test("EmbedderError → embedder_failed", () => {
  const r = mapErrorToMcpResult(new EmbedderError("network down"));
  const body = parse(r);
  expect(body.code).toBe("embedder_failed");
  expect(body.message).toBe("network down");
  expect(body.details).toBeUndefined();
});

test("unknown error → internal", () => {
  const r = mapErrorToMcpResult(new Error("boom"));
  const body = parse(r);
  expect(body.code).toBe("internal");
  expect(body.message).toBe("internal server error");
});

test("non-Error thrown value → internal", () => {
  const r = mapErrorToMcpResult("nope");
  const body = parse(r);
  expect(body.code).toBe("internal");
});

test("OBError without details emits no details key", () => {
  const r = mapErrorToMcpResult(new InvalidInputError("bare"));
  const body = parse(r);
  expect(body.code).toBe("invalid_input");
  expect(body.details).toBeUndefined();
});

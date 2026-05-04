/**
 * Helper: convert a `ZodError` to an `InvalidInputError`. Centralised so every
 * route maps Zod failures to the same canonical `invalid_input` code with the
 * issue array surfaced under `details.issues`.
 */

import type { ZodError } from "zod";
import { InvalidInputError } from "../../errors.ts";

export function zodIssuesToInvalidInput(err: ZodError): InvalidInputError {
  return new InvalidInputError("schema validation failed", {
    issues: err.issues,
  });
}

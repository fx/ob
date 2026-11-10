/**
 * Zod schemas for grep (REST API › Grep).
 *
 * REST parses `GrepBody` from the JSON request body; the MCP `grep` tool
 * parses `GrepInput`, the same fields plus `vault`. Both take real JSON
 * booleans and numbers, so the fields are defined once and shared.
 */

import { z } from "zod";

export const MAX_GREP_PATTERN_CHARS = 1024;
export const MAX_GREP_PREFIX_BYTES = 1024;

/** 1–1024 characters, counted in code points like every other grep column. */
const pattern = z
  .string()
  .min(1)
  .refine((s) => Array.from(s).length <= MAX_GREP_PATTERN_CHARS, {
    message: `pattern exceeds ${MAX_GREP_PATTERN_CHARS} characters`,
  });

/** Literal prefix matched against the start of each path; bounded in UTF-8 bytes. */
const prefix = z.string().refine((s) => Buffer.byteLength(s, "utf8") <= MAX_GREP_PREFIX_BYTES, {
  message: `prefix exceeds ${MAX_GREP_PREFIX_BYTES} bytes`,
});

const fields = {
  pattern,
  /** Default `false`: `pattern` is a literal substring. */
  regex: z.boolean().optional(),
  /** Unicode case-insensitive matching in both modes. Default `false`. */
  ignoreCase: z.boolean().optional(),
  prefix: prefix.optional(),
  /** Maximum matches returned; default 100 (applied by the service core). */
  limit: z.number().int().min(1).max(1000).optional(),
  /** Lines of context before and after each match; default 0. */
  context: z.number().int().min(0).max(5).optional(),
};

/** `POST /v1/vaults/:slug/grep` body. Unknown keys are `invalid_input`. */
export const GrepBody = z.object(fields).strict();
export type GrepBody = z.infer<typeof GrepBody>;

/** MCP `grep` input. */
export const GrepInput = z.object({ vault: z.string().min(1), ...fields }).strict();
export type GrepInput = z.infer<typeof GrepInput>;

export const GrepMatch = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  text: z.string(),
  textStart: z.number().int().positive(),
  before: z.array(z.string()).optional(),
  after: z.array(z.string()).optional(),
});
export type GrepMatch = z.infer<typeof GrepMatch>;

/** Response shape shared by REST and MCP. */
export const GrepResponse = z.object({
  matches: z.array(GrepMatch),
  truncated: z.boolean(),
  reason: z.enum(["limit", "bytes", "time"]).nullable(),
  filesScanned: z.number().int().nonnegative(),
  filesSkipped: z.number().int().nonnegative(),
});
export type GrepResponse = z.infer<typeof GrepResponse>;

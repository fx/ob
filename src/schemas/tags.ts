/**
 * Zod schemas for tag listing.
 *
 * The REST handler parses `ListTagsQuery` (query-string values, so `limit`
 * is coerced); the MCP `list_tags` tool parses `ListTagsInput` (JSON numbers).
 * `prefix` is defined once and shared, so both adapters bound it identically.
 */

import { z } from "zod";

/** Upper bound on `prefix`, in UTF-8 bytes (REST spec › Tags). */
export const MAX_TAG_PREFIX_BYTES = 1024;

/**
 * Literal path prefix: only documents whose path starts with it are
 * counted. Bounded in bytes rather than UTF-16 units, as the spec states.
 */
export const TagPrefix = z
  .string()
  .refine((s) => Buffer.byteLength(s, "utf8") <= MAX_TAG_PREFIX_BYTES, {
    message: `prefix exceeds ${MAX_TAG_PREFIX_BYTES} bytes`,
  });

/** The `limit` bounds shared by both adapters. */
const TagLimit = z.number().int().min(1).max(1000);

/**
 * `GET /v1/vaults/:slug/tags` query parameters. Unknown keys are rejected.
 * `limit` must be plain decimal digits: `z.coerce.number()` would also
 * accept `0x10`, `1e2`, or ` 5`, which the spec's "any other value" rules out.
 */
export const ListTagsQuery = z
  .object({
    prefix: TagPrefix.optional(),
    limit: z
      .string()
      .regex(/^[0-9]+$/, "limit must be a decimal integer")
      .transform(Number)
      .pipe(TagLimit)
      .default(100),
  })
  .strict();
export type ListTagsQuery = z.infer<typeof ListTagsQuery>;

/** MCP `list_tags` input. Mirrors `ListTagsQuery` for the tool surface. */
export const ListTagsInput = z
  .object({
    vault: z.string().min(1),
    prefix: TagPrefix.optional(),
    limit: TagLimit.optional(),
  })
  .strict();
export type ListTagsInput = z.infer<typeof ListTagsInput>;

/** One listed tag with the number of distinct documents carrying it. */
export const TagCount = z.object({
  tag: z.string(),
  count: z.number().int().positive(),
});
export type TagCount = z.infer<typeof TagCount>;

/** Response shape shared by `GET /tags` and `list_tags`. */
export const ListTagsResponse = z.object({
  items: z.array(TagCount),
  total: z.number().int().nonnegative(),
});
export type ListTagsResponse = z.infer<typeof ListTagsResponse>;

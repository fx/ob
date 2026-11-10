/**
 * Zod schemas for the type-agnostic path operations (REST API › Path
 * operations): list and delete over files and folders alike.
 *
 * REST parses the `*Query` schemas from the query string (so booleans and
 * numbers arrive as strings); the MCP `list` / `delete` tools parse the
 * `*Input` schemas, whose `inputSchema` is derived from the same Zod values
 * via `z.toJSONSchema()` and which take real JSON booleans and numbers. The
 * individual fields are defined once below and shared by both.
 */

import { z } from "zod";

/** Maximum `prefix` length, in UTF-8 bytes. */
export const MAX_PREFIX_BYTES = 1024;

/** Literal prefix matched against the leading bytes of each path. */
const prefix = z
  .string()
  .max(MAX_PREFIX_BYTES)
  .refine((s) => Buffer.byteLength(s, "utf8") <= MAX_PREFIX_BYTES, {
    message: `prefix exceeds ${MAX_PREFIX_BYTES} bytes`,
  });
/** Opaque cursor: a previous page's `nextCursor`. */
const cursor = z.string();
/** Entry type filter; omitted means both. */
const pathType = z.enum(["file", "folder"]);
/** Page size bounds (default 100, applied by the service core). */
const limit = z.number().int().min(1).max(1000);
/** Query-string boolean: only the literal `"true"` / `"false"`. */
const queryBoolean = z.enum(["true", "false"]).transform((v) => v === "true");

/** `GET /v1/vaults/:slug/paths` query string. Unknown parameters are `invalid_query`. */
export const ListPathsQuery = z
  .object({
    prefix: prefix.optional(),
    limit: z.coerce.number().pipe(limit).default(100),
    cursor: cursor.optional(),
    type: pathType.optional(),
    recursive: queryBoolean.optional(),
  })
  .strict();
export type ListPathsQuery = z.infer<typeof ListPathsQuery>;

/** MCP `list` input. `recursive` defaults to `true` in the service core. */
export const ListPathsInput = z
  .object({
    vault: z.string().min(1),
    prefix: prefix.optional(),
    limit: limit.optional(),
    cursor: cursor.optional(),
    type: pathType.optional(),
    recursive: z.boolean().optional(),
  })
  .strict();
export type ListPathsInput = z.infer<typeof ListPathsInput>;

/** One listing entry, discriminated by `type`. Folders carry no size, hash, or content type. */
export const PathEntry = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("file"),
    path: z.string(),
    mtimeMs: z.number(),
    size: z.number(),
    sha256: z.string(),
    contentType: z.string(),
  }),
  z.object({
    type: z.literal("folder"),
    path: z.string(),
    mtimeMs: z.number(),
  }),
]);
export type PathEntry = z.infer<typeof PathEntry>;

export const ListPathsResponse = z.object({
  items: z.array(PathEntry),
  nextCursor: z.string().nullable(),
});
export type ListPathsResponse = z.infer<typeof ListPathsResponse>;

/** `DELETE /v1/vaults/:slug/paths/*path` query string. */
export const DeletePathQuery = z
  .object({
    recursive: queryBoolean.optional(),
  })
  .strict();
export type DeletePathQuery = z.infer<typeof DeletePathQuery>;

/** MCP `delete` input. `recursive` defaults to `false` in the service core. */
export const DeletePathInput = z
  .object({
    vault: z.string().min(1),
    path: z.string().min(1),
    recursive: z.boolean().optional(),
  })
  .strict();
export type DeletePathInput = z.infer<typeof DeletePathInput>;

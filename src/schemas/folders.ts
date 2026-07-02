/**
 * Zod schemas for folder-related inputs and outputs (change 0012).
 *
 * Mirrors `src/schemas/files.ts`. The REST handlers parse the `*Query`
 * schemas; the MCP tools parse the `*Input` schemas (whose `inputSchema` is
 * derived from the same Zod values via `zod-to-json-schema`). A field is
 * defined once here and reused by both adapters — no duplicated zod defs.
 */

import { z } from "zod";

/**
 * List query parameters. Same semantics as `ListFilesQuery`: `prefix` is
 * matched literally against the leading bytes of each path, `limit` defaults
 * to 100 (capped at 1000), `cursor` is opaque base64 of the last-seen path.
 */
export const ListFoldersQuery = z
  .object({
    prefix: z.string().max(1024).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(100),
    cursor: z.string().optional(),
  })
  .strict();
export type ListFoldersQuery = z.infer<typeof ListFoldersQuery>;

/** Single entry in the list-folders response. */
export const FolderEntry = z.object({
  path: z.string(),
  mtimeMs: z.number(),
});
export type FolderEntry = z.infer<typeof FolderEntry>;

export const ListFoldersResponse = z.object({
  items: z.array(FolderEntry),
  nextCursor: z.string().nullable(),
});
export type ListFoldersResponse = z.infer<typeof ListFoldersResponse>;

/** Response shape for `PUT /v1/vaults/:slug/folders/*path`. */
export const CreateFolderResponse = z.object({
  path: z.string(),
  mtimeMs: z.number(),
  created: z.boolean(),
});
export type CreateFolderResponse = z.infer<typeof CreateFolderResponse>;

/**
 * DELETE query parameters. `recursive` is a query string (`?recursive=true`)
 * rather than a body so `fetch(url, { method: "DELETE" })` works with no body.
 * Only the literal `"true"`/`"false"` are accepted; anything else is an
 * `invalid_query`.
 */
export const DeleteFolderQuery = z
  .object({
    recursive: z.enum(["true", "false"]).optional(),
  })
  .strict();
export type DeleteFolderQuery = z.infer<typeof DeleteFolderQuery>;

/** MCP `list_folders` input. Mirrors `ListFoldersQuery` for the tool surface. */
export const ListFoldersInput = z
  .object({
    vault: z.string().min(1),
    prefix: z.string().max(1024).optional(),
    limit: z.number().int().min(1).max(1000).optional(),
    cursor: z.string().optional(),
  })
  .strict();
export type ListFoldersInput = z.infer<typeof ListFoldersInput>;

/** MCP `create_folder` input. */
export const CreateFolderInput = z
  .object({
    vault: z.string().min(1),
    path: z.string().min(1),
  })
  .strict();
export type CreateFolderInput = z.infer<typeof CreateFolderInput>;

/** MCP `delete_folder` input. `recursive` is a real boolean over MCP. */
export const DeleteFolderInput = z
  .object({
    vault: z.string().min(1),
    path: z.string().min(1),
    recursive: z.boolean().optional(),
  })
  .strict();
export type DeleteFolderInput = z.infer<typeof DeleteFolderInput>;

/**
 * Zod schemas for the one folder-only operation, create (change 0012).
 *
 * Listing and deleting are type-agnostic path operations; their schemas live
 * in `src/schemas/paths.ts`. The MCP `create_folder` tool parses
 * `CreateFolderInput` (its `inputSchema` is derived from the same Zod value via
 * `z.toJSONSchema()`).
 */

import { z } from "zod";

/** Response shape for `PUT /v1/vaults/:slug/folders/*path`. */
export const CreateFolderResponse = z.object({
  path: z.string(),
  mtimeMs: z.number(),
  created: z.boolean(),
});
export type CreateFolderResponse = z.infer<typeof CreateFolderResponse>;

/** MCP `create_folder` input. */
export const CreateFolderInput = z
  .object({
    vault: z.string().min(1),
    path: z.string().min(1),
  })
  .strict();
export type CreateFolderInput = z.infer<typeof CreateFolderInput>;

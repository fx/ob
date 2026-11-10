/**
 * Zod schemas for file-related inputs and outputs.
 *
 * The REST handlers parse with these schemas; the MCP adapter (0005) registers
 * tools whose `inputSchema` is derived from the same Zod values via Zod's
 * native `z.toJSONSchema()`. A field MUST NOT be defined twice — when a shape
 * needs adjusting, edit it here.
 */

import { z } from "zod";

/**
 * Markdown-with-frontmatter view of a read response. Returned by the HTTP
 * adapter when a `.md`/`.markdown` GET carries `Accept: application/json`.
 */
export const ReadFileMarkdownResponse = z.object({
  path: z.string(),
  content: z.string(),
  frontmatter: z.record(z.string(), z.unknown()),
  mtimeMs: z.number(),
  size: z.number(),
  sha256: z.string(),
});
export type ReadFileMarkdownResponse = z.infer<typeof ReadFileMarkdownResponse>;

/**
 * JSON variant body for `PUT` on a Markdown file. `content` is the raw body;
 * `frontmatter` is the parsed YAML front-matter (passed through `gray-matter`
 * on serialize).
 */
export const PutMarkdownBody = z
  .object({
    content: z.string(),
    frontmatter: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();
export type PutMarkdownBody = z.infer<typeof PutMarkdownBody>;

/**
 * Single edit in a `PATCH` body. `replaceAll: true` requires ≥ 1 occurrence;
 * `replaceAll` omitted/false requires exactly 1.
 */
export const PatchEdit = z
  .object({
    old: z.string().min(1),
    new: z.string(),
    replaceAll: z.boolean().optional(),
  })
  .strict();
export type PatchEdit = z.infer<typeof PatchEdit>;

export const PatchFileBody = z
  .object({
    edits: z.array(PatchEdit).min(1),
  })
  .strict();
export type PatchFileBody = z.infer<typeof PatchFileBody>;

/** JSON variant body for `:append` on a Markdown file. */
export const AppendBody = z
  .object({
    content: z.string(),
  })
  .strict();
export type AppendBody = z.infer<typeof AppendBody>;

/** Common write-response fields. `created` distinguishes PUT (true|false) from append (always false). */
export const WriteFileResponse = z.object({
  path: z.string(),
  mtimeMs: z.number(),
  size: z.number(),
  sha256: z.string(),
  contentType: z.string(),
  created: z.boolean(),
  indexed: z.boolean(),
});
export type WriteFileResponse = z.infer<typeof WriteFileResponse>;

/** PATCH response shape — `WriteFileResponse` plus the count of edits applied. */
export const PatchFileResponse = WriteFileResponse.extend({
  edits: z.number().int().nonnegative(),
});
export type PatchFileResponse = z.infer<typeof PatchFileResponse>;

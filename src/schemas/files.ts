/**
 * Zod schemas for file-related inputs and outputs.
 *
 * The REST handlers parse with these schemas; the MCP adapter (0005) registers
 * tools whose `inputSchema` is derived from the same Zod values via
 * `zod-to-json-schema`. A field MUST NOT be defined twice — when a shape
 * needs adjusting, edit it here.
 */

import { z } from "zod";

/**
 * List query parameters.
 *
 * `prefix` is matched literally against the leading bytes of each path.
 * `limit` defaults to 100, capped at 1000 (REST spec).
 * `cursor` is opaque — base64-encoded path of the last item from the
 * previous page; `listFiles` is the only producer/consumer.
 */
export const ListFilesQuery = z
  .object({
    prefix: z.string().max(1024).optional(),
    limit: z.coerce.number().int().min(1).max(1000).default(100),
    cursor: z.string().optional(),
  })
  .strict();
export type ListFilesQuery = z.infer<typeof ListFilesQuery>;

/** Single entry in the list-files response. */
export const FileEntry = z.object({
  path: z.string(),
  mtimeMs: z.number(),
  size: z.number(),
  sha256: z.string(),
  contentType: z.string(),
});
export type FileEntry = z.infer<typeof FileEntry>;

export const ListFilesResponse = z.object({
  items: z.array(FileEntry),
  nextCursor: z.string().nullable(),
});
export type ListFilesResponse = z.infer<typeof ListFilesResponse>;

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

/**
 * Zod schemas for natural-language search.
 */

import { z } from "zod";

export const SearchFilter = z
  .object({
    tag: z.string().optional(),
    pathPrefix: z.string().optional(),
  })
  .strict();
export type SearchFilter = z.infer<typeof SearchFilter>;

export const SearchMode = z.enum(["hybrid", "vector", "fts"]);
export type SearchMode = z.infer<typeof SearchMode>;

export const SearchBody = z
  .object({
    query: z.string().min(1).max(4096),
    limit: z.number().int().min(1).max(100).default(20),
    filter: SearchFilter.optional(),
    mode: SearchMode.optional(),
    /** Score floor in [0, 1]. Hits below the threshold are dropped. */
    threshold: z.number().min(0).max(1).optional(),
    /** MMR mixing constant. */
    mmrLambda: z.number().min(0).max(1).optional(),
    /** Per-path return cap. */
    maxPerPath: z.number().int().min(1).max(100).optional(),
  })
  .strict();
export type SearchBody = z.infer<typeof SearchBody>;

/** A single hit, mirroring `SearchHit` from the indexer module. */
export const SearchHitSchema = z.object({
  path: z.string(),
  chunkIndex: z.number().int().nonnegative(),
  headingPath: z.array(z.string()),
  text: z.string(),
  score: z.number(),
  frontmatter: z.record(z.string(), z.unknown()),
  links: z.array(z.string()),
  tags: z.array(z.string()),
});
export type SearchHitSchema = z.infer<typeof SearchHitSchema>;

export const SearchResponse = z.object({
  hits: z.array(SearchHitSchema),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

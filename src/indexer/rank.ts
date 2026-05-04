/**
 * Pure post-processing for hybrid retrieval results: MMR diversification
 * and a score threshold.
 *
 * The indexer fuses vector + FTS arms via Reciprocal Rank Fusion in
 * `searchHybrid` (see `src/indexer/store.ts`). The fused list is then run
 * through:
 *
 *   fuse → applyMmr (over top K = max(60, 3 × limit))
 *        → applyThreshold (drop score < threshold)
 *        → cut to limit
 *
 * Both functions are pure (no I/O, no LanceDB) so they're easy to unit-test
 * exhaustively, and they live here rather than inside `searchHybrid` so the
 * `vector` and `fts` modes can reuse the same diversification + threshold
 * pipeline without copy-paste.
 */
import type { SearchHit } from "./store.ts";

export interface MmrOptions {
  /**
   * Mixing constant in `[0, 1]`. At `λ = 1` the diversity term vanishes
   * (selection collapses to pure relevance order); at `λ = 0` selection
   * ignores relevance and only spreads across paths.
   */
  readonly lambda: number;
  /** Maximum number of selections per `path`. Spec default: 3. */
  readonly maxPerPath: number;
  /**
   * K-cap. The MMR loop only considers the first `topK` candidates of the
   * fused list; deeper candidates are dropped. Spec: `max(60, 3 × limit)`.
   */
  readonly topK: number;
}

export const DEFAULT_LAMBDA = 0.5;
export const DEFAULT_MAX_PER_PATH = 3;
export const DEFAULT_THRESHOLD = 0;

/**
 * Maximal Marginal Relevance over a fused candidate list.
 *
 * Per spec: `mmrScore(c) = λ × relevance(c) − (1 − λ) × similarity-to-selected(c)`,
 * where `similarity-to-selected(c) = 1` if any already-selected hit shares
 * the same `path`, else `0` (path-level diversity, not vector similarity).
 * The candidate with the **highest** `mmrScore` is selected next.
 *
 * Candidates whose path has already reached `maxPerPath` are dropped from
 * consideration. The relevance term is `c.score` directly (already
 * normalized into `(0, 1]` upstream).
 *
 * Returns a re-ordered list, no truncation. Caller applies `threshold` and
 * the final `limit` cut.
 */
export function applyMmr(candidates: readonly SearchHit[], opts: MmrOptions): SearchHit[] {
  const pool = candidates.slice(0, opts.topK);
  const remaining = new Set<number>(pool.map((_, i) => i));
  const selected: SearchHit[] = [];
  const perPath = new Map<string, number>();
  const lambda = opts.lambda;

  while (remaining.size > 0) {
    let bestIdx = -1;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const i of remaining) {
      const c = pool[i];
      if (c === undefined) continue;
      // Path cap: skip candidates whose path already at the cap.
      if ((perPath.get(c.path) ?? 0) >= opts.maxPerPath) continue;
      const sharedPath = (perPath.get(c.path) ?? 0) > 0 ? 1 : 0;
      const score = lambda * c.score - (1 - lambda) * sharedPath;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx === -1) break;
    const picked = pool[bestIdx];
    if (picked === undefined) break;
    selected.push(picked);
    perPath.set(picked.path, (perPath.get(picked.path) ?? 0) + 1);
    remaining.delete(bestIdx);
  }

  return selected;
}

/**
 * Drop hits with `score < threshold`. With `threshold = 0` this is a
 * no-op (every legitimate score is in `(0, 1]`). Empty result is returned
 * as `[]` — never as an error — so callers can surface a 200 with
 * `{ hits: [] }` for queries below the floor.
 */
export function applyThreshold(hits: readonly SearchHit[], threshold: number): SearchHit[] {
  if (threshold <= 0) return hits.slice();
  return hits.filter((h) => h.score >= threshold);
}

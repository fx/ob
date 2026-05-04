/**
 * Service core: aggregate supervisor + indexer state into the response shape
 * documented in `GET /v1/vaults` and `GET /v1/vaults/:slug`.
 */

import type { Indexer, IndexerStatus } from "../indexer/index.ts";
import type { Supervisor, VaultStatus } from "../obsidian/index.ts";

export interface VaultSummary {
  readonly slug: string;
  readonly name: string;
  readonly sync: VaultStatus;
  readonly indexer: IndexerStatus;
}

export interface StatusDeps {
  readonly supervisor: Supervisor;
  readonly indexer: Pick<Indexer, "list" | "status">;
}

function emptyIndexer(slug: string): IndexerStatus {
  return {
    slug,
    state: "starting",
    documents: 0,
    chunks: 0,
    lastIndexedAt: null,
    pending: 0,
    errors: 0,
  };
}

export function listVaults(deps: StatusDeps): VaultSummary[] {
  const supStatuses = deps.supervisor.list();
  const idxStatuses = deps.indexer.list();
  // Build a slug → IndexerStatus lookup so a startup race (supervisor knows
  // the vault, indexer hasn't registered yet) reports a `starting` indexer
  // rather than throwing.
  const idxBySlug = new Map<string, IndexerStatus>();
  for (const i of idxStatuses) idxBySlug.set(i.slug, i);
  return supStatuses.map((sync) => ({
    slug: sync.slug,
    name: sync.name,
    sync,
    indexer: idxBySlug.get(sync.slug) ?? emptyIndexer(sync.slug),
  }));
}

export function vaultStatus(deps: StatusDeps, slug: string): VaultSummary | null {
  const sync = deps.supervisor.get(slug);
  if (sync === null) return null;
  const indexer = deps.indexer.status(slug) ?? emptyIndexer(slug);
  return { slug: sync.slug, name: sync.name, sync, indexer };
}

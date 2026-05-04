/**
 * Common deps shape passed to every `/v1/*` route module.
 *
 * Routes deliberately depend on the shared `VaultServiceDeps` (for file CRUD)
 * plus the supervisor + indexer pair (for status aggregation). The HTTP
 * adapter constructs one of these per process and reuses it for every
 * request.
 */

import type { Indexer } from "../../indexer/index.ts";
import type { Supervisor } from "../../obsidian/index.ts";
import type { VaultServiceDeps } from "../../vault/files.ts";

export interface RouteDeps extends VaultServiceDeps {
  readonly supervisor: Supervisor;
  readonly indexer: Indexer;
}

/**
 * Test helpers for the vault service core.
 *
 * Builds a fake `VaultServiceDeps` rooted at a `Bun.tmpdirSync()` directory,
 * exposing the indexer hooks (`reindex`, `drop`, `search`) so tests can
 * assert that markdown writes call the indexer once and binary writes don't.
 * Also captures `logger.warn` calls so tests can assert that indexer
 * failures are reported via the structured-log channel.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SearchHit } from "../../src/indexer/index.ts";
import type { LogFields, Logger } from "../../src/log.ts";
import type { VaultDescriptor, VaultServiceDeps } from "../../src/vault/files.ts";

export interface FakeIndexerCalls {
  readonly reindex: { slug: string; path: string }[];
  readonly drop: { slug: string; path: string }[];
  readonly search: { slug: string; query: string }[];
}

export interface LogCall {
  readonly msg: string;
  readonly fields?: LogFields;
}

export interface CapturedLogs {
  readonly trace: LogCall[];
  readonly debug: LogCall[];
  readonly info: LogCall[];
  readonly warn: LogCall[];
  readonly error: LogCall[];
}

export interface VaultFixture {
  readonly deps: VaultServiceDeps;
  readonly root: string;
  readonly slug: string;
  readonly calls: FakeIndexerCalls;
  readonly logCalls: CapturedLogs;
  /** Override what `indexer.search` returns for the next call(s). */
  setHits(hits: SearchHit[]): void;
  /** Make `indexer.reindex` reject once. */
  failNextReindex(error: unknown): void;
  /** Make `indexer.drop` reject once. */
  failNextDrop(error: unknown): void;
}

export function makeVaultFixture(): VaultFixture {
  const dir = mkdtempSync(join(tmpdir(), "ob-vault-"));
  const slug = "v";
  const root = join(dir, "vaults", slug);
  mkdirSync(root, { recursive: true });

  const calls: FakeIndexerCalls = { reindex: [], drop: [], search: [] };
  let nextHits: SearchHit[] = [];
  let nextReindexError: unknown = null;
  let reindexErrorPending = false;
  let nextDropError: unknown = null;
  let dropErrorPending = false;

  const logCalls: CapturedLogs = {
    trace: [],
    debug: [],
    info: [],
    warn: [],
    error: [],
  };
  const make = (bucket: LogCall[]) => (msg: string, fields?: LogFields) => {
    bucket.push(fields !== undefined ? { msg, fields } : { msg });
  };
  const logger: Logger = {
    trace: make(logCalls.trace),
    debug: make(logCalls.debug),
    info: make(logCalls.info),
    warn: make(logCalls.warn),
    error: make(logCalls.error),
  };

  const descriptor: VaultDescriptor = { slug, name: slug, root };

  const deps: VaultServiceDeps = {
    vault: (s): VaultDescriptor | null => (s === slug ? descriptor : null),
    indexer: {
      reindex: async (s, p): Promise<void> => {
        calls.reindex.push({ slug: s, path: p });
        if (reindexErrorPending) {
          const e = nextReindexError;
          reindexErrorPending = false;
          nextReindexError = null;
          throw e;
        }
      },
      drop: async (s, p): Promise<void> => {
        calls.drop.push({ slug: s, path: p });
        if (dropErrorPending) {
          const e = nextDropError;
          dropErrorPending = false;
          nextDropError = null;
          throw e;
        }
      },
      search: async (s, q): Promise<SearchHit[]> => {
        calls.search.push({ slug: s, query: q });
        return nextHits;
      },
    },
    logger,
  };

  return {
    deps,
    root,
    slug,
    calls,
    logCalls,
    setHits(hits): void {
      nextHits = hits;
    },
    failNextReindex(err): void {
      nextReindexError = err;
      reindexErrorPending = true;
    },
    failNextDrop(err): void {
      nextDropError = err;
      dropErrorPending = true;
    },
  };
}

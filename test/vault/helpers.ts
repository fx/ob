/**
 * Test helpers for the vault service core.
 *
 * Builds a fake `VaultServiceDeps` rooted at a `Bun.tmpdirSync()` directory,
 * exposing the indexer hooks (`reindex`, `drop`, `search`, `tags`,
 * `indexedPaths`, `isIndexable`) so tests can assert that markdown writes call the indexer
 * once and binary writes don't. The fake keeps an in-memory set of indexed
 * paths (`reindex` adds, `drop` removes, `indexedPaths` filters it by literal
 * prefix) and answers `isIndexable` with the REAL `isIndexablePath` on the
 * vault root, so drop-guard tests observe real index state. Every indexer call
 * is also appended to `events` (`drop:<path>`, `indexedPaths:<prefix>`, …) so
 * tests can assert ordering against their own hook events.
 * Also captures `logger.warn` calls so tests can assert that indexer
 * failures are reported via the structured-log channel.
 */

import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SearchHit, TagListing, TagListingOptions } from "../../src/indexer/index.ts";
import { isIndexablePath } from "../../src/indexer/scanner.ts";
import type { LogFields, Logger } from "../../src/log.ts";
import type { VaultDescriptor, VaultServiceDeps } from "../../src/vault/files.ts";

export interface FakeIndexerCalls {
  readonly reindex: { slug: string; path: string }[];
  readonly drop: { slug: string; path: string }[];
  readonly search: { slug: string; query: string }[];
  readonly tags: { slug: string; opts: TagListingOptions | undefined }[];
  readonly indexedPaths: { slug: string; prefix: string }[];
  readonly isIndexable: { slug: string; path: string }[];
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
  /** Override what `indexer.tags` returns for the next call(s). */
  setTags(listing: TagListing): void;
  /** Make `indexer.reindex` reject once. */
  failNextReindex(error: unknown): void;
  /** Make `indexer.drop` reject once. */
  failNextDrop(error: unknown): void;
  /** Make `indexer.indexedPaths` reject once. */
  failNextIndexedPaths(error: unknown): void;
  /** The fake index: vault-relative paths that currently "have rows". */
  readonly indexed: Set<string>;
  /** Ordered log of every indexer call, shared with test hooks. */
  readonly events: string[];
}

export function makeVaultFixture(): VaultFixture {
  const dir = mkdtempSync(join(tmpdir(), "ob-vault-"));
  const slug = "v";
  const root = join(dir, "vaults", slug);
  mkdirSync(root, { recursive: true });

  const calls: FakeIndexerCalls = {
    reindex: [],
    drop: [],
    search: [],
    tags: [],
    indexedPaths: [],
    isIndexable: [],
  };
  const indexed = new Set<string>();
  const events: string[] = [];
  let nextIndexedPathsError: unknown = null;
  let indexedPathsErrorPending = false;
  let nextHits: SearchHit[] = [];
  let nextTags: TagListing = { items: [], total: 0 };
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
        events.push(`reindex:${p}`);
        if (reindexErrorPending) {
          const e = nextReindexError;
          reindexErrorPending = false;
          nextReindexError = null;
          throw e;
        }
        indexed.add(p);
      },
      drop: async (s, p): Promise<void> => {
        calls.drop.push({ slug: s, path: p });
        events.push(`drop:${p}`);
        if (dropErrorPending) {
          const e = nextDropError;
          dropErrorPending = false;
          nextDropError = null;
          throw e;
        }
        indexed.delete(p);
      },
      indexedPaths: async (s, prefix): Promise<string[]> => {
        calls.indexedPaths.push({ slug: s, prefix });
        events.push(`indexedPaths:${prefix}`);
        if (indexedPathsErrorPending) {
          const e = nextIndexedPathsError;
          indexedPathsErrorPending = false;
          nextIndexedPathsError = null;
          throw e;
        }
        return [...indexed].filter((p) => p.startsWith(prefix)).sort();
      },
      isIndexable: async (s, p): Promise<boolean> => {
        calls.isIndexable.push({ slug: s, path: p });
        events.push(`isIndexable:${p}`);
        return isIndexablePath(root, p);
      },
      search: async (s, q): Promise<SearchHit[]> => {
        calls.search.push({ slug: s, query: q });
        return nextHits;
      },
      tags: async (s, opts): Promise<TagListing> => {
        calls.tags.push({ slug: s, opts });
        return nextTags;
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
    setTags(listing): void {
      nextTags = listing;
    },
    failNextReindex(err): void {
      nextReindexError = err;
      reindexErrorPending = true;
    },
    failNextDrop(err): void {
      nextDropError = err;
      dropErrorPending = true;
    },
    failNextIndexedPaths(err): void {
      nextIndexedPathsError = err;
      indexedPathsErrorPending = true;
    },
    indexed,
    events,
  };
}

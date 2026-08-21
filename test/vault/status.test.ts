import { describe, expect, test } from "bun:test";
import type { Indexer, IndexerStatus } from "../../src/indexer/index.ts";
import type { Supervisor, VaultStatus } from "../../src/obsidian/index.ts";
import { listVaults, vaultStatus } from "../../src/vault/status.ts";
import { makeVaultStatus } from "../helpers/vaultStatus.ts";

function fakeSupervisor(statuses: VaultStatus[]): Supervisor {
  return {
    list: () => statuses.slice(),
    get: (slug) => statuses.find((s) => s.slug === slug) ?? null,
    stop: async () => undefined,
  };
}

function fakeIndexer(statuses: IndexerStatus[]): Pick<Indexer, "list" | "status"> {
  return {
    list: () => statuses.slice(),
    status: (slug) => statuses.find((s) => s.slug === slug) ?? null,
  };
}

const SYNC_OK: VaultStatus = makeVaultStatus({ slug: "v" });

const IDX_READY: IndexerStatus = {
  slug: "v",
  state: "ready",
  documents: 1,
  chunks: 1,
  lastIndexedAt: 100,
  pending: 0,
  errors: 0,
};

describe("listVaults", () => {
  test("aggregates supervisor + indexer state", () => {
    const result = listVaults({
      supervisor: fakeSupervisor([SYNC_OK]),
      indexer: fakeIndexer([IDX_READY]),
    });
    expect(result).toEqual([{ slug: "v", name: "v", sync: SYNC_OK, indexer: IDX_READY }]);
  });

  test("uses an empty indexer placeholder when supervisor is ahead", () => {
    const result = listVaults({
      supervisor: fakeSupervisor([SYNC_OK]),
      indexer: fakeIndexer([]),
    });
    expect(result[0]?.indexer.state).toBe("starting");
    expect(result[0]?.indexer.documents).toBe(0);
  });

  test("returns empty list when supervisor reports no vaults", () => {
    const result = listVaults({
      supervisor: fakeSupervisor([]),
      indexer: fakeIndexer([]),
    });
    expect(result).toEqual([]);
  });
});

describe("vaultStatus", () => {
  test("returns the matching summary", () => {
    const result = vaultStatus(
      { supervisor: fakeSupervisor([SYNC_OK]), indexer: fakeIndexer([IDX_READY]) },
      "v",
    );
    expect(result?.indexer).toEqual(IDX_READY);
  });

  test("returns null on unknown slug", () => {
    const result = vaultStatus(
      { supervisor: fakeSupervisor([]), indexer: fakeIndexer([]) },
      "missing",
    );
    expect(result).toBeNull();
  });

  test("uses placeholder indexer state when only supervisor knows the vault", () => {
    const result = vaultStatus(
      { supervisor: fakeSupervisor([SYNC_OK]), indexer: fakeIndexer([]) },
      "v",
    );
    expect(result?.indexer.state).toBe("starting");
  });
});

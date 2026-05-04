import { describe, expect, test } from "bun:test";
import {
  AppendBody,
  ListFilesQuery,
  ListFilesResponse,
  PatchEdit,
  PatchFileBody,
  PatchFileResponse,
  PutMarkdownBody,
  ReadFileMarkdownResponse,
  SearchBody,
  SearchHitSchema,
  SearchResponse,
  VaultIndexerStatus,
  VaultSummary,
  VaultSyncStatus,
  VaultsListResponse,
  WriteFileResponse,
} from "../../src/schemas/index.ts";

describe("ListFilesQuery", () => {
  test("accepts a normal query and applies the default limit", () => {
    const r = ListFilesQuery.parse({});
    expect(r.limit).toBe(100);
  });
  test("rejects non-numeric limit", () => {
    expect(() => ListFilesQuery.parse({ limit: "abc" })).toThrow();
  });
  test("rejects limits over 1000", () => {
    expect(() => ListFilesQuery.parse({ limit: 9999 })).toThrow();
  });
  test("accepts cursor + prefix", () => {
    const r = ListFilesQuery.parse({ prefix: "notes/", cursor: "abc" });
    expect(r.prefix).toBe("notes/");
    expect(r.cursor).toBe("abc");
  });
  test("rejects unknown query keys via strict()", () => {
    expect(() => ListFilesQuery.parse({ junk: "x" })).toThrow();
  });
});

describe("ListFilesResponse", () => {
  test("validates a simple response", () => {
    expect(() =>
      ListFilesResponse.parse({
        items: [{ path: "a.md", mtimeMs: 1, size: 1, sha256: "x", contentType: "text/markdown" }],
        nextCursor: null,
      }),
    ).not.toThrow();
  });
});

describe("ReadFileMarkdownResponse", () => {
  test("requires content + frontmatter object", () => {
    expect(() =>
      ReadFileMarkdownResponse.parse({
        path: "x.md",
        content: "x",
        frontmatter: { tags: ["a"] },
        mtimeMs: 1,
        size: 1,
        sha256: "abc",
      }),
    ).not.toThrow();
  });
});

describe("PutMarkdownBody", () => {
  test("requires content; frontmatter optional", () => {
    expect(PutMarkdownBody.parse({ content: "x" }).content).toBe("x");
    expect(() => PutMarkdownBody.parse({})).toThrow();
  });
});

describe("PatchFileBody", () => {
  test("non-empty edits required", () => {
    expect(() => PatchFileBody.parse({ edits: [] })).toThrow();
  });
  test("each edit needs a non-empty `old`", () => {
    expect(() => PatchFileBody.parse({ edits: [{ old: "", new: "x" }] })).toThrow();
  });
  test("happy path", () => {
    const r = PatchFileBody.parse({
      edits: [{ old: "a", new: "b", replaceAll: true }],
    });
    expect(r.edits.length).toBe(1);
  });
  test("rejects extra keys via strict()", () => {
    expect(() => PatchFileBody.parse({ edits: [{ old: "a", new: "b" }], junk: 1 })).toThrow();
  });
  test("PatchEdit alone parses", () => {
    expect(PatchEdit.parse({ old: "a", new: "b" }).old).toBe("a");
  });
});

describe("AppendBody", () => {
  test("requires content string", () => {
    expect(() => AppendBody.parse({ content: 5 })).toThrow();
    expect(AppendBody.parse({ content: "" }).content).toBe("");
  });
});

describe("WriteFileResponse + PatchFileResponse", () => {
  const base = {
    path: "x.md",
    mtimeMs: 1,
    size: 1,
    sha256: "abc",
    contentType: "text/markdown",
    created: false,
    indexed: true,
  };
  test("WriteFileResponse parses a typical payload", () => {
    expect(() => WriteFileResponse.parse(base)).not.toThrow();
  });
  test("PatchFileResponse needs `edits` count", () => {
    expect(() => PatchFileResponse.parse({ ...base, edits: 2 })).not.toThrow();
    expect(() => PatchFileResponse.parse(base)).toThrow();
  });
});

describe("SearchBody", () => {
  test("query must be 1–4096 chars", () => {
    expect(() => SearchBody.parse({ query: "" })).toThrow();
    expect(() => SearchBody.parse({ query: "x".repeat(5000) })).toThrow();
  });
  test("limit clamped to [1, 100]", () => {
    expect(() => SearchBody.parse({ query: "x", limit: 0 })).toThrow();
    expect(() => SearchBody.parse({ query: "x", limit: 101 })).toThrow();
    expect(SearchBody.parse({ query: "x", limit: 20 }).limit).toBe(20);
  });
  test("default limit is 20", () => {
    expect(SearchBody.parse({ query: "x" }).limit).toBe(20);
  });
  test("filter accepts tag and pathPrefix", () => {
    expect(() =>
      SearchBody.parse({ query: "x", filter: { tag: "t", pathPrefix: "notes/" } }),
    ).not.toThrow();
  });
  test("mode accepts the three known values", () => {
    for (const mode of ["hybrid", "vector", "fts"] as const) {
      expect(SearchBody.parse({ query: "x", mode }).mode).toBe(mode);
    }
  });
  test("mode rejects unknown values; error names allowed values", () => {
    let err: unknown;
    try {
      SearchBody.parse({ query: "x", mode: "bogus" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    const msg = (err as Error).message;
    // Zod's default error embeds the enum's allowed values.
    expect(msg).toContain("hybrid");
    expect(msg).toContain("vector");
    expect(msg).toContain("fts");
  });
  test("threshold rejects values outside [0, 1]", () => {
    expect(() => SearchBody.parse({ query: "x", threshold: -0.1 })).toThrow();
    expect(() => SearchBody.parse({ query: "x", threshold: 1.5 })).toThrow();
    expect(SearchBody.parse({ query: "x", threshold: 0 }).threshold).toBe(0);
    expect(SearchBody.parse({ query: "x", threshold: 1 }).threshold).toBe(1);
    expect(SearchBody.parse({ query: "x", threshold: 0.5 }).threshold).toBe(0.5);
  });
  test("threshold rejects non-number types", () => {
    expect(() => SearchBody.parse({ query: "x", threshold: "0.5" })).toThrow();
  });
  test("mmrLambda rejects values outside [0, 1]", () => {
    expect(() => SearchBody.parse({ query: "x", mmrLambda: -0.1 })).toThrow();
    expect(() => SearchBody.parse({ query: "x", mmrLambda: 1.5 })).toThrow();
    expect(SearchBody.parse({ query: "x", mmrLambda: 0 }).mmrLambda).toBe(0);
    expect(SearchBody.parse({ query: "x", mmrLambda: 1 }).mmrLambda).toBe(1);
  });
  test("maxPerPath requires an integer in [1, 100]", () => {
    expect(() => SearchBody.parse({ query: "x", maxPerPath: 0 })).toThrow();
    expect(() => SearchBody.parse({ query: "x", maxPerPath: 101 })).toThrow();
    expect(() => SearchBody.parse({ query: "x", maxPerPath: 1.5 })).toThrow();
    expect(() => SearchBody.parse({ query: "x", maxPerPath: "3" })).toThrow();
    expect(SearchBody.parse({ query: "x", maxPerPath: 1 }).maxPerPath).toBe(1);
    expect(SearchBody.parse({ query: "x", maxPerPath: 100 }).maxPerPath).toBe(100);
  });
});

describe("SearchHitSchema + SearchResponse", () => {
  test("rejects missing fields", () => {
    expect(() => SearchHitSchema.parse({})).toThrow();
  });
  test("happy path", () => {
    expect(() =>
      SearchResponse.parse({
        hits: [
          {
            path: "x.md",
            chunkIndex: 0,
            headingPath: ["#"],
            text: "x",
            score: 0.5,
            frontmatter: {},
            links: [],
            tags: [],
          },
        ],
      }),
    ).not.toThrow();
  });
});

describe("VaultSummary, VaultsListResponse, VaultSyncStatus, VaultIndexerStatus", () => {
  const sync = {
    slug: "v",
    name: "v",
    state: "running",
    pid: 1,
    restarts: 0,
    lastError: null,
  };
  const indexer = {
    slug: "v",
    state: "ready",
    documents: 1,
    chunks: 1,
    lastIndexedAt: 100,
    pending: 0,
    errors: 0,
  };
  test("VaultSyncStatus parses", () => {
    expect(() => VaultSyncStatus.parse(sync)).not.toThrow();
  });
  test("VaultIndexerStatus parses", () => {
    expect(() => VaultIndexerStatus.parse(indexer)).not.toThrow();
  });
  test("VaultSummary + list", () => {
    const summary = { slug: "v", name: "v", sync, indexer };
    expect(() => VaultSummary.parse(summary)).not.toThrow();
    expect(() => VaultsListResponse.parse([summary])).not.toThrow();
  });
});

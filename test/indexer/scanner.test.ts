import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ScannerFile,
  isMarkdownFile,
  scanVault,
  shouldIgnorePath,
  walkVault,
} from "../../src/indexer/scanner.ts";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "ob-scanner-test-"));
}

function writeMd(root: string, rel: string, body = "# H\n\nbody"): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, body);
}

describe("shouldIgnorePath", () => {
  test.each([
    [".obsidian/workspace.json", true],
    [".trash/old.md", true],
    [".DS_Store", true],
    ["notes/.tmp.md", true],
    ["node_modules/x", true],
    ["notes/foo.md", false],
    ["sub/dir/file.md", false],
    ["", false],
  ])("ignores %s → %s", (rel, expected) => {
    expect(shouldIgnorePath(rel)).toBe(expected);
  });
});

describe("isMarkdownFile", () => {
  test.each([
    ["x.md", true],
    ["x.markdown", true],
    ["x.MD", true],
    ["x.txt", false],
    ["foo", false],
  ])("%s → %s", (p, ok) => {
    expect(isMarkdownFile(p)).toBe(ok);
  });
});

describe("walkVault", () => {
  test("yields markdown files only, skipping ignored dirs", () => {
    const root = tmpRoot();
    writeMd(root, "a.md");
    writeMd(root, "sub/b.md");
    writeMd(root, ".obsidian/skip.md");
    writeMd(root, "notes/c.markdown");
    writeFileSync(join(root, "x.txt"), "not md");
    const files = Array.from(walkVault(root));
    const rels = files.map((f: ScannerFile) => f.relPath).sort();
    expect(rels).toEqual(["a.md", "notes/c.markdown", "sub/b.md"]);
  });

  test("missing root yields nothing", () => {
    const files = Array.from(walkVault("/nonexistent-/ob-scanner-missing"));
    expect(files).toEqual([]);
  });

  test("non-files (e.g. symlink to dir) are skipped — sanity over fs.Dirent", () => {
    const root = tmpRoot();
    // Use a regular file so we exercise the entry.isFile() path; the
    // explicit non-file branch is defensive against odd fs entries.
    writeMd(root, "a.md");
    const files = Array.from(walkVault(root));
    expect(files.length).toBe(1);
  });
});

describe("scanVault", () => {
  test("processes every markdown file with concurrency cap", async () => {
    const root = tmpRoot();
    for (let i = 0; i < 12; i++) writeMd(root, `notes/${i}.md`);
    const seen: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const summary = await scanVault(
      root,
      async (file) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 5));
        seen.push(file.relPath);
        inFlight--;
      },
      { concurrency: 3 },
    );
    expect(seen.length).toBe(12);
    expect(summary.scanned).toBe(12);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  test("default concurrency is 4", async () => {
    const root = tmpRoot();
    for (let i = 0; i < 6; i++) writeMd(root, `n${i}.md`);
    let inFlight = 0;
    let maxInFlight = 0;
    await scanVault(root, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(maxInFlight).toBeLessThanOrEqual(4);
  });

  test("sha256 short-circuit skips matching files when mtime differs", async () => {
    const root = tmpRoot();
    writeMd(root, "a.md", "same");
    writeMd(root, "b.md", "different");
    let processed = 0;
    const summary = await scanVault(
      root,
      async () => {
        processed++;
      },
      {
        // Force-disable the cheap mtime gate so the scanner has to fall
        // through to the read+hash path. With matching sha, a.md is
        // skipped at the content gate.
        statMtimeMs: async () => 0,
        readFile: async (p) => (p.endsWith("a.md") ? "same" : "different"),
        sha256: (c) => c, // Trivial: content === sha for this test.
        lookupFingerprint: async (rel) =>
          rel === "a.md" ? { mtimeMs: 1, sha256: "same" } : undefined,
      },
    );
    expect(processed).toBe(1);
    expect(summary.scanned).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(summary.errors).toBe(0);
  });

  test("mtime gate skips files even without re-reading them", async () => {
    const root = tmpRoot();
    writeMd(root, "a.md", "any content");
    let reads = 0;
    const summary = await scanVault(root, async () => undefined, {
      readFile: async () => {
        reads++;
        return "";
      },
      statMtimeMs: async () => 42,
      // mtime matches → no read, no hash, just skip.
      lookupFingerprint: async () => ({ mtimeMs: 42, sha256: "anything" }),
    });
    expect(reads).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.scanned).toBe(0);
  });

  test("stat failure falls through to read+hash path", async () => {
    const root = tmpRoot();
    writeMd(root, "a.md", "content");
    let processed = 0;
    const summary = await scanVault(
      root,
      async () => {
        processed++;
      },
      {
        statMtimeMs: async () => {
          throw new Error("stat boom");
        },
        readFile: async () => "content",
        sha256: () => "different-sha",
        lookupFingerprint: async () => ({ mtimeMs: 1, sha256: "stored-sha" }),
      },
    );
    expect(processed).toBe(1);
    expect(summary.scanned).toBe(1);
  });

  test("processor exceptions are counted as errors and don't halt the scan", async () => {
    const root = tmpRoot();
    writeMd(root, "a.md");
    writeMd(root, "b.md");
    let processed = 0;
    const summary = await scanVault(root, async (file) => {
      processed++;
      if (file.relPath === "a.md") throw new Error("boom");
    });
    expect(processed).toBe(2);
    expect(summary.errors).toBe(1);
    expect(summary.scanned).toBe(1);
  });

  test("uses default statMtimeMs (real fs.stat) when none injected", async () => {
    const root = tmpRoot();
    writeMd(root, "a.md", "content");
    let processed = 0;
    // No statMtimeMs override → covers the defaultStatMtime path. The
    // file's real mtime won't match our fake fingerprint mtime (1), so
    // the scanner falls through to read+hash and processes the file.
    const summary = await scanVault(
      root,
      async () => {
        processed++;
      },
      {
        readFile: async () => "content",
        sha256: () => "different-sha",
        lookupFingerprint: async () => ({ mtimeMs: 1, sha256: "stored" }),
      },
    );
    expect(processed).toBe(1);
    expect(summary.scanned).toBe(1);
  });

  test("clamps concurrency to ≥ 1", async () => {
    const root = tmpRoot();
    writeMd(root, "a.md");
    const summary = await scanVault(root, async () => undefined, { concurrency: 0 });
    expect(summary.scanned).toBe(1);
  });

  test("readFile failure is counted as an error", async () => {
    const root = tmpRoot();
    writeMd(root, "a.md");
    const summary = await scanVault(root, async () => undefined, {
      readFile: async () => {
        throw new Error("nope");
      },
    });
    expect(summary.errors).toBe(1);
  });
});

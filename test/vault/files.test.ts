import { describe, expect, test } from "bun:test";
import { promises as fs, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  DocNotFoundError,
  InvalidBodyError,
  InvalidPathError,
  PatchAmbiguousError,
  PatchNoMatchError,
  UnsupportedMediaTypeError,
  VaultNotFoundError,
} from "../../src/errors.ts";
import { appendFile, patchFile, readFile, writeFile } from "../../src/vault/files.ts";
import { makeVaultFixture } from "./helpers.ts";

describe("readFile", () => {
  test("returns bytes + sha + mtime + contentType", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "x.md"), "# hi");
    const r = await readFile(fx.deps, fx.slug, "x.md");
    expect(r.path).toBe("x.md");
    expect(r.contentType).toBe("text/markdown; charset=utf-8");
    expect(new TextDecoder().decode(r.bytes)).toBe("# hi");
    expect(r.size).toBe(4);
    expect(r.sha256.length).toBe(64);
    expect(r.mtimeMs).toBeGreaterThan(0);
  });

  test("404 on missing", async () => {
    const fx = makeVaultFixture();
    await expect(readFile(fx.deps, fx.slug, "nope.md")).rejects.toBeInstanceOf(DocNotFoundError);
  });

  test("non-ENOENT stat error propagates", async () => {
    const fx = makeVaultFixture();
    // Create a directory at the path and try to readFile — that's EISDIR
    // (or ENOENT on stat — depends on platform). Either way, not Doc-404.
    await fs.mkdir(join(fx.root, "isadir"), { recursive: true });
    let err: unknown;
    try {
      await readFile(fx.deps, fx.slug, "isadir");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DocNotFoundError);
  });
});

describe("writeFile", () => {
  test("Markdown PUT triggers reindex once and reports indexed: true", async () => {
    const fx = makeVaultFixture();
    const result = await writeFile(fx.deps, fx.slug, "notes/n.md", {
      kind: "markdown",
      content: "# hello",
    });
    expect(result.created).toBe(true);
    expect(result.indexed).toBe(true);
    expect(fx.calls.reindex).toEqual([{ slug: fx.slug, path: "notes/n.md" }]);
    expect(readFileSync(join(fx.root, "notes/n.md"), "utf8")).toBe("# hello");
  });

  test("Markdown PUT serialises frontmatter as YAML", async () => {
    const fx = makeVaultFixture();
    const date = new Date("2026-05-03T00:00:00.000Z");
    const result = await writeFile(fx.deps, fx.slug, "n.md", {
      kind: "markdown",
      content: "body",
      frontmatter: { tags: ["a", "b"], when: date },
    });
    expect(result.indexed).toBe(true);
    const onDisk = readFileSync(join(fx.root, "n.md"), "utf8");
    expect(onDisk.startsWith("---\n")).toBe(true);
    expect(onDisk).toContain('when: "2026-05-03T00:00:00.000Z"');
    expect(onDisk).toContain("body");
  });

  test("Markdown PUT with empty frontmatter object does not emit fences", async () => {
    const fx = makeVaultFixture();
    await writeFile(fx.deps, fx.slug, "n.md", {
      kind: "markdown",
      content: "body",
      frontmatter: {},
    });
    expect(readFileSync(join(fx.root, "n.md"), "utf8")).toBe("body");
  });

  test("raw PUT to a binary path is reindexed, and reported not indexed", async () => {
    const fx = makeVaultFixture();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const result = await writeFile(fx.deps, fx.slug, "attachments/x.png", {
      kind: "raw",
      contentType: "image/png",
      bytes: png,
    });
    expect(result.indexed).toBe(false);
    expect(result.contentType).toBe("image/png");
    // Every written path is handed to `reindex`, which applies the rule.
    expect(fx.calls.reindex).toEqual([{ slug: "v", path: "attachments/x.png" }]);
  });

  test("PUT replacement reports created: false", async () => {
    const fx = makeVaultFixture();
    await writeFile(fx.deps, fx.slug, "x.md", { kind: "markdown", content: "a" });
    const second = await writeFile(fx.deps, fx.slug, "x.md", {
      kind: "markdown",
      content: "b",
    });
    expect(second.created).toBe(false);
  });

  test("markdown body to non-markdown path is a 415 (unsupported)", async () => {
    const fx = makeVaultFixture();
    await expect(
      writeFile(fx.deps, fx.slug, "x.png", { kind: "markdown", content: "x" }),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeError);
  });

  test("uses injected randomUUID for the tmp filename", async () => {
    const fx = makeVaultFixture();
    let calls = 0;
    const deps = {
      ...fx.deps,
      randomUUID: (): string => {
        calls++;
        return "deterministic";
      },
    };
    await writeFile(deps, fx.slug, "x.md", { kind: "markdown", content: "a" });
    expect(calls).toBe(1);
  });

  test("VaultNotFoundError when the slug is missing", async () => {
    const fx = makeVaultFixture();
    await expect(
      writeFile(fx.deps, "missing", "x.md", { kind: "markdown", content: "a" }),
    ).rejects.toBeInstanceOf(VaultNotFoundError);
  });
});

describe("patchFile", () => {
  test("single-edit success", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "x.md"), "# Title\n\n- a\n- b\n");
    const result = await patchFile(fx.deps, fx.slug, "x.md", {
      edits: [{ old: "- b\n", new: "- b\n- c\n" }],
    });
    expect(result.edits).toBe(1);
    expect(result.indexed).toBe(true);
    expect(readFileSync(join(fx.root, "x.md"), "utf8")).toBe("# Title\n\n- a\n- b\n- c\n");
  });

  test("replaceAll: true replaces every occurrence", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "x.md"), "foo\nfoo\n");
    const result = await patchFile(fx.deps, fx.slug, "x.md", {
      edits: [{ old: "foo", new: "bar", replaceAll: true }],
    });
    expect(result.edits).toBe(1);
    expect(readFileSync(join(fx.root, "x.md"), "utf8")).toBe("bar\nbar\n");
  });

  test("replaceAll: true with zero occurrences → patch_no_match", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "x.md"), "abc\n");
    let err: unknown;
    try {
      await patchFile(fx.deps, fx.slug, "x.md", {
        edits: [{ old: "missing", new: "x", replaceAll: true }],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PatchNoMatchError);
    expect((err as PatchNoMatchError).editIndex).toBe(0);
    expect(readFileSync(join(fx.root, "x.md"), "utf8")).toBe("abc\n");
  });

  test("ambiguous old without replaceAll → patch_ambiguous", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "x.md"), "foo\nfoo\n");
    let err: unknown;
    try {
      await patchFile(fx.deps, fx.slug, "x.md", { edits: [{ old: "foo", new: "bar" }] });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PatchAmbiguousError);
    expect((err as PatchAmbiguousError).occurrences).toBe(2);
    expect(readFileSync(join(fx.root, "x.md"), "utf8")).toBe("foo\nfoo\n");
  });

  test("atomic abort: second edit fails → no write", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "x.md"), "alpha\nbeta\n");
    let err: unknown;
    try {
      await patchFile(fx.deps, fx.slug, "x.md", {
        edits: [
          { old: "alpha", new: "ALPHA" },
          { old: "gamma", new: "GAMMA" },
        ],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(PatchNoMatchError);
    expect((err as PatchNoMatchError).editIndex).toBe(1);
    expect(readFileSync(join(fx.root, "x.md"), "utf8")).toBe("alpha\nbeta\n");
    expect(fx.calls.reindex).toEqual([]);
  });

  test("no-op edit (old === new) → invalid_body", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "x.md"), "abc\n");
    let err: unknown;
    try {
      await patchFile(fx.deps, fx.slug, "x.md", {
        edits: [{ old: "abc", new: "abc" }],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(InvalidBodyError);
  });

  test("binary path → 415", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "x.png"), new Uint8Array([1, 2, 3]));
    await expect(
      patchFile(fx.deps, fx.slug, "x.png", { edits: [{ old: "a", new: "b" }] }),
    ).rejects.toBeInstanceOf(UnsupportedMediaTypeError);
  });

  test("missing file → 404", async () => {
    const fx = makeVaultFixture();
    await expect(
      patchFile(fx.deps, fx.slug, "x.md", { edits: [{ old: "a", new: "b" }] }),
    ).rejects.toBeInstanceOf(DocNotFoundError);
  });

  test("empty file → 404", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "x.md"), "");
    await expect(
      patchFile(fx.deps, fx.slug, "x.md", { edits: [{ old: "a", new: "b" }] }),
    ).rejects.toBeInstanceOf(DocNotFoundError);
  });

  test("non-Markdown text path: writes, reindexes, and reports not indexed", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "x.txt"), "hello");
    const result = await patchFile(fx.deps, fx.slug, "x.txt", {
      edits: [{ old: "hello", new: "world" }],
    });
    expect(result.indexed).toBe(false);
    expect(fx.calls.reindex).toEqual([{ slug: "v", path: "x.txt" }]);
    expect(readFileSync(join(fx.root, "x.txt"), "utf8")).toBe("world");
  });

  test("multi-edit succeeds and reindexes once", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "x.md"), "a\nb\nc\n");
    const result = await patchFile(fx.deps, fx.slug, "x.md", {
      edits: [
        { old: "a", new: "A" },
        { old: "c", new: "C" },
      ],
    });
    expect(result.edits).toBe(2);
    expect(fx.calls.reindex.length).toBe(1);
    expect(readFileSync(join(fx.root, "x.md"), "utf8")).toBe("A\nb\nC\n");
  });

  test("empty `old` for an edit triggers patch_no_match path", async () => {
    // Schema rejects this at the adapter, but core defends in depth.
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "x.md"), "abc\n");
    await expect(
      patchFile(fx.deps, fx.slug, "x.md", { edits: [{ old: "", new: "x" }] }),
    ).rejects.toBeInstanceOf(PatchNoMatchError);
  });

  test("non-ENOENT read error propagates", async () => {
    const fx = makeVaultFixture();
    // mkdir at the path to provoke EISDIR on readFile.
    await fs.mkdir(join(fx.root, "isadir"), { recursive: true });
    // The path needs to be considered text by isTextPath, so use .txt
    // Move the dir to a .txt name.
    await fs.rename(join(fx.root, "isadir"), join(fx.root, "isadir.txt"));
    let err: unknown;
    try {
      await patchFile(fx.deps, fx.slug, "isadir.txt", {
        edits: [{ old: "a", new: "b" }],
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DocNotFoundError);
  });
});

describe("appendFile", () => {
  test("appends bytes verbatim with no newline normalisation", async () => {
    const fx = makeVaultFixture();
    await fs.mkdir(join(fx.root, "daily"), { recursive: true });
    writeFileSync(join(fx.root, "daily/2026-05-03.md"), "# Today\n");
    const result = await appendFile(
      fx.deps,
      fx.slug,
      "daily/2026-05-03.md",
      new TextEncoder().encode("- 14:30 had coffee\n"),
    );
    expect(result.indexed).toBe(true);
    expect(readFileSync(join(fx.root, "daily/2026-05-03.md"), "utf8")).toBe(
      "# Today\n- 14:30 had coffee\n",
    );
  });

  test("appended bytes are byte-perfect (no inserted newline)", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "x.txt"), "abc");
    await appendFile(fx.deps, fx.slug, "x.txt", new TextEncoder().encode("def"));
    expect(readFileSync(join(fx.root, "x.txt"), "utf8")).toBe("abcdef");
  });

  test("non-Markdown text path is reindexed and reported not indexed", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "x.txt"), "abc");
    const result = await appendFile(fx.deps, fx.slug, "x.txt", new TextEncoder().encode("d"));
    expect(result.indexed).toBe(false);
    expect(fx.calls.reindex).toEqual([{ slug: "v", path: "x.txt" }]);
  });

  test("binary path → 415", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "x.png"), new Uint8Array([1, 2, 3]));
    await expect(appendFile(fx.deps, fx.slug, "x.png", new Uint8Array([4]))).rejects.toBeInstanceOf(
      UnsupportedMediaTypeError,
    );
  });

  test("missing file → 404", async () => {
    const fx = makeVaultFixture();
    await expect(
      appendFile(fx.deps, fx.slug, "missing.md", new Uint8Array([])),
    ).rejects.toBeInstanceOf(DocNotFoundError);
  });

  test("non-ENOENT read error propagates", async () => {
    const fx = makeVaultFixture();
    await fs.mkdir(join(fx.root, "dir.txt"), { recursive: true });
    let err: unknown;
    try {
      await appendFile(fx.deps, fx.slug, "dir.txt", new Uint8Array([1]));
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DocNotFoundError);
  });
});

describe("indexer failure is non-fatal post-disk", () => {
  test("write: reindex throw still returns 200 with indexed: false", async () => {
    const fx = makeVaultFixture();
    fx.failNextReindex(new Error("indexer down"));
    const result = await writeFile(fx.deps, fx.slug, "x.md", {
      kind: "markdown",
      content: "# hi",
    });
    expect(result.indexed).toBe(false);
    // Disk write happened.
    expect(readFileSync(join(fx.root, "x.md"), "utf8")).toBe("# hi");
  });

  test("patch: reindex throw still returns success with indexed: false", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "x.md"), "abc\n");
    fx.failNextReindex(new Error("indexer down"));
    const result = await patchFile(fx.deps, fx.slug, "x.md", {
      edits: [{ old: "abc", new: "ABC" }],
    });
    expect(result.indexed).toBe(false);
    expect(readFileSync(join(fx.root, "x.md"), "utf8")).toBe("ABC\n");
  });

  test("append: reindex throw still returns success with indexed: false", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "x.md"), "abc");
    fx.failNextReindex(new Error("indexer down"));
    const result = await appendFile(fx.deps, fx.slug, "x.md", new TextEncoder().encode("def"));
    expect(result.indexed).toBe(false);
    expect(readFileSync(join(fx.root, "x.md"), "utf8")).toBe("abcdef");
  });

  test("write: indexer warning is logged with vault + path + error", async () => {
    const fx = makeVaultFixture();
    fx.failNextReindex(new Error("kaboom"));
    await writeFile(fx.deps, fx.slug, "y.md", { kind: "markdown", content: "x" });
    const warn = fx.logCalls.warn.find((c) => c.msg.startsWith("indexer.reindex"));
    expect(warn).toBeDefined();
    expect(warn?.fields).toMatchObject({ vault: fx.slug, path: "y.md", error: "kaboom" });
  });

  test("write: non-Error indexer rejection still logs via String() coercion", async () => {
    const fx = makeVaultFixture();
    // biome-ignore lint/suspicious/noExplicitAny: deliberate non-Error rejection to exercise coercion.
    fx.failNextReindex("string-error" as any);
    await writeFile(fx.deps, fx.slug, "z.md", { kind: "markdown", content: "x" });
    const warn = fx.logCalls.warn.find((c) => c.msg.startsWith("indexer.reindex"));
    expect(warn?.fields?.error).toBe("string-error");
  });
});

describe("symlink-escape rejection", () => {
  test("readFile rejects a path whose leaf is a symlink", async () => {
    const fx = makeVaultFixture();
    symlinkSync("/etc/passwd", join(fx.root, "out.md"));
    await expect(readFile(fx.deps, fx.slug, "out.md")).rejects.toBeInstanceOf(InvalidPathError);
  });

  test("writeFile rejects a path whose parent dir is a symlink", async () => {
    const fx = makeVaultFixture();
    await fs.mkdir(join(fx.root, "real"), { recursive: true });
    symlinkSync(join(fx.root, "real"), join(fx.root, "linked"));
    await expect(
      writeFile(fx.deps, fx.slug, "linked/x.md", { kind: "markdown", content: "x" }),
    ).rejects.toBeInstanceOf(InvalidPathError);
  });

  test("patchFile rejects a symlinked target", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "real.md"), "abc");
    symlinkSync(join(fx.root, "real.md"), join(fx.root, "shadow.md"));
    await expect(
      patchFile(fx.deps, fx.slug, "shadow.md", { edits: [{ old: "abc", new: "ABC" }] }),
    ).rejects.toBeInstanceOf(InvalidPathError);
  });

  test("appendFile rejects a symlinked target", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "real.md"), "abc");
    symlinkSync(join(fx.root, "real.md"), join(fx.root, "shadow.md"));
    await expect(
      appendFile(fx.deps, fx.slug, "shadow.md", new Uint8Array([1])),
    ).rejects.toBeInstanceOf(InvalidPathError);
  });

  test("symlink-escape check is a no-op for paths that don't exist", async () => {
    // Creating a brand-new file under a clean tree must succeed even
    // though `lstat` returns ENOENT for the leaf.
    const fx = makeVaultFixture();
    await writeFile(fx.deps, fx.slug, "fresh/path.md", { kind: "markdown", content: "x" });
    expect(readFileSync(join(fx.root, "fresh/path.md"), "utf8")).toBe("x");
  });
});

describe("concurrent mutating calls (LUuG)", () => {
  test("five simultaneous appends produce 5x the appended bytes (no lost writes)", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "log.md"), "");
    const line = "x\n";
    const tasks = Array.from({ length: 5 }, () =>
      appendFile(fx.deps, fx.slug, "log.md", new TextEncoder().encode(line)),
    );
    await Promise.all(tasks);
    const out = readFileSync(join(fx.root, "log.md"), "utf8");
    expect(out).toBe("x\n".repeat(5));
    expect(out.split("\n").filter((s) => s === "x").length).toBe(5);
  });

  test("simultaneous patch + append serialise (no clobber)", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "n.md"), "abc");
    const a = patchFile(fx.deps, fx.slug, "n.md", { edits: [{ old: "abc", new: "ABC" }] });
    const b = appendFile(fx.deps, fx.slug, "n.md", new TextEncoder().encode("DEF"));
    await Promise.all([a, b]);
    const final = readFileSync(join(fx.root, "n.md"), "utf8");
    // Either patch-then-append (ABCDEF) or append-then-patch (no match,
    // throws). The lock guarantees ONE of those serialisations.
    expect([final]).toContain("ABCDEF");
  });
});

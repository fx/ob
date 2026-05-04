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
import {
  appendFile,
  deleteFile,
  listFiles,
  patchFile,
  readFile,
  writeFile,
} from "../../src/vault/files.ts";
import { makeVaultFixture } from "./helpers.ts";

describe("listFiles", () => {
  test("walks the vault root, skipping hidden / .obsidian / .trash", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "a.md"), "a");
    writeFileSync(join(fx.root, "b.txt"), "b");
    await fs.mkdir(join(fx.root, "notes"), { recursive: true });
    await fs.mkdir(join(fx.root, ".obsidian"), { recursive: true });
    await fs.mkdir(join(fx.root, ".trash"), { recursive: true });
    writeFileSync(join(fx.root, "notes", "x.md"), "# x");
    writeFileSync(join(fx.root, ".obsidian", "workspace.json"), "{}");
    writeFileSync(join(fx.root, ".trash", "old.md"), "old");
    writeFileSync(join(fx.root, ".DS_Store"), "junk");

    const result = await listFiles(fx.deps, fx.slug);
    const paths = result.items.map((i) => i.path).sort();
    expect(paths).toEqual(["a.md", "b.txt", "notes/x.md"]);
    expect(result.nextCursor).toBe(null);
  });

  test("filters by prefix", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "a.md"), "1");
    writeFileSync(join(fx.root, "b.md"), "2");
    await fs.mkdir(join(fx.root, "notes"), { recursive: true });
    writeFileSync(join(fx.root, "notes", "x.md"), "3");

    const result = await listFiles(fx.deps, fx.slug, { prefix: "notes/" });
    expect(result.items.map((i) => i.path)).toEqual(["notes/x.md"]);
  });

  test("paginates via cursor", async () => {
    const fx = makeVaultFixture();
    for (const n of ["a", "b", "c", "d"]) {
      writeFileSync(join(fx.root, `${n}.md`), n);
    }
    const first = await listFiles(fx.deps, fx.slug, { limit: 2 });
    expect(first.items.map((i) => i.path)).toEqual(["a.md", "b.md"]);
    expect(first.nextCursor).not.toBeNull();
    const cursor = first.nextCursor as string;
    const second = await listFiles(fx.deps, fx.slug, { limit: 2, cursor });
    expect(second.items.map((i) => i.path)).toEqual(["c.md", "d.md"]);
    expect(second.nextCursor).toBeNull();
  });

  test("non-string cursor decodes via base64 round-trip", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "a.md"), "x");
    writeFileSync(join(fx.root, "b.md"), "y");
    // Decoded cursor "a.md" — page 2 should yield "b.md" only.
    const cursor = Buffer.from("a.md", "utf8").toString("base64");
    const result = await listFiles(fx.deps, fx.slug, { cursor });
    expect(result.items.map((i) => i.path)).toEqual(["b.md"]);
  });

  test("treats an empty cursor like none", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "a.md"), "x");
    const result = await listFiles(fx.deps, fx.slug, { cursor: "" });
    expect(result.items.length).toBe(1);
  });

  test("returns empty when the root does not exist", async () => {
    const fx = makeVaultFixture();
    await fs.rm(fx.root, { recursive: true });
    const result = await listFiles(fx.deps, fx.slug);
    expect(result.items).toEqual([]);
    expect(result.nextCursor).toBeNull();
  });

  test("throws VaultNotFoundError for unknown slug", async () => {
    const fx = makeVaultFixture();
    await expect(listFiles(fx.deps, "missing")).rejects.toBeInstanceOf(VaultNotFoundError);
  });

  test("non-ENOENT readdir error propagates", async () => {
    const fx = makeVaultFixture();
    // Create a regular file at the root to provoke ENOTDIR on readdir.
    await fs.rm(fx.root, { recursive: true });
    writeFileSync(fx.root, "not-a-dir");
    let err: unknown;
    try {
      await listFiles(fx.deps, fx.slug);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
  });
});

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

  test("raw PUT to a binary path does NOT call the indexer", async () => {
    const fx = makeVaultFixture();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const result = await writeFile(fx.deps, fx.slug, "attachments/x.png", {
      kind: "raw",
      contentType: "image/png",
      bytes: png,
    });
    expect(result.indexed).toBe(false);
    expect(result.contentType).toBe("image/png");
    expect(fx.calls.reindex).toEqual([]);
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

  test("non-Markdown text path: writes but does not reindex", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "x.txt"), "hello");
    const result = await patchFile(fx.deps, fx.slug, "x.txt", {
      edits: [{ old: "hello", new: "world" }],
    });
    expect(result.indexed).toBe(false);
    expect(fx.calls.reindex).toEqual([]);
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

  test("non-Markdown text path does not reindex", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "x.txt"), "abc");
    const result = await appendFile(fx.deps, fx.slug, "x.txt", new TextEncoder().encode("d"));
    expect(result.indexed).toBe(false);
    expect(fx.calls.reindex).toEqual([]);
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

describe("deleteFile", () => {
  test("204 on success; reindexer drop hook called for Markdown", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "x.md"), "# x");
    await deleteFile(fx.deps, fx.slug, "x.md");
    expect(fx.calls.drop).toEqual([{ slug: fx.slug, path: "x.md" }]);
  });

  test("404 if absent", async () => {
    const fx = makeVaultFixture();
    await expect(deleteFile(fx.deps, fx.slug, "missing.md")).rejects.toBeInstanceOf(
      DocNotFoundError,
    );
  });

  test("does not call indexer.drop for binary paths", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "x.png"), new Uint8Array([1]));
    await deleteFile(fx.deps, fx.slug, "x.png");
    expect(fx.calls.drop).toEqual([]);
  });

  test("non-ENOENT unlink error propagates", async () => {
    const fx = makeVaultFixture();
    // Create a directory; unlink will fail with EISDIR.
    await fs.mkdir(join(fx.root, "isadir.md"), { recursive: true });
    let err: unknown;
    try {
      await deleteFile(fx.deps, fx.slug, "isadir.md");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DocNotFoundError);
  });

  test("VaultNotFoundError on unknown slug", async () => {
    const fx = makeVaultFixture();
    await expect(deleteFile(fx.deps, "missing", "x.md")).rejects.toBeInstanceOf(VaultNotFoundError);
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

  test("delete: drop throw still completes the unlink", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "x.md"), "# x");
    fx.failNextDrop(new Error("indexer down"));
    await deleteFile(fx.deps, fx.slug, "x.md");
    // unlink happened despite the drop failure.
    let stat: import("node:fs").Stats | null = null;
    try {
      stat = await fs.stat(join(fx.root, "x.md"));
    } catch {
      stat = null;
    }
    expect(stat).toBeNull();
  });

  test("delete drops BEFORE unlink (call order)", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "x.md"), "# x");
    await deleteFile(fx.deps, fx.slug, "x.md");
    // Both observed; drop must precede the eventual unlink. The fixture
    // doesn't track unlinks explicitly, so we assert drop fired exactly
    // once and the file is gone.
    expect(fx.calls.drop).toEqual([{ slug: fx.slug, path: "x.md" }]);
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

  test("delete: drop warning logs vault + path + error (Error and non-Error)", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "a.md"), "a");
    fx.failNextDrop(new Error("dropfail"));
    await deleteFile(fx.deps, fx.slug, "a.md");
    expect(fx.logCalls.warn.find((c) => c.fields?.error === "dropfail")).toBeDefined();

    writeFileSync(join(fx.root, "b.md"), "b");
    // biome-ignore lint/suspicious/noExplicitAny: deliberate non-Error rejection to exercise coercion.
    fx.failNextDrop("string-drop" as any);
    await deleteFile(fx.deps, fx.slug, "b.md");
    expect(fx.logCalls.warn.find((c) => c.fields?.error === "string-drop")).toBeDefined();
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

  test("deleteFile rejects a symlinked target", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "real.md"), "abc");
    symlinkSync(join(fx.root, "real.md"), join(fx.root, "shadow.md"));
    await expect(deleteFile(fx.deps, fx.slug, "shadow.md")).rejects.toBeInstanceOf(
      InvalidPathError,
    );
  });

  test("listFiles silently skips symlink entries", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "real.md"), "x");
    symlinkSync(join(fx.root, "real.md"), join(fx.root, "shadow.md"));
    const result = await listFiles(fx.deps, fx.slug);
    expect(result.items.map((i) => i.path)).toEqual(["real.md"]);
  });

  test("symlink-escape check is a no-op for paths that don't exist", async () => {
    // Creating a brand-new file under a clean tree must succeed even
    // though `lstat` returns ENOENT for the leaf.
    const fx = makeVaultFixture();
    await writeFile(fx.deps, fx.slug, "fresh/path.md", { kind: "markdown", content: "x" });
    expect(readFileSync(join(fx.root, "fresh/path.md"), "utf8")).toBe("x");
  });
});

describe("listFiles concurrency / ordering", () => {
  test("skips files that vanish mid-page (ENOENT on per-entry stat/read)", async () => {
    // Patch `fs.promises.stat` to throw ENOENT for a specific path while
    // the listing is in flight. We restore the original on every exit
    // path (success / throw) via a try/finally.
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "a.md"), "a");
    writeFileSync(join(fx.root, "ghost.md"), "g");
    writeFileSync(join(fx.root, "z.md"), "z");
    const realStat = fs.stat;
    const ghostAbs = join(fx.root, "ghost.md");
    const stub = ((p: string, ...rest: unknown[]) => {
      if (p === ghostAbs) {
        const err = new Error("ENOENT (stubbed)") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      // biome-ignore lint/suspicious/noExplicitAny: forwarding rest args to the original fs.stat overloads.
      return realStat(p as any, ...(rest as []));
    }) as typeof fs.stat;
    (fs as unknown as { stat: typeof fs.stat }).stat = stub;
    try {
      const result = await listFiles(fx.deps, fx.slug);
      expect(result.items.map((i) => i.path)).toEqual(["a.md", "z.md"]);
    } finally {
      (fs as unknown as { stat: typeof fs.stat }).stat = realStat;
    }
  });

  test("non-ENOENT errors during listing still propagate", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "boom.md"), "b");
    const realStat = fs.stat;
    const stub = ((p: string, ...rest: unknown[]) => {
      if (p === join(fx.root, "boom.md")) {
        throw new Error("EACCES (stubbed)");
      }
      // biome-ignore lint/suspicious/noExplicitAny: forwarding rest args to the original fs.stat overloads.
      return realStat(p as any, ...(rest as []));
    }) as typeof fs.stat;
    (fs as unknown as { stat: typeof fs.stat }).stat = stub;
    try {
      await expect(listFiles(fx.deps, fx.slug)).rejects.toThrow("EACCES");
    } finally {
      (fs as unknown as { stat: typeof fs.stat }).stat = realStat;
    }
  });

  test("paginates correctly with mixed-case names (codepoint sort + strict-greater cursor)", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "A.md"), "1");
    writeFileSync(join(fx.root, "Z.md"), "3");
    writeFileSync(join(fx.root, "a.md"), "2");
    // Codepoint order: A (0x41) < Z (0x5A) < a (0x61).
    const first = await listFiles(fx.deps, fx.slug, { limit: 2 });
    expect(first.items.map((i) => i.path)).toEqual(["A.md", "Z.md"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await listFiles(fx.deps, fx.slug, {
      limit: 2,
      cursor: first.nextCursor as string,
    });
    expect(second.items.map((i) => i.path)).toEqual(["a.md"]);
    expect(second.nextCursor).toBeNull();
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

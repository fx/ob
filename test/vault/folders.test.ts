import { describe, expect, test } from "bun:test";
import { promises as fs, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { InvalidPathError } from "../../src/errors.ts";
import { createFolder } from "../../src/vault/folders.ts";
import { makeVaultFixture } from "./helpers.ts";

describe("createFolder", () => {
  test("creates a nested folder and reports created: true", async () => {
    const fx = makeVaultFixture();
    const result = await createFolder(fx.deps, fx.slug, "archive/2026");
    expect(result.created).toBe(true);
    expect(result.path).toBe("archive/2026");
    expect(result.mtimeMs).toBeGreaterThan(0);
    expect((await fs.stat(join(fx.root, "archive/2026"))).isDirectory()).toBe(true);
    // Folders are never indexed.
    expect(fx.calls.reindex).toEqual([]);
  });

  test("is idempotent: second create is a no-op with the same mtime", async () => {
    const fx = makeVaultFixture();
    const first = await createFolder(fx.deps, fx.slug, "archive/2026");
    const second = await createFolder(fx.deps, fx.slug, "archive/2026");
    expect(second.created).toBe(false);
    expect(second.mtimeMs).toBe(first.mtimeMs);
  });

  test("rejects when the path already exists as a file", async () => {
    const fx = makeVaultFixture();
    await fs.mkdir(join(fx.root, "notes"), { recursive: true });
    writeFileSync(join(fx.root, "notes", "x.md"), "content");
    await expect(createFolder(fx.deps, fx.slug, "notes/x.md")).rejects.toBeInstanceOf(
      InvalidPathError,
    );
    // File is unchanged.
    expect(await fs.readFile(join(fx.root, "notes", "x.md"), "utf8")).toBe("content");
  });

  test("rejects a symlinked target", async () => {
    const fx = makeVaultFixture();
    await fs.mkdir(join(fx.root, "real"), { recursive: true });
    symlinkSync(join(fx.root, "real"), join(fx.root, "linked"));
    await expect(createFolder(fx.deps, fx.slug, "linked")).rejects.toBeInstanceOf(InvalidPathError);
  });

  test("rejects a traversal path without creating anything outside the root", async () => {
    const fx = makeVaultFixture();
    await expect(createFolder(fx.deps, fx.slug, "../escape")).rejects.toBeInstanceOf(
      InvalidPathError,
    );
  });

  test("rejects a dot path that resolves to the vault root", async () => {
    const fx = makeVaultFixture();
    await expect(createFolder(fx.deps, fx.slug, ".")).rejects.toBeInstanceOf(InvalidPathError);
  });

  test("rejects creating under a symlinked ancestor and creates nothing outside the vault", async () => {
    const fx = makeVaultFixture();
    // `outside` lives beside the vault root, reachable only via the symlink.
    const outside = join(fx.root, "..", "..", "outside-create");
    await fs.mkdir(outside, { recursive: true });
    try {
      symlinkSync(outside, join(fx.root, "link"));
      // The intermediate `link/new` does not exist yet; the symlinked ancestor
      // `link` must still be rejected before any mkdir -p runs.
      await expect(createFolder(fx.deps, fx.slug, "link/new/child")).rejects.toBeInstanceOf(
        InvalidPathError,
      );
      expect(await folderExists(join(outside, "new", "child"))).toBe(false);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test("rejects creating a folder nested under an existing file (ENOTDIR → invalid_path)", async () => {
    const fx = makeVaultFixture();
    writeFileSync(join(fx.root, "notes"), "i am a file");
    let caught: unknown;
    try {
      await createFolder(fx.deps, fx.slug, "notes/sub");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidPathError);
    // The error reports the vault-relative path, never the absolute layout.
    expect((caught as InvalidPathError).path).toBe("notes/sub");
    expect((caught as InvalidPathError).message).not.toContain(fx.root);
    // The file is unchanged.
    expect(await fs.readFile(join(fx.root, "notes"), "utf8")).toBe("i am a file");
  });

  test("non-ENOENT lstat error on the probe propagates", async () => {
    const fx = makeVaultFixture();
    // The first lstat(target) is assertNotSymlinkEscape's leaf probe (ENOENT
    // naturally for a fresh path); the second is createFolder's own probe.
    await withLstatFailingOnSecondCall(join(fx.root, "probe"), async () => {
      await expect(createFolder(fx.deps, fx.slug, "probe")).rejects.toThrow("EACCES");
    });
  });
});

async function folderExists(abs: string): Promise<boolean> {
  try {
    await fs.lstat(abs);
    return true;
  } catch {
    return false;
  }
}

/**
 * Run `fn` with `fs.lstat` stubbed to throw EACCES on the SECOND call for
 * `target` (all other paths and the first call pass through). The service core
 * calls `lstat(target)` once via `assertNotSymlinkEscape` and once for its own
 * probe/pre-check, so this exercises the probe's non-ENOENT error branch.
 * Restores the original `fs.lstat` on every exit path.
 */
async function withLstatFailingOnSecondCall(
  target: string,
  fn: () => Promise<void>,
): Promise<void> {
  const realLstat = fs.lstat;
  let hits = 0;
  const stub = ((p: string, ...rest: unknown[]) => {
    if (p === target) {
      hits++;
      if (hits >= 2) throw new Error("EACCES (stubbed)");
    }
    // biome-ignore lint/suspicious/noExplicitAny: forwarding rest args to the original fs.lstat overloads.
    return realLstat(p as any, ...(rest as []));
  }) as typeof fs.lstat;
  (fs as unknown as { lstat: typeof fs.lstat }).lstat = stub;
  try {
    await fn();
  } finally {
    (fs as unknown as { lstat: typeof fs.lstat }).lstat = realLstat;
  }
}

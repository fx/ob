/**
 * Vault path resolution and traversal-safety check.
 *
 * `safeJoin(root, rel)` is the lexical chokepoint every service-core function
 * uses to convert a vault-relative path into an absolute filesystem path. It
 * delegates to `assertSafeRelativePath` for every traversal-unsafe input
 * (`..`, leading `/`, NUL, > 1024 bytes, hidden segments, drive prefixes)
 * and then resolves the path against the root.
 *
 * Lexical validation alone is NOT sufficient: a symlink placed inside the
 * vault could still make a read or write escape the root (e.g.
 * `notes/out.md` → `/etc/passwd`). The vault is supposed to be a working
 * tree owned by `ob sync`, not a place users curate symlinks, so the
 * service core also calls `assertNotSymlinkEscape(absPath)` at every use
 * site. The check uses `lstat` (does NOT follow the link) and rejects any
 * path whose terminal entry is a symbolic link, plus any non-existent path
 * whose parent chain contains a symlink. This is the conservative choice
 * the spec calls for: refuse symlinks outright rather than try to resolve
 * them and check residency.
 */

import { promises as fs } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { InvalidPathError, assertSafeRelativePath } from "../errors.ts";

// Re-export so callers have a single import path for "path validation lives
// in vault/path".
export { InvalidPathError } from "../errors.ts";

/**
 * Resolve `rel` against `root`, returning the absolute filesystem path.
 * Throws `InvalidPathError` for any traversal-unsafe input.
 *
 * `root` MUST already be normalised; callers compute it once at
 * deps-construction time (e.g. `join(cfg.dataDir, "vaults", slug)`).
 */
export function safeJoin(root: string, rel: string): string {
  // Pre-flight: traversal/hidden/length checks happen on the raw input
  // before we let `path.resolve` collapse anything.
  // `assertSafeRelativePath` throws `InvalidPathError` directly, so we just
  // let it propagate.
  assertSafeRelativePath(rel);
  const abs = resolve(root, rel);
  // A path made only of `.` segments (e.g. `.` or `./.`) survives
  // `assertSafeRelativePath` (single-dot segments are legal mid-path) but
  // resolves to the vault root itself. The root is never a valid operation
  // target — addressing it would let `deleteFolder(root, { recursive })` wipe
  // the whole vault. Reject it here so every service-core op is protected.
  if (abs === resolve(root)) {
    throw new InvalidPathError(rel, "resolves to the vault root");
  }
  return abs;
}

/**
 * Reject any symbolic link encountered along `absPath` or in the directory
 * chain between `root` and `absPath`. The vault is a working tree owned by
 * `ob sync`; callers are not allowed to plant symlinks that escape (or
 * shadow) it.
 *
 * The check is deliberately conservative:
 *   - If `absPath` itself exists and is a symlink, reject.
 *   - If any intermediate directory between `root` and `absPath` is a
 *     symlink, reject.
 *   - If `absPath` doesn't exist (e.g. about to be created), still check the
 *     parent chain so a `PUT` can't be redirected to land outside the root.
 *
 * Throws `InvalidPathError` on any escape attempt; otherwise returns
 * normally. The cost is one `lstat` per directory level — negligible
 * relative to the actual fs operation that follows.
 */
export async function assertNotSymlinkEscape(absPath: string, root: string): Promise<void> {
  const absRoot = resolve(root);
  // Walk from absPath up toward absRoot. For each segment, lstat — if it's a
  // symlink, reject. ENOENT is fine for the leaf (we may be creating it) but
  // not for intermediate directories.
  let current = absPath;
  let seenLeaf = false;
  while (current.length >= absRoot.length && current !== absRoot) {
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.lstat(current);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT" && !seenLeaf) {
        // Leaf may legitimately not exist (about-to-create case).
        seenLeaf = true;
        current = dirname(current);
        continue;
      }
      // ENOENT on an intermediate directory means the path is already
      // unreachable — let the outer fs op surface its own error rather
      // than translate it to InvalidPathError.
      if (err.code === "ENOENT") return;
      throw e;
    }
    if (stat.isSymbolicLink()) {
      throw new InvalidPathError(absPath, "path traverses a symbolic link");
    }
    seenLeaf = true;
    current = dirname(current);
  }
}

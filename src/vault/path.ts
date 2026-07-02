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
import { dirname, relative, resolve, sep } from "node:path";
import { InvalidPathError, assertSafeRelativePath } from "../errors.ts";

// Re-export so callers have a single import path for "path validation lives
// in vault/path".
export { InvalidPathError } from "../errors.ts";

/**
 * Vault-relative path in POSIX (`/`-separated) form. `path.relative` yields
 * OS-native separators (backslashes on Windows); every error envelope speaks
 * `/`, so normalize before surfacing. A no-op on POSIX where `sep` is already
 * `/` — `split`/`join` runs unconditionally, introducing no untestable branch.
 */
function toPosixRelative(absRoot: string, absPath: string): string {
  return relative(absRoot, absPath).split(sep).join("/");
}

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
 *   - If `absPath` (or any ancestor) doesn't exist (e.g. about to be created),
 *     keep walking UP the chain so a symlinked ancestor above a not-yet-created
 *     intermediate is still caught — otherwise a later recursive `mkdir` would
 *     follow the link and land outside the root.
 *
 * Throws `InvalidPathError` on any escape attempt; otherwise returns
 * normally. The cost is one `lstat` per directory level — negligible
 * relative to the actual fs operation that follows.
 */
export async function assertNotSymlinkEscape(absPath: string, root: string): Promise<void> {
  const absRoot = resolve(root);
  // Walk from absPath up toward absRoot. For each level, lstat — if it's a
  // symlink, reject. A non-existent level (ENOENT) is fine on its own (the
  // leaf or an intermediate may be about to be created), but we MUST keep
  // walking up: a symlinked ancestor higher in the chain would otherwise be
  // missed, and the subsequent `mkdir -p` would follow it out of the vault.
  let current = absPath;
  while (current.length >= absRoot.length && current !== absRoot) {
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.lstat(current);
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === "ENOENT") {
        current = dirname(current);
        continue;
      }
      // ENOTDIR means a path component that must be a directory is actually a
      // file (e.g. `notes/sub` where `notes` is a file). That's a caller path
      // conflict, not an internal fault — translate it to a typed 4xx so it
      // doesn't leak as a 500. Report the vault-RELATIVE path (like every other
      // invalid_path error) so the envelope never exposes the absolute layout.
      if (err.code === "ENOTDIR") {
        throw new InvalidPathError(
          toPosixRelative(absRoot, absPath),
          "path traverses a non-directory",
        );
      }
      throw e;
    }
    if (stat.isSymbolicLink()) {
      throw new InvalidPathError(
        toPosixRelative(absRoot, absPath),
        "path traverses a symbolic link",
      );
    }
    current = dirname(current);
  }
}

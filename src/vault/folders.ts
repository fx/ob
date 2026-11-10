/**
 * Service core: the one folder-only operation, `createFolder` (`mkdir -p`).
 *
 * Listing and deleting folders are type-agnostic path operations shared with
 * files and live in `src/vault/paths.ts`. `createFolder` is pure-by-deps like
 * the rest of the core: it takes `(deps, slug, path)`, resolves the path inside
 * the configured vault root via `safeJoin`, calls `assertNotSymlinkEscape`, and
 * performs the on-disk operation. Folders are NOT indexed, so it never touches
 * the indexer.
 */

import { promises as fs } from "node:fs";
import { InvalidPathError } from "../errors.ts";
import { type VaultServiceDeps, resolveVault } from "./files.ts";
import { assertNotSymlinkEscape, safeJoin } from "./path.ts";

export interface CreateFolderResult {
  readonly path: string;
  readonly mtimeMs: number;
  /** `true` on first creation, `false` on an idempotent no-op. */
  readonly created: boolean;
}

/**
 * Canonical folder path: no trailing slash, matching the on-disk reality and
 * the no-trailing-slash form `listPaths` emits. Normalizing here (rather than
 * only in the REST route) keeps every adapter — REST and MCP — in parity: the
 * returned `path` and any error message are canonical regardless of caller.
 */
function canonicalFolderPath(path: string): string {
  return path.replace(/\/+$/, "");
}

export async function createFolder(
  deps: VaultServiceDeps,
  slug: string,
  path: string,
): Promise<CreateFolderResult> {
  const v = resolveVault(deps, slug);
  const rel = canonicalFolderPath(path);
  const abs = safeJoin(v.root, rel);
  await assertNotSymlinkEscape(abs, v.root);
  // Probe first so we can report `created` accurately: mkdir -p can't tell us
  // whether it made the leaf or found it already there.
  let existing: import("node:fs").Stats | null;
  try {
    existing = await fs.lstat(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") existing = null;
    else throw e;
  }
  if (existing !== null) {
    if (!existing.isDirectory()) {
      throw new InvalidPathError(rel, "path already exists as a file, not a directory");
    }
    // Idempotent no-op: leave the folder untouched so mtime is stable.
    return { path: rel, mtimeMs: existing.mtimeMs, created: false };
  }
  await fs.mkdir(abs, { recursive: true });
  const stat = await fs.stat(abs);
  return { path: rel, mtimeMs: stat.mtimeMs, created: true };
}

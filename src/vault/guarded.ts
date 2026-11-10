/**
 * Guarded filesystem helpers shared by the path operations.
 *
 * - `guardedRead` is the content read the REST spec's containment precondition
 *   requires (REST API › Path operations): the parent-chain symlink check
 *   immediately before the read, an `O_NOFOLLOW` open, and an `fstat` on the
 *   opened descriptor confirming a regular file (and, with `maxBytes`, its
 *   size). The read itself is bounded to `maxBytes + 1` bytes; the one extra
 *   sentinel byte only detects a file that grew after the `fstat`, which is
 *   then reported as oversize — the caller never receives more than
 *   `maxBytes` of content.
 * - `dropGuarded` / `dropUnlessIndexable` implement the drop guard (Vault
 *   Indexer › Indexable paths): a removed path's rows are dropped unless an
 *   indexable note exists at the path when the drop runs. Indexability is
 *   asked of the INDEXER (`deps.indexer.isIndexable`), which evaluates it on
 *   the real vault root — never on `vault(slug).root`, which in a scoped MCP
 *   session is the scope root. A drop failure is logged and swallowed: the
 *   removal already happened, and the watcher's `unlink` event reconciles.
 */

import type { Stats } from "node:fs";
import { constants, promises as fs } from "node:fs";
import { join } from "node:path";
import { DocNotFoundError, InvalidPathError } from "../errors.ts";
import type { VaultServiceDeps } from "./files.ts";
import { withPathLock } from "./lock.ts";
import { assertNotSymlinkEscape } from "./path.ts";

/** Thrown by `guardedRead` when the file exceeds `maxBytes` (at `fstat` or while reading). */
export class OversizeReadError extends Error {
  readonly path: string;
  readonly maxBytes: number;
  constructor(path: string, maxBytes: number) {
    super(`file "${path}" exceeds ${maxBytes} bytes`);
    this.name = "OversizeReadError";
    this.path = path;
    this.maxBytes = maxBytes;
  }
}

const NOT_REACHED = "path traverses a symbolic link or non-directory";

export interface GuardedReadOptions {
  /** Refuse files larger than this many bytes (`OversizeReadError`). Omitted: no cap. */
  readonly maxBytes?: number;
  /** Test seam: runs after the parent-chain check, immediately before the open. */
  readonly beforeOpen?: () => Promise<void>;
  /** Test seam: runs after the descriptor's `fstat`, immediately before the read. */
  readonly afterStat?: () => Promise<void>;
}

export interface GuardedReadResult {
  readonly bytes: Uint8Array;
  /** `fstat` of the opened descriptor — the file that was actually read. */
  readonly stat: Stats;
}

/**
 * Read `rel` (relative to `root`) under the containment precondition.
 *
 * Throws `DocNotFoundError` when the path does not exist, `InvalidPathError`
 * when a component is a symlink or not a directory, or the opened entry is
 * not a regular file, and `OversizeReadError` past `maxBytes`. Anything else
 * propagates unchanged.
 */
export async function guardedRead(
  root: string,
  rel: string,
  opts: GuardedReadOptions = {},
): Promise<GuardedReadResult> {
  const abs = join(root, rel);
  await assertNotSymlinkEscape(abs, root);
  await opts.beforeOpen?.();
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new DocNotFoundError(rel);
    // ELOOP: the leaf became a symlink after the chain check. ENOTDIR: a
    // parent became a file. Both are containment failures, not faults.
    throw code === "ELOOP" || code === "ENOTDIR" ? new InvalidPathError(rel, NOT_REACHED) : e;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new InvalidPathError(rel, "not a regular file");
    const max = opts.maxBytes;
    if (max !== undefined && stat.size > max) throw new OversizeReadError(rel, max);
    await opts.afterStat?.();
    const bytes = max === undefined ? await readAll(handle) : await readBounded(handle, rel, max);
    return { bytes, stat };
  } finally {
    await handle.close();
  }
}

async function readAll(handle: fs.FileHandle): Promise<Uint8Array> {
  const buf = await handle.readFile();
  // Copy into a fresh ArrayBuffer-backed view (see `readFile` in files.ts).
  const view = new Uint8Array(buf.byteLength);
  view.set(buf);
  return view;
}

/** Read at most `max + 1` bytes; the sentinel byte means the file grew past `max`. */
async function readBounded(handle: fs.FileHandle, rel: string, max: number): Promise<Uint8Array> {
  const buf = new Uint8Array(max + 1);
  let total = 0;
  while (total < buf.byteLength) {
    const { bytesRead } = await handle.read(buf, total, buf.byteLength - total, total);
    if (bytesRead === 0) break;
    total += bytesRead;
  }
  if (total > max) throw new OversizeReadError(rel, max);
  return buf.slice(0, total);
}

/**
 * The drop guard for a caller that ALREADY holds `path`'s write lock: drop
 * the path's rows unless an indexable note exists there now. Never throws.
 */
export async function dropUnlessIndexable(
  deps: VaultServiceDeps,
  slug: string,
  path: string,
): Promise<void> {
  try {
    if (await deps.indexer.isIndexable(slug, path)) return;
    await deps.indexer.drop(slug, path);
  } catch (e) {
    deps.logger?.warn("indexer.drop failed; chokidar will reconcile", {
      vault: slug,
      path,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** The drop guard, taking `path`'s write lock for the check and the drop. Never throws. */
export async function dropGuarded(
  deps: VaultServiceDeps,
  slug: string,
  path: string,
): Promise<void> {
  await withPathLock(`${slug}:${path}`, () => dropUnlessIndexable(deps, slug, path));
}

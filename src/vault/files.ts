/**
 * Service core: file CRUD operations on a single vault.
 *
 * Every public function is a pure-by-deps wrapper: it takes `(deps, slug, …)`,
 * resolves the path inside the configured vault root via `safeJoin`, performs
 * the on-disk operation, and (for Markdown) calls the indexer hook. The HTTP
 * adapter under `src/http/` and the MCP adapter (0005) call these functions
 * unchanged — every behavioral test for the surface lands in `test/vault/`.
 *
 * Atomic writes use `<target>.tmp.<uuid>` + `fs.promises.rename`. Patch /
 * append / read / delete refuse to touch hidden segments and `..` paths via
 * `safeJoin`. Every use site additionally calls `assertNotSymlinkEscape` so
 * a symlink planted inside the vault tree can't redirect a read or write
 * outside the root. The Markdown-with-frontmatter wrapper lives in the HTTP
 * adapter, not here — these functions deal in raw bytes only.
 *
 * Indexer hooks (`reindex` / `drop`) are best-effort post-disk steps. If
 * reindex fails after a successful disk write, we log a warning and return
 * `indexed: false` — the on-disk change has already happened, the chokidar
 * watcher will reconcile asynchronously, and the spec's "MUST `await
 * indexer.reindex` before responding" clause is about TIMING (wait for the
 * call to settle), not about treating its failure as fatal. Returning 5xx
 * after a successful write would lie about the disk state and prompt
 * retries that duplicate appended content.
 *
 * For DELETE we run `indexer.drop` FIRST — also best-effort, also logged on
 * failure — and only then unlink. The chokidar `unlink` event will trigger
 * a second drop via the pipeline if the first one was lost, so the index is
 * eventually consistent even when the API-side drop call fails.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import {
  DocNotFoundError,
  InvalidBodyError,
  PatchAmbiguousError,
  PatchNoMatchError,
  UnsupportedMediaTypeError,
  VaultNotFoundError,
} from "../errors.ts";
import type { Indexer } from "../indexer/index.ts";
import type { Logger } from "../log.ts";
import { detectContentType, isMarkdownPath, isTextPath } from "./contentType.ts";
import { withPathLock } from "./lock.ts";
import { assertNotSymlinkEscape, safeJoin } from "./path.ts";

/** A configured vault — sufficient identity for the service core. */
export interface VaultDescriptor {
  readonly slug: string;
  readonly name: string;
  /** Absolute on-disk path of the vault root. */
  readonly root: string;
}

/**
 * Dependencies the service core needs. Adapters construct one of these per
 * process and reuse it for every call.
 */
export interface VaultServiceDeps {
  /** Resolve a slug to its descriptor (including absolute root). */
  vault(slug: string): VaultDescriptor | null;
  /** Indexer surface for `reindex`/`drop`. */
  readonly indexer: Pick<Indexer, "reindex" | "drop" | "search">;
  /** Inject `Date.now`-equivalent for deterministic tests. */
  readonly now?: () => number;
  /** Override `crypto.randomUUID` for deterministic tmp-file names in tests. */
  readonly randomUUID?: () => string;
  /**
   * Optional logger for soft-failure paths (indexer reindex/drop errors).
   * Tests inject a capture; production wiring passes the server logger.
   */
  readonly logger?: Logger;
}

interface FileMeta {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string;
}

export interface FileEntry extends FileMeta {}

export interface ListFilesOptions {
  readonly prefix?: string;
  readonly limit?: number;
  readonly cursor?: string;
}

export interface ListFilesResult {
  readonly items: FileEntry[];
  readonly nextCursor: string | null;
}

export interface ReadFileResult {
  readonly path: string;
  readonly contentType: string;
  readonly bytes: Uint8Array;
  readonly mtimeMs: number;
  readonly size: number;
  readonly sha256: string;
}

export type WriteBody =
  | { readonly kind: "raw"; readonly contentType: string; readonly bytes: Uint8Array }
  | {
      readonly kind: "markdown";
      readonly content: string;
      readonly frontmatter?: Record<string, unknown>;
    };

export interface WriteFileResult {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string;
  readonly created: boolean;
  readonly indexed: boolean;
}

export interface AppendFileResult {
  readonly path: string;
  readonly mtimeMs: number;
  readonly size: number;
  readonly sha256: string;
  readonly contentType: string;
  readonly indexed: boolean;
}

export interface PatchEditInput {
  readonly old: string;
  readonly new: string;
  readonly replaceAll?: boolean;
}

export interface PatchFileBody {
  readonly edits: readonly PatchEditInput[];
}

export interface PatchFileResult extends WriteFileResult {
  readonly edits: number;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function sha256(bytes: Uint8Array): string {
  // `createHash().update()` accepts `Uint8Array` directly. Callers hand us
  // either `Uint8Array` or a `Buffer` (which extends `Uint8Array` at
  // runtime); to keep TS happy under @types/bun's narrow `BinaryLike` we
  // require Uint8Array and rely on Buffer being a subclass at runtime.
  return createHash("sha256").update(bytes).digest("hex");
}

function resolveVault(deps: VaultServiceDeps, slug: string): VaultDescriptor {
  const v = deps.vault(slug);
  if (v === null) throw new VaultNotFoundError(slug);
  return v;
}

function decodeCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined || cursor === "") return undefined;
  // We use base64 of the last-seen path so callers can't construct a cursor
  // that bypasses our prefix check. `Buffer.from(_, "base64")` is total —
  // it never throws, garbage just decodes to garbage that won't match any
  // path. The cursor is not a security boundary.
  return Buffer.from(cursor, "base64").toString("utf8");
}

function encodeCursor(path: string): string {
  return Buffer.from(path, "utf8").toString("base64");
}

/**
 * Try-catch wrapper around `indexer.reindex`. Logs a structured warning on
 * failure and returns `false` so the caller can flip `indexed` in the
 * response. Disk state has already been committed by the time we get here;
 * the chokidar watcher will reconcile asynchronously.
 */
async function tryReindex(deps: VaultServiceDeps, slug: string, path: string): Promise<boolean> {
  try {
    await deps.indexer.reindex(slug, path);
    return true;
  } catch (e) {
    deps.logger?.warn("indexer.reindex failed; chokidar will reconcile", {
      vault: slug,
      path,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

/**
 * Best-effort wrapper around `indexer.drop`. Logs a warning on failure but
 * never throws — the eventual chokidar `unlink` event will retry the drop
 * via the pipeline.
 */
async function tryDrop(deps: VaultServiceDeps, slug: string, path: string): Promise<void> {
  try {
    await deps.indexer.drop(slug, path);
  } catch (e) {
    deps.logger?.warn("indexer.drop failed; chokidar will reconcile", {
      vault: slug,
      path,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/**
 * Walk the vault root recursively, yielding vault-relative paths in
 * lexicographic order. Skips the same hidden / `.obsidian/` / `.trash/`
 * segments that `safeJoin` rejects, so callers can never list a path they
 * would later be unable to read. Symlinks are skipped outright (`Dirent`
 * type is examined, not followed) — they would be rejected by
 * `assertNotSymlinkEscape` at use time anyway.
 */
async function* walkVault(root: string, sub = ""): AsyncIterable<string> {
  const dir = sub === "" ? root : join(root, sub);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    // Vault root might not exist on a fresh install — treat as empty.
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
    throw e;
  }
  // Sort once per directory by raw codepoint so the global walk order is
  // stable across platforms AND matches the strict-greater-than `>`
  // comparison the cursor uses below. `localeCompare` would treat `A` and
  // `a` as equivalent depending on locale, which would let the cursor
  // skip or repeat entries when paginating across mixed-case names.
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const ent of entries) {
    if (ent.name.startsWith(".")) continue; // hidden / .obsidian / .trash
    if (ent.isSymbolicLink()) continue; // refuse symlinks (rejected at use time too)
    const rel = sub === "" ? ent.name : `${sub}/${ent.name}`;
    if (ent.isDirectory()) {
      yield* walkVault(root, rel);
    } else if (ent.isFile()) {
      yield rel;
    }
  }
}

export async function listFiles(
  deps: VaultServiceDeps,
  slug: string,
  opts: ListFilesOptions = {},
): Promise<ListFilesResult> {
  const v = resolveVault(deps, slug);
  const limit = Math.min(opts.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const cursor = decodeCursor(opts.cursor);
  const prefix = opts.prefix ?? "";

  const items: FileEntry[] = [];
  let nextCursor: string | null = null;
  let lastPath: string | null = null;

  for await (const rel of walkVault(v.root)) {
    // Strict `>` (not `<=`) so the cursor advances past the boundary entry
    // exactly once. Sort uses the same raw-codepoint ordering — see
    // `walkVault` comment.
    if (cursor !== undefined && !(rel > cursor)) continue;
    if (prefix !== "" && !rel.startsWith(prefix)) continue;
    if (items.length >= limit) {
      nextCursor = lastPath === null ? null : encodeCursor(lastPath);
      return { items, nextCursor };
    }
    const abs = join(v.root, rel);
    // The vault directory is live (chokidar may be racing the listing
    // with `ob sync` writes/deletes). If a file vanishes between readdir
    // and stat/read, skip it instead of failing the whole page.
    let stat: import("node:fs").Stats;
    let bytes: Buffer;
    try {
      stat = await fs.stat(abs);
      bytes = await fs.readFile(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    // `fs.readFile` returns `Buffer` (Node) but we hash via Uint8Array view
    // for tighter typing under @types/bun's BinaryLike.
    const view = new Uint8Array(bytes.byteLength);
    view.set(bytes);
    items.push({
      path: rel,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sha256: sha256(view),
      contentType: detectContentType(rel),
    });
    lastPath = rel;
  }
  return { items, nextCursor };
}

export async function readFile(
  deps: VaultServiceDeps,
  slug: string,
  path: string,
): Promise<ReadFileResult> {
  const v = resolveVault(deps, slug);
  const abs = safeJoin(v.root, path);
  await assertNotSymlinkEscape(abs, v.root);
  let stat: import("node:fs").Stats;
  let bytes: Buffer;
  try {
    stat = await fs.stat(abs);
    bytes = await fs.readFile(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new DocNotFoundError(path);
    throw e;
  }
  // Copy into a fresh ArrayBuffer-backed Uint8Array so callers don't get
  // a view onto a SharedArrayBuffer (which would tighten downstream typing).
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  return {
    path,
    contentType: detectContentType(path),
    bytes: view,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    sha256: sha256(view),
  };
}

/**
 * Serialize a Markdown payload to bytes. Front-matter is YAML between
 * `---` fences — we keep this dependency local to the service core so the
 * adapter never needs to know about the disk-format detail.
 */
function serializeMarkdown(content: string, frontmatter?: Record<string, unknown>): Uint8Array {
  if (frontmatter === undefined || Object.keys(frontmatter).length === 0) {
    return new TextEncoder().encode(content);
  }
  // Lazy require so non-markdown writes don't pay the dependency cost.
  // gray-matter is already a dep (used by chunker).
  const lines: string[] = ["---"];
  for (const [k, raw] of Object.entries(frontmatter)) {
    // Date values coerce to ISO strings (rule established in 0003).
    const v = raw instanceof Date ? raw.toISOString() : raw;
    lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  lines.push("---", "", content);
  return new TextEncoder().encode(lines.join("\n"));
}

async function atomicWrite(
  abs: string,
  bytes: Uint8Array,
  randomUUID: () => string,
): Promise<void> {
  await fs.mkdir(dirname(abs), { recursive: true });
  const tmp = `${abs}.tmp.${randomUUID()}`;
  await fs.writeFile(tmp, bytes);
  await fs.rename(tmp, abs);
}

async function existed(abs: string): Promise<boolean> {
  try {
    await fs.stat(abs);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

export async function writeFile(
  deps: VaultServiceDeps,
  slug: string,
  path: string,
  body: WriteBody,
): Promise<WriteFileResult> {
  const v = resolveVault(deps, slug);
  const abs = safeJoin(v.root, path);
  // Symlink guard: if any segment between the root and the target is a
  // symlink, refuse. The leaf may not exist yet (we're about to create
  // it); `assertNotSymlinkEscape` handles that case.
  await assertNotSymlinkEscape(abs, v.root);
  const isMd = isMarkdownPath(path);
  if (body.kind === "markdown" && !isMd) {
    // Markdown-shaped JSON to a non-Markdown path is a request envelope
    // mismatch — the adapter is the only legitimate caller, but we guard
    // anyway so the MCP tool can't smuggle a JSON body to a `.png`.
    throw new UnsupportedMediaTypeError(
      `markdown body not allowed for non-Markdown path "${path}"`,
      path,
    );
  }
  // Per-path lock: keeps a concurrent PATCH/APPEND on the same path from
  // racing the existed() probe + atomicWrite + reindex sequence.
  return withPathLock(`${slug}:${path}`, async () => {
    const bytes =
      body.kind === "markdown" ? serializeMarkdown(body.content, body.frontmatter) : body.bytes;
    const wasExisting = await existed(abs);
    const randomUUID = deps.randomUUID ?? crypto.randomUUID.bind(crypto);
    await atomicWrite(abs, bytes, randomUUID);
    // Indexer is a soft post-disk step — see file header.
    const indexed = isMd ? await tryReindex(deps, slug, path) : false;
    const stat = await fs.stat(abs);
    return {
      path,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sha256: sha256(bytes),
      contentType: detectContentType(path),
      created: !wasExisting,
      indexed,
    };
  });
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === "") return 0;
  let count = 0;
  let from = 0;
  for (let i = haystack.indexOf(needle, from); i >= 0; i = haystack.indexOf(needle, from)) {
    count++;
    from = i + needle.length;
  }
  return count;
}

function applyEdits(buffer: string, edits: readonly PatchEditInput[]): string {
  let buf = buffer;
  for (let i = 0; i < edits.length; i++) {
    // Index existence is guaranteed by the loop bound, but
    // noUncheckedIndexedAccess narrows to optional anyway.
    const edit = edits[i] as PatchEditInput;
    if (edit.old === edit.new) {
      throw new InvalidBodyError(`patch edit ${i} is a no-op (old === new)`, { editIndex: i });
    }
    const occurrences = countOccurrences(buf, edit.old);
    if (occurrences === 0) throw new PatchNoMatchError(i);
    if (edit.replaceAll === true) {
      // `String.prototype.replaceAll` with a string argument matches every
      // occurrence — exactly the spec's behaviour.
      buf = buf.replaceAll(edit.old, edit.new);
    } else {
      if (occurrences > 1) throw new PatchAmbiguousError(i, occurrences);
      buf = buf.replace(edit.old, edit.new);
    }
  }
  return buf;
}

export async function patchFile(
  deps: VaultServiceDeps,
  slug: string,
  path: string,
  body: PatchFileBody,
): Promise<PatchFileResult> {
  const v = resolveVault(deps, slug);
  const abs = safeJoin(v.root, path);
  await assertNotSymlinkEscape(abs, v.root);
  if (!isTextPath(path)) {
    throw new UnsupportedMediaTypeError(`patch not supported on non-text path "${path}"`, path);
  }
  // Per-path lock: read-modify-write must be atomic versus other PATCH /
  // APPEND / PUT calls on the same path or two concurrent PATCHes will
  // both see the original and the second writer will silently overwrite
  // the first. Lock spans the read → applyEdits → atomicWrite → reindex
  // sequence end-to-end.
  return withPathLock(`${slug}:${path}`, async () => {
    let original: string;
    try {
      original = await fs.readFile(abs, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new DocNotFoundError(path);
      throw e;
    }
    if (original.length === 0) {
      // Patching an empty file is meaningless — `old` cannot match. The
      // spec calls this out explicitly: PATCH is for editing, not creating.
      throw new DocNotFoundError(path);
    }
    const next = applyEdits(original, body.edits);
    const bytes = new TextEncoder().encode(next);
    const randomUUID = deps.randomUUID ?? crypto.randomUUID.bind(crypto);
    await atomicWrite(abs, bytes, randomUUID);
    const indexed = isMarkdownPath(path) ? await tryReindex(deps, slug, path) : false;
    const stat = await fs.stat(abs);
    return {
      path,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sha256: sha256(bytes),
      contentType: detectContentType(path),
      created: false,
      indexed,
      edits: body.edits.length,
    };
  });
}

export async function appendFile(
  deps: VaultServiceDeps,
  slug: string,
  path: string,
  bytes: Uint8Array,
): Promise<AppendFileResult> {
  const v = resolveVault(deps, slug);
  const abs = safeJoin(v.root, path);
  await assertNotSymlinkEscape(abs, v.root);
  if (!isTextPath(path)) {
    throw new UnsupportedMediaTypeError(`append not supported on non-text path "${path}"`, path);
  }
  // Per-path lock: append is read-modify-write — two concurrent appends
  // would otherwise read the same prefix and the second writer would
  // overwrite the first. The end-to-end lock guarantees five concurrent
  // appends produce 5x the appended bytes (no lost writes).
  return withPathLock(`${slug}:${path}`, async () => {
    let original: Buffer;
    try {
      original = await fs.readFile(abs);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") throw new DocNotFoundError(path);
      throw e;
    }
    // Verbatim concat — no newline normalisation. The caller controls the bytes.
    const combined = new Uint8Array(original.byteLength + bytes.byteLength);
    // Copy original byte-by-byte via a fresh Uint8Array view to avoid
    // SharedArrayBuffer-typed source views.
    const origView = new Uint8Array(original.byteLength);
    origView.set(original);
    combined.set(origView, 0);
    combined.set(bytes, original.byteLength);
    const randomUUID = deps.randomUUID ?? crypto.randomUUID.bind(crypto);
    await atomicWrite(abs, combined, randomUUID);
    const indexed = isMarkdownPath(path) ? await tryReindex(deps, slug, path) : false;
    const stat = await fs.stat(abs);
    return {
      path,
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      sha256: sha256(combined),
      contentType: detectContentType(path),
      indexed,
    };
  });
}

export async function deleteFile(
  deps: VaultServiceDeps,
  slug: string,
  path: string,
): Promise<void> {
  const v = resolveVault(deps, slug);
  const abs = safeJoin(v.root, path);
  await assertNotSymlinkEscape(abs, v.root);
  // Lock the path so a concurrent PATCH can't read mid-delete.
  return withPathLock(`${slug}:${path}`, async () => {
    // Probe existence before doing anything else so we get a 404 BEFORE
    // attempting drop+unlink. Otherwise a missing file would still trigger
    // a doomed drop call and a confusing log line.
    if (!(await existed(abs))) throw new DocNotFoundError(path);
    // Drop FIRST (best-effort) so that if the unlink succeeds the index is
    // already in the right state. If drop fails, log and continue — the
    // chokidar `unlink` event will retry the drop via the pipeline.
    if (isMarkdownPath(path)) {
      await tryDrop(deps, slug, path);
    }
    try {
      await fs.unlink(abs);
    } catch (e) {
      // ENOENT here means a concurrent deleter raced us between the
      // existed() probe and unlink; treat as a successful delete.
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return;
      throw e;
    }
  });
}

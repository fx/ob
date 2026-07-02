/**
 * Shared typed error classes.
 *
 * The architecture spec routes every error through a closed-set `code` that
 * the REST and MCP adapters translate to their respective transport
 * envelopes. This module is the canonical home for the closed set: every
 * error class declared here exposes a single `readonly code` field whose
 * value matches the strings in the REST API's error model. Both adapters
 * MUST translate the same class to the same code.
 *
 * The class hierarchy uses a common `OBError` base so adapters and tests can
 * type-check "any of our typed errors" with a single `instanceof` check, and
 * so future codes can land here without changing the adapter mapper.
 */

/**
 * Closed set of error codes shared between REST and MCP adapters. Every typed
 * error class in this module exposes one of these as its `code` field. The
 * REST error mapper (`src/http/errors.ts`) and the MCP adapter (0005) drive
 * their response envelopes off this same set — adding a code here is the
 * one-place edit that keeps both adapters honest.
 */
export type ErrorCode =
  | "vault_not_found"
  | "not_found"
  | "invalid_input"
  | "invalid_path"
  | "invalid_body"
  | "invalid_query"
  | "unsupported_media_type"
  | "patch_no_match"
  | "patch_ambiguous"
  | "embedder_failed"
  | "extraction_failed"
  | "internal";

/**
 * Runtime enumeration of every code. Adapters and tests use this to assert
 * uniqueness and the full closed-set membership.
 */
export const ERROR_CODES: readonly ErrorCode[] = Object.freeze([
  "vault_not_found",
  "not_found",
  "invalid_input",
  "invalid_path",
  "invalid_body",
  "invalid_query",
  "unsupported_media_type",
  "patch_no_match",
  "patch_ambiguous",
  "embedder_failed",
  "extraction_failed",
  "internal",
] as const);

/**
 * Base class for every typed error in the service core. Adapters translate
 * `OBError` subclasses to transport-specific envelopes; non-`OBError` throws
 * fall through to the `internal` 500 path.
 *
 * Concrete (not abstract) so subclasses without an explicit constructor still
 * get a callable default ctor that flows through the base — Bun's coverage
 * tooling otherwise reports the implicit ctor as an uncovered function.
 */
export class OBError extends Error {
  readonly code: ErrorCode = "internal";
  /**
   * Optional structured details surfaced under `error.details` in the
   * response envelope. Subclasses populate this when the spec mandates a
   * specific shape (e.g. `patchAmbiguous` carries `editIndex` + `occurrences`).
   */
  readonly details?: Record<string, unknown>;
  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = new.target.name;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Thrown when a caller-supplied path either contains a path-traversal
 * sequence (`..`), a leading `/`, a NUL byte, a hidden segment (e.g.
 * `.obsidian`), exceeds the per-spec ceiling, or otherwise resolves outside
 * the vault root once joined.
 */
export class InvalidPathError extends OBError {
  override readonly code = "invalid_path" as const;
  readonly path: string;
  readonly reason: string;
  constructor(path: string, reason: string) {
    super(`invalid path "${path}": ${reason}`, { path, reason });
    this.path = path;
    this.reason = reason;
  }
}

/** Vault slug not configured. Maps to HTTP 404 / `vault_not_found`. */
export class VaultNotFoundError extends OBError {
  override readonly code = "vault_not_found" as const;
  readonly slug: string;
  constructor(slug: string) {
    super(`vault "${slug}" not found`, { slug });
    this.slug = slug;
  }
}

/** Document missing on disk. Maps to HTTP 404 / `not_found`. */
export class DocNotFoundError extends OBError {
  override readonly code = "not_found" as const;
  readonly path: string;
  constructor(path: string) {
    super(`file "${path}" not found`, { path });
    this.path = path;
  }
}

/**
 * Schema-validation failure. Canonical for Zod issues; shared with MCP.
 *
 * Subclasses re-declare an explicit constructor that just defers to `super`.
 * Bun's coverage tooling counts implicit (synthesised) constructors as
 * uncovered functions, so we declare them by hand even though Biome's
 * `noUselessConstructor` rule flags the pattern.
 */
export class InvalidInputError extends OBError {
  override readonly code = "invalid_input" as const;
  // biome-ignore lint/complexity/noUselessConstructor: explicit ctor needed for Bun coverage tracking.
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/** Unparseable request envelope (HTTP-specific). */
export class InvalidBodyError extends OBError {
  override readonly code = "invalid_body" as const;
  // biome-ignore lint/complexity/noUselessConstructor: explicit ctor needed for Bun coverage tracking.
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/** Unknown or malformed query string (HTTP-specific). */
export class InvalidQueryError extends OBError {
  override readonly code = "invalid_query" as const;
  // biome-ignore lint/complexity/noUselessConstructor: explicit ctor needed for Bun coverage tracking.
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/**
 * Patch / append refused on a non-text path, or JSON variant requested on a
 * non-Markdown read. Maps to HTTP 415 / `unsupported_media_type`.
 */
export class UnsupportedMediaTypeError extends OBError {
  override readonly code = "unsupported_media_type" as const;
  readonly path: string | undefined;
  constructor(message: string, path?: string) {
    super(message, path !== undefined ? { path } : undefined);
    this.path = path;
  }
}

/**
 * A patch edit's `old` did not appear in the file (zero occurrences). Carries
 * the index of the failing edit so callers can pinpoint the offending element
 * of `edits[]`. Maps to HTTP 409 / `patch_no_match`.
 */
export class PatchNoMatchError extends OBError {
  override readonly code = "patch_no_match" as const;
  readonly editIndex: number;
  constructor(editIndex: number) {
    super(`patch edit ${editIndex} found no occurrences of "old"`, { editIndex });
    this.editIndex = editIndex;
  }
}

/**
 * A non-`replaceAll` patch edit matched more than once. Carries the index of
 * the failing edit and the actual occurrence count so callers can either
 * disambiguate `old` or set `replaceAll: true`. Maps to HTTP 409 /
 * `patch_ambiguous`.
 */
export class PatchAmbiguousError extends OBError {
  override readonly code = "patch_ambiguous" as const;
  readonly editIndex: number;
  readonly occurrences: number;
  constructor(editIndex: number, occurrences: number) {
    super(`patch edit ${editIndex} matched ${occurrences} occurrences (need exactly 1)`, {
      editIndex,
      occurrences,
    });
    this.editIndex = editIndex;
    this.occurrences = occurrences;
  }
}

/**
 * Maximum length of a vault-relative path, in bytes. Picked to leave plenty
 * of headroom for the longest plausible Obsidian note path while still
 * rejecting pathological inputs that could OOM downstream consumers.
 */
export const MAX_PATH_BYTES = 1024;

/**
 * Validate a vault-relative path against the project's traversal-safety
 * rules. Returns the input unchanged on success; throws `InvalidPathError`
 * on any violation.
 *
 * Rules (must match the indexer's watcher/scanner ignore predicate):
 * - non-empty, ≤ `MAX_PATH_BYTES` UTF-8 bytes
 * - no NUL byte
 * - no leading `/` (paths are always vault-relative)
 * - no `..` segment (in any normalised form, including encoded variants)
 * - no segment starting with `.` (filters out `.obsidian/`, `.trash/`,
 *   `.git/`, `.DS_Store`, etc.)
 * - no Windows-style drive prefix (`C:\\...`) or UNC root (`//host/share`)
 *
 * The function is intentionally conservative: anything ambiguous fails.
 * Adapters wrap typed errors into the response envelope; the indexer's
 * `reindex`/`drop` callers see the error class directly.
 */
export function assertSafeRelativePath(path: string): string {
  if (typeof path !== "string" || path.length === 0) {
    throw new InvalidPathError(String(path), "must be a non-empty string");
  }
  // Byte-length check uses TextEncoder so multibyte chars count correctly.
  // A short ASCII guard avoids the encoder for the common case.
  const byteLen = path.length > MAX_PATH_BYTES ? path.length : Buffer.byteLength(path, "utf8");
  if (byteLen > MAX_PATH_BYTES) {
    throw new InvalidPathError(path, `exceeds ${MAX_PATH_BYTES} bytes`);
  }
  if (path.includes("\0")) {
    throw new InvalidPathError(path, "contains NUL byte");
  }
  // Leading `/` or `\` means absolute — reject before any normalisation
  // would ambiguously resolve it.
  if (path.startsWith("/") || path.startsWith("\\")) {
    throw new InvalidPathError(path, "must not start with a path separator");
  }
  // Reject Windows drive letters and UNC roots up-front.
  if (/^[A-Za-z]:[\\/]/.test(path)) {
    throw new InvalidPathError(path, "must not contain a drive prefix");
  }
  // Split on either separator so we catch `notes\..\..\etc` on any host.
  const segments = path.split(/[/\\]/);
  for (const seg of segments) {
    if (seg === "..") {
      throw new InvalidPathError(path, "contains parent-directory segment");
    }
    if (seg.startsWith(".") && seg !== ".") {
      // `.` (current dir) is fine; anything else starting with `.` is a
      // hidden segment and matches the indexer's ignore predicate.
      throw new InvalidPathError(path, `hidden segment "${seg}" not allowed`);
    }
  }
  return path;
}

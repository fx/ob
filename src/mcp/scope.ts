/**
 * MCP session scoping — resolve a `/mcp/:slug/:prefix{.+}` URL into a
 * validated `McpScope`, and wrap the adapter's service dependencies so a
 * scoped session sees the prefix as if it were the vault root.
 *
 * Two halves live here:
 *
 * 1. **Resolution.** `parseScope` turns the RAW (still percent-encoded) path
 *    segments after `/mcp` into either a scope or a typed rejection. It is
 *    deliberately the only place that decodes: exactly one
 *    `decodeURIComponent` per segment, then normalization, then validation
 *    through the same `assertSafeRelativePath` the file surface uses.
 *    Decoding twice would turn a literal `%252e%252e` into `..` *after*
 *    validation had already passed; validating before decoding would let
 *    `%2e%2e%2f` through. `scopeKey` derives the canonical identity from the
 *    RESOLVED scope, so URL aliases (`agents/a`, `agents/a/`, `agents/./a`)
 *    collapse to one key.
 *
 * 2. **Confinement.** `scopeDeps` / `scopeStatusDeps` wrap the deps objects
 *    the tool registry is built from. Because every service-core function in
 *    `src/vault/` resolves through `vault(slug).root` and then `safeJoin` +
 *    `assertNotSymlinkEscape`, substituting the vault descriptor's `root`
 *    with the scope root confines all of them and makes every emitted path
 *    scope-relative — with no change to `src/vault/`. The indexer is the one
 *    dependency that needs explicit translation, because it is per-vault and
 *    stores vault-relative paths.
 *
 * The one containment gap the per-operation guards do not cover is the scope
 * root ITSELF: `safeJoin` / `assertNotSymlinkEscape` only walk up to the root
 * they are handed, which for a scoped session IS the scope root, so nothing
 * ever inspects the span between the scope root and the vault root.
 * `assertScopeRootSafe` walks exactly that span, and `guardToolDefinition` /
 * `guardResourceHandler` run it before every operation so a scope directory
 * swapped for a symlink mid-session is caught on the next call rather than
 * never.
 *
 * NOTE: scoping is NOT an authentication or authorization boundary. The
 * server has no auth; anything that can reach a scoped mount can also reach
 * the unscoped `/mcp` and address the whole vault. This confines a
 * cooperating client that was configured with a scoped URL.
 */

import { join } from "node:path";
import { InvalidPathError, assertSafeRelativePath } from "../errors.ts";
import type { Indexer, SearchHit, SearchOptions } from "../indexer/index.ts";
import { assertNotSymlinkEscape } from "../vault/path.ts";
import type { StatusDeps } from "../vault/status.ts";
import { mapErrorToMcpResult } from "./errors.ts";
// Type-only import: `index.ts` imports nothing from this module at runtime
// today, and keeping this edge type-only guarantees it never becomes a cycle
// once the routing PR wires the two together.
import type { McpRoutesDeps } from "./index.ts";
import { URI_SCHEME, notFound } from "./resources.ts";
import type { ResourceHandler } from "./resources.ts";
import type { McpToolResult, ToolDefinition } from "./tool.ts";

/** A resolved session scope: one vault, one folder prefix inside it. */
export interface McpScope {
  readonly slug: string;
  /** Vault-relative folder prefix, no leading or trailing "/". "" means the vault root. */
  readonly prefix: string;
}

/**
 * Why a scope could not be resolved. `invalid_prefix` is the client's fault
 * (traversal, encoded separator, malformed escape, hidden segment, …);
 * `unknown_vault` means the prefix was fine but the slug is not configured.
 * The routing layer maps them to `400` and `404` respectively.
 */
export type ScopeRejection =
  | { readonly kind: "invalid_prefix" }
  | { readonly kind: "unknown_vault"; readonly slug: string };

export type ScopeParseResult =
  | { readonly ok: true; readonly scope: McpScope }
  | { readonly ok: false; readonly rejection: ScopeRejection };

/** Shared singleton — the rejection carries no payload, so it never varies. */
const INVALID_PREFIX: ScopeParseResult = Object.freeze({
  ok: false,
  rejection: Object.freeze({ kind: "invalid_prefix" }),
} as const);

/**
 * Resolve the raw path segments after `/mcp` into a scope.
 *
 * @param rawSegments RAW, still-percent-encoded path segments. `rawSegments[0]`
 *   is the vault slug; the remainder form the folder prefix.
 * @param hasVault Predicate: is this decoded slug a configured vault?
 *
 * Order is load-bearing and matches the change document:
 * decode once → reject decoded separators → normalize → validate → look up
 * the slug. See the module header for why each step cannot move.
 */
export function parseScope(
  rawSegments: readonly string[],
  hasVault: (slug: string) => boolean,
): ScopeParseResult {
  const decoded: string[] = [];
  for (const raw of rawSegments) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      // A malformed escape (`%ZZ`, a truncated `%2`) throws `URIError`. Left
      // uncaught it would surface as a 500 for a purely client-side mistake.
      return INVALID_PREFIX;
    }
    // A percent-encoded separator is never legitimate inside one segment.
    // Rejecting it (rather than letting the empty-segment normalization below
    // quietly rewrite `%2Fetc` into the relative prefix `etc`) keeps the
    // meaning of the URL and the meaning of the scope identical.
    if (seg.includes("/") || seg.includes("\\")) return INVALID_PREFIX;
    decoded.push(seg);
  }
  const slug = decoded[0];
  // No segments at all is the unscoped mount, which never reaches here; treat
  // it as a malformed scope rather than inventing an empty slug.
  if (slug === undefined) return INVALID_PREFIX;
  // Normalization. No decoded segment can contain `/` (rejected above), so
  // dropping empty and single-dot segments is exactly the change document's
  // "join with `/`, strip any trailing `/`, drop empty and `.` segments" —
  // `//agents/a`, `agents/a/`, and `agents/./a` all collapse to `agents/a`.
  const prefix = decoded
    .slice(1)
    .filter((seg) => seg !== "" && seg !== ".")
    .join("/");
  if (prefix !== "") {
    try {
      // The same closed set the file surface rejects: `..`, absolute paths,
      // NUL, hidden segments, drive prefixes, over-length.
      assertSafeRelativePath(prefix);
    } catch {
      return INVALID_PREFIX;
    }
  }
  // An empty prefix is the VAULT-ROOT scope — accepted, and deliberately not
  // passed to `assertSafeRelativePath`, which rejects the empty string.
  if (!hasVault(slug)) return { ok: false, rejection: { kind: "unknown_vault", slug } };
  return { ok: true, scope: { slug, prefix } };
}

/**
 * Canonical scope identity, derived from the RESOLVED scope so URL aliases
 * of one scope produce one key. NUL is the field separator because it cannot
 * occur in either field (`assertSafeRelativePath` rejects it in the prefix,
 * and a slug containing it would not be a configured vault).
 */
export function scopeKey(scope: McpScope): string {
  return `${scope.slug}\0${scope.prefix}`;
}

/** The scope's root on disk. `join` collapses the vault-root scope to `vaultRoot`. */
export function scopeRootPath(vaultRoot: string, scope: McpScope): string {
  return join(vaultRoot, scope.prefix);
}

/**
 * Reject a scope root that is (or sits under) a symbolic link.
 *
 * `assertNotSymlinkEscape` walks up past `ENOENT` levels, so a scope root
 * that does not exist yet is NOT a rejection — an empty scope lists as empty
 * and the first `write_file` / `create_folder` creates it.
 *
 * The thrown error is re-wrapped: `assertNotSymlinkEscape` reports the path
 * RELATIVE TO `vaultRoot`, which is precisely the scope prefix the session is
 * never supposed to learn. `"."` is the scope root as the client sees it.
 */
export async function assertScopeRootSafe(scopeRoot: string, vaultRoot: string): Promise<void> {
  try {
    await assertNotSymlinkEscape(scopeRoot, vaultRoot);
  } catch {
    throw new InvalidPathError(".", "scope root is not a directory inside the vault");
  }
}

/**
 * Run `check()` before delegating to `tool.call`. A rejection becomes the
 * ordinary typed-error envelope (`invalid_path`) — no new error code, and no
 * scope prefix in the payload (see `assertScopeRootSafe`).
 */
export function guardToolDefinition(
  tool: ToolDefinition,
  check: () => Promise<void>,
): ToolDefinition {
  return {
    ...tool,
    call: async (raw: unknown): Promise<McpToolResult> => {
      try {
        await check();
      } catch (e) {
        return mapErrorToMcpResult(e);
      }
      return tool.call(raw);
    },
  };
}

/**
 * Run `check()` before delegating to BOTH `list` and `read`. `list` needs the
 * guard as much as `read` does: `listFiles` walks the root itself, so an
 * unguarded `resources/list` would enumerate a swapped-in symlink target.
 *
 * A rejection surfaces as the module's canonical `not_found` `McpError` —
 * the same shape any other unaddressable resource produces, carrying neither
 * the absolute vault path nor the scope prefix.
 */
export function guardResourceHandler(
  handler: ResourceHandler,
  check: () => Promise<void>,
): ResourceHandler {
  const guard = async (uri: string): Promise<void> => {
    try {
      await check();
    } catch {
      throw notFound(uri);
    }
  };
  return {
    async list(cursor: string | undefined) {
      // No single URI is being addressed by a listing; the scheme is the
      // most specific honest identifier that leaks nothing.
      await guard(URI_SCHEME);
      return handler.list(cursor);
    },
    async read(uri: string) {
      await guard(uri);
      return handler.read(uri);
    },
  };
}

/**
 * Build the search options the underlying indexer actually receives.
 *
 * `store.ts` filters with `starts_with(path, …)`, so the bare prefix
 * `agents/a` would also match `agents/ab/note.md` — the forced filter carries
 * a TRAILING SLASH. A caller-supplied `pathPrefix` is validated and nested
 * UNDER the scope prefix (never replaces it), and is joined without an extra
 * trailing slash so `journal` under scope `agents/a` reaches the indexer as
 * `agents/a/journal`.
 *
 * In the vault-root scope there is no forced filter at all: indexed paths are
 * vault-relative and never start with `/`, so a literal `"/"` would match
 * nothing and silently empty every search.
 */
function withScopedFilter(opts: SearchOptions | undefined, scope: McpScope): SearchOptions {
  const base = opts ?? {};
  const caller = base.filter?.pathPrefix;
  // A throw here is the caller's `invalid_path` and MUST surface — the tool
  // wrapper maps it exactly as it maps any other bad path argument.
  if (caller !== undefined) assertSafeRelativePath(caller);
  if (scope.prefix === "") return base;
  const pathPrefix = caller === undefined ? `${scope.prefix}/` : `${scope.prefix}/${caller}`;
  return { ...base, filter: { ...base.filter, pathPrefix } };
}

/**
 * Wrap the path-addressing dependencies so every operation is confined to
 * (and expressed relative to) `scope`.
 */
export function scopeDeps(deps: McpRoutesDeps, scope: McpScope): McpRoutesDeps {
  const inner = deps.vault(scope.slug);
  // `vault()` is nullable. `parseScope` already rejected unknown slugs with a
  // 404, so reaching here with null is a wiring bug, not client input.
  if (inner === null) throw new Error(`scope references unknown vault "${scope.slug}"`);
  const root = scopeRootPath(inner.root, scope);
  const under = (p: string): string => (scope.prefix === "" ? p : `${scope.prefix}/${p}`);
  const strip = (p: string): string | null => {
    if (scope.prefix === "") return p;
    return p.startsWith(`${scope.prefix}/`) ? p.slice(scope.prefix.length + 1) : null;
  };

  const indexer: Indexer = {
    // `McpRoutesDeps.indexer` is the full `Indexer`, so `status`, `list`, and
    // `stop` MUST be delegated — the status tools and the readiness probe
    // depend on them. They pass through unchanged here; narrowing the
    // reported vault set to the scope is `scopeStatusDeps`' job, so there is
    // exactly one place that does it.
    status: (s) => deps.indexer.status(s),
    list: () => deps.indexer.list(),
    stop: () => deps.indexer.stop(),
    reindex: (s, p) => deps.indexer.reindex(s, under(p)),
    drop: (s, p) => deps.indexer.drop(s, under(p)),
    search: async (s, q, opts): Promise<SearchHit[]> => {
      const hits = await deps.indexer.search(s, q, withScopedFilter(opts, scope));
      // flatMap, not map+filter: `strip` returns `string | null`, and
      // filtering afterwards would not narrow the type back to `SearchHit[]`.
      // Dropping (rather than returning unprefixed) is defensive — a stale
      // index entry is otherwise indistinguishable from an in-scope hit once
      // stripped. `text` / `frontmatter` / `tags` / `links` are note content,
      // not server-computed paths, and pass through verbatim.
      return hits.flatMap((h) => {
        const path = strip(h.path);
        return path === null ? [] : [{ ...h, path }];
      });
    },
  };

  return {
    ...deps,
    vault: (s) => (s === scope.slug ? { ...inner, root } : null),
    indexer,
  };
}

/**
 * Wrap the status dependencies so `list_vaults` reports only the scoped vault
 * and `vault_status` on any other slug surfaces `vault_not_found`.
 *
 * The `documents` / `chunks` / `pending` / `errors` counts stay VAULT-WIDE —
 * they come from the indexer's per-vault runtime and there is no per-prefix
 * accounting.
 */
export function scopeStatusDeps(deps: StatusDeps, scope: McpScope): StatusDeps {
  return {
    supervisor: {
      list: () => deps.supervisor.list().filter((s) => s.slug === scope.slug),
      get: (s) => (s === scope.slug ? deps.supervisor.get(s) : null),
      stop: () => deps.supervisor.stop(),
    },
    indexer: {
      list: () => deps.indexer.list().filter((i) => i.slug === scope.slug),
      status: (s) => (s === scope.slug ? deps.indexer.status(s) : null),
    },
  };
}

/**
 * Scoped tool-surface helpers for the MCP adapter.
 *
 * A scoped session (see `docs/changes/0014-mcp-folder-scoping.md`) is bound to
 * one vault and one folder prefix by its connection URL, so the `vault`
 * argument every path-addressing tool takes is already determined before the
 * agent says anything. These helpers are the presentation half of that:
 *
 * - `scopeToolDefinition` returns a scoped VIEW of an existing
 *   `ToolDefinition`: `vault` drops out of the advertised `required` array and
 *   is injected with the scope slug when the caller omits it. It is a shallow
 *   transform of the plain JSON Schema object `zodToJsonSchema` already
 *   produced in `tool.ts` — the Zod schemas themselves are never forked, so
 *   the wire schema and the runtime validator cannot drift apart. The
 *   transform is pure: neither the source `ToolDefinition` nor its
 *   `inputSchema` is mutated, because the unscoped registry shares those
 *   objects.
 * - `SCOPED_INSTRUCTIONS` is the SDK `instructions` string a scoped
 *   per-session `Server` is constructed with. Announcing the scope once at
 *   `initialize` is what keeps tool descriptions process-wide: forking N
 *   descriptions per live scope to say one thing once is the alternative the
 *   change document rejects.
 * - `VAULT_WIDE_COUNTS_NOTE` is the one description suffix that is NOT
 *   informational duplication — `vault_status` reports indexer counters that
 *   really are vault-wide, and an agent reading them as "my memory has N
 *   documents" would be wrong.
 *
 * Nothing here is an authentication or authorization boundary. The server has
 * no auth; the same files remain reachable through the unscoped `/mcp` mount.
 * The instruction text says so rather than claiming privacy.
 *
 * This module is intentionally standalone — the routing/session wiring that
 * consumes it lands separately.
 */

import type { McpToolResult, ToolDefinition } from "./tool.ts";

/**
 * SDK `instructions` for a scoped per-session `Server`, delivered once at
 * `initialize`. States the three facts a scoped agent needs — paths are
 * relative to a root it is never told the name of, `vault` is optional, and
 * nothing outside the root is reachable *through this session* — and
 * explicitly declines to describe the arrangement as isolation.
 */
export const SCOPED_INSTRUCTIONS: string =
  "This session is scoped to one folder of one vault. Every path you send and every path you " +
  "receive is relative to that folder, which is presented to you as the root of the vault; its " +
  "location within the vault is not disclosed and you do not need it. The `vault` argument is " +
  "optional in this session and defaults to this session's vault, so you can omit it. Nothing " +
  "outside the scoped root is reachable through this session. This is a confinement of what " +
  "this session can address, not a security boundary: the server has no authentication, and the " +
  "same files stay reachable to other clients through the unscoped mount, so do not treat the " +
  "folder as isolated from anyone else.";

/**
 * Sentence appended to the scoped `vault_status` description. The indexer's
 * counters come from a per-vault runtime and there is no per-prefix
 * accounting, so a scoped session's numbers describe the whole vault.
 */
export const VAULT_WIDE_COUNTS_NOTE: string =
  "In this scoped session the `documents`, `chunks`, `pending`, and `errors` counts are " +
  "vault-wide: they cover every file in the vault, not only the folder this session is scoped " +
  "to, so they are not a count of your own notes.";

/** Narrow `unknown` to an indexable object — excludes `null` and arrays. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Return a scoped view of `tool`.
 *
 * Tools whose input schema has no `vault` property (`list_vaults`) are handed
 * back with their `inputSchema` and `call` untouched: injecting a `vault`
 * argument into a schema that has no such key would only produce an
 * unknown-key rejection from the tool's own strict Zod validator.
 *
 * For tools that do take a vault:
 * - the advertised schema loses `"vault"` from `required` (dropping the key
 *   entirely rather than advertising an empty array), and
 * - a call whose arguments object omits `vault` is delegated with
 *   `vault: slug` filled in. Anything else — a matching `vault`, a different
 *   `vault`, or a non-object payload — is delegated verbatim, so a mismatched
 *   slug still surfaces the service core's `vault_not_found` and a malformed
 *   payload still surfaces the existing Zod validation error.
 */
export function scopeToolDefinition(
  tool: ToolDefinition,
  slug: string,
  descriptionSuffix?: string,
): ToolDefinition {
  const description =
    descriptionSuffix === undefined || descriptionSuffix === ""
      ? tool.description
      : `${tool.description} ${descriptionSuffix}`;

  const properties = tool.inputSchema.properties;
  if (!isPlainObject(properties) || !Object.hasOwn(properties, "vault")) {
    return { ...tool, description };
  }

  // Destructuring builds a fresh object, so the shared unscoped `inputSchema`
  // is read but never written.
  const { required: sourceRequired, ...rest } = tool.inputSchema;
  const required = Array.isArray(sourceRequired)
    ? sourceRequired.filter((key: unknown) => key !== "vault")
    : [];
  const inputSchema: Record<string, unknown> = required.length > 0 ? { ...rest, required } : rest;

  return {
    ...tool,
    description,
    inputSchema,
    call: (raw: unknown): Promise<McpToolResult> =>
      isPlainObject(raw) && !Object.hasOwn(raw, "vault")
        ? tool.call({ ...raw, vault: slug })
        : tool.call(raw),
  };
}

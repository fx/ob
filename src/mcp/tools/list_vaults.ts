/**
 * MCP tool: `list_vaults`. Mirrors `GET /v1/vaults` byte-for-byte: returns
 * the bare `VaultSummary[]` array, not a wrapped envelope. Wrapping in
 * `{ vaults: [...] }` would force every parity test (and every agent
 * client) to special-case MCP — the architecture spec says the two
 * adapters MUST produce structurally identical successful payloads modulo
 * the transport envelope. The text-content JSON IS the transport envelope
 * here, so what's inside it should match REST exactly.
 */

import { z } from "zod";
import { type StatusDeps, listVaults } from "../../vault/status.ts";
import { type ToolDefinition, tool } from "../tool.ts";

const Input = z.object({}).strict();

export function listVaultsTool(deps: StatusDeps): ToolDefinition {
  return tool(
    "list_vaults",
    "List every configured vault and its current sync + indexer status. Mirrors REST GET /v1/vaults — returns the bare VaultSummary array.",
    Input,
    async () => listVaults(deps),
  );
}

/**
 * MCP tool: `vault_status`. Mirrors `GET /v1/vaults/:slug`.
 */

import { z } from "zod";
import { VaultNotFoundError } from "../../errors.ts";
import { type StatusDeps, vaultStatus } from "../../vault/status.ts";
import { type ToolDefinition, tool } from "../tool.ts";

const Input = z.object({ vault: z.string().min(1) }).strict();

export function vaultStatusTool(deps: StatusDeps): ToolDefinition {
  return tool(
    "vault_status",
    "Return one configured vault's sync + indexer status. Mirrors REST GET /v1/vaults/:slug.",
    Input,
    async (args) => {
      const status = vaultStatus(deps, args.vault);
      // The service core returns null on unknown slugs; the typed error
      // translates to the same `vault_not_found` code REST uses.
      if (status === null) throw new VaultNotFoundError(args.vault);
      return status;
    },
  );
}

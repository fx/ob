/**
 * MCP tool: `append_file`. Mirrors `POST /v1/vaults/:slug/files/*path:append`.
 */

import { z } from "zod";
import { type VaultServiceDeps, appendFile } from "../../vault/files.ts";
import { type ToolDefinition, tool } from "../tool.ts";

const Input = z
  .object({
    vault: z.string().min(1),
    path: z.string().min(1),
    content: z.string(),
  })
  .strict();

export function appendFileTool(deps: VaultServiceDeps): ToolDefinition {
  return tool(
    "append_file",
    "Append `content` to an existing text file. Use this for daily-note / log / capture flows where no existing context is needed. Mirrors REST POST /v1/vaults/:slug/files/*path:append.",
    Input,
    async (args) => {
      const bytes = new TextEncoder().encode(args.content);
      return appendFile(deps, args.vault, args.path, bytes);
    },
  );
}

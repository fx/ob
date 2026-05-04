/**
 * MCP tool: `patch_file`. Mirrors `PATCH /v1/vaults/:slug/files/*path`.
 *
 * Description per spec: tells the agent when to prefer `patch_file` over
 * `write_file` (small targeted edits). Atomicity, ambiguous-edit
 * `patch_ambiguous`, and binary rejection (`unsupported_media_type`) all
 * come from the service core.
 */

import { z } from "zod";
import { type VaultServiceDeps, patchFile } from "../../vault/files.ts";
import { type ToolDefinition, tool } from "../tool.ts";

const Input = z
  .object({
    vault: z.string().min(1),
    path: z.string().min(1),
    edits: z
      .array(
        z
          .object({
            old: z.string().min(1),
            new: z.string(),
            replaceAll: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export function patchFileTool(deps: VaultServiceDeps): ToolDefinition {
  return tool(
    "patch_file",
    "Apply find/replace edits to an existing text file. Use `patch_file` whenever you would otherwise re-send the entire file with small changes. Each `old` must appear exactly once in the file, or pass `replaceAll: true`. Edits apply in order and the patch is atomic — any failed edit aborts the whole call. Mirrors REST PATCH /v1/vaults/:slug/files/*path.",
    Input,
    async (args) => patchFile(deps, args.vault, args.path, { edits: args.edits }),
  );
}

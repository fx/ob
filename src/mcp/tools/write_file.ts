/**
 * MCP tool: `write_file`. Mirrors `PUT /v1/vaults/:slug/files/*path`.
 *
 * Spec: `encoding` defaults to `"utf-8"`; pass `"base64"` to write a binary.
 * `frontmatter` is only valid when `path` is Markdown — the service core
 * enforces this via `UnsupportedMediaTypeError`, no adapter logic needed.
 */

import { z } from "zod";
import { isMarkdownPath } from "../../vault/contentType.ts";
import { type VaultServiceDeps, type WriteBody, writeFile } from "../../vault/files.ts";
import { type ToolDefinition, tool } from "../tool.ts";

const Input = z
  .object({
    vault: z.string().min(1),
    path: z.string().min(1),
    content: z.string(),
    encoding: z.enum(["utf-8", "base64"]).optional(),
    contentType: z.string().optional(),
    frontmatter: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export function writeFileTool(deps: VaultServiceDeps): ToolDefinition {
  return tool(
    "write_file",
    "Create or replace a file. `encoding` defaults to `utf-8`; pass `base64` for binaries. `frontmatter` is only valid when path is Markdown. Mirrors REST PUT /v1/vaults/:slug/files/*path.",
    Input,
    async (args) => {
      const enc = args.encoding ?? "utf-8";
      // Markdown writes go through the structured `markdown` body so the
      // service core can serialise the front-matter; everything else is a
      // raw byte write. Choosing the `markdown` shape on a non-Markdown
      // path would be rejected by the service core with
      // `unsupported_media_type` — same behavior REST gets.
      const body: WriteBody = isMarkdownPath(args.path)
        ? {
            kind: "markdown",
            content:
              enc === "base64"
                ? Buffer.from(args.content, "base64").toString("utf8")
                : args.content,
            ...(args.frontmatter !== undefined ? { frontmatter: args.frontmatter } : {}),
          }
        : {
            kind: "raw",
            contentType: args.contentType ?? "application/octet-stream",
            bytes:
              enc === "base64"
                ? new Uint8Array(Buffer.from(args.content, "base64"))
                : new TextEncoder().encode(args.content),
          };
      return writeFile(deps, args.vault, args.path, body);
    },
  );
}

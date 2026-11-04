# 0018: MCP Read-Only Tool Annotations

## Summary

Advertise `annotations: { readOnlyHint: true }` in `tools/list` for the six tools that only read: `list_vaults`, `vault_status`, `list_files`, `read_file`, `list_folders`, and `search`. Implements the new tool-annotations rule in [MCP Server › Tool surface](../specs/mcp-server/index.md#tool-surface).

**Spec:** [MCP Server](../specs/mcp-server/)
**Status:** complete
**Depends On:** 0005

## Motivation

`tools/list` returned no annotations, so MCP clients had to treat every tool as potentially mutating. Claude Code in plan mode only runs MCP tools that declare `readOnlyHint: true`; without it, every ob call is refused or prompts, even for a pure read. Declaring the hint on the read tools lets agents search and read a vault in plan mode.

## Requirements

### Testing Requirements

The standing 100% line + branch coverage gate on `src/` MUST hold, and Biome and `bunx tsc --noEmit` MUST pass.

### Behavior owned by the specs

[MCP Server › Tool surface](../specs/mcp-server/index.md#tool-surface) owns which tools carry `readOnlyHint` and that `tools/list` advertises it, scoped sessions included.

## Design

`ToolDefinition` gains an optional `annotations` field and `tool()` an optional fifth argument that fills it; the six read tools pass `{ readOnlyHint: true }` and `tools/list` forwards the field. Scoped views already spread the source definition, so they inherit it. The write tools set nothing: MCP defaults `destructiveHint` to `true` and `readOnlyHint` to `false`, so omitting hints is already the correct, conservative declaration for them.

### Non-Goals

- `destructiveHint`, `idempotentHint`, or `openWorldHint` on the other tools. The defaults already describe them.

## Tasks

- [x] Add `annotations` to `ToolDefinition` and `tool()`; forward it in `tools/list`.
- [x] Pass `{ readOnlyHint: true }` from the six read tools.
- [x] Assert in `test/mcp/server.test.ts` that exactly those six tools advertise it.

## References

- [MCP tool annotations](https://modelcontextprotocol.io/specification/2025-06-18/schema#toolannotations)

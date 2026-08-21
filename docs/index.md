# Documentation

## Specs

| Spec | Description | Status |
|------|-------------|--------|
| [architecture](specs/architecture/) | Single-process Bun server topology, runtime, config, container, and standing testing/lint conventions. | active |
| [obsidian-sync](specs/obsidian-sync/) | Auth-token bootstrap and per-vault obsidian-headless child-process supervision. | active |
| [vault-indexer](specs/vault-indexer/) | Chokidar watcher, Markdown chunker, embedding providers, and per-vault LanceDB store. | active |
| [rest-api](specs/rest-api/) | Vault-scoped HTTP CRUD over arbitrary files plus natural-language search over Markdown. | active |
| [mcp-server](specs/mcp-server/) | MCP HTTP/SSE server exposing the same surface as REST as MCP tools and resources. | active |

## Changes

| # | Change | Spec | Status | Depends On |
|---|--------|------|--------|------------|
| 0001 | [project-scaffold](changes/0001-project-scaffold.md) | [architecture](specs/architecture/) | complete | — |
| 0002 | [obsidian-supervisor](changes/0002-obsidian-supervisor.md) | [obsidian-sync](specs/obsidian-sync/) | complete | 0001 |
| 0003 | [vault-indexer](changes/0003-vault-indexer.md) | [vault-indexer](specs/vault-indexer/) | complete | 0002 |
| 0004 | [rest-api](changes/0004-rest-api.md) | [rest-api](specs/rest-api/) | complete | 0003 |
| 0005 | [mcp-server](changes/0005-mcp-server.md) | [mcp-server](specs/mcp-server/) | complete | 0004 |
| 0006 | [production-image](changes/0006-production-image.md) | [architecture](specs/architecture/) | complete | 0005 |
| 0007 | [indexer-relevance](changes/0007-indexer-relevance.md) | [vault-indexer](specs/vault-indexer/) | complete | 0006 |
| 0008 | [search-relevance](changes/0008-search-relevance.md) | [vault-indexer](specs/vault-indexer/) | complete | 0007 |
| 0009 | [ci-test-suite](changes/0009-ci-test-suite.md) | [architecture](specs/architecture/) | complete | 0006 |
| 0010 | [release-and-image-publishing](changes/0010-release-and-image-publishing.md) | [architecture](specs/architecture/) | complete | 0009 |
| 0011 | [sync-config-bootstrap](changes/0011-sync-config-bootstrap.md) | [obsidian-sync](specs/obsidian-sync/) | complete | 0002 |
| 0012 | [folder-operations](changes/0012-folder-operations.md) | [rest-api](specs/rest-api/) | complete | 0004, 0005 |
| 0013 | [pdf-text-extraction](changes/0013-pdf-text-extraction.md) | [mcp-server](specs/mcp-server/) | complete | 0004, 0005 |
| 0014 | [mcp-folder-scoping](changes/0014-mcp-folder-scoping.md) | [mcp-server](specs/mcp-server/) | complete | 0005, 0008, 0012 |
| 0015 | [sync-stall-watchdog](changes/0015-sync-stall-watchdog.md) | [obsidian-sync](specs/obsidian-sync/) | complete | 0002, 0011 |

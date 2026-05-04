# 0005: MCP Server (HTTP/SSE)

## Summary

Stand up the MCP server over the Streamable HTTP transport on the same Bun process and Hono app as the REST API, registering nine tools and the `obvault://` resource handler. This PR is pure adapter work: every tool calls into the shared service core landed in 0004 (`src/vault/`, `src/errors.ts`, `src/schemas/`) and MUST NOT add new behavior under those paths. Behavior parity with REST is enforced by code reuse and by parity tests under `test/parity/`.

**Spec:** [MCP Server](../specs/mcp-server/)
**Status:** complete
**Depends On:** 0004

## Motivation

The REST API is fine for humans and conventional clients; agents talking the Model Context Protocol need a first-class tool surface. Co-hosting on the same process avoids a second runtime and keeps the indexer/supervisor singleton. By going through the shared service core we get behavior parity with REST for free — neither adapter forks behavior, and adding a future capability becomes a one-place change.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint)). CI enforces these as merge gates:

- All tests run under `bun test`; coverage MUST stay at 100% line + branch on `src/`.
- Tool tests MUST drive the registered MCP server through its in-process JSON-RPC handler — not through HTTP. A separate transport test MUST exercise the single `/mcp` endpoint end-to-end: `POST /mcp` for `initialize` and a follow-up `tools/call`, plus a `DELETE /mcp` teardown. `GET /mcp` (server-initiated SSE) MAY be exercised opportunistically.
- For each REST↔MCP pair, a parity test under `test/parity/` MUST drive both adapters with the same inputs against the same fixture vault and assert structurally identical successful payloads (modulo each adapter's transport envelope) AND identical error `code`s on failure paths.
- Validation failures MUST be tested per tool with at least one invalid input.
- This PR MUST NOT modify any file under `src/vault/`, `src/errors.ts`, or `src/schemas/` (additive only — and even then prefer landing the addition in 0004 by anticipation). A diff that touches the service core is a signal the PR is doing the wrong work.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Tools

- `src/mcp/tools/*.ts` MUST register each of: `list_vaults`, `vault_status`, `list_files`, `read_file`, `write_file`, `patch_file`, `append_file`, `delete_file`, `search`.
- Each handler MUST: derive `inputSchema` from the matching Zod schema in `src/schemas/`, parse the input with that schema, call the corresponding service function in `src/vault/`, and translate any thrown typed error into the MCP `isError` shape with the JSON `{ code, message, details? }` body. The handler body MUST be ≤ ~10 lines.
- `read_file` MUST report `encoding: "utf-8"` for text/Markdown files and `encoding: "base64"` for binaries; `write_file` MUST accept the same `encoding` field and decode accordingly.

#### Scenario: Tool↔REST parity (`read_file` Markdown)

- **GIVEN** a fixture vault `v` containing `notes/x.md`
- **WHEN** `read_file({vault:"v", path:"notes/x.md"})` is invoked through the MCP server
- **AND** `GET /v1/vaults/v/files/notes/x.md` (Accept: application/json) is invoked through the REST app
- **THEN** the parsed payloads are deep-equal (modulo the MCP `encoding` wrapper)

#### Scenario: Tool↔REST parity (`read_file` binary)

- **GIVEN** a fixture vault `v` containing `attachments/x.png`
- **WHEN** `read_file({vault:"v", path:"attachments/x.png"})` is invoked through the MCP server
- **AND** `GET /v1/vaults/v/files/attachments/x.png` is invoked through the REST app
- **THEN** decoding the MCP tool's base64 `content` yields the same bytes as the REST response body

#### Scenario: Invalid input

- **GIVEN** a registered MCP server
- **WHEN** the client invokes `read_file({vault:"v"})` (missing `path`)
- **THEN** the response has `isError: true`
- **AND** the text content parses as `{ code: "invalid_input", message: <validation msg> }`

### Transport

- The Streamable HTTP transport MUST mount on the existing Hono app at the single endpoint `/mcp`, handling `POST`, `GET`, and `DELETE`.
- `POST /mcp` is the JSON-RPC entry point. Responses MUST be `application/json` for one-shot results and `text/event-stream` for streamed results/notifications, decided per request by the SDK.
- `GET /mcp` opens a server-initiated SSE stream for unsolicited notifications. SSE responses MUST set `Cache-Control: no-cache`, `Connection: keep-alive`, `Content-Type: text/event-stream`.
- `DELETE /mcp` MUST terminate the named session and free its resources.
- A `Mcp-Session-Id` response header MUST be set on the first response of a session; the same header MUST be required on every subsequent request.

#### Scenario: End-to-end transport

- **GIVEN** the running Hono app
- **WHEN** a client `POST`s a JSON-RPC `initialize` to `/mcp` with no session id
- **THEN** the response status is `200`
- **AND** the response sets `Mcp-Session-Id`
- **AND** the parsed JSON body advertises tools and resources capabilities

#### Scenario: Missing session id is rejected

- **GIVEN** a session has been established
- **WHEN** the client `POST`s a `tools/call` to `/mcp` without `Mcp-Session-Id`
- **THEN** the response status is the SDK's documented "missing session" status (4xx)

### Resources

- `resources/list` MUST return one page of `obvault://<slug>/<path>` entries with cursor.
- `resources/read` of an `obvault://` URI MUST return the document text with `mimeType: "text/markdown"`.
- Unknown URIs MUST return an MCP error with code `not_found`.

## Design

### Approach

- One `Server` instance per process. Sessions are HTTP-side state; tool handlers are stateless.
- Tool registration uses one helper:
  ```ts
  function tool<I, O>(name, desc, schema: ZodType<I>, handler: (i: I) => Promise<O>) { ... }
  ```
- The `tool()` helper centralizes input parsing, success wrapping (text content with JSON), and error translation — it is the only place where the typed-error → `isError` mapping appears for MCP. The same typed errors map to HTTP statuses in `src/http/errors.ts`. Both mappers consume the canonical `code` field from `src/errors.ts`; if a new error class is needed, it is added in `src/errors.ts` (a 0004-style change), not in either adapter.

### Decisions

- **Snake_case tool names**: matches typical MCP host UIs.
- **Vault on every tool, not per-vault tool variants**: keeps the tool list short and stable.
- **No streaming tool responses in v1**: every tool returns a single payload; simpler, easier to test, and adequate for CRUD + search.

### Non-Goals

- No auth.
- No prompts (`prompts/list`) in v1.
- No write-side resource updates (resources are read-only; writes go through `write_file`).

## Tasks

- [x] **MCP server bootstrap** — `src/mcp/server.ts` instantiating the SDK server and exposing a `register(tool)` helper.
- [x] **Streamable HTTP transport routes** — `src/mcp/index.ts` exporting `buildMcpRoutes` mounted in `src/http`. Implements `POST/GET/DELETE /mcp` and session-id issuance/validation.
- [x] **Tool: `list_vaults`** + parity test.
- [x] **Tool: `vault_status`** + parity test.
- [x] **Tool: `list_files`** + parity test (including pagination cursor and mixed text/binary entries).
- [x] **Tool: `read_file`** + parity tests for Markdown (utf-8, JSON-shape match against REST) AND binary (base64 round-trip).
- [x] **Tool: `write_file`** + parity tests for Markdown (index visibility) AND binary (no indexer call).
- [x] **Tool: `patch_file`** + parity tests covering: single-edit success, atomic abort on ambiguous, binary rejection (`unsupported_media_type`), missing-file rejection.
- [x] **Tool: `append_file`** + parity tests covering: text append, Markdown append triggers index update, binary rejection, missing-file rejection.
- [x] **Tool: `delete_file`** + parity test (Markdown deletes drop the index, binary deletes do not).
- [x] **Tool: `search`** + parity test using the deterministic fake embedder.
- [x] **Resources** — `obvault://` URI parser, `resources/list`, `resources/read`, plus tests.
- [x] **End-to-end transport test** — `POST /mcp` `initialize`, assert `Mcp-Session-Id` and capabilities; follow up with a `tools/call` and assert response.
- [x] **Coverage 100%**.

## Open Questions

- [x] **SDK transport import.** Pinned `@modelcontextprotocol/sdk@1.29.0`; the Web Standards transport lives at `@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js` (Node 18+/Bun-friendly, no Express dependency). Imports use that path; the version is pinned exact in `package.json`.
- [x] **Backpressure on SSE.** Delegated to the SDK: the transport's `send()` already drops messages when its `ReadableStream` controller's queue fills, and `close()` tears down the session. We do not layer our own buffer on top — the SDK's per-stream buffer plus the `onclose` cleanup gives us the spec's "bounded buffer then close session" behavior at zero adapter cost.

## References

- Spec: [MCP Server](../specs/mcp-server/)
- Mirror surface: [REST API](../specs/rest-api/)
- Related changes: [0004-rest-api](./0004-rest-api.md)
- [@modelcontextprotocol/sdk](https://github.com/modelcontextprotocol/typescript-sdk)

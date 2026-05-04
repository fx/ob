/**
 * Central `tool()` helper for the MCP adapter.
 *
 * Every registered tool follows the same shape: derive a JSON Schema from a
 * shared Zod schema (so `inputSchema` and the runtime validator agree), parse
 * the raw input, invoke a service-core function, then wrap the result. This
 * helper is the only place that knows how to do that wrapping — every
 * `src/mcp/tools/*.ts` module is a thin binding that hands the helper a
 * schema, a description, and an `(args) => Promise<output>` function.
 *
 * The helper centralizes:
 * - Zod input parsing → a `ZodError` becomes an `InvalidInputError` so the
 *   shared error mapper in `src/mcp/errors.ts` translates it the same way
 *   the REST adapter would (both adapters consume the same canonical `code`).
 * - Success wrapping: every output becomes a single text content block
 *   carrying the JSON-serialized service-core return value. The MCP spec
 *   permits structured content blocks; we deliberately stick to text-of-JSON
 *   so parity tests can assert structurally identical bodies against the
 *   REST adapter without normalizing two competing envelopes.
 * - Error translation: the typed-error → `isError` mapping is delegated to
 *   `mapErrorToMcpResult`. A handler body is never expected to construct an
 *   `isError` payload itself.
 */

import type { ZodTypeAny, z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { InvalidInputError } from "../errors.ts";
import { mapErrorToMcpResult } from "./errors.ts";

/** Shape an MCP tool result takes on the success path. */
export interface McpSuccessResult {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
}

/** Either an MCP success or the failure shape from `mapErrorToMcpResult`. */
export type McpToolResult = McpSuccessResult | ReturnType<typeof mapErrorToMcpResult>;

/**
 * Definition produced by the `tool()` helper. Consumed by the server
 * bootstrap when servicing `tools/list` and `tools/call` requests.
 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  /**
   * Plain JSON Schema (object type with `properties` / `required`).
   * Derived at registration time from the per-tool Zod schema via
   * `zod-to-json-schema`, so the wire `inputSchema` and the runtime
   * validator are guaranteed to agree.
   *
   * Most MCP tool inputs today are tool-local Zod schemas (kept next to
   * each handler in `src/mcp/tools/*.ts`) because the REST adapter parses
   * different surfaces (path-param + query for some, body for others) than
   * MCP does (single `arguments` object). Canonical reusable schemas — the
   * ones REST and MCP MUST agree on, like `SearchBody` and `PatchEdit` —
   * live in `src/schemas/`. New cross-adapter input shapes SHOULD land in
   * `src/schemas/` first and be referenced by both adapters.
   */
  readonly inputSchema: Record<string, unknown>;
  /**
   * Validates `raw` and runs the bound service-core function. Returns either
   * the success shape or the `isError` failure shape — never throws.
   */
  readonly call: (raw: unknown) => Promise<McpToolResult>;
}

/**
 * Bind a Zod-validated tool body into the canonical `ToolDefinition` shape.
 *
 * `handler` MUST be a thin wrapper over a function in `src/vault/`. Anything
 * beyond `parse → call → respond` belongs in the service core.
 */
export function tool<S extends ZodTypeAny, O>(
  name: string,
  description: string,
  schema: S,
  handler: (args: z.infer<S>) => Promise<O>,
): ToolDefinition {
  // Strip `$schema` and unused `definitions` keys so the wire payload matches
  // what the SDK validates against (`{ type: "object", properties, required }`).
  // Destructure the noisy keys off and keep the rest — `delete` would force
  // mutation Biome's `noDelete` rule rejects.
  const raw = zodToJsonSchema(schema, { target: "jsonSchema7" }) as Record<string, unknown>;
  const { $schema: _$schema, definitions: _definitions, ...json } = raw;
  return {
    name,
    description,
    inputSchema: json,
    call: async (raw: unknown): Promise<McpToolResult> => {
      // Step 1: validate. ZodError → typed `InvalidInputError` so the same
      // error mapper that handles the service-core's typed errors handles
      // schema failures too.
      const parsed = schema.safeParse(raw);
      if (!parsed.success) {
        return mapErrorToMcpResult(
          new InvalidInputError("schema validation failed", {
            issues: parsed.error.issues,
          }),
        );
      }
      // Step 2: invoke the service-core function. Step 3: wrap.
      try {
        const output = await handler(parsed.data as z.infer<S>);
        return wrapSuccess(output);
      } catch (e) {
        return mapErrorToMcpResult(e);
      }
    },
  };
}

/**
 * Wrap a service-core return value as the canonical MCP success envelope.
 * Exported so resource handlers (which don't go through `tool()`) can produce
 * the same shape.
 */
export function wrapSuccess(output: unknown): McpSuccessResult {
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
  };
}

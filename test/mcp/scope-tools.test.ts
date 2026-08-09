/**
 * Scoped tool-surface tests.
 *
 * Drives `scopeToolDefinition` against the REAL tool registry built by
 * `buildToolRegistry` (via `makeMcpFixture`), so the schemas under test are
 * the ones `zodToJsonSchema` actually emits and the calls under test hit the
 * real service core. Hand-rolled `ToolDefinition`s appear only where a real
 * tool cannot express the shape (a schema with no `properties`, or a
 * vault-taking schema with no `required` array).
 */

import { afterEach, expect, test } from "bun:test";
import {
  SCOPED_INSTRUCTIONS,
  VAULT_WIDE_COUNTS_NOTE,
  scopeToolDefinition,
} from "../../src/mcp/scope-tools.ts";
import { type ToolDefinition, wrapSuccess } from "../../src/mcp/tool.ts";
import { type McpFixture, makeMcpFixture } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

async function fixture(label: string): Promise<McpFixture> {
  const fx = await makeMcpFixture({ label });
  cleanup.push(fx.stop);
  return fx;
}

/** Registry lookup that fails loudly instead of returning `undefined`. */
function toolNamed(fx: McpFixture, name: string): ToolDefinition {
  const t = fx.registry.get(name);
  if (t === undefined) throw new Error(`tool ${name} not registered`);
  return t;
}

/** Invoke a definition and parse the JSON text content, like `fx.callTool`. */
async function callParsed(
  def: ToolDefinition,
  args: unknown,
): Promise<{ isError?: boolean; parsed: unknown }> {
  const r = (await def.call(args)) as {
    isError?: boolean;
    content: readonly { type: string; text: string }[];
  };
  const text = r.content[0]?.text ?? "";
  return r.isError === true
    ? { isError: true, parsed: JSON.parse(text) }
    : { parsed: JSON.parse(text) };
}

/** A stub tool that records what it was delegated, for shapes no real tool has. */
function recordingTool(inputSchema: Record<string, unknown>): {
  readonly def: ToolDefinition;
  readonly calls: unknown[];
} {
  const calls: unknown[] = [];
  return {
    calls,
    def: {
      name: "stub",
      description: "stub tool",
      inputSchema,
      call: async (raw: unknown) => {
        calls.push(raw);
        return wrapSuccess({ ok: true });
      },
    },
  };
}

test("scoped tools/list schemas differ from the unscoped ones only in `required`", async () => {
  const fx = await fixture("scope-tools-list");
  const tools = fx.registry.list();
  expect(tools.length).toBeGreaterThan(0);
  for (const t of tools) {
    const scoped = scopeToolDefinition(t, fx.slug);
    expect(scoped.name).toBe(t.name);
    expect(scoped.description).toBe(t.description);

    const { required: scopedRequired, ...scopedRest } = scoped.inputSchema;
    const { required: sourceRequired, ...sourceRest } = t.inputSchema;
    expect(scopedRest).toEqual(sourceRest);

    const expected = (sourceRequired as string[] | undefined)?.filter((k) => k !== "vault") ?? [];
    if (expected.length === 0) {
      expect(scopedRequired).toBeUndefined();
    } else {
      expect(scopedRequired).toEqual(expected);
    }
    // Whatever the tool required, the scoped view never requires `vault`.
    expect((scopedRequired as string[] | undefined) ?? []).not.toContain("vault");
  }
});

test("scoping does not mutate the shared unscoped inputSchema", async () => {
  const fx = await fixture("scope-tools-pure");
  const source = toolNamed(fx, "list_files");
  const before = structuredClone(source.inputSchema);
  const scoped = scopeToolDefinition(source, fx.slug);
  expect(source.inputSchema).toEqual(before);
  expect((source.inputSchema.required as string[]).includes("vault")).toBe(true);
  expect(scoped.inputSchema).not.toBe(source.inputSchema);
  // Mutating the scoped copy must not reach back into the shared original.
  scoped.inputSchema.required = ["poisoned"];
  expect(source.inputSchema).toEqual(before);
});

test("a vault-only `required` array is dropped rather than advertised empty", async () => {
  const fx = await fixture("scope-tools-empty-required");
  const source = toolNamed(fx, "vault_status");
  expect(source.inputSchema.required).toEqual(["vault"]);
  const scoped = scopeToolDefinition(source, fx.slug);
  expect("required" in scoped.inputSchema).toBe(false);
});

test("omitted `vault` defaults to the scope slug and succeeds", async () => {
  const fx = await fixture("scope-tools-omitted");
  const scoped = scopeToolDefinition(toolNamed(fx, "list_files"), fx.slug);
  const res = await callParsed(scoped, {});
  expect(res.isError).toBeUndefined();
  expect((res.parsed as { items: unknown[] }).items).toEqual([]);
  // Other arguments survive the injection.
  const withArgs = await callParsed(scoped, { limit: 5 });
  expect(withArgs.isError).toBeUndefined();
});

test("a matching `vault` argument is accepted, a different one is vault_not_found", async () => {
  const fx = await fixture("scope-tools-explicit");
  const scoped = scopeToolDefinition(toolNamed(fx, "list_files"), fx.slug);

  const same = await callParsed(scoped, { vault: fx.slug });
  expect(same.isError).toBeUndefined();

  const other = await callParsed(scoped, { vault: "not-the-scope" });
  expect(other.isError).toBe(true);
  expect((other.parsed as { code: string }).code).toBe("vault_not_found");
});

test("non-object arguments pass through so the existing Zod error is preserved", async () => {
  const fx = await fixture("scope-tools-nonobject");
  const scoped = scopeToolDefinition(toolNamed(fx, "list_files"), fx.slug);
  for (const raw of [undefined, "nope", null, [], 7]) {
    const res = await callParsed(scoped, raw);
    expect(res.isError).toBe(true);
    expect((res.parsed as { code: string }).code).toBe("invalid_input");
  }
});

test("a tool with no `vault` property is passed through untouched and still works", async () => {
  const fx = await fixture("scope-tools-novault");
  const source = toolNamed(fx, "list_vaults");
  expect(Object.hasOwn(source.inputSchema.properties as object, "vault")).toBe(false);

  const scoped = scopeToolDefinition(source, fx.slug);
  expect(scoped.inputSchema).toBe(source.inputSchema);
  expect(scoped.call).toBe(source.call);
  expect(scoped.name).toBe(source.name);

  const res = await callParsed(scoped, {});
  expect(res.isError).toBeUndefined();
  expect((res.parsed as { slug: string }[]).map((v) => v.slug)).toEqual([fx.slug]);
});

test("a schema without a `properties` object is treated as taking no vault", async () => {
  const stub = recordingTool({ type: "object" });
  const scoped = scopeToolDefinition(stub.def, "v");
  expect(scoped.inputSchema).toBe(stub.def.inputSchema);
  await scoped.call({});
  expect(stub.calls).toEqual([{}]);
});

test("a vault-taking schema with no `required` array yields no `required` key", async () => {
  const stub = recordingTool({
    type: "object",
    properties: { vault: { type: "string" } },
  });
  const scoped = scopeToolDefinition(stub.def, "v");
  expect("required" in scoped.inputSchema).toBe(false);
  expect(scoped.inputSchema).toEqual({ type: "object", properties: { vault: { type: "string" } } });

  await scoped.call({ path: "a.md" });
  await scoped.call({ path: "b.md", vault: "explicit" });
  expect(stub.calls).toEqual([
    { path: "a.md", vault: "v" },
    { path: "b.md", vault: "explicit" },
  ]);
});

test("descriptionSuffix is appended when non-empty and ignored otherwise", async () => {
  const fx = await fixture("scope-tools-description");
  const source = toolNamed(fx, "vault_status");

  expect(scopeToolDefinition(source, fx.slug).description).toBe(source.description);
  expect(scopeToolDefinition(source, fx.slug, "").description).toBe(source.description);
  expect(scopeToolDefinition(source, fx.slug, VAULT_WIDE_COUNTS_NOTE).description).toBe(
    `${source.description} ${VAULT_WIDE_COUNTS_NOTE}`,
  );

  // The suffix also applies to a tool that takes no vault (`list_vaults`).
  const noVault = toolNamed(fx, "list_vaults");
  expect(scopeToolDefinition(noVault, fx.slug, "Extra.").description).toBe(
    `${noVault.description} Extra.`,
  );
});

test("SCOPED_INSTRUCTIONS states the scope contract without claiming isolation", () => {
  const text = SCOPED_INSTRUCTIONS.toLowerCase();
  // (a) paths are relative to a scoped root.
  expect(text).toContain("relative");
  expect(text).toContain("scoped");
  // (b) the vault argument is optional and defaults to this session's vault.
  expect(text).toContain("`vault` argument is optional");
  expect(text).toContain("defaults to this session's vault");
  // (c) nothing outside the root is reachable THROUGH THIS SESSION.
  expect(text).toContain("outside the scoped root is reachable through this session");
  // It must not claim privacy or isolation, and must say why not.
  expect(text).not.toContain("private");
  expect(text).toContain("no authentication");
  expect(text).toContain("unscoped mount");
  // The prefix itself is never revealed — the string carries no path at all.
  expect(SCOPED_INSTRUCTIONS).not.toContain("/");
});

test("VAULT_WIDE_COUNTS_NOTE names every vault-wide counter", () => {
  const text = VAULT_WIDE_COUNTS_NOTE.toLowerCase();
  for (const field of ["documents", "chunks", "pending", "errors"]) {
    expect(text).toContain(field);
  }
  expect(text).toContain("vault-wide");
  expect(text).toContain("not only the folder this session is scoped to");
});

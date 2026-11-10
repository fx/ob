/**
 * `POST /v1/vaults/:slug/grep` through the real Hono app and the real scan
 * worker, including the no-stall scenario at the production time budget.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GrepResponse } from "../../src/schemas/index.ts";
import { GREP_TIME_BUDGET_MS } from "../../src/vault/grep.ts";
import { type HttpFixture, makeHttpFixture } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

async function fixture(label: string, files: Record<string, string>): Promise<HttpFixture> {
  const fx = await makeHttpFixture(label);
  cleanup.push(fx.stop);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(fx.vaultRoot, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return fx;
}

async function post(
  fx: HttpFixture,
  body: unknown,
  init: RequestInit = {},
  slug = "v",
): Promise<{ status: number; body: unknown }> {
  const res = await fx.app.request(`/v1/vaults/${slug}/grep`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...init,
  });
  return { status: res.status, body: await res.json() };
}

function code(body: unknown): string {
  return (body as { error: { code: string } }).error.code;
}

/** Lines that each keep `(a+)+$` backtracking far past any budget. */
const CATASTROPHIC = `${"a".repeat(10_000)}!\n`.repeat(50);

describe("POST /v1/vaults/:slug/grep", () => {
  test("literal grep finds exact text with line numbers", async () => {
    const fx = await fixture("grep-literal", {
      "notes/a.md": "one\ntwo\nTODO: call the plumber\n",
      "img/logo.png": "TODO: not searched",
    });
    const r = await post(fx, { pattern: "TODO:" });
    expect(r.status).toBe(200);
    expect(GrepResponse.parse(r.body)).toEqual({
      matches: [
        { path: "notes/a.md", line: 3, column: 1, text: "TODO: call the plumber", textStart: 1 },
      ],
      truncated: false,
      reason: null,
      filesScanned: 1,
      filesSkipped: 0,
    });
  });

  test("regex special characters are literal by default", async () => {
    const fx = await fixture("grep-special", { "a.md": "cost (est.) $5\n" });
    const r = await post(fx, { pattern: "(est.) $5" });
    expect((r.body as GrepResponse).matches[0]?.column).toBe(6);
  });

  test("options pass through: regex, ignoreCase, prefix, limit, context", async () => {
    const fx = await fixture("grep-opts", {
      "a/x.md": "Foo\nbar\nfoo\n",
      "b/y.md": "foo\n",
    });
    const r = await post(fx, {
      pattern: "^f",
      regex: true,
      ignoreCase: true,
      prefix: "a/",
      limit: 1,
      context: 1,
    });
    expect(r.body).toEqual({
      matches: [
        {
          path: "a/x.md",
          line: 1,
          column: 1,
          text: "Foo",
          textStart: 1,
          before: [],
          after: ["bar"],
        },
      ],
      truncated: true,
      reason: "limit",
      filesScanned: 1,
      filesSkipped: 0,
    });
  });

  test("an invalid regex is 400 invalid_input", async () => {
    const fx = await fixture("grep-badre", {});
    const r = await post(fx, { pattern: "([", regex: true });
    expect(r.status).toBe(400);
    expect(code(r.body)).toBe("invalid_input");
  });

  test("an unparseable body is invalid_body; a schema-invalid one is invalid_input", async () => {
    const fx = await fixture("grep-body", {});
    const bad = await post(fx, "{not json");
    expect(bad.status).toBe(400);
    expect(code(bad.body)).toBe("invalid_body");
    for (const body of [
      {},
      { pattern: "" },
      { pattern: "x", limit: 0 },
      { pattern: "x", limit: 1001 },
      { pattern: "x", context: 6 },
      { pattern: "x", regex: "yes" },
      { pattern: "x", flags: "g" },
      { pattern: "a".repeat(1025) },
      { pattern: "x", prefix: "p".repeat(1025) },
    ]) {
      const r = await post(fx, body);
      expect(r.status).toBe(400);
      expect(code(r.body)).toBe("invalid_input");
    }
  });

  test("an unknown vault is 404 vault_not_found", async () => {
    const fx = await fixture("grep-404", {});
    const r = await post(fx, { pattern: "x" }, {}, "ghost");
    expect(r.status).toBe(404);
    expect(code(r.body)).toBe("vault_not_found");
  });

  test("path-traversal-shaped prefixes match nothing rather than escaping", async () => {
    const fx = await fixture("grep-traversal", { "a.md": "SECRET\n" });
    // A sibling of the vault that a traversal would reach.
    writeFileSync(join(fx.vaultRoot, "..", "outside.md"), "SECRET\n");
    for (const prefix of ["../", "..", "../outside.md", "/", "/etc/", "./a.md", "%2e%2e/"]) {
      const r = await post(fx, { pattern: "SECRET", prefix });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({
        matches: [],
        truncated: false,
        reason: null,
        filesScanned: 0,
        filesSkipped: 0,
      });
    }
  });

  test(
    "a catastrophic regex is cut off at the budget without stalling the server",
    async () => {
      const fx = await fixture("grep-redos", { "cat.txt": CATASTROPHIC });
      const started = performance.now();
      const grepping = post(fx, { pattern: "(a+)+$", regex: true }).then((r) => ({
        ...r,
        at: performance.now() - started,
      }));
      await Bun.sleep(200);
      const healthStart = performance.now();
      const health = await fx.app.request("/healthz");
      const healthMs = performance.now() - healthStart;
      const r = await grepping;
      expect(health.status).toBe(200);
      expect(healthMs).toBeLessThan(500);
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ matches: [], truncated: true, reason: "time" });
      expect(r.at).toBeGreaterThanOrEqual(GREP_TIME_BUDGET_MS - 50);
      expect(r.at).toBeLessThan(GREP_TIME_BUDGET_MS + 1_500);
    },
    GREP_TIME_BUDGET_MS + 10_000,
  );

  test("a client that disconnects stops the grep", async () => {
    const fx = await fixture("grep-abort", { "cat.txt": CATASTROPHIC });
    const ctl = new AbortController();
    const started = performance.now();
    const grepping = post(fx, { pattern: "(a+)+$", regex: true }, { signal: ctl.signal });
    await Bun.sleep(100);
    ctl.abort();
    const r = await grepping;
    expect(performance.now() - started).toBeLessThan(GREP_TIME_BUDGET_MS / 2);
    expect(r.body).toMatchObject({ matches: [], truncated: true });
  });
});

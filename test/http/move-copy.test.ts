/**
 * `POST /v1/vaults/:slug/paths/*path:move` and `:copy` through the real Hono
 * app, the real `safeJoin`, and a real indexer (fake embedder, real LanceDB)
 * on a tmpdir vault. Path validation is exercised on the source AND the
 * destination of both operations, each asserting the status, the code, and
 * that nothing changed on disk or in the index.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { type HttpFixture, makeHttpFixture, waitFor } from "./helpers.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) await cleanup.pop()?.();
});

async function fixture(label: string): Promise<HttpFixture> {
  const fx = await makeHttpFixture(label);
  cleanup.push(fx.stop);
  await waitFor(() => fx.indexer.status("v")?.state === "ready");
  return fx;
}

function put(root: string, rel: string, content = "x"): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

function post(fx: HttpFixture, url: string, body: unknown, contentType = "application/json") {
  return fx.app.request(url, {
    method: "POST",
    headers: { "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function errorCode(res: Response): Promise<string> {
  return ((await res.json()) as { error: { code: string } }).error.code;
}

/** Everything on disk around the vault (recursive, hidden included). */
function snapshot(fx: HttpFixture): string[] {
  return (readdirSync(join(fx.vaultRoot, "..", ".."), { recursive: true }) as string[])
    .filter((p) => !p.startsWith("lancedb"))
    .sort();
}

describe("POST …:move", () => {
  test("scenario: rename a note and update links to it", async () => {
    const fx = await fixture("mv-rename");
    put(fx.vaultRoot, "notes/old.md", "# Old\n\nbody");
    put(fx.vaultRoot, "daily/today.md", "see [[old]]");
    await fx.indexer.reindex("v", "notes/old.md");
    await fx.indexer.reindex("v", "daily/today.md");
    const res = await post(fx, "/v1/vaults/v/paths/notes/old.md:move", {
      destination: "notes/new.md",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      path: "notes/old.md",
      destination: "notes/new.md",
      type: "file",
      overwritten: false,
      indexed: true,
      links: { updated: [{ path: "daily/today.md", links: 1, indexed: true }], failed: [] },
    });
    expect(readFileSync(join(fx.vaultRoot, "daily/today.md"), "utf8")).toBe("see [[new]]");
    expect(existsSync(join(fx.vaultRoot, "notes/old.md"))).toBe(false);
    expect(await fx.indexer.indexedPaths("v", "notes/")).toEqual(["notes/new.md"]);
  });

  test("scenario: move a folder into a new parent without link updates", async () => {
    const fx = await fixture("mv-folder");
    put(fx.vaultRoot, "inbox/2026/a.md", "# A");
    put(fx.vaultRoot, "inbox/2026/img.png", "PNG");
    const res = await post(fx, "/v1/vaults/v/paths/inbox/2026:move", {
      destination: "archive/2026",
      updateLinks: false,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ type: "folder", links: null });
    expect(existsSync(join(fx.vaultRoot, "archive/2026/img.png"))).toBe(true);
    expect(existsSync(join(fx.vaultRoot, "inbox/2026"))).toBe(false);
  });

  test("errors: already_exists 409, not_found 404, folder into itself 400", async () => {
    const fx = await fixture("mv-errors");
    put(fx.vaultRoot, "a.md", "A");
    put(fx.vaultRoot, "b.md", "B");
    put(fx.vaultRoot, "projects/p.md");
    const clobber = await post(fx, "/v1/vaults/v/paths/a.md:move", { destination: "b.md" });
    expect([clobber.status, await errorCode(clobber)]).toEqual([409, "already_exists"]);
    const missing = await post(fx, "/v1/vaults/v/paths/nope.md:move", { destination: "c.md" });
    expect([missing.status, await errorCode(missing)]).toEqual([404, "not_found"]);
    const inside = await post(fx, "/v1/vaults/v/paths/projects:move", {
      destination: "projects/old",
    });
    expect([inside.status, await errorCode(inside)]).toEqual([400, "invalid_path"]);
    const vault = await post(fx, "/v1/vaults/nope/paths/a.md:move", { destination: "c.md" });
    expect([vault.status, await errorCode(vault)]).toEqual([404, "vault_not_found"]);
  });
});

describe("POST …:copy", () => {
  test("scenario: copy a folder recursively", async () => {
    const fx = await fixture("cp-folder");
    put(fx.vaultRoot, "templates/weekly.md", "# Weekly\n\nplan");
    mkdirSync(join(fx.vaultRoot, "templates/empty"));
    put(fx.vaultRoot, "templates/.hidden", "h");
    const res = await post(fx, "/v1/vaults/v/paths/templates:copy", {
      destination: "templates-copy",
      recursive: true,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      path: "templates",
      destination: "templates-copy",
      type: "folder",
      overwritten: false,
      indexed: true,
      files: 1,
      skipped: 1,
    });
    expect(existsSync(join(fx.vaultRoot, "templates-copy/empty"))).toBe(true);
    expect(existsSync(join(fx.vaultRoot, "templates-copy/.hidden"))).toBe(false);
    expect(await fx.indexer.indexedPaths("v", "templates-copy/")).toEqual([
      "templates-copy/weekly.md",
    ]);
  });

  test("scenario: folder copy requires recursive", async () => {
    const fx = await fixture("cp-recursive");
    put(fx.vaultRoot, "templates/t.md");
    const res = await post(fx, "/v1/vaults/v/paths/templates:copy", { destination: "t2" });
    expect([res.status, await errorCode(res)]).toEqual([400, "invalid_path"]);
    expect(existsSync(join(fx.vaultRoot, "t2"))).toBe(false);
  });
});

describe("request envelopes", () => {
  for (const op of ["move", "copy"] as const) {
    test(`${op}: non-JSON is 415, bad JSON invalid_body, bad shape invalid_input`, async () => {
      const fx = await fixture(`env-${op}`);
      put(fx.vaultRoot, "a.md", "A");
      const url = `/v1/vaults/v/paths/a.md:${op}`;
      const text = await post(fx, url, "destination=b.md", "text/plain");
      expect([text.status, await errorCode(text)]).toEqual([415, "unsupported_media_type"]);
      const none = await fx.app.request(url, { method: "POST", body: "{}" });
      expect(none.status).toBe(415);
      const bad = await post(fx, url, "{not json");
      expect([bad.status, await errorCode(bad)]).toEqual([400, "invalid_body"]);
      for (const body of [
        {},
        { destination: "" },
        { destination: "b.md", extra: 1 },
        { destination: 7 },
      ]) {
        const r = await post(fx, url, body);
        expect([r.status, await errorCode(r)]).toEqual([400, "invalid_input"]);
      }
      expect(readdirSync(fx.vaultRoot)).toEqual(["a.md"]);
    });
  }
});

describe("path validation on the source and the destination of both operations", () => {
  function seed(fx: HttpFixture): void {
    put(fx.vaultRoot, "keep.md", "KEEP");
    put(fx.vaultRoot, "real/keep.md", "REAL");
    put(fx.vaultRoot, ".obsidian/app.json", "{}");
    symlinkSync(join(fx.vaultRoot, "real"), join(fx.vaultRoot, "link"));
    put(join(fx.vaultRoot, "..", ".."), "sentinel", "S");
  }

  const SOURCES: [string, string][] = [
    ["a `..` traversal", "..%2F..%2Fsentinel"],
    ["an absolute path", "%2Fetc%2Fpasswd"],
    ["a hidden folder", ".obsidian"],
    ["a NUL byte", "keep.md%00"],
    ["a symlink in the chain", "link/keep.md"],
    ["the vault root as `./.`", "%2E%2F%2E"],
  ];
  const DESTINATIONS: [string, string][] = [
    ["a `..` traversal", "../../outside.md"],
    ["a nested `..` traversal", "a/../../outside.md"],
    ["an absolute path", "/tmp/outside.md"],
    ["a hidden segment", ".obsidian/x.md"],
    ["a NUL byte", "x\0.md"],
    ["a symlink in the chain", "link/x.md"],
    ["the vault root", "."],
    ["an over-length path", `${"a".repeat(1100)}.md`],
  ];

  for (const op of ["move", "copy"] as const) {
    for (const [label, tail] of SOURCES) {
      test(`${op} source: ${label}`, async () => {
        const fx = await fixture(`src-${op}`);
        seed(fx);
        await fx.indexer.reindex("v", "keep.md");
        const before = snapshot(fx);
        const res = await post(fx, `/v1/vaults/v/paths/${tail}:${op}`, { destination: "new.md" });
        expect([res.status, await errorCode(res)]).toEqual([400, "invalid_path"]);
        expect(snapshot(fx)).toEqual(before);
        expect(await fx.indexer.indexedPaths("v", "")).toEqual(["keep.md"]);
      });
    }
    for (const [label, destination] of DESTINATIONS) {
      test(`${op} destination: ${label}`, async () => {
        const fx = await fixture(`dst-${op}`);
        seed(fx);
        await fx.indexer.reindex("v", "keep.md");
        const before = snapshot(fx);
        const res = await post(fx, `/v1/vaults/v/paths/keep.md:${op}`, { destination });
        expect([res.status, await errorCode(res)]).toEqual([400, "invalid_path"]);
        expect(snapshot(fx)).toEqual(before);
        expect(readFileSync(join(fx.vaultRoot, "keep.md"), "utf8")).toBe("KEEP");
        expect(await fx.indexer.indexedPaths("v", "")).toEqual(["keep.md"]);
      });
    }
  }
});

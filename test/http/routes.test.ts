import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeHttpFixture, waitFor } from "./helpers.ts";

const PDF_FIXTURES = join(import.meta.dir, "../fixtures/pdf");
function pdfFixture(name: string): Uint8Array {
  const buf = readFileSync(join(PDF_FIXTURES, name));
  const view = new Uint8Array(buf.byteLength);
  view.set(buf);
  return view;
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

describe("GET /v1/vaults", () => {
  test("returns list with sync + indexer state", async () => {
    const fx = await makeHttpFixture("vaults-list");
    cleanup.push(fx.stop);
    await waitFor(() => fx.indexer.status("v")?.state === "ready");
    const res = await fx.app.request("/v1/vaults");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string; sync: { state: string } }[];
    expect(body.length).toBe(1);
    expect(body[0]?.slug).toBe("v");
    expect(body[0]?.sync.state).toBe("running");
  });
});

describe("GET /v1/vaults/:slug", () => {
  test("returns single status", async () => {
    const fx = await makeHttpFixture("vaults-get");
    cleanup.push(fx.stop);
    const res = await fx.app.request("/v1/vaults/v");
    expect(res.status).toBe(200);
  });

  test("404 on unknown slug", async () => {
    const fx = await makeHttpFixture("vaults-404");
    cleanup.push(fx.stop);
    const res = await fx.app.request("/v1/vaults/missing");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("vault_not_found");
  });
});

describe("file CRUD", () => {
  test("PUT then GET round-trips Markdown bytes", async () => {
    const fx = await makeHttpFixture("rt");
    cleanup.push(fx.stop);
    await waitFor(() => fx.indexer.status("v")?.state === "ready");
    const put = await fx.app.request("/v1/vaults/v/files/notes/x.md", {
      method: "PUT",
      headers: { "content-type": "text/markdown" },
      body: "# hi",
    });
    expect(put.status).toBe(200);
    const putBody = (await put.json()) as { indexed: boolean; created: boolean };
    expect(putBody.indexed).toBe(true);
    expect(putBody.created).toBe(true);

    const get = await fx.app.request("/v1/vaults/v/files/notes/x.md");
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await get.text()).toBe("# hi");
  });

  test("Markdown round-trip with index visibility", async () => {
    const fx = await makeHttpFixture("rt-search");
    cleanup.push(fx.stop);
    await waitFor(() => fx.indexer.status("v")?.state === "ready");
    await fx.app.request("/v1/vaults/v/files/notes/coffee.md", {
      method: "PUT",
      headers: { "content-type": "text/markdown" },
      body: "# coffee\n\nbean notes",
    });
    const search = await fx.app.request("/v1/vaults/v/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "bean notes", limit: 5 }),
    });
    expect(search.status).toBe(200);
    const body = (await search.json()) as { hits: { path: string }[] };
    expect(body.hits.some((h) => h.path === "notes/coffee.md")).toBe(true);
  });

  test("GET with Accept: application/json on Markdown returns JSON wrapper", async () => {
    const fx = await makeHttpFixture("getjson");
    cleanup.push(fx.stop);
    await waitFor(() => fx.indexer.status("v")?.state === "ready");
    await fx.app.request("/v1/vaults/v/files/n.md", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "body", frontmatter: { tags: ["a"] } }),
    });
    const res = await fx.app.request("/v1/vaults/v/files/n.md", {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      path: string;
      content: string;
      frontmatter: Record<string, unknown>;
      mtimeMs: number;
      size: number;
      sha256: string;
    };
    expect(body.path).toBe("n.md");
    expect(body.content.trim()).toBe("body");
    expect(body.frontmatter.tags).toEqual(["a"]);
  });

  test("GET with Accept: application/json on non-Markdown returns 406", async () => {
    const fx = await makeHttpFixture("getjson406");
    cleanup.push(fx.stop);
    writeFileSync(join(fx.vaultRoot, "x.png"), new Uint8Array([1]));
    const res = await fx.app.request("/v1/vaults/v/files/x.png", {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(406);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unsupported_media_type");
  });

  test("GET with Accept: application/json on a PDF returns extracted text", async () => {
    const fx = await makeHttpFixture("getjsonpdf");
    cleanup.push(fx.stop);
    writeFileSync(join(fx.vaultRoot, "paper.pdf"), pdfFixture("text.pdf"));
    const res = await fx.app.request("/v1/vaults/v/files/paper.pdf", {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      path: string;
      content: string;
      contentType: string;
      pdf: { pages: number; hasTextLayer: boolean };
      frontmatter?: unknown;
    };
    expect(body.path).toBe("paper.pdf");
    expect(body.content).toBe("alpha\n\n<!-- page 2 -->\n\nbeta");
    expect(body.contentType).toBe("application/pdf");
    expect(body.pdf).toEqual({ pages: 2, hasTextLayer: true });
    expect(body.frontmatter).toBeUndefined();
  });

  test("plain GET on a PDF still returns verbatim bytes", async () => {
    const fx = await makeHttpFixture("getbytespdf");
    cleanup.push(fx.stop);
    const bytes = pdfFixture("text.pdf");
    writeFileSync(join(fx.vaultRoot, "paper.pdf"), bytes);
    const res = await fx.app.request("/v1/vaults/v/files/paper.pdf");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    const got = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(got)).toEqual(Array.from(bytes));
  });

  test("GET JSON on a corrupt PDF returns 422 extraction_failed", async () => {
    const fx = await makeHttpFixture("getjsonpdfbroken");
    cleanup.push(fx.stop);
    writeFileSync(join(fx.vaultRoot, "bad.pdf"), pdfFixture("broken.pdf"));
    const res = await fx.app.request("/v1/vaults/v/files/bad.pdf", {
      headers: { accept: "application/json" },
    });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("extraction_failed");
  });

  test("PUT binary path: indexed=false, no indexer call", async () => {
    const fx = await makeHttpFixture("putbin");
    cleanup.push(fx.stop);
    await waitFor(() => fx.indexer.status("v")?.state === "ready");
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const put = await fx.app.request("/v1/vaults/v/files/attachments/x.png", {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: png,
    });
    const body = (await put.json()) as { indexed: boolean; contentType: string };
    expect(body.indexed).toBe(false);
    expect(body.contentType).toBe("image/png");
    const get = await fx.app.request("/v1/vaults/v/files/attachments/x.png");
    expect(get.status).toBe(200);
    expect(get.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(png);
  });

  test("GET on missing file returns 404 not_found", async () => {
    const fx = await makeHttpFixture("get404");
    cleanup.push(fx.stop);
    const res = await fx.app.request("/v1/vaults/v/files/missing.md");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  test("PUT with traversal path returns 400 invalid_path", async () => {
    const fx = await makeHttpFixture("trav");
    cleanup.push(fx.stop);
    const res = await fx.app.request("/v1/vaults/v/files/..%2Fetc%2Fpasswd", {
      method: "PUT",
      headers: { "content-type": "text/markdown" },
      body: "x",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_path");
  });

  test("PUT JSON body to non-Markdown path returns 415 unsupported_media_type", async () => {
    const fx = await makeHttpFixture("putjson415");
    cleanup.push(fx.stop);
    const res = await fx.app.request("/v1/vaults/v/files/attachments/x.png", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    expect(res.status).toBe(415);
  });

  test("PUT JSON with malformed JSON body returns 400 invalid_body", async () => {
    const fx = await makeHttpFixture("putjsonbad");
    cleanup.push(fx.stop);
    const res = await fx.app.request("/v1/vaults/v/files/x.md", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_body");
  });

  test("PUT JSON with unknown extra fields returns 400 invalid_input", async () => {
    const fx = await makeHttpFixture("putjsoninvalid");
    cleanup.push(fx.stop);
    const res = await fx.app.request("/v1/vaults/v/files/x.md", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: 5 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_input");
  });

  test("DELETE 204 then 404", async () => {
    const fx = await makeHttpFixture("del");
    cleanup.push(fx.stop);
    await waitFor(() => fx.indexer.status("v")?.state === "ready");
    await fx.app.request("/v1/vaults/v/files/x.md", {
      method: "PUT",
      headers: { "content-type": "text/markdown" },
      body: "# x",
    });
    const del = await fx.app.request("/v1/vaults/v/files/x.md", { method: "DELETE" });
    expect(del.status).toBe(204);
    const del2 = await fx.app.request("/v1/vaults/v/files/x.md", { method: "DELETE" });
    expect(del2.status).toBe(404);
  });
});

describe("LIST /v1/vaults/:slug/files", () => {
  test("lists files with prefix and limit", async () => {
    const fx = await makeHttpFixture("list");
    cleanup.push(fx.stop);
    writeFileSync(join(fx.vaultRoot, "a.md"), "a");
    writeFileSync(join(fx.vaultRoot, "b.md"), "b");
    const res = await fx.app.request("/v1/vaults/v/files?prefix=a&limit=10");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { path: string }[] };
    expect(body.items.map((i) => i.path)).toEqual(["a.md"]);
  });

  test("rejects bad limit with 400 invalid_query", async () => {
    const fx = await makeHttpFixture("list-badq");
    cleanup.push(fx.stop);
    const res = await fx.app.request("/v1/vaults/v/files?limit=99999");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_query");
  });
});

describe("PATCH /v1/vaults/:slug/files/*path", () => {
  test("single-edit success", async () => {
    const fx = await makeHttpFixture("patch1");
    cleanup.push(fx.stop);
    await waitFor(() => fx.indexer.status("v")?.state === "ready");
    writeFileSync(join(fx.vaultRoot, "x.md"), "# Title\n\n- a\n- b\n");
    const res = await fx.app.request("/v1/vaults/v/files/x.md", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ edits: [{ old: "- b\n", new: "- b\n- c\n" }] }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { edits: number; indexed: boolean };
    expect(body.edits).toBe(1);
    expect(body.indexed).toBe(true);
  });

  test("ambiguous old → 409 patch_ambiguous with details.occurrences", async () => {
    const fx = await makeHttpFixture("patch-amb");
    cleanup.push(fx.stop);
    writeFileSync(join(fx.vaultRoot, "x.md"), "foo\nfoo\n");
    const res = await fx.app.request("/v1/vaults/v/files/x.md", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ edits: [{ old: "foo", new: "bar" }] }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details: { occurrences: number } };
    };
    expect(body.error.code).toBe("patch_ambiguous");
    expect(body.error.details.occurrences).toBe(2);
  });

  test("atomic abort → 409 patch_no_match with editIndex 1", async () => {
    const fx = await makeHttpFixture("patch-abort");
    cleanup.push(fx.stop);
    writeFileSync(join(fx.vaultRoot, "x.md"), "alpha\nbeta\n");
    const res = await fx.app.request("/v1/vaults/v/files/x.md", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        edits: [
          { old: "alpha", new: "ALPHA" },
          { old: "gamma", new: "GAMMA" },
        ],
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      error: { code: string; details: { editIndex: number } };
    };
    expect(body.error.code).toBe("patch_no_match");
    expect(body.error.details.editIndex).toBe(1);
  });

  test("PATCH on binary → 415", async () => {
    const fx = await makeHttpFixture("patch-bin");
    cleanup.push(fx.stop);
    writeFileSync(join(fx.vaultRoot, "x.png"), new Uint8Array([1]));
    const res = await fx.app.request("/v1/vaults/v/files/x.png", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ edits: [{ old: "a", new: "b" }] }),
    });
    expect(res.status).toBe(415);
  });

  test("no-op edit → 400 invalid_body", async () => {
    const fx = await makeHttpFixture("patch-noop");
    cleanup.push(fx.stop);
    writeFileSync(join(fx.vaultRoot, "x.md"), "abc\n");
    const res = await fx.app.request("/v1/vaults/v/files/x.md", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ edits: [{ old: "abc", new: "abc" }] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_body");
  });

  test("PATCH without JSON content type → 415", async () => {
    const fx = await makeHttpFixture("patch-ct");
    cleanup.push(fx.stop);
    writeFileSync(join(fx.vaultRoot, "x.md"), "abc\n");
    const res = await fx.app.request("/v1/vaults/v/files/x.md", {
      method: "PATCH",
      headers: { "content-type": "text/plain" },
      body: "not json",
    });
    expect(res.status).toBe(415);
  });

  test("PATCH with malformed JSON → 400 invalid_body", async () => {
    const fx = await makeHttpFixture("patch-bad");
    cleanup.push(fx.stop);
    writeFileSync(join(fx.vaultRoot, "x.md"), "abc\n");
    const res = await fx.app.request("/v1/vaults/v/files/x.md", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_body");
  });

  test("PATCH with empty edits → 400 invalid_input", async () => {
    const fx = await makeHttpFixture("patch-empty");
    cleanup.push(fx.stop);
    writeFileSync(join(fx.vaultRoot, "x.md"), "abc\n");
    const res = await fx.app.request("/v1/vaults/v/files/x.md", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ edits: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_input");
  });
});

describe("POST /v1/vaults/:slug/files/*path:append", () => {
  test("appends raw bytes to existing daily note", async () => {
    const fx = await makeHttpFixture("append-daily");
    cleanup.push(fx.stop);
    writeFileSync(join(fx.vaultRoot, "daily.md"), "# Today\n");
    const res = await fx.app.request("/v1/vaults/v/files/daily.md:append", {
      method: "POST",
      headers: { "content-type": "text/markdown" },
      body: "- 14:30 had coffee\n",
    });
    expect(res.status).toBe(200);
  });

  test("appends via JSON body", async () => {
    const fx = await makeHttpFixture("append-json");
    cleanup.push(fx.stop);
    writeFileSync(join(fx.vaultRoot, "x.md"), "abc");
    const res = await fx.app.request("/v1/vaults/v/files/x.md:append", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "DEF" }),
    });
    expect(res.status).toBe(200);
  });

  test("append on binary → 415", async () => {
    const fx = await makeHttpFixture("append-bin");
    cleanup.push(fx.stop);
    writeFileSync(join(fx.vaultRoot, "x.png"), new Uint8Array([1]));
    const res = await fx.app.request("/v1/vaults/v/files/x.png:append", {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: new Uint8Array([2]),
    });
    expect(res.status).toBe(415);
  });

  test("append on missing → 404", async () => {
    const fx = await makeHttpFixture("append-miss");
    cleanup.push(fx.stop);
    const res = await fx.app.request("/v1/vaults/v/files/missing.md:append", {
      method: "POST",
      headers: { "content-type": "text/markdown" },
      body: "x",
    });
    expect(res.status).toBe(404);
  });

  test("append with malformed JSON → 400 invalid_body", async () => {
    const fx = await makeHttpFixture("append-bad");
    cleanup.push(fx.stop);
    writeFileSync(join(fx.vaultRoot, "x.md"), "abc");
    const res = await fx.app.request("/v1/vaults/v/files/x.md:append", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  test("append with non-conforming JSON body → 400 invalid_input", async () => {
    const fx = await makeHttpFixture("append-shape");
    cleanup.push(fx.stop);
    writeFileSync(join(fx.vaultRoot, "x.md"), "abc");
    const res = await fx.app.request("/v1/vaults/v/files/x.md:append", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ wrong: 1 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_input");
  });
});

describe("POST /v1/vaults/:slug/search", () => {
  test("rejects bad query length", async () => {
    const fx = await makeHttpFixture("search-bad");
    cleanup.push(fx.stop);
    const res = await fx.app.request("/v1/vaults/v/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "x".repeat(5000) }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_input");
  });

  test("rejects bad limit", async () => {
    const fx = await makeHttpFixture("search-lim");
    cleanup.push(fx.stop);
    const res0 = await fx.app.request("/v1/vaults/v/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "x", limit: 0 }),
    });
    expect(res0.status).toBe(400);
    const res101 = await fx.app.request("/v1/vaults/v/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "x", limit: 101 }),
    });
    expect(res101.status).toBe(400);
  });

  test("rejects bogus mode → 400 invalid_input naming allowed values in details", async () => {
    const fx = await makeHttpFixture("search-bad-mode");
    cleanup.push(fx.stop);
    const res = await fx.app.request("/v1/vaults/v/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "x", mode: "bogus" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as {
      error: {
        code: string;
        message: string;
        details?: { issues?: { path?: (string | number)[]; [k: string]: unknown }[] };
      };
    };
    expect(body.error.code).toBe("invalid_input");
    // The Zod issue list is surfaced under `details.issues`; the offending
    // field (`mode`) AND the allowed values must be discoverable so the
    // caller can recover without consulting the spec.
    const issues = body.error.details?.issues ?? [];
    const issueText = JSON.stringify(issues);
    expect(issues.some((i) => Array.isArray(i.path) && i.path.includes("mode"))).toBe(true);
    expect(issueText).toContain("hybrid");
    expect(issueText).toContain("vector");
    expect(issueText).toContain("fts");
  });

  test("rejects threshold outside [0, 1] → 400 invalid_input", async () => {
    const fx = await makeHttpFixture("search-bad-threshold");
    cleanup.push(fx.stop);
    for (const threshold of [-0.1, 1.5]) {
      const res = await fx.app.request("/v1/vaults/v/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "x", threshold }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid_input");
    }
  });

  test("rejects mmrLambda outside [0, 1] → 400 invalid_input", async () => {
    const fx = await makeHttpFixture("search-bad-mmr");
    cleanup.push(fx.stop);
    for (const mmrLambda of [-0.1, 1.5]) {
      const res = await fx.app.request("/v1/vaults/v/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "x", mmrLambda }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid_input");
    }
  });

  test("rejects malformed maxPerPath → 400 invalid_input", async () => {
    const fx = await makeHttpFixture("search-bad-maxpp");
    cleanup.push(fx.stop);
    // Non-integer, out-of-range, and wrong type.
    const cases: unknown[] = [0, 101, 1.5, "3"];
    for (const maxPerPath of cases) {
      const res = await fx.app.request("/v1/vaults/v/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: "x", maxPerPath }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe("invalid_input");
    }
  });

  test("malformed JSON → 400 invalid_body", async () => {
    const fx = await makeHttpFixture("search-bad-json");
    cleanup.push(fx.stop);
    const res = await fx.app.request("/v1/vaults/v/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_body");
  });

  test("unknown slug → 404 vault_not_found", async () => {
    const fx = await makeHttpFixture("search-novault");
    cleanup.push(fx.stop);
    const res = await fx.app.request("/v1/vaults/missing/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "x" }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("vault_not_found");
  });
});

describe("server-error logging branch", () => {
  test("a thrown non-typed Error in a route is logged at error and surfaced as 500", async () => {
    // Wire a bare app with a single throwing route plus the same onError
    // shape via buildHttpApp. We can't easily inject a route into the
    // production buildHttpApp, but we can hit the embedder error path —
    // which is mapped to 502 — by calling search with a query string the
    // fake embedder's `dim` getter rejects. Easier: use a fake indexer
    // that throws a plain Error from `search`.
    const { mkdtempSync, mkdirSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { buildHttpApp } = await import("../../src/http/index.ts");
    const dataDir = mkdtempSync(join(tmpdir(), "ob-err500-"));
    mkdirSync(join(dataDir, "vaults", "v"), { recursive: true });
    const fakeIndexer = {
      list: () => [
        {
          slug: "v",
          state: "ready" as const,
          documents: 0,
          chunks: 0,
          lastIndexedAt: null,
          pending: 0,
          errors: 0,
        },
      ],
      status: () => null,
      search: async (): Promise<never> => {
        throw new Error("kaboom internal");
      },
      reindex: async () => undefined,
      drop: async () => undefined,
      stop: async () => undefined,
    };
    const calls: { msg: string; fields?: Record<string, unknown> }[] = [];
    const logger = {
      trace: () => undefined,
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (msg: string, fields?: Record<string, unknown>) => {
        calls.push({ msg, fields });
      },
    };
    const app = buildHttpApp({
      supervisor: {
        list: () => [
          { slug: "v", name: "v", state: "running", pid: 1, restarts: 0, lastError: null },
        ],
        get: (s: string) =>
          s === "v"
            ? {
                slug: "v",
                name: "v",
                state: "running" as const,
                pid: 1,
                restarts: 0,
                lastError: null,
              }
            : null,
        stop: async () => undefined,
      },
      indexer: fakeIndexer,
      config: {
        obsidianAuthToken: undefined,
        vaults: [{ name: "v", slug: "v" }],
        dataDir,
        httpPort: 0,
        httpHost: "127.0.0.1",
        embeddingProvider: "transformers",
        embeddingModel: "x",
        logLevel: "error",
        syncConfigEnv: {},
      },
      logger,
    });
    const res = await app.request("/v1/vaults/v/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "x" }),
    });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: { code: string; details: { requestId: string } } };
    expect(body.error.code).toBe("internal");
    expect(typeof body.error.details.requestId).toBe("string");
    expect(calls.length).toBe(1);
    expect(calls[0]?.msg).toBe("http error");
    expect(calls[0]?.fields?.path).toBe("/v1/vaults/v/search");
  });
});

describe("middleware + error handling", () => {
  test("x-request-id is set on every response", async () => {
    const fx = await makeHttpFixture("rid");
    cleanup.push(fx.stop);
    const res = await fx.app.request("/healthz");
    expect(res.headers.get("x-request-id")?.length).toBeGreaterThan(0);
  });

  test("x-request-id from client is honoured", async () => {
    const fx = await makeHttpFixture("rid-pass");
    cleanup.push(fx.stop);
    const res = await fx.app.request("/healthz", {
      headers: { "x-request-id": "rid-from-client" },
    });
    expect(res.headers.get("x-request-id")).toBe("rid-from-client");
  });

  test("unknown route → 404 not_found", async () => {
    const fx = await makeHttpFixture("unknown");
    cleanup.push(fx.stop);
    const res = await fx.app.request("/v1/whatever");
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  test("buildHttpApp without config does not mount /v1 routes", async () => {
    // Build the app with no supervisor / no indexer / no config — the
    // /v1 routes must NOT be mounted, but /healthz must still respond.
    const { buildHttpApp } = await import("../../src/http/index.ts");
    const app = buildHttpApp({});
    const health = await app.request("/healthz");
    expect(health.status).toBe(200);
    const v1 = await app.request("/v1/vaults");
    expect(v1.status).toBe(404);
    const body = (await v1.json()) as { error: { code: string } };
    expect(body.error.code).toBe("not_found");
  });

  test("PUT JSON body with extra unknown keys is rejected (strict schema)", async () => {
    const fx = await makeHttpFixture("put-strict");
    cleanup.push(fx.stop);
    const res = await fx.app.request("/v1/vaults/v/files/x.md", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hi", extra: 1 }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_input");
  });
});

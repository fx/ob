/**
 * `read_file` tool — unexpected-error passthrough for the PDF branch.
 *
 * The tool's PDF branch only remaps `PdfExtractionError` into the
 * `extraction_failed` + retry-hint message; ANY other throw (a bug, an
 * unexpected error) must propagate unchanged so it is not mislabelled as an
 * extraction failure. To exercise that defensive branch we mock the shared
 * `extractPdfMarkdown` to throw a `TypeError`.
 *
 * `mock.module` patches an already-imported live binding, but Bun's
 * `mock.restore()` does NOT undo a module mock — so this test lives in its own
 * file and restores the real module in `afterAll` by re-mocking with the
 * captured real exports, keeping every other test file on the genuine
 * implementation.
 */

import { afterAll, afterEach, expect, mock, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import * as pdfText from "../../../src/vault/pdfText.ts";
import { loadPdfFixture } from "../../helpers/loadPdfFixture.ts";
import { makeMcpFixture } from "../helpers.ts";

const PDF_TEXT_PATH = "../../../src/vault/pdfText.ts";
const REAL_EXTRACT = pdfText.extractPdfMarkdown;
const REAL_ERROR = pdfText.PdfExtractionError;

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanup.length > 0) {
    const f = cleanup.pop();
    if (f !== undefined) await f();
  }
});

afterAll(() => {
  // Restore the genuine module for any later test file in the same process.
  mock.module(PDF_TEXT_PATH, () => ({
    extractPdfMarkdown: REAL_EXTRACT,
    PdfExtractionError: REAL_ERROR,
  }));
});

test("read_file does NOT map a non-extraction error to extraction_failed", async () => {
  mock.module(PDF_TEXT_PATH, () => ({
    PdfExtractionError: REAL_ERROR,
    extractPdfMarkdown: () => {
      throw new TypeError("unexpected boom");
    },
  }));

  const fx = await makeMcpFixture({ label: "tool-rf-pdf-typeerr" });
  cleanup.push(fx.stop);
  writeFileSync(join(fx.vaultRoot, "weird.pdf"), loadPdfFixture("text.pdf"));

  const r = await fx.callTool("read_file", { vault: "v", path: "weird.pdf" });
  expect(r.isError).toBe(true);
  const parsed = r.parsed as { code: string };
  // The TypeError propagates out of the tool handler and is mapped generically
  // ("internal"), NOT swallowed and rebranded as an extraction failure.
  expect(parsed.code).not.toBe("extraction_failed");
  expect(parsed.code).toBe("internal");
});

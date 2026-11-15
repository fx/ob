/**
 * `extractPdfMarkdown` — a failing pdf.js teardown must not mask the result.
 *
 * No real PDF makes `destroy()` throw, so we mock `unpdf` to hand back the
 * genuine document proxy with a throwing `destroy`. `mock.module` patches an
 * already-imported live binding, but Bun's `mock.restore()` does NOT undo a
 * module mock — so this test lives in its own file and restores the real
 * module in `afterAll` by re-mocking with the captured real exports, keeping
 * every other test file on the genuine implementation.
 */

import { afterAll, expect, mock, test } from "bun:test";
import * as unpdf from "unpdf";
import { extractPdfMarkdown } from "../../src/vault/pdfText.ts";
import { loadPdfFixture } from "../helpers/loadPdfFixture.ts";

const REAL_UNPDF = { ...unpdf };

afterAll(() => {
  mock.module("unpdf", () => REAL_UNPDF);
});

test("a throwing destroy() is swallowed and the extraction still returns", async () => {
  let destroyCalls = 0;
  mock.module("unpdf", () => ({
    ...REAL_UNPDF,
    getDocumentProxy: async (...args: Parameters<typeof unpdf.getDocumentProxy>) => {
      const pdf = await REAL_UNPDF.getDocumentProxy(...args);
      const realDestroy = pdf.destroy.bind(pdf);
      pdf.destroy = async () => {
        destroyCalls++;
        await realDestroy();
        throw new Error("teardown boom");
      };
      return pdf;
    },
  }));

  const result = await extractPdfMarkdown(loadPdfFixture("text.pdf"));
  expect(result.pages).toBe(2);
  expect(result.markdown).toBe("alpha\n\n<!-- page 2 -->\n\nbeta");
  expect(destroyCalls).toBe(1);
});

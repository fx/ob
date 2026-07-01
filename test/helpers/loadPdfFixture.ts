/**
 * Load a hand-crafted PDF fixture from `test/fixtures/pdf/` as a standalone
 * `Uint8Array`.
 *
 * The bytes are copied into a fresh view (not a subarray of Node's pooled
 * `Buffer`) so callers get an isolated buffer with a zero offset — the shape
 * the vault/service code and REST byte comparisons expect. Fixtures are built
 * by `test/fixtures/pdf/build.ts`.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

const PDF_FIXTURES = join(import.meta.dir, "../fixtures/pdf");

export function loadPdfFixture(name: string): Uint8Array {
  const buf = readFileSync(join(PDF_FIXTURES, name));
  const view = new Uint8Array(buf.byteLength);
  view.set(buf);
  return view;
}

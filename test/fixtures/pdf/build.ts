/**
 * Regenerates the hand-crafted PDF fixtures used by the extraction tests.
 *
 * These are deliberately minimal PDFs (a few hundred bytes) whose xref
 * offsets are computed from the actual serialized byte positions so pdf.js
 * (via `unpdf`) accepts them. Run with `bun test/fixtures/pdf/build.ts` after
 * changing fixture content. Not a `.test.ts` file, so `bun test` skips it.
 *
 * - `text.pdf`         two pages whose text layers are "alpha" and "beta"
 * - `scanned.pdf`      one page with an empty content stream (no text objects)
 * - `broken.pdf`       a valid header followed by garbage / truncation
 * - `mixed.pdf`        three pages: "alpha", empty (image-only), "gamma"
 * - `mixed-leading.pdf` two pages: empty (image-only), then "beta"
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

function buildPdf(objects: string[]): Uint8Array {
  const enc = new TextEncoder();
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 0; i < objects.length; i++) {
    offsets.push(enc.encode(body).length);
    body += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = enc.encode(body).length;
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  xref += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return enc.encode(body + xref);
}

function contentStream(text: string): string {
  const stream = `BT /F1 24 Tf 72 700 Td (${text}) Tj ET`;
  const length = new TextEncoder().encode(stream).length;
  return `<< /Length ${length} >>\nstream\n${stream}\nendstream`;
}

const textPdf = buildPdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
  contentStream("alpha"),
  contentStream("beta"),
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
]);

const scannedPdf = buildPdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>",
  "<< /Length 0 >>\nstream\n\nendstream",
]);

const brokenPdf = new TextEncoder().encode("%PDF-1.4\n%garbage\x01\x02\x03 not a real pdf");

const emptyStream = "<< /Length 0 >>\nstream\n\nendstream";

// Three pages — text, image-only (no text objects), text — so the join must
// drop the middle page and keep "gamma"'s own physical page number (3) in its
// marker: "alpha\n\n<!-- page 3 -->\n\ngamma".
const mixedPdf = buildPdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 9 0 R >> >> >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 7 0 R /Resources << >> >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 8 0 R /Resources << /Font << /F1 9 0 R >> >> >>",
  contentStream("alpha"),
  emptyStream,
  contentStream("gamma"),
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
]);

// Leading image-only page followed by a text page — the first emitted page is
// page 2, so it MUST still carry its "<!-- page 2 -->" marker with no leading
// blank run: "<!-- page 2 -->\n\nbeta".
const mixedLeadingPdf = buildPdf([
  "<< /Type /Catalog /Pages 2 0 R >>",
  "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << >> >>",
  "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>",
  emptyStream,
  contentStream("beta"),
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
]);

const dir = import.meta.dir;
writeFileSync(join(dir, "text.pdf"), textPdf);
writeFileSync(join(dir, "scanned.pdf"), scannedPdf);
writeFileSync(join(dir, "broken.pdf"), brokenPdf);
writeFileSync(join(dir, "mixed.pdf"), mixedPdf);
writeFileSync(join(dir, "mixed-leading.pdf"), mixedLeadingPdf);
console.log("wrote text.pdf, scanned.pdf, broken.pdf, mixed.pdf, mixed-leading.pdf");

/**
 * Shared-core PDF text extraction.
 *
 * `extractPdfMarkdown(bytes)` pulls the text layer out of a PDF and returns it
 * as Markdown-safe plain text with page markers. Both adapters (MCP
 * `read_file`, REST JSON read) call this so a PDF read yields readable text an
 * LLM can consume instead of a base64 blob that blows past token limits.
 *
 * Extraction runs on `unpdf` (a Bun-friendly, pre-bundled build of pdf.js) via
 * `extractText(pdf, { mergePages: false })`, which preserves page boundaries.
 * Pages are joined with `\n\n<!-- page N -->\n\n` markers (N = the 1-based
 * number of the FOLLOWING page; no marker before page 1). The markers are HTML
 * comments so they never collide with content-derived Markdown structure and
 * stay invisible in rendered output while giving callers page anchors.
 *
 * A PDF with no text objects (scanned/image-only) is a SUCCESS, not an error:
 * `hasTextLayer` is `false` and `markdown` is `""`. Only a genuinely
 * unparseable PDF (corrupt, encrypted) throws `PdfExtractionError`, which the
 * adapters translate to the `extraction_failed` code. OCR is out of scope.
 */

import { extractText, getDocumentProxy } from "unpdf";
import { OBError } from "../errors.ts";

export interface PdfExtraction {
  /** Extracted text with page markers; `""` when there is no text layer. */
  readonly markdown: string;
  /** Total page count reported by the PDF (≥ 1 for any valid PDF). */
  readonly pages: number;
  /** `false` when every page's trimmed text is empty (scanned/image-only). */
  readonly hasTextLayer: boolean;
}

/**
 * Thrown when a PDF cannot be parsed at all (corrupt bytes, encrypted /
 * password-protected). Carries the shared `extraction_failed` code so the REST
 * mapper emits a `422` and the MCP mapper emits an `isError` block with the
 * same code — a scanned PDF does NOT throw this (see module header).
 */
export class PdfExtractionError extends OBError {
  override readonly code = "extraction_failed" as const;
  // biome-ignore lint/complexity/noUselessConstructor: explicit ctor needed for Bun coverage tracking.
  constructor(message: string, details?: Record<string, unknown>) {
    super(message, details);
  }
}

/**
 * Whitespace-normalize a single page: trim the outer edges and collapse runs
 * of 3+ newlines to exactly 2 so page text stays Markdown-safe without any
 * heading/list reconstruction (explicitly out of scope for v1).
 */
function normalizePage(text: string): string {
  return text.trim().replace(/\n{3,}/g, "\n\n");
}

/**
 * Extract the text layer from PDF bytes. Resolves with `hasTextLayer: false`
 * and empty `markdown` for image-only PDFs; throws `PdfExtractionError` when
 * the PDF cannot be parsed.
 */
export async function extractPdfMarkdown(bytes: Uint8Array): Promise<PdfExtraction> {
  let pageTexts: string[];
  let pages: number;
  try {
    const pdf = await getDocumentProxy(bytes);
    const result = await extractText(pdf, { mergePages: false });
    pages = result.totalPages;
    pageTexts = result.text;
  } catch (e) {
    throw new PdfExtractionError(`failed to parse PDF: ${String(e)}`);
  }
  const normalized = pageTexts.map(normalizePage);
  const hasTextLayer = normalized.some((page) => page.length > 0);
  if (!hasTextLayer) {
    return { markdown: "", pages, hasTextLayer: false };
  }
  const markdown = normalized
    .map((page, i) => (i === 0 ? page : `<!-- page ${i + 1} -->\n\n${page}`))
    .join("\n\n");
  return { markdown, pages, hasTextLayer: true };
}

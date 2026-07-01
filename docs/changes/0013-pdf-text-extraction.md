# 0013: PDF Text Extraction on Read

## Summary

`read_file` (MCP) and the JSON read variant (REST) return extracted plain-text/Markdown content for PDFs by default, instead of the raw base64/binary payload. Callers can still request the verbatim bytes explicitly. Motivated by real agent failures: a base64-encoded PDF blew past the MCP client's token ceiling (~224k characters for a modest PDF) while carrying zero readable signal for the model.

**Spec:** [MCP Server](../specs/mcp-server/) (and [REST API](../specs/rest-api/) for the mirrored surface)
**Status:** draft
**Depends On:** 0004, 0005

## Motivation

- An MCP client calling `read_file` on a `.pdf` today receives the whole file base64-encoded in a single text block. For any real PDF this exceeds tool-result token limits, and even when it fits, base64 bytes are useless to an LLM.
- The REST JSON variant (`Accept: application/json`) hard-rejects non-Markdown with `406`, so there is no text-oriented read path for PDFs on either adapter.
- Vaults routinely contain PDFs (Obsidian Sync has first-class `pdf` file-type support, mirrored by our `SyncFileType` in `src/config/index.ts`), so "read the attached paper" is a mainline agent workflow, not an edge case.

## Requirements

### Testing Requirements

This change MUST satisfy the project's standing testing rules (see [Architecture › Testing & Lint](../specs/architecture/index.md#testing--lint)). CI enforces these as merge gates:

- Tests MUST use `bun test` (no Jest, no Vitest); coverage via `bun test --coverage` MUST stay at 100% line and branch on `src/`.
- A **parity test** under `test/parity/` MUST drive both adapters (MCP `read_file` and REST `GET …/files/*path` with `Accept: application/json`) against the same fixture PDFs and assert structurally identical success payloads and identical error `code`s.
- Network calls MUST be mocked; PDF extraction MUST run against real fixture bytes on disk (extraction is local compute, not network).
- `tsc --noEmit` and Biome MUST pass; any `// @ts-expect-error` / `// biome-ignore` MUST carry a one-line justification.
- The `ob` binary smoke test (`ob --help` exits 0) MUST remain green.

Skipping or weakening any of these rules to land the PR MUST be treated as a bug in the PR, not in the rule.

### Core extraction module

- A shared-core module `src/vault/pdfText.ts` MUST expose `extractPdfMarkdown(bytes: Uint8Array): Promise<PdfExtraction>` where `PdfExtraction = { markdown: string, pages: number, hasTextLayer: boolean }`.
- Extraction MUST use `unpdf` (`extractText(pdf, { mergePages: false })`) so page boundaries are preserved.
- Pages MUST be joined with `\n\n<!-- page N -->\n\n` markers (N is the 1-based page number of the page that follows; no marker before page 1). Markers are HTML comments so they never collide with content-derived Markdown structure.
- Per-page text SHOULD be whitespace-normalized: trim each page, collapse runs of 3+ newlines to 2. No heading/list reconstruction in v1 — output is Markdown-safe plain text, not reflowed Markdown.
- `hasTextLayer` MUST be `false` when the concatenated, trimmed text of all pages is empty (scanned/image-only PDF). This is a successful result, NOT an error; `markdown` is `""`.
- If the PDF cannot be parsed (corrupt, encrypted/password-protected), the module MUST throw a typed error that adapters map to error code `extraction_failed`. OCR is OUT OF SCOPE.

#### Scenario: Text-layer PDF

- **GIVEN** a two-page PDF whose pages contain "alpha" and "beta"
- **WHEN** `extractPdfMarkdown(bytes)` resolves
- **THEN** `markdown` is `"alpha\n\n<!-- page 2 -->\n\nbeta"` (modulo intra-page whitespace)
- **AND** `pages` is `2` and `hasTextLayer` is `true`

#### Scenario: Scanned PDF

- **GIVEN** a PDF containing only a full-page image and no text objects
- **WHEN** `extractPdfMarkdown(bytes)` resolves
- **THEN** `markdown` is `""`, `pages` ≥ 1, `hasTextLayer` is `false`

### MCP `read_file` gains `format`

- The `read_file` input schema MUST gain `format?: "text" | "binary"`, default `"text"`.
- With `format: "text"` (or omitted):
  - Text files (per `isTextMimeType`) MUST behave exactly as today (`encoding: "utf-8"`, frontmatter for Markdown).
  - PDFs MUST return `{ path, contentType: "application/pdf", content: <extracted markdown>, encoding: "utf-8", pdf: { pages, hasTextLayer }, mtimeMs, size, sha256 }`. `size` and `sha256` MUST describe the original on-disk bytes, not the extracted text.
  - Other binaries (images, unknown types) MUST behave exactly as today (`encoding: "base64"`); there is no extractor for them.
- With `format: "binary"`, the tool MUST return the verbatim file bytes base64-encoded (`encoding: "base64"`) for ANY file type, including Markdown and PDFs. No frontmatter parsing.
- A PDF that fails to parse under `format: "text"` MUST return `isError: true` with `{ code: "extraction_failed", message }`; the message MUST tell the caller to retry with `format: "binary"` for the raw bytes.
- The tool description MUST state: PDFs return extracted text by default; pass `format: "binary"` for verbatim base64 bytes.

#### Scenario: Read a PDF returns extracted text by default

- **GIVEN** vault `v` contains `papers/attention.pdf` with a text layer
- **WHEN** the client invokes `read_file` with `{ vault: "v", path: "papers/attention.pdf" }`
- **THEN** the response is not an error, `encoding` is `"utf-8"`, `contentType` is `"application/pdf"`
- **AND** `content` is the extracted text and `pdf.hasTextLayer` is `true`

#### Scenario: Explicitly request the binary

- **GIVEN** the same vault and file
- **WHEN** the client invokes `read_file` with `{ vault: "v", path: "papers/attention.pdf", format: "binary" }`
- **THEN** `encoding` is `"base64"` and decoding `content` yields the original PDF bytes

#### Scenario: Encrypted PDF fails closed

- **GIVEN** vault `v` contains a password-protected `secret.pdf`
- **WHEN** the client invokes `read_file` with default `format`
- **THEN** the response is `isError: true` with `code: "extraction_failed"`

### REST JSON variant accepts PDFs

- `GET /v1/vaults/:slug/files/*path` with `Accept: application/json` on a `.pdf` MUST return `200 { path, content, contentType, pdf: { pages, hasTextLayer }, mtimeMs, size, sha256 }` (extracted text; no `frontmatter` field) instead of today's `406`.
- The default (non-JSON) GET MUST keep returning raw bytes with `Content-Type: application/pdf` — byte round-trip is unchanged.
- Non-Markdown, non-PDF files with `Accept: application/json` MUST still return `406`.
- Extraction failure MUST return `422` with `error.code = "extraction_failed"`; the closed error-code set in the REST spec gains `extraction_failed`.

#### Scenario: JSON read of a PDF

- **GIVEN** vault `v` contains `papers/attention.pdf`
- **WHEN** the client `GET`s `/v1/vaults/v/files/papers/attention.pdf` with `Accept: application/json`
- **THEN** the response is `200` JSON with `content` = extracted text and `pdf.pages` ≥ 1
- **AND** a plain `GET` of the same URL still returns the verbatim bytes with `Content-Type: application/pdf`

### Parity

- MCP `read_file` `format: "text"` on a PDF and REST JSON read of the same PDF MUST produce structurally identical payloads (modulo the MCP-only `encoding` field and transport envelope), including identical `pdf` metadata and identical `extraction_failed` codes on failure.
- MCP `format: "binary"` MUST decode to the exact bytes REST serves on a plain GET.

## Design

### Approach

- **Dependency:** add `unpdf` (exact-pinned, matching existing dependency style). MIT, pure JS/WASM serverless build of pdf.js v5 with Bun support — no native bindings, no Docker image changes.
- **Core:** new `src/vault/pdfText.ts` (extraction + page joining + typed `PdfExtractionError`). New helper `isPdfPath(path)` in `src/vault/contentType.ts`.
- **Adapters (thin, per architecture):**
  - `src/mcp/tools/read_file.ts` — add `format` to the Zod input; branch: text-mime → unchanged; PDF + `text` → `extractPdfMarkdown`; anything + `binary` → base64.
  - `src/http/routes/files.ts` — in the `Accept: application/json` branch, allow `.pdf` alongside `.md`.
- **Errors:** `extraction_failed` added to the shared error-code set (`422` on REST; `isError` text block on MCP).
- **Fixtures:** `test/fixtures/pdf/` gains three hand-crafted minimal PDFs: `text.pdf` (two pages of known text), `scanned.pdf` (no text objects), `broken.pdf` (truncated/garbage after header). Minimal PDFs are a few hundred bytes written as literals — no binary blobs in git history beyond that.

### Decisions

- **Decision:** `unpdf` over `pdfjs-dist`, `pdf-parse`, `mupdf.js`, poppler `pdftotext`.
  - **Why:** only permissive-licensed option that runs on Bun without polyfill surgery (pdf.js ≥5 needs DOM/worker shims that unpdf pre-bundles). ~1.35M weekly downloads, actively maintained (v1.6.x, 2026). Per-page output and trivially detectable empty text layer.
  - **Alternatives:** `pdf-parse` v2 has an open Bun crash (`DOMMatrix` ReferenceError) and a native `@napi-rs/canvas` dep; `mupdf.js` has the best structure output but is AGPL; poppler CLI adds ~35MB of system deps to the image and GPL; raw `pdfjs-dist` is unpdf minus the packaging.
- **Decision:** default is extraction (`format: "text"`), binary is opt-in.
  - **Why:** the tool exists to feed an LLM; base64 is the wrong default for that consumer and demonstrably breaks clients. Byte-preserving reads remain one explicit argument away (and REST's plain GET is untouched for machine consumers).
- **Decision:** scanned PDFs succeed with `hasTextLayer: false` rather than erroring.
  - **Why:** "this PDF has no text layer" is an answer, not a failure; an error would push agents into retry loops. The flag lets callers decide to fetch the binary for OCR elsewhere.
- **Decision:** page markers are HTML comments (`<!-- page N -->`), not headings or rules.
  - **Why:** synthetic `##` headings would corrupt document structure for downstream consumers; `---` collides with frontmatter/thematic breaks. Comments are invisible in rendered Markdown yet give LLMs page anchors for citations.
- **Decision:** `sha256`/`size` keep describing the on-disk file even for extracted reads.
  - **Why:** they are identity/etag fields; extracted text is a derived view. Changing their meaning per-format would break change-detection callers.

### Non-Goals

- OCR for image-only PDFs.
- Indexing/searching PDF content (the indexer remains Markdown-only; see Open Questions).
- Extraction for other binary formats (docx, epub, images).
- Heading/list/table reconstruction from PDF layout — v1 output is plain text with page markers.
- Offset/limit or page-range reads of extracted text.

## Tasks

- [ ] Core extraction + contentType helper — add `unpdf` (exact pin); implement `src/vault/pdfText.ts` (`extractPdfMarkdown`, page joining, whitespace normalization, `PdfExtractionError`) and `isPdfPath()` in `src/vault/contentType.ts`; create `test/fixtures/pdf/{text,scanned,broken}.pdf`; unit tests in `test/vault/pdfText.test.ts` covering text-layer, scanned, corrupt, and page-marker format (100% branch)
- [ ] Adapters + error code — add `format` to MCP `read_file` (schema, branching, updated tool description) with tests in `test/mcp/tools/read_file.test.ts`; extend REST JSON-variant branch in `src/http/routes/files.ts` for PDFs (200 JSON, 422 `extraction_failed`, 406 preserved for other binaries) with tests in `test/http/routes.test.ts`; register `extraction_failed` in the shared error model
- [ ] Parity + docs — extend `test/parity/read_file.test.ts` with text-format PDF parity, binary-format byte parity, and `extraction_failed` code parity; verify coverage stays 100%; flip this change to complete and update spec changelogs if wording drifted

## Open Questions

- [ ] Should extracted PDF text feed the search index (chunker/embeddings)? — Natural follow-up; needs its own change against [vault-indexer](../specs/vault-indexer/). **Default:** not in this change.
- [ ] Page-range / truncation controls (`pages: "3-7"`, `maxChars`) for very large PDFs whose *extracted* text still overflows client token limits? — **Default:** not in v1; the extracted text of typical vault PDFs is an order of magnitude smaller than its base64.
- [ ] Light structure reconstruction (headings from font-size heuristics, e.g. `@opendocsg/pdf2md`)? — **Default:** not in v1; plain text with page markers is sufficient for reading workflows.

## References

- Spec: [MCP Server](../specs/mcp-server/), [REST API](../specs/rest-api/)
- Related changes: [0004-rest-api](./0004-rest-api.md), [0005-mcp-server](./0005-mcp-server.md)
- External: [unpdf](https://github.com/unjs/unpdf) · [pdf-parse Bun crash #73](https://github.com/mehmet-kozan/pdf-parse/issues/73) (why not pdf-parse)

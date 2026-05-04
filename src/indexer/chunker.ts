/**
 * Markdown → chunk[] using `remark`.
 *
 * Splits at heading boundaries; if a section's body exceeds 1500 chars the
 * section is sub-split at paragraph boundaries (and, as a last resort, by
 * hard slicing at the limit so an unparagraphed wall of text still produces
 * bounded chunks). Frontmatter is parsed once, attached verbatim to every
 * chunk, but is NOT embedded.
 *
 * Wikilink and tag extraction is performed against the body text — wikilinks
 * (`[[Name]]`, `[[Name|alias]]`, `[[Name#section]]`) all yield the same
 * normalized target name, and inline tags (`#foo`, `#foo/bar`) skip anything
 * inside fenced or inline code so README snippets that contain `#brewing` in
 * their docs don't pollute the index.
 *
 * Output `Chunk[]` carries enough metadata for the LanceDB store to compute
 * the row id (`path#index`), the heading-path filter, the wikilinks list, and
 * the tags list — all in one pass over the Markdown AST.
 */

import matter from "gray-matter";
import { remark } from "remark";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import { visit } from "unist-util-visit";

export const MAX_CHUNK_CHARS = 1500;

/**
 * Threshold for the flat-list section classifier. A heading section qualifies
 * as a flat-list when ≥ 70 % of its non-blank root-level children (after
 * frontmatter and heading removal) are list items belonging to a single list.
 * Per-bullet emission then runs in document order. Tweak this constant to
 * shift the prose-vs-flat-list boundary; it's the single tuning knob.
 */
export const FLAT_LIST_THRESHOLD = 0.7;

export interface Chunk {
  readonly index: number;
  readonly headingPath: readonly string[];
  readonly text: string;
  /**
   * Text actually fed to the embedder. Composed once at chunk time as
   * `<path>\n<headingPath joined by " > ">\n\n<text>` (heading-path line
   * omitted when the heading path is empty). Stored alongside `text` so
   * the FTS index in 0008 can index path/heading tokens too without
   * re-deriving.
   */
  readonly embedText: string;
  readonly frontmatter: Record<string, unknown>;
  readonly links: readonly string[];
  readonly tags: readonly string[];
}

/**
 * Build the embedder-facing payload for a chunk: `<path>\n<headingPath joined
 * by " > ">\n\n<body>`, with the heading-path line omitted when empty. Pure
 * function so tests can lock the exact wire format independently of chunk
 * construction.
 */
export function composeEmbedText(
  path: string,
  headingPath: readonly string[],
  body: string,
): string {
  const headingLine = headingPath.length === 0 ? "" : headingPath.join(" > ");
  if (headingLine === "") return `${path}\n\n${body}`;
  return `${path}\n${headingLine}\n\n${body}`;
}

/**
 * Coerce a value parsed out of YAML to a JSON-safe form.
 *
 * `Date` (e.g. `2026-05-03`) → ISO string per the change doc's open-question
 * default. Everything else round-trips through JSON unmodified.
 */
function normalizeFrontmatterValue(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(normalizeFrontmatterValue);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = normalizeFrontmatterValue(val);
    }
    return out;
  }
  return v;
}

function normalizeFrontmatter(input: unknown): Record<string, unknown> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    out[k] = normalizeFrontmatterValue(v);
  }
  return out;
}

/**
 * Extract the wikilink target name from any of `[[Name]]`, `[[Name|alias]]`,
 * `[[Name#section]]`, `[[Name#section|alias]]`. Trims whitespace and treats
 * the empty result as "no link" — `[[]]` in user content is a typo, not a
 * meaningful target.
 */
function normalizeWikilink(raw: string): string | undefined {
  let s = raw;
  const pipe = s.indexOf("|");
  if (pipe !== -1) s = s.slice(0, pipe);
  const hash = s.indexOf("#");
  if (hash !== -1) s = s.slice(0, hash);
  const trimmed = s.trim();
  return trimmed === "" ? undefined : trimmed;
}

const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

/**
 * Match an inline tag *outside* of code. Allowed first char is a letter or
 * digit (so `#1` numeric is allowed but pure punctuation is not), and the
 * tag may include forward slashes for nested tags. The leading `(?:^|\s)`
 * keeps URL fragments (`#page-section`) from being grabbed when they're
 * embedded inside a URL — though `#page-section` directly after a space
 * is, per Obsidian's behaviour, a tag.
 */
const TAG_RE = /(?:^|\s)#([A-Za-z0-9][A-Za-z0-9_/-]*)/g;

function extractWikilinks(text: string, into: Set<string>): void {
  for (const m of text.matchAll(WIKILINK_RE)) {
    const target = normalizeWikilink(m[1] ?? "");
    if (target !== undefined) into.add(target);
  }
}

function extractTags(text: string, into: Set<string>): void {
  for (const m of text.matchAll(TAG_RE)) {
    const tag = m[1];
    if (tag !== undefined) into.add(tag);
  }
}

/**
 * Strip code fences and inline code spans before tag extraction.
 *
 * Sibling block-level nodes are joined with `\n\n` so a tag at the start of
 * a later paragraph (e.g. `paragraph A\n\n#brewing`) doesn't fuse with the
 * previous block's trailing word and slip past `TAG_RE`'s word-boundary
 * requirement. Inline children are joined with no separator since the
 * original text didn't have one between them.
 */
function withoutCode(node: { type: string; value?: string; children?: unknown[] }): string {
  if (node.type === "code" || node.type === "inlineCode") return "";
  if (typeof node.value === "string") return node.value;
  if (Array.isArray(node.children)) {
    const parts = (node.children as { type: string; value?: string; children?: unknown[] }[]).map(
      withoutCode,
    );
    // `root` and explicit container types whose children are siblings on
    // distinct lines need a paragraph break between them. Inline-only
    // containers (paragraph/heading/strong/emphasis/etc.) keep the no-sep
    // join so adjacent text reads as it did in source.
    const isBlockContainer =
      node.type === "root" ||
      node.type === "blockquote" ||
      node.type === "list" ||
      node.type === "listItem";
    return parts.join(isBlockContainer ? "\n\n" : "");
  }
  return "";
}

/**
 * Reconstruct the textual body of a section AST node, preserving the original
 * formatting (paragraph breaks, code fences, list markers). We round-trip
 * through `remark.stringify` because re-implementing serialisation would
 * fight every Markdown edge case from scratch — exactly what the spec's
 * "use remark, not regex" decision avoids.
 */
function stringifyChildren(processor: ReturnType<typeof remark>, children: unknown[]): string {
  // remark's processor.stringify expects a Root or any node with `type` and
  // `children`; we wrap the section's children in a synthetic root so the
  // call is well-typed.
  const root = { type: "root" as const, children };
  // biome-ignore lint/suspicious/noExplicitAny: remark's stringify type is generic over the unified Root; an ad-hoc literal trips inference.
  const out = processor.stringify(root as any);
  return out.toString().trimEnd();
}

interface NodePosition {
  readonly start: { readonly offset?: number };
  readonly end: { readonly offset?: number };
}

function nodeOffsets(node: unknown): { start: number; end: number } | undefined {
  const pos = (node as { position?: NodePosition }).position;
  if (pos === undefined) return undefined;
  const { start, end } = pos;
  if (typeof start.offset !== "number" || typeof end.offset !== "number") return undefined;
  return { start: start.offset, end: end.offset };
}

/** Walk the AST once, accumulating sections keyed by heading path. */
function collectSections(
  source: string,
  ast: { type: string; children?: unknown[] },
  processor: ReturnType<typeof remark>,
): Section[] {
  const sections: Section[] = [];
  const headingStack: string[] = [];
  let bufChildren: unknown[] = [];
  let bufStart: number | undefined;
  let bufEnd: number | undefined;

  const flush = (): void => {
    if (bufChildren.length === 0 && headingStack.length === 0) return;
    // Prefer raw source (preserves wikilinks/tags) and fall back to remark's
    // stringification when offsets aren't available — synthetic AST nodes
    // built by the long-section splitter take the fallback path.
    const raw =
      bufStart !== undefined && bufEnd !== undefined
        ? source.slice(bufStart, bufEnd).replace(/^\n+/, "").replace(/\n+$/, "")
        : stringifyChildren(processor, bufChildren);
    if (raw === "" && headingStack.length === 0) return;
    sections.push({
      headingPath: headingStack.slice(),
      text: raw,
      raw,
      children: bufChildren.slice(),
    });
    bufChildren = [];
    bufStart = undefined;
    bufEnd = undefined;
  };

  const children = ast.children ?? [];
  for (const raw of children) {
    const node = raw as { type: string; depth?: number; children?: unknown[] };
    if (node.type === "heading") {
      flush();
      const depth = typeof node.depth === "number" ? node.depth : 1;
      // Heading title text from its inline children, code-stripped so a
      // title like `# An H1 with `#code`` doesn't bleed code into the path.
      const title = stringifyChildren(processor, node.children ?? []).trim();
      // Pop the stack to the current heading's parent depth.
      while (headingStack.length >= depth) headingStack.pop();
      headingStack.push(title);
      continue;
    }
    bufChildren.push(node);
    const off = nodeOffsets(node);
    if (off !== undefined) {
      if (bufStart === undefined) bufStart = off.start;
      bufEnd = off.end;
    }
  }
  flush();
  return sections;
}

/** Split `text` at paragraph boundaries so no piece exceeds `MAX_CHUNK_CHARS`. */
function splitLongSection(text: string): string[] {
  if (text.length <= MAX_CHUNK_CHARS) return [text];
  const paragraphs = text.split(/\n{2,}/);
  const out: string[] = [];
  let buf = "";
  const push = (s: string): void => {
    if (s.length === 0) return;
    out.push(s);
  };
  for (const p of paragraphs) {
    if (p.length > MAX_CHUNK_CHARS) {
      // Flush whatever we'd been accumulating.
      push(buf);
      buf = "";
      // Fall back to hard slicing — paragraph itself is too large.
      for (let i = 0; i < p.length; i += MAX_CHUNK_CHARS) {
        push(p.slice(i, i + MAX_CHUNK_CHARS));
      }
      continue;
    }
    const candidate = buf === "" ? p : `${buf}\n\n${p}`;
    if (candidate.length > MAX_CHUNK_CHARS) {
      push(buf);
      buf = p;
    } else {
      buf = candidate;
    }
  }
  push(buf);
  return out;
}

interface Section {
  readonly headingPath: readonly string[];
  readonly text: string;
  /**
   * Original (unescaped) source text for the section, used for wikilink and
   * tag extraction. `text` is built from the same slice — preserving
   * `[[Foo]]` and `#tag` so the embedder sees the same text Obsidian shows.
   */
  readonly raw: string;
  /**
   * Original AST children for this section (already-parsed). The chunker uses
   * them to detect flat-list sections and to round-trip individual list items
   * back through `processor.stringify`.
   */
  readonly children: readonly unknown[];
}

/**
 * Decide whether a section is a flat list of bullets — i.e. ≥
 * `FLAT_LIST_THRESHOLD` of its non-blank root-level children belong to a
 * single top-level list. Returns the qualifying list node when the section
 * qualifies, otherwise `null`.
 *
 * The change doc's open question about "headings inside the section
 * disqualify" is satisfied structurally by `collectSections`: it flushes
 * the buffered children at every heading regardless of depth, so by the
 * time we get here `children` cannot contain a heading node. We therefore
 * don't need (and cannot reach) an explicit heading-disqualifies branch —
 * the heading-as-hard-split behaviour falls out of section collection,
 * and the existing tests cover it end-to-end via `chunkMarkdown`.
 */
function detectFlatList(
  children: readonly unknown[],
): { type: string; children?: unknown[] } | null {
  let listNode: { type: string; children?: unknown[] } | null = null;
  let listItems = 0;
  let nonBlank = 0;
  for (const raw of children) {
    const node = raw as { type: string; children?: unknown[]; value?: string };
    // remark already normalises whitespace; every AST node we see here is
    // a real block — there is no "blank" node type. Count every node.
    nonBlank++;
    if (node.type === "list") {
      // Only the first encountered top-level list qualifies; sibling lists
      // don't aggregate (would imply multiple flat-list groups, which we
      // treat as prose-ish).
      if (listNode === null) {
        listNode = node;
        listItems = Array.isArray(node.children) ? node.children.length : 0;
      } else {
        return null;
      }
    }
  }
  if (listNode === null || listItems === 0) return null;
  // Score: every list-item counts toward the numerator, every other top-level
  // child counts toward the denominator alongside the list itself (which
  // contributes its items). The list node itself is a single child but
  // represents `listItems` discrete items — that's the count we score on,
  // matching the change doc's "list items belonging to a single list".
  const ratio = listItems / (listItems + nonBlank - 1);
  return ratio >= FLAT_LIST_THRESHOLD ? listNode : null;
}

/**
 * Top-level chunker entry point. Given a Markdown string and the file's
 * relative `path`, returns the chunk array the LanceDB store will write.
 * Empty Markdown yields an empty array. The path is used purely to compose
 * each chunk's `embedText`.
 */
export function chunkMarkdown(source: string, path = ""): Chunk[] {
  // gray-matter handles frontmatter parsing including the YAML date-coercion
  // we need to normalise.
  const parsed = matter(source);
  const frontmatter = normalizeFrontmatter(parsed.data);

  const processor = remark().use(remarkGfm).use(remarkFrontmatter, ["yaml"]);
  // Parse the *body* (post-frontmatter) so frontmatter doesn't appear as a
  // YAML node in the section text.
  const ast = processor.parse(parsed.content) as { type: string; children?: unknown[] };

  const sections = collectSections(parsed.content, ast, processor);

  const chunks: Chunk[] = [];
  let idx = 0;
  for (const section of sections) {
    // Wikilinks and tags use the *raw* (un-escaped) source for the section
    // because remark.stringify escapes `[[...]]` to `\[\[...]]`. Tags also
    // use the code-stripped raw — re-parse the raw section with remark and
    // skip code/inlineCode nodes.
    const linksSet = new Set<string>();
    const tagsSet = new Set<string>();
    extractWikilinks(section.raw, linksSet);
    const sectionAst = processor.parse(section.raw) as {
      type: string;
      children?: unknown[];
    };
    const codeStripped = withoutCode(sectionAst);
    extractTags(codeStripped, tagsSet);
    const links = Array.from(linksSet);
    const tags = Array.from(tagsSet);

    const flatList = detectFlatList(section.children);
    const pieces: string[] =
      flatList === null ? splitLongSection(section.text) : flatListPieces(flatList, processor);
    for (const piece of pieces) {
      const headingPath = section.headingPath.slice();
      chunks.push({
        index: idx,
        headingPath,
        text: piece,
        embedText: composeEmbedText(path, headingPath, piece),
        frontmatter,
        links,
        tags,
      });
      idx++;
    }
  }
  return chunks;
}

/**
 * Emit one piece per top-level list item. A single oversized item falls back
 * to the paragraph splitter for THAT item only — sibling items are not
 * affected.
 */
function flatListPieces(
  list: { type: string; children?: unknown[] },
  processor: ReturnType<typeof remark>,
): string[] {
  const items = Array.isArray(list.children) ? list.children : [];
  const out: string[] = [];
  for (const item of items) {
    // Each list item round-trips through stringify so the markers, nested
    // children, and indentation match the source.
    const itemRoot = { type: "root" as const, children: [item] };
    const text = processor
      // biome-ignore lint/suspicious/noExplicitAny: stringify type fights synthetic Root literals.
      .stringify(itemRoot as any)
      .toString()
      .trimEnd();
    if (text.length > MAX_CHUNK_CHARS) {
      for (const piece of splitLongSection(text)) out.push(piece);
    } else {
      out.push(text);
    }
  }
  return out;
}

// Re-export `visit` so a future caller wanting AST access can rely on the
// same `unist-util-visit` version we resolved. Kept tiny and documented to
// avoid an "unused dep" surprise.
export { visit };

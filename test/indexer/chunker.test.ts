import { describe, expect, test } from "bun:test";
import {
  FLAT_LIST_THRESHOLD,
  MAX_CHUNK_CHARS,
  chunkMarkdown,
  composeEmbedText,
  visit,
} from "../../src/indexer/chunker.ts";

describe("chunkMarkdown", () => {
  test("splits at heading boundaries", () => {
    const md = "# H1\n\nbody1\n\n## H2\n\nbody2\n\n## H2b\n\nbody3";
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBe(3);
    expect(chunks[0]?.headingPath).toEqual(["H1"]);
    expect(chunks[1]?.headingPath).toEqual(["H1", "H2"]);
    expect(chunks[2]?.headingPath).toEqual(["H1", "H2b"]);
    expect(chunks[0]?.index).toBe(0);
    expect(chunks[2]?.index).toBe(2);
  });

  test("long section splits at paragraph boundaries — ≥ 3 chunks, all under limit, identical headingPath", () => {
    const para = `${"x".repeat(1300)}.`;
    const md = `# H1\n\n${para}\n\n${para}\n\n${para}`;
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(c.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
      expect(c.headingPath).toEqual(["H1"]);
    }
  });

  test("paragraph longer than the limit is hard-sliced", () => {
    const para = "y".repeat(4000);
    const chunks = chunkMarkdown(`# H1\n\n${para}`);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
  });

  test("frontmatter is parsed and attached to every chunk; YAML date → ISO string", () => {
    const md = ["---", "title: Hello", "date: 2026-05-03", "---", "", "# H1", "", "body"].join(
      "\n",
    );
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.frontmatter).toEqual({
      title: "Hello",
      date: "2026-05-03T00:00:00.000Z",
    });
  });

  test("frontmatter with nested objects is normalised recursively", () => {
    const md = ["---", "meta:", "  created: 2026-05-03", "---", "", "# H", "", "x"].join("\n");
    const chunks = chunkMarkdown(md);
    expect(chunks[0]?.frontmatter).toEqual({
      meta: { created: "2026-05-03T00:00:00.000Z" },
    });
  });

  test("frontmatter with arrays of dates", () => {
    const md = [
      "---",
      "dates:",
      "  - 2026-01-01",
      "  - 2026-02-02",
      "---",
      "",
      "# H",
      "",
      "x",
    ].join("\n");
    const chunks = chunkMarkdown(md);
    expect(chunks[0]?.frontmatter).toEqual({
      dates: ["2026-01-01T00:00:00.000Z", "2026-02-02T00:00:00.000Z"],
    });
  });

  test("frontmatter that is not a YAML object stays empty", () => {
    // gray-matter returns `null` for empty frontmatter blocks.
    const md = "---\n---\n\n# H\n\nx";
    const chunks = chunkMarkdown(md);
    expect(chunks[0]?.frontmatter).toEqual({});
  });

  test("wikilink + tag extraction", () => {
    const md = "# H1\n\nSee [[Foo|the foo]] about #brewing/pour-over.";
    const chunks = chunkMarkdown(md);
    expect(chunks[0]?.links).toEqual(["Foo"]);
    expect(chunks[0]?.tags).toEqual(["brewing/pour-over"]);
  });

  test("wikilink with section anchor strips the anchor", () => {
    const md = "# H1\n\n[[Note#Section]]";
    const chunks = chunkMarkdown(md);
    expect(chunks[0]?.links).toEqual(["Note"]);
  });

  test("empty wikilink is ignored", () => {
    const md = "# H1\n\n[[ ]] real text";
    const chunks = chunkMarkdown(md);
    expect(chunks[0]?.links).toEqual([]);
  });

  test("tags inside fenced code block are not extracted", () => {
    const md = "# H1\n\n```\n# not a tag\n#also-not\n```\n\nsome trailing text";
    const chunks = chunkMarkdown(md);
    expect(chunks[0]?.tags).toEqual([]);
  });

  test("tag at the start of a later paragraph is still extracted (LDnu)", () => {
    // Regression for LDnu: when `withoutCode` joined sibling block-level
    // nodes with `""`, the `#tag` at the start of the second paragraph
    // collapsed onto the previous word and missed the word-boundary
    // match (`prevText#tag` instead of `prevText\n\n#tag`).
    const md = "# H1\n\nfirst paragraph\n\n#brewing rest of second paragraph";
    const chunks = chunkMarkdown(md);
    expect(chunks[0]?.tags).toContain("brewing");
  });

  test("tag at the start of a list item is still extracted", () => {
    const md = "# H1\n\n- first item\n- #brewing second item";
    const chunks = chunkMarkdown(md);
    expect(chunks[0]?.tags).toContain("brewing");
  });

  test("tag at the start of a blockquote is still extracted", () => {
    const md = "# H1\n\nintro\n\n> #brewing quoted";
    const chunks = chunkMarkdown(md);
    expect(chunks[0]?.tags).toContain("brewing");
  });

  test("tag inside inline code is not extracted", () => {
    const md = "# H1\n\nUse `#brewing` is just code, not a tag.";
    const chunks = chunkMarkdown(md);
    expect(chunks[0]?.tags).toEqual([]);
  });

  test("URL fragment-like # is not picked up when it has no leading whitespace context", () => {
    const md = "# H1\n\nVisit https://example.com/foo#bar for context.";
    const chunks = chunkMarkdown(md);
    // `#bar` is not preceded by whitespace, so the regex skips it.
    expect(chunks[0]?.tags).toEqual([]);
  });

  test("multiple chunks within the same section share links/tags", () => {
    const para = "[[Foo]] x".padEnd(1500 - 8, "x");
    const md = `# H1\n\n${para}\n\n${"y".repeat(1500)}`;
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // The wikilink only appears in the first paragraph; both produced
    // chunks share section-level links by design.
    expect(chunks[0]?.links).toEqual(["Foo"]);
    expect(chunks[1]?.links).toEqual(["Foo"]);
  });

  test("setext heading is supported", () => {
    const md = "Title\n=====\n\nbody";
    const chunks = chunkMarkdown(md);
    expect(chunks[0]?.headingPath).toEqual(["Title"]);
  });

  test("empty markdown returns no chunks", () => {
    expect(chunkMarkdown("")).toEqual([]);
  });

  test("markdown with only a heading still produces a chunk", () => {
    const chunks = chunkMarkdown("# Just A Heading");
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.headingPath).toEqual(["Just A Heading"]);
    expect(chunks[0]?.text).toBe("");
  });

  test("markdown with no headings produces a single chunk with empty headingPath", () => {
    const chunks = chunkMarkdown("just a paragraph\n\nand another");
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.headingPath).toEqual([]);
    expect(chunks[0]?.text).toContain("just a paragraph");
  });

  test("re-export of `visit` is stable", () => {
    expect(typeof visit).toBe("function");
  });

  test("nodes with no value and no children are tolerated (e.g. hard-break)", () => {
    // GFM hard-break inside a paragraph creates a `break` node with no
    // value and no children. The chunker's code-stripper must return an
    // empty string for such nodes so tag extraction still runs cleanly.
    const md = "# H\n\nleft  \nright #brewing";
    const chunks = chunkMarkdown(md);
    expect(chunks[0]?.tags).toEqual(["brewing"]);
  });

  test("thematic break (---) inside a section produces a chunk with no tags or links", () => {
    const md = "# H\n\nbody text\n\n---\n\nmore";
    const chunks = chunkMarkdown(md);
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.tags).toEqual([]);
  });
});

describe("composeEmbedText", () => {
  test("path + heading path + body, two newlines before body", () => {
    const out = composeEmbedText("entities/Alice Example.md", ["Reviews", "2026"], "body text");
    expect(out).toBe("entities/Alice Example.md\nReviews > 2026\n\nbody text");
  });

  test("empty heading path omits the heading line", () => {
    const out = composeEmbedText("notes/x.md", [], "body");
    expect(out).toBe("notes/x.md\n\nbody");
  });
});

describe("flat-list classifier", () => {
  test("FLAT_LIST_THRESHOLD is the documented value", () => {
    expect(FLAT_LIST_THRESHOLD).toBeCloseTo(0.7, 5);
  });

  test("scenario: pure flat-list section emits one chunk per top-level bullet", () => {
    const bullets = Array.from({ length: 10 }, (_, i) => `- bullet ${i}`).join("\n");
    const md = `## Work\n\n${bullets}`;
    const chunks = chunkMarkdown(md, "self/tasks.md");
    expect(chunks.length).toBe(10);
    for (const c of chunks) {
      expect(c.headingPath).toEqual(["Work"]);
    }
    // First chunk should contain only the first bullet's serialized text.
    // `remark.stringify` uses `*` as the default list marker; the chunker
    // round-trips through it, so per-bullet chunks come back as `* …`.
    expect(chunks[0]?.text).toBe("* bullet 0");
    expect(chunks[9]?.text).toBe("* bullet 9");
    // embedText carries the path + heading + body.
    expect(chunks[0]?.embedText).toBe("self/tasks.md\nWork\n\n* bullet 0");
  });

  test("scenario: prose section unchanged (single chunk)", () => {
    const para1 = "x".repeat(200);
    const para2 = "y".repeat(200);
    const para3 = "z".repeat(200);
    const md = `# Doc\n\n## Background\n\n${para1}\n\n${para2}\n\n${para3}`;
    const chunks = chunkMarkdown(md, "x.md");
    // Prose section only: 1 chunk for "Doc" (no body), 1 chunk for Background.
    const bg = chunks.find((c) => c.headingPath.includes("Background"));
    expect(bg).toBeDefined();
    expect(bg?.text.includes(para1)).toBe(true);
    expect(bg?.text.includes(para2)).toBe(true);
    expect(bg?.text.includes(para3)).toBe(true);
  });

  test("just-under-threshold mixed section stays prose (paragraph + 1 small list)", () => {
    // 1 paragraph + 1 list with 2 items: list-items=2, root nodes=2 (list+para),
    // ratio = 2 / (2 + 2 - 1) = 2/3 ≈ 0.66 — below 0.7.
    const md = "# H\n\nintro paragraph\n\n- one\n- two";
    const chunks = chunkMarkdown(md, "x.md");
    // Single prose chunk — bullets are inlined into the section text.
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.text).toContain("intro paragraph");
    expect(chunks[0]?.text).toContain("- one");
  });

  test("oversized bullet falls back to paragraph splitter for THAT item only", () => {
    const bigBody = "p".repeat(2200);
    // First bullet's body is 2200 chars (with two paragraphs to ensure split
    // boundaries exist). Subsequent bullets are small.
    const big = `- big item\n\n  ${"a".repeat(1300)}\n\n  ${"b".repeat(1300)}`;
    const md = `# H\n\n## Work\n\n${big}\n- small one\n- small two`;
    const chunks = chunkMarkdown(md, "x.md");
    // Big item produced ≥ 2 chunks; siblings produced 1 each.
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    // Last two chunks must be the small siblings, not pieces of the big one.
    expect(chunks[chunks.length - 1]?.text).toBe("* small two");
    expect(chunks[chunks.length - 2]?.text).toBe("* small one");
    void bigBody;
  });

  test("empty section (heading only) still produces a single empty chunk", () => {
    const chunks = chunkMarkdown("# H1", "p.md");
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.text).toBe("");
    // embedText still includes path + heading even though body is empty.
    expect(chunks[0]?.embedText).toBe("p.md\nH1\n\n");
  });

  test("heading inside a list-heavy section disqualifies flat-list (default)", () => {
    // Section starts as a flat list, then a sub-heading appears inside it.
    // Per change doc open-question default, the heading splits the section
    // and each part takes the prose path.
    const md = "# H\n\n- a\n- b\n- c\n\n### Sub\n\n- d";
    const chunks = chunkMarkdown(md, "p.md");
    // The first section (under H) sees a list (3 items) only, ratio=3/(3+1-1)=1.0
    // → flat-list path → 3 chunks. Then ### Sub starts a new section that's
    // its own flat-list of 1 → 1 chunk. Total 4.
    expect(chunks.length).toBe(4);
  });

  test("multiple top-level lists in one section disqualify flat-list", () => {
    // Two distinct lists separated by a paragraph. detectFlatList only
    // accepts a single list group — anything else is prose.
    const md = "# H\n\n- a\n- b\n\nintro\n\n- c\n- d";
    const chunks = chunkMarkdown(md, "p.md");
    expect(chunks.length).toBe(1);
    expect(chunks[0]?.text).toContain("- a");
    expect(chunks[0]?.text).toContain("- d");
  });

  test("flat-list with nested children includes the nested children in the chunk", () => {
    const md = "# H\n\n- parent\n  - child1\n  - child2\n- sibling";
    const chunks = chunkMarkdown(md, "p.md");
    expect(chunks.length).toBe(2);
    expect(chunks[0]?.text).toContain("parent");
    expect(chunks[0]?.text).toContain("child1");
    expect(chunks[0]?.text).toContain("child2");
    expect(chunks[1]?.text).toContain("sibling");
  });
});

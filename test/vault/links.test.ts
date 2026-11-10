/**
 * Table-driven tests for the link rewriter (REST API › Link rewriting):
 * every row of the recognized-link, resolution, and rewritten-text tables,
 * and every Link rewriting scenario, against in-memory file sets. The
 * end-to-end application (locks, atomic note writes, `links.updated` /
 * `links.failed`) is covered through `movePath` in `move.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import {
  type FoundLink,
  buildFileIndex,
  findLinks,
  planRewrite,
  resolveLink,
} from "../../src/vault/links.ts";

/** `[kind, linkpath, raw span text]` for every link in `text`. */
function links(text: string): [string, string, string][] {
  return findLinks(text).map((l: FoundLink) => [l.kind, l.linkpath, text.slice(l.start, l.end)]);
}

describe("findLinks: recognized links", () => {
  const rows: [string, [string, string, string][]][] = [
    ["[[T]]", [["wiki", "T", "T"]]],
    ["[[T|alias]]", [["wiki", "T", "T"]]],
    ["[[T#Heading]]", [["wiki", "T", "T"]]],
    ["[[T#^block-id]]", [["wiki", "T", "T"]]],
    ["[[T#Heading|alias]]", [["wiki", "T", "T"]]],
    ["[[ T ]]", [["wiki", "T", "T"]]],
    ["![[T]]", [["wiki", "T", "T"]]],
    ["![[T|300]]", [["wiki", "T", "T"]]],
    ["![[T#Heading]]", [["wiki", "T", "T"]]],
    ["| [[T\\|alias]] |", [["wiki", "T", "T"]]],
    ["[[dir/T]]", [["wiki", "dir/T", "dir/T"]]],
    ["[text](D)", [["md", "D", "D"]]],
    ["![alt](D)", [["md", "D", "D"]]],
    ['[text](<D> "title")', [["md", "D", "D"]]],
    ["[text](<a b.md>)", [["md", "a b.md", "a b.md"]]],
    ["[t](D 'title')", [["md", "D", "D"]]],
    ["[t](D (title))", [["md", "D", "D"]]],
    ["[t](a.md#heading)", [["md", "a.md", "a.md"]]],
    ["[t](d%201.png)", [["md", "d 1.png", "d%201.png"]]],
    ["[t](a\\_b.md)", [["md", "a_b.md", "a\\_b.md"]]],
    ["[t](a(b)c.md)", [["md", "a(b)c.md", "a(b)c.md"]]],
    ["[a [b] c](x.md)", [["md", "x.md", "x.md"]]],
    ["[t](/abs/x.md)", [["md", "/abs/x.md", "/abs/x.md"]]],
    ["[t](<a\\>b.md>)", [["md", "a>b.md", "a\\>b.md"]]],
    ["[t](%E0%A4%A.md)", [["md", "%E0%A4%A.md", "%E0%A4%A.md"]]],
    ["[t](\n  x.md\n)", [["md", "x.md", "x.md"]]],
    ['---\nup: "[[old]]"\n---\n\nbody', [["wiki", "old", "old"]]],
  ];
  for (const [text, expected] of rows) {
    test(JSON.stringify(text), () => {
      expect(links(text)).toEqual(expected);
    });
  }

  const none: string[] = [
    "[[#Heading]]",
    "[[ |alias]]",
    "[x](https://example.com/a.md)",
    "[x](mailto:someone@example.com)",
    "[x](obsidian://open?file=a)",
    "[x](#section)",
    "[x](//host/a.md)",
    "[x][ref]\n\n[ref]: a.md",
    "<https://example.com>",
    "`[[old]]`",
    "```\n[[old]]\n```",
    "    [[indented]]",
    "[x]()",
    "[x](a b.md)",
    "[x](<a.md)",
    "[x](<a\nb.md>)",
    "[x](<a<b.md>)",
    "[x](a(b.md)",
    "foo](bar.md)",
    "[\n\n](x.md)",
    "\\[x\\](y.md)",
    '[x](a.md "unterminated',
    "`[x](a.md)`",
  ];
  for (const text of none) {
    test(`not a link: ${JSON.stringify(text)}`, () => {
      expect(links(text)).toEqual([]);
    });
  }

  test("links come back in source order with exact raw spans", () => {
    const text = "a [m](x.md) b [[w]] c ![[e.png]]";
    expect(links(text)).toEqual([
      ["md", "x.md", "x.md"],
      ["wiki", "w", "w"],
      ["wiki", "e.png", "e.png"],
    ]);
  });
});

describe("resolveLink", () => {
  const wiki = (linkpath: string) => ({ kind: "wiki" as const, linkpath });
  const md = (linkpath: string) => ({ kind: "md" as const, linkpath });

  test("step 1: a relative Markdown link and a ./ or ../ wikilink, joined to the note's folder", () => {
    const idx = buildFileIndex(["notes/img/d.png", "notes/b.md", "top.md"]);
    expect(resolveLink(md("img/d.png"), "notes/a.md", idx)).toEqual({
      path: "notes/img/d.png",
      step: 1,
    });
    expect(resolveLink(wiki("./b"), "notes/a.md", idx)).toEqual({ path: "notes/b.md", step: 1 });
    expect(resolveLink(wiki("../top"), "notes/a.md", idx)).toEqual({ path: "top.md", step: 1 });
  });

  test("step 1 that finds nothing continues at step 2; climbing above the root resolves to nothing", () => {
    const idx = buildFileIndex(["old/spec.md", "a.md"]);
    expect(resolveLink(md("old/spec.md"), "docs/n.md", idx)).toEqual({
      path: "old/spec.md",
      step: 2,
    });
    expect(resolveLink(md("../../a.md"), "docs/n.md", idx)).toBeNull();
    // `../a.md` from the root climbs above it: nothing, and no fallback to `a.md` by name.
    expect(resolveLink(wiki("../a"), "n.md", idx)).toBeNull();
  });

  test("step 2: vault-absolute, one leading slash removed; P before P.md", () => {
    const idx = buildFileIndex(["assets/logo.png", "a", "a.md"]);
    expect(resolveLink(md("/assets/logo.png"), "notes/x.md", idx)).toEqual({
      path: "assets/logo.png",
      step: 2,
    });
    expect(resolveLink(wiki("a"), "x.md", idx)).toEqual({ path: "a", step: 2 });
  });

  test("step 3: by name, preferring exact case, then the note's folder, then fewest segments, then path order", () => {
    const idx = buildFileIndex(["inbox/todo.md", "work/todo.md", "x/y/todo.md"]);
    expect(resolveLink(wiki("todo"), "a.md", idx)).toEqual({ path: "inbox/todo.md", step: 3 });
    expect(resolveLink(wiki("todo"), "work/n.md", idx)).toEqual({ path: "work/todo.md", step: 3 });
    const segs = buildFileIndex(["a/b/c/n.md", "z/n.md"]);
    expect(resolveLink(wiki("n"), "q.md", segs)).toEqual({ path: "z/n.md", step: 3 });
    const kase = buildFileIndex(["a/Note.md", "b/note.md"]);
    expect(resolveLink(wiki("note"), "q.md", kase)).toEqual({ path: "b/note.md", step: 3 });
    expect(resolveLink(wiki("Note"), "q.md", kase)).toEqual({ path: "a/Note.md", step: 3 });
    expect(resolveLink(wiki("NOTE"), "q.md", kase)).toEqual({ path: "a/Note.md", step: 3 });
    expect(resolveLink(md("logo.png"), "notes/r.md", buildFileIndex(["assets/logo.png"]))).toEqual({
      path: "assets/logo.png",
      step: 3,
    });
  });

  test("step 3 matches a path-qualified tail; step 4 is unresolved", () => {
    const idx = buildFileIndex(["deep/alpha/plan.md"]);
    expect(resolveLink(wiki("alpha/plan"), "a.md", idx)).toEqual({
      path: "deep/alpha/plan.md",
      step: 3,
    });
    expect(resolveLink(wiki("nothing"), "a.md", idx)).toBeNull();
  });

  test("scenario: case-only duplicates resolve deterministically", () => {
    const idx = buildFileIndex(["FOO.md", "Foo.md", "dir/FOO.md", "dir/Foo.md", "a.md"]);
    expect(resolveLink(wiki("Foo"), "a.md", idx)?.path).toBe("Foo.md");
    expect(resolveLink(wiki("dir/Foo"), "a.md", idx)?.path).toBe("dir/Foo.md");
    expect(resolveLink(wiki("foo"), "a.md", idx)?.path).toBe("FOO.md");
    expect(resolveLink(wiki("dir/foo"), "a.md", idx)?.path).toBe("dir/FOO.md");
  });
});

/**
 * Plan the rewrite of `note` (at `notePath`, moving to `moves[notePath]` if
 * listed) after applying `moves` to `files`. Returns the new text, or the
 * text unchanged when nothing is rewritten.
 */
function rewrite(
  files: readonly string[],
  moves: Record<string, string>,
  notePath: string,
  note: string,
): string | "unresolvable" {
  const after = files.map((f) => moves[f] ?? f).filter((f, i, a) => a.indexOf(f) === i);
  const plan = planRewrite(note, notePath, moves[notePath] ?? notePath, {
    moves: new Map(Object.entries(moves)),
    before: buildFileIndex(files),
    after: buildFileIndex(after),
  });
  if (plan === "unresolvable") return plan;
  return plan === null ? note : plan.text;
}

describe("Link rewriting scenarios", () => {
  test("bare-name wikilink follows a rename", () => {
    const files = ["notes/old.md", "a.md"];
    expect(
      rewrite(
        files,
        { "notes/old.md": "notes/new.md" },
        "a.md",
        "[[old]] and [[old#Intro|the intro]]",
      ),
    ).toBe("[[new]] and [[new#Intro|the intro]]");
  });

  test("path-qualified wikilink follows a folder move", () => {
    const files = ["projects/alpha/plan.md", "index.md"];
    expect(
      rewrite(
        files,
        { "projects/alpha/plan.md": "archive/alpha/plan.md" },
        "index.md",
        "![[projects/alpha/plan]]",
      ),
    ).toBe("![[archive/alpha/plan]]");
  });

  test("bare name that would become ambiguous is qualified", () => {
    const files = ["inbox/todo.md", "work/todo.md", "a.md"];
    expect(rewrite(files, { "inbox/todo.md": "archive/2026/todo.md" }, "a.md", "[[todo]]")).toBe(
      "[[archive/2026/todo]]",
    );
  });

  test("moved note's relative Markdown links are updated", () => {
    const files = ["notes/a.md", "notes/img/d 1.png"];
    expect(
      rewrite(files, { "notes/a.md": "archive/a.md" }, "notes/a.md", "![diagram](img/d%201.png)"),
    ).toBe("![diagram](../notes/img/d%201.png)");
  });

  test("vault-absolute Markdown link keeps its leading slash", () => {
    const files = ["assets/logo.png", "notes/a.md"];
    expect(
      rewrite(
        files,
        { "assets/logo.png": "media/logo.png" },
        "notes/a.md",
        "![logo](/assets/logo.png)",
      ),
    ).toBe("![logo](/media/logo.png)");
  });

  test("shadowed vault path falls back to a relative link", () => {
    const files = ["old/spec.md", "docs/new/spec.md", "docs/n.md"];
    expect(
      rewrite(files, { "old/spec.md": "new/spec.md" }, "docs/n.md", "[spec](old/spec.md)"),
    ).toBe("[spec](../new/spec.md)");
  });

  test("case-only duplicates: [[foo]] is qualified, [[Foo]] unchanged", () => {
    const files = ["FOO.md", "Foo.md", "dir/FOO.md", "dir/Foo.md", "a.md"];
    expect(
      rewrite(files, { "FOO.md": "archive/FOO.md" }, "a.md", "[[foo]] [[Foo]] [[dir/Foo]]"),
    ).toBe("[[archive/FOO]] [[Foo]] [[dir/Foo]]");
  });

  test("attachment move updates nothing while the name still resolves", () => {
    const files = ["assets/logo.png", "readme.md"];
    const note = "![[logo.png]]";
    expect(rewrite(files, { "assets/logo.png": "assets/brand/logo.png" }, "readme.md", note)).toBe(
      note,
    );
  });

  test("code is never rewritten", () => {
    const files = ["notes/old.md", "a.md"];
    const note = "`[[old]]`\n\n```\n[[old]]\n```\n";
    expect(rewrite(files, { "notes/old.md": "notes/new.md" }, "a.md", note)).toBe(note);
  });
});

describe("which links are rewritten", () => {
  test("an unresolved link is never rewritten", () => {
    const note = "[[ghost]] [x](nope.md)";
    expect(rewrite(["a.md", "b.md"], { "b.md": "c.md" }, "a.md", note)).toBe(note);
  });

  test("a link in an unmoved note to an unmoved file is left even if its resolution changed", () => {
    // `[[todo]]` from `work/a.md` resolves to `inbox/todo.md` (path order).
    // Moving `x/todo.md` next to the note makes it win the folder tie-break,
    // but neither the target nor the note moved, so nothing is rewritten.
    const files = ["inbox/todo.md", "x/todo.md", "work/a.md"];
    const note = "[[todo]]";
    expect(rewrite(files, { "x/todo.md": "work/todo.md" }, "work/a.md", note)).toBe(note);
  });

  test("a moved note's by-name link whose tie-break changed is qualified", () => {
    const files = ["inbox/todo.md", "work/todo.md", "inbox/n.md"];
    // From `inbox/`, `[[todo]]` was the same-folder `inbox/todo.md`; from `work/` it would not be.
    expect(rewrite(files, { "inbox/n.md": "work/n.md" }, "inbox/n.md", "[[todo]]")).toBe(
      "[[inbox/todo]]",
    );
  });

  test("a moved note's link that still resolves the same is unchanged", () => {
    const note = "[[a]] [x](/top.md)";
    expect(rewrite(["a.md", "top.md", "n.md"], { "n.md": "deep/n.md" }, "n.md", note)).toBe(note);
  });

  test("a link to an overwritten destination keeps pointing at that path", () => {
    // `src.md` replaced `dst.md`; a link to `dst` still resolves to `dst.md`.
    const note = "[[dst]]";
    expect(rewrite(["src.md", "dst.md", "n.md"], { "src.md": "dst.md" }, "n.md", note)).toBe(note);
  });

  test("a relative link that only still resolves by name is rewritten to stay relative", () => {
    const files = ["notes/a.md", "notes/img/x.png"];
    expect(rewrite(files, { "notes/a.md": "other/a.md" }, "notes/a.md", "![i](img/x.png)")).toBe(
      "![i](../notes/img/x.png)",
    );
  });
});

describe("rewritten text", () => {
  test("relative wikilinks stay relative, keeping ./ only when the result does not climb", () => {
    const files = ["n/a.md", "n/b.md", "n/sub/c.md"];
    expect(rewrite(files, { "n/b.md": "n/sub/b.md" }, "n/a.md", "[[./b]]")).toBe("[[./sub/b]]");
    expect(rewrite(files, { "n/b.md": "b.md" }, "n/a.md", "[[./b]]")).toBe("[[../b]]");
    expect(rewrite(files, { "n/sub/c.md": "n/c.md" }, "n/a.md", "[[./sub/c|C]]")).toBe("[[./c|C]]");
  });

  test("a Markdown link resolved at step 1 stays relative, without adding ./", () => {
    const files = ["n/a.md", "n/b.md"];
    expect(rewrite(files, { "n/b.md": "n/x/b.md" }, "n/a.md", "[b](b.md)")).toBe("[b](x/b.md)");
    expect(rewrite(files, { "n/b.md": "n/x/b.md" }, "n/a.md", "[b](./b.md)")).toBe("[b](./x/b.md)");
  });

  test("a Markdown link resolved by name is written by name, or by path when the name is ambiguous", () => {
    const files = ["assets/logo.png", "notes/r.md", "other/logo.png"];
    expect(
      rewrite(files, { "assets/logo.png": "media/logo.png" }, "notes/r.md", "![l](logo.png)"),
    ).toBe("![l](logo.png)");
    const solo = ["assets/logo.png", "notes/r.md"];
    expect(
      rewrite(solo, { "assets/logo.png": "media/icon.png" }, "notes/r.md", "![l](logo.png)"),
    ).toBe("![l](icon.png)");
  });

  test("a vault-path Markdown link without a leading slash stays without one", () => {
    const files = ["assets/a.png", "n.md"];
    expect(rewrite(files, { "assets/a.png": "media/a.png" }, "n.md", "![x](assets/a.png)")).toBe(
      "![x](media/a.png)",
    );
  });

  test("the new linkpath carries the target's extension; .md is omitted only if the link had none", () => {
    const files = ["a.md", "icon.png", "r.pdf", "n.markdown", "x.md"];
    const moves = {
      "a.md": "d/a.md",
      "icon.png": "d/icon2.png",
      "r.pdf": "d/r2.pdf",
      "n.markdown": "d/n2.markdown",
    };
    expect(
      rewrite(files, moves, "x.md", "[[a]] [[a.md]] ![[icon.png]] [[r.pdf]] [[n.markdown]]"),
    ).toBe("[[a]] [[a.md]] ![[icon2.png]] [[r2.pdf]] [[n2.markdown]]");
    expect(rewrite(["a.md", "x.md"], { "a.md": "d/b.md" }, "x.md", "[[a]] [[a.md]]")).toBe(
      "[[b]] [[b.md]]",
    );
  });

  test("Markdown linkpaths are percent-encoded so decoding gives the path back; wikilinks are not", () => {
    const files = ["a.png", "n.md"];
    const target = "d/x %#\\<>(y).png";
    expect(rewrite(files, { "a.png": target }, "n.md", "![i](a.png)")).toBe(
      "![i](d/x%20%25%23%5C%3C%3E%28y%29.png)",
    );
    expect(rewrite(files, { "a.png": target }, "n.md", "![i](<a.png>)")).toBe(
      "![i](<d/x %25%23%5C%3C%3E(y).png>)",
    );
    expect(rewrite(files, { "a.png": "d/x y.png" }, "n.md", "![[a.png]]")).toBe("![[x y.png]]");
  });

  test("only the linkpath is replaced: embed marker, fragment, alias, text, title, brackets, bytes kept", () => {
    const files = ["a.md", "n.md"];
    const note = 'x ![[ a #h|al ]] y [t *e*](<a.md#f> "ti") z\r\n';
    expect(rewrite(files, { "a.md": "q/b.md" }, "n.md", note)).toBe(
      'x ![[ b #h|al ]] y [t *e*](<q/b.md#f> "ti") z\r\n',
    );
  });

  test("a note with a link no form can point back at its target is unresolvable", () => {
    // `x/a` (no extension) shadows every extensionless form of `x/a.md`.
    const files = ["a.md", "x/a", "a", "n.md"];
    expect(rewrite(files, { "a.md": "x/a.md" }, "n.md", "[[a]]")).toBe("[[a]]");
    const files2 = ["a.md", "x/a", "n.md", "z/a"];
    expect(rewrite(files2, { "a.md": "x/a.md" }, "n.md", "[[a.md]] [[a]]")).toBe("unresolvable");
  });
});

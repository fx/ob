/**
 * Link rewriting after a move (REST API › Link rewriting).
 *
 * Pure apart from its file I/O. Three layers:
 *
 * 1. **Parsing** (`findLinks`). The note is parsed with the remark setup the
 *    chunker already uses (`remark` + `remark-gfm` + `remark-frontmatter`)
 *    ONLY to obtain the source offsets of `code` and `inlineCode` nodes. The
 *    raw text outside those ranges is scanned with a wikilink regex and a
 *    CommonMark inline-link destination scanner. Working on raw offsets,
 *    never on a re-serialized AST, is what keeps every untouched byte
 *    identical. Frontmatter is scanned like body text.
 * 2. **Resolution** (`resolveLink`) over a `FileIndex` built once per file
 *    set: a case-folded map from full path to the files with that folded
 *    path, and one from every `/`-suffix to its candidates, each list in path
 *    order — so every step is O(1) lookups plus the spec's one case
 *    tie-break (exact case against each candidate's target form, then path
 *    order; step 3 inserts its folder and segment preferences in between).
 * 3. **Rewriting** (`planRewrite`, `rewriteLinks`). For each link: `t0`,
 *    `expected`, `t1`, and the steps before and after decide whether it is
 *    rewritten; the replacement keeps the link's style per the spec's table,
 *    is checked to resolve back to its target (falling back to the relative
 *    form, then the vault-absolute form), and replacements are spliced
 *    back-to-front by offset. Each referring note is read and written under
 *    its own lock — the rewrite is computed from the bytes read while
 *    holding it — through `guardedRead` and `guarded` (exclusive hidden temp
 *    file + rename), then reindexed under the same lock.
 */

import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import { remark } from "remark";
import remarkFrontmatter from "remark-frontmatter";
import remarkGfm from "remark-gfm";
import { visit } from "unist-util-visit";
import { OBError } from "../errors.ts";
import { type LinkScope, type VaultServiceDeps, tryReindexResult } from "./files.ts";
import { type GuardContext, atStep, guarded, guardedRead } from "./guarded.ts";
import { pathLockKey, withPathLock } from "./lock.ts";
import { comparePaths } from "./order.ts";

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** One recognized link: what it resolves by, and the raw span its linkpath occupies. */
export interface FoundLink {
  readonly kind: "wiki" | "md";
  /** The linkpath resolution uses: trimmed (wikilink), or escape-processed, fragment-free, percent-decoded (Markdown). */
  readonly linkpath: string;
  /** Raw offsets of the linkpath text in the note — the only bytes a rewrite replaces. */
  readonly start: number;
  readonly end: number;
  /** Markdown only: the destination is written in angle brackets. */
  readonly angle: boolean;
  /** Raw offsets of the whole link construct (`[[…]]`, or `[…](…)`), for re-parsing a rewrite. */
  readonly constructStart: number;
  readonly constructEnd: number;
}

const parser = remark().use(remarkFrontmatter, ["yaml"]).use(remarkGfm);

/** Source ranges `[start, end)` of fenced/indented code blocks and inline code spans. */
function codeRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  visit(parser.parse(text), (node) => {
    if (node.type !== "code" && node.type !== "inlineCode") return;
    // Every node remark produces from a parse carries offsets.
    const pos = node.position as NonNullable<typeof node.position>;
    ranges.push([pos.start.offset as number, pos.end.offset as number]);
  });
  return ranges;
}

const inRanges = (i: number, ranges: readonly [number, number][]): boolean =>
  ranges.some(([s, e]) => i >= s && i < e);

const WIKILINK = /(!?)\[\[([^[\]\n]*)\]\]/g;

/** `\` before ASCII punctuation is an escape (CommonMark). */
const ESCAPABLE = /[!-/:-@[-`{-~]/;

function unescapeMd(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i] as string;
    const next = s[i + 1];
    if (c === "\\" && next !== undefined && ESCAPABLE.test(next)) {
      out += next;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

function percentDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Index of the `[` that the `]` at `close` closes, honouring nesting and escapes; -1 if none in the paragraph. */
function openingBracket(text: string, close: number): number {
  let depth = 0;
  for (let i = close - 1; i >= 0; i--) {
    const c = text[i];
    if (c === "\n" && text[i - 1] === "\n") return -1;
    if (text[i - 1] === "\\") continue;
    if (c === "]") depth++;
    else if (c === "[") {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

/** Skip spaces and tabs and at most one line ending. */
function skipSpace(text: string, i: number): number {
  let j = i;
  let newlines = 0;
  while (j < text.length) {
    const c = text[j];
    if (c === " " || c === "\t") j++;
    else if (c === "\n" && newlines === 0) {
      newlines++;
      j++;
    } else break;
  }
  return j;
}

interface Destination {
  readonly raw: string;
  readonly start: number;
  readonly angle: boolean;
  /** Index just past the destination. */
  readonly next: number;
}

/** Parse a link destination at `i` (CommonMark): `<…>` or a raw destination with balanced parens. */
function scanDestination(text: string, i: number): Destination | null {
  if (text[i] === "<") {
    for (let j = i + 1; j < text.length; j++) {
      const c = text[j];
      if (c === "\\") {
        j++;
        continue;
      }
      if (c === "\n" || c === "<") return null;
      if (c === ">") return { raw: text.slice(i + 1, j), start: i + 1, angle: true, next: j + 1 };
    }
    return null;
  }
  let depth = 0;
  let j = i;
  for (; j < text.length; j++) {
    const c = text[j] as string;
    if (c === "\\") {
      j++;
      continue;
    }
    if (c === " " || c === "\t" || c === "\n" || c < " ") break;
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) break;
      depth--;
    }
  }
  if (depth !== 0) return null;
  return { raw: text.slice(i, j), start: i, angle: false, next: j };
}

/** After a destination: an optional title, then `)`. Returns the index of that `)`, or -1. */
function closingParen(text: string, i: number): number {
  let j = skipSpace(text, i);
  const open = text[j];
  if (j > i && (open === '"' || open === "'" || open === "(")) {
    const close = open === "(" ? ")" : open;
    for (j++; j < text.length && text[j] !== close; j++) if (text[j] === "\\") j++;
    if (j >= text.length) return -1;
    j = skipSpace(text, j + 1);
  }
  return text[j] === ")" ? j : -1;
}

/** A Markdown destination is internal iff it has no scheme and does not start with `#` or `//`. */
function isInternal(dest: string): boolean {
  return !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(dest) && !dest.startsWith("#") && !dest.startsWith("//");
}

/** Every recognized link outside code, in source order. */
export function findLinks(text: string): FoundLink[] {
  const code = codeRanges(text);
  const links: FoundLink[] = [];
  const wikiRanges: [number, number][] = [];
  for (const m of text.matchAll(WIKILINK)) {
    const at = m.index as number;
    if (inRanges(at, code)) continue;
    wikiRanges.push([at, at + m[0].length]);
    const inner = m[2] as string;
    const innerStart = at + (m[1] as string).length + 2;
    // `[[T|alias]]`, and `[[T\|alias]]` as written inside a table.
    let target = inner;
    const bar = inner.indexOf("|");
    if (bar >= 0) target = inner.slice(0, inner[bar - 1] === "\\" ? bar - 1 : bar);
    const hash = target.indexOf("#");
    const raw = hash >= 0 ? target.slice(0, hash) : target;
    const linkpath = raw.trim();
    // `[[#Heading]]` links into the same note: not a file link.
    if (linkpath === "") continue;
    const lead = raw.length - raw.trimStart().length;
    links.push({
      kind: "wiki",
      linkpath,
      start: innerStart + lead,
      end: innerStart + lead + linkpath.length,
      angle: false,
      constructStart: at,
      constructEnd: at + m[0].length,
    });
  }
  for (let i = text.indexOf("]("); i >= 0; i = text.indexOf("](", i + 1)) {
    if (inRanges(i, code) || inRanges(i, wikiRanges) || text[i - 1] === "\\") continue;
    const open = openingBracket(text, i);
    if (open < 0 || inRanges(open, code)) continue;
    const dest = scanDestination(text, skipSpace(text, i + 2));
    const close = dest === null ? -1 : closingParen(text, dest.next);
    if (dest === null || close < 0) continue;
    const hash = dest.raw.indexOf("#");
    const rawPath = hash >= 0 ? dest.raw.slice(0, hash) : dest.raw;
    const processed = unescapeMd(dest.raw);
    if (!isInternal(processed) || rawPath === "") continue;
    links.push({
      kind: "md",
      linkpath: percentDecode(unescapeMd(rawPath)),
      start: dest.start,
      end: dest.start + rawPath.length,
      angle: dest.angle,
      constructStart: open,
      constructEnd: close + 1,
    });
  }
  return links.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** A file set indexed for resolution; build once per set with `buildFileIndex`. */
export interface FileIndex {
  readonly byPath: ReadonlyMap<string, readonly string[]>;
  readonly bySuffix: ReadonlyMap<string, readonly string[]>;
}

const fold = (s: string): string => s.toLowerCase();

const folderOf = (p: string): string => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");

const segmentCount = (p: string): number => p.split("/").length;

function push(map: Map<string, string[]>, key: string, value: string): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/** Index `files` (vault-relative paths): every list ends up in path order. */
export function buildFileIndex(files: readonly string[]): FileIndex {
  const byPath = new Map<string, string[]>();
  const bySuffix = new Map<string, string[]>();
  for (const f of [...files].sort(comparePaths)) {
    push(byPath, fold(f), f);
    const segs = f.split("/");
    for (let i = 1; i < segs.length; i++) push(bySuffix, fold(`/${segs.slice(i).join("/")}`), f);
  }
  return { byPath, bySuffix };
}

/** Exact case against the target form wins; otherwise the first in path order. */
function caseTieBreak(candidates: readonly string[], form: string): string {
  return candidates.find((c) => c === form) ?? (candidates[0] as string);
}

/** `match(P)`: the file whose path is `P`, else `P.md`, case-insensitively, by the case tie-break. */
function match(index: FileIndex, p: string): string | null {
  const exact = index.byPath.get(fold(p));
  if (exact !== undefined) return caseTieBreak(exact, p);
  const md = index.byPath.get(fold(`${p}.md`));
  return md === undefined ? null : caseTieBreak(md, `${p}.md`);
}

/** Join `rel` to `folder` and normalize; `null` when it climbs above the vault root. */
function joinNormalized(folder: string, rel: string): string | null {
  const out = folder === "" ? [] : folder.split("/");
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

/** What a link resolves to, and at which step (1 relative, 2 vault-absolute, 3 by name). */
export interface Resolution {
  readonly path: string;
  readonly step: 1 | 2 | 3;
}

type LinkShape = Pick<FoundLink, "kind" | "linkpath">;

const isRelativeSyntax = (lp: string): boolean => lp.startsWith("./") || lp.startsWith("../");

/** `resolve(link, S, F)`: the spec's four steps. */
export function resolveLink(link: LinkShape, source: string, index: FileIndex): Resolution | null {
  const lp = link.linkpath;
  if (isRelativeSyntax(lp) || (link.kind === "md" && !lp.startsWith("/"))) {
    const r = joinNormalized(folderOf(source), lp);
    if (r === null) return null;
    const hit = match(index, r);
    if (hit !== null) return { path: hit, step: 1 };
  }
  const l = lp.startsWith("/") ? lp.slice(1) : lp;
  const abs = match(index, l);
  if (abs !== null) return { path: abs, step: 2 };
  let cands = [
    ...(index.bySuffix.get(fold(`/${l}`)) ?? []).map((p) => ({ p, form: l })),
    ...(index.bySuffix.get(fold(`/${l}.md`)) ?? []).map((p) => ({ p, form: `${l}.md` })),
  ];
  if (cands.length === 0) return null;
  const narrow = (keep: (c: (typeof cands)[number]) => boolean): void => {
    const kept = cands.filter(keep);
    if (kept.length > 0) cands = kept;
  };
  narrow((c) => c.p.endsWith(`/${c.form}`));
  narrow((c) => folderOf(c.p) === folderOf(source));
  const fewest = Math.min(...cands.map((c) => segmentCount(c.p)));
  narrow((c) => segmentCount(c.p) === fewest);
  cands.sort((a, b) => comparePaths(a.p, b.p));
  return { path: (cands[0] as (typeof cands)[number]).p, step: 3 };
}

// ---------------------------------------------------------------------------
// Rewriting
// ---------------------------------------------------------------------------

/** The relative path from `folder` to `target`, `./`-prefixed when asked and it does not climb. */
function relativeForm(folder: string, target: string, dot: boolean): string {
  const from = folder === "" ? [] : folder.split("/");
  const to = target.split("/");
  let common = 0;
  while (common < from.length && common < to.length - 1 && from[common] === to[common]) common++;
  const rel = [...Array(from.length - common).fill(".."), ...to.slice(common)].join("/");
  return rel.startsWith("../") || !dot ? rel : `./${rel}`;
}

/** Percent-encode a Markdown linkpath so decoding gives the path back. */
function encodeMd(p: string, angle: boolean): string {
  let out = p.replace(/[%#\\<>]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  if (!angle) out = out.replace(/[ ()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return out;
}

/** The last segment of `p` carries an extension (`.pdf`, `.md`, `.note`, …). */
const hasExtension = (p: string): boolean => /\.[^./]+$/.test(p.slice(p.lastIndexOf("/") + 1));

/**
 * The new linkpath text for `link` (found in `text`), now pointing at
 * `target` from `s1`; `null` if no form does.
 *
 * Every candidate form is checked the way it will be READ: written into a
 * copy of the link's own construct (`[[…]]` or `[…](…)`, alias, fragment
 * and all), parsed with `findLinks`, and accepted only when exactly one
 * re-parsed link of the same kind spans the whole replacement, no other
 * re-parsed link overlaps it, and that link's parsed linkpath resolves to
 * `target`. Links nested in a Markdown label (a linked image, a wikilink in
 * the text) do not count against it. A target name that the syntax cannot
 * carry — `#`, `|`, or `]]` in a wikilink, a `[[…]]` inside a Markdown
 * destination — therefore never yields a rewrite read as a different link.
 */
function newLinkpath(
  link: FoundLink,
  text: string,
  step0: 1 | 2 | 3,
  target: string,
  s1: string,
  after: FileIndex,
): string | null {
  // `.md` is left off only when the original linkpath had no extension at all.
  const omitMd = /\.md$/i.test(target) && !hasExtension(link.linkpath);
  const offset = link.start - link.constructStart;
  const emit = (p: string): string | null => {
    const bare = omitMd ? p.slice(0, -3) : p;
    const raw = link.kind === "md" ? encodeMd(bare, link.angle) : bare;
    const snippet =
      text.slice(link.constructStart, link.start) + raw + text.slice(link.end, link.constructEnd);
    const end = offset + raw.length;
    const parsed = findLinks(snippet);
    // Links nested in a label (a linked image, a wikilink in the text) are
    // fine; what must hold is that exactly one link of this kind spans the
    // replacement and no other link reaches into it.
    const spanning = parsed.filter(
      (l) => l.kind === link.kind && l.start === offset && l.end === end,
    );
    const only = spanning.length === 1 ? (spanning[0] as FoundLink) : null;
    const intact =
      only !== null && parsed.every((l) => l === only || l.end <= offset || l.start >= end);
    return intact && resolveLink(only, s1, after)?.path === target ? raw : null;
  };
  const relative = isRelativeSyntax(link.linkpath);
  const folder = folderOf(s1);
  let primary: string;
  if (
    (link.kind === "wiki" && !relative && !link.linkpath.includes("/")) ||
    (link.kind === "md" && step0 === 3)
  ) {
    // By bare name, if the name alone still finds the target.
    const name = basename(target);
    primary = emit(name) !== null ? name : target;
  } else if (link.kind === "wiki" && !relative) {
    primary = target;
  } else if (relative || step0 === 1) {
    primary = relativeForm(folder, target, link.linkpath.startsWith("./"));
  } else {
    primary = link.linkpath.startsWith("/") ? `/${target}` : target;
  }
  const forms = [primary, relativeForm(folder, target, true)];
  forms.push(link.kind === "md" ? `/${target}` : target);
  for (const form of forms) {
    const raw = emit(form);
    if (raw !== null) return raw;
  }
  return null;
}

/** The inputs one rewrite pass needs, all vault-relative. */
export interface RewriteInput {
  /** Old path → new path of every moved file. */
  readonly moves: ReadonlyMap<string, string>;
  readonly before: FileIndex;
  readonly after: FileIndex;
}

/**
 * Plan the rewrite of one note: its rewritten text and how many links
 * changed, `null` when no link needs rewriting, or `"unresolvable"` when some
 * link has no form at all that resolves to its target (the note is then left
 * unchanged).
 */
export function planRewrite(
  text: string,
  s0: string,
  s1: string,
  input: RewriteInput,
): { text: string; links: number } | null | "unresolvable" {
  const edits: { start: number; end: number; text: string }[] = [];
  for (const link of findLinks(text)) {
    const r0 = resolveLink(link, s0, input.before);
    if (r0 === null) continue;
    const moved = input.moves.get(r0.path);
    if (moved === undefined && s0 === s1) continue;
    const expected = moved ?? r0.path;
    const r1 = resolveLink(link, s1, input.after);
    if (r1?.path === expected && !(r0.step === 1 && r1.step !== 1)) continue;
    const replacement = newLinkpath(link, text, r0.step, expected, s1, input.after);
    if (replacement === null) return "unresolvable";
    edits.push({ start: link.start, end: link.end, text: replacement });
  }
  if (edits.length === 0) return null;
  let out = text;
  for (const e of edits.reverse()) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  return { text: out, links: edits.length };
}

// ---------------------------------------------------------------------------
// Applying
// ---------------------------------------------------------------------------

export interface LinksReport {
  readonly updated: { path: string; links: number; indexed: boolean }[];
  readonly failed: { path: string; code: string; message: string }[];
}

/** One note's reindex outcome: `ok` = the reindex did not fail. */
export interface ReindexOutcome {
  readonly ok: boolean;
  readonly indexed: boolean;
}

const MARKDOWN = /\.(?:md|markdown)$/i;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Thrown when a note's links cannot all be pointed back at their targets. */
class UnresolvableLinkError extends OBError {
  override readonly code = "invalid_path" as const;
  // biome-ignore lint/complexity/noUselessConstructor: explicit ctor needed for Bun coverage tracking.
  constructor(message: string) {
    super(message);
  }
}

export interface RewriteLinksArgs extends RewriteInput {
  readonly deps: VaultServiceDeps;
  readonly slug: string;
  /** Containment root for reads and writes: the (scope) root paths resolve against. */
  readonly g: GuardContext;
  /** The whole-vault view: the real root and the scope prefix. */
  readonly scope: LinkScope;
  /** Every Markdown file of the post-move file set is a candidate referring note. */
  readonly afterFiles: readonly string[];
}

/**
 * Rewrite the links of every referring note inside the scope. Returns the
 * report (scope-relative paths, in path order) and each rewritten note's
 * reindex outcome, keyed by its scope-relative path.
 */
export async function rewriteLinks(
  args: RewriteLinksArgs,
): Promise<{ report: LinksReport; reindexed: Map<string, ReindexOutcome> }> {
  const { scope } = args;
  const inverse = new Map<string, string>();
  for (const [from, to] of args.moves) inverse.set(to, from);
  const updated: LinksReport["updated"] = [];
  const failed: LinksReport["failed"] = [];
  const reindexed = new Map<string, ReindexOutcome>();
  const lead = scope.prefix === "" ? "" : `${scope.prefix}/`;
  for (const s1 of args.afterFiles) {
    if (!MARKDOWN.test(s1) || !s1.startsWith(lead)) continue;
    const local = s1.slice(lead.length);
    try {
      const out = await rewriteNote(args, inverse.get(s1) ?? s1, s1, local);
      if (out === null) continue;
      updated.push({ path: local, links: out.links, indexed: out.reindex.indexed });
      reindexed.set(local, out.reindex);
    } catch (e) {
      failed.push({
        path: local,
        code: e instanceof OBError ? e.code : "internal",
        message: e instanceof OBError ? e.message : "the note could not be rewritten",
      });
    }
  }
  const byPath = (a: { path: string }, b: { path: string }): number => comparePaths(a.path, b.path);
  return { report: { updated: updated.sort(byPath), failed: failed.sort(byPath) }, reindexed };
}

/** Read, plan, write, and reindex one note under its lock; `null` when nothing changed. */
async function rewriteNote(
  args: RewriteLinksArgs,
  s0: string,
  s1: string,
  local: string,
): Promise<{ links: number; reindex: ReindexOutcome } | null> {
  const { g, deps, slug } = args;
  const abs = join(g.root, local);
  return withPathLock(pathLockKey(g.root, local), async () => {
    await atStep(g, "rewrite.read", [abs]);
    const { bytes } = await guardedRead(g.root, local);
    let text: string;
    try {
      text = strictUtf8.decode(bytes);
    } catch {
      // Not UTF-8: re-encoding could not keep every byte. Not a referring note.
      return null;
    }
    const plan = planRewrite(text, s0, s1, args);
    if (plan === null) return null;
    if (plan === "unresolvable") {
      throw new UnresolvableLinkError(
        `a link in "${local}" has no form that resolves to its target`,
      );
    }
    await writeNote(g, abs, new TextEncoder().encode(plan.text), deps);
    return { links: plan.links, reindex: await tryReindexResult(deps, slug, local) };
  });
}

/** Replace the note atomically: exclusive hidden temp file, then rename over it. */
async function writeNote(
  g: GuardContext,
  abs: string,
  bytes: Uint8Array,
  deps: VaultServiceDeps,
): Promise<void> {
  const uuid = (deps.randomUUID ?? crypto.randomUUID.bind(crypto))();
  const tmp = join(dirname(abs), `.${basename(abs)}.${uuid}.tmp`);
  const handle = await guarded(g, "rewrite.openTmp", [abs, tmp], () => fs.open(tmp, "wx"));
  try {
    try {
      await guarded(g, "rewrite.writeTmp", [abs, tmp], () => handle.writeFile(bytes));
    } finally {
      await handle.close();
    }
    await guarded(g, "rewrite.rename", [tmp, abs], () => fs.rename(tmp, abs));
  } catch (e) {
    // Only this call's own temp file is ever removed, never the note.
    await guarded(g, "rewrite.unlinkTmp", [abs, tmp], () => fs.unlink(tmp)).catch(() => undefined);
    throw e;
  }
}

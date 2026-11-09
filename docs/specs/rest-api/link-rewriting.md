# Link Rewriting

Supplementary document of the [REST API spec](index.md). It owns how a move (`POST /v1/vaults/:slug/paths/*path:move` and the MCP `move` tool) keeps internal links pointing at what they pointed at before. The move itself — atomicity, clobber rules, indexing, the response shape — is owned by [REST API › Path operations](index.md#path-operations).

> Specified by draft change [0020](../../changes/0020-move-and-copy.md); not yet implemented.

## Overview

Obsidian desktop rewrites internal links when a note or attachment is renamed or moved ("Automatically update internal links", on by default). A move made through ob, which happens on disk and reaches desktop clients through Obsidian Sync, gets no such treatment from Obsidian, so ob does it itself: `updateLinks` defaults to `true`.

The rules below are ob's own, modelled on Obsidian's behavior. Obsidian does not document how it breaks ties between same-named files, so the tie-break here is a deterministic choice, not a claim of byte-for-byte equivalence (see [Open Questions](#open-questions)).

## Requirements

### Notes scanned

- Every Markdown file (`.md`, `.markdown`) that `GET /v1/vaults/:slug/paths` would list after the move is a referring note, including the moved notes at their new paths. Other file types — including Obsidian canvas files — are not scanned.
- Within a note, everything is scanned except code: fenced and indented code blocks and inline code spans, as CommonMark defines them. YAML frontmatter is scanned like body text, so a link written in a property is maintained.
- In a scoped MCP session, links are resolved against the whole vault exactly as in an unscoped session, but only notes inside the session's scope are rewritten. A note outside the scope is neither modified nor reported, so moving a note in a scoped session can leave links from outside the scope pointing at its old path.

### Recognized links

| Form | Examples | Linkpath |
|---|---|---|
| Wikilink | `[[T]]`, `[[T\|alias]]`, `[[T#Heading]]`, `[[T#^block-id]]`, `[[T#Heading\|alias]]` | `T`, trimmed |
| Wikilink embed | `![[T]]`, `![[T\|300]]`, `![[T#Heading]]` | `T`, trimmed |
| Markdown link or image | `[text](D)`, `![alt](D)`, `[text](<D> "title")` | `D` after backslash-escape processing, without its `#fragment`, percent-decoded |

- A wikilink whose linkpath is empty (`[[#Heading]]`, a link into the same note) is not a file link and is never rewritten.
- A Markdown link is internal only when `D` has no URI scheme (`https:`, `mailto:`, `obsidian:`, …), does not start with `#`, and does not start with `//`. Reference-style links and autolinks are not recognized.

### Resolution

`resolve(link, S, F)` maps a recognized link in the note at vault-relative path `S` to one file of the vault file set `F`, or to nothing. Path comparison is case-insensitive, and when several files match a step only by case, the one matching case exactly wins. `match(P)` is the file whose path is `P`, else the file whose path is `P.md`.

1. **Relative.** If the linkpath starts with `./` or `../`, or the link is a Markdown link whose destination does not start with `/`, let `R` be the linkpath joined to the folder of `S` and normalized. If `match(R)` exists, it is the result. A relative linkpath that climbs above the vault root resolves to nothing.
2. **Vault-absolute.** Otherwise, if `match(L)` exists, where `L` is the linkpath with one leading `/` removed, it is the result.
3. **By name.** Otherwise, the candidates are the files whose path ends with `/L` or `/L.md`. One candidate is the result. Among several, the result is the candidate in the same folder as `S`, else the one with the fewest path segments, else the first in path order.
4. Otherwise the link is unresolved.

Resolution is a pure function of the link, the note's path, and the file set, and ob evaluates it against the vault before the move and again after it.

### Which links are rewritten

Let `M` map the old path of every moved file to its new path — one entry for a file, and for a folder one per descendant file (of any type) that `GET /paths` would list. Hidden entries and symlinks travel with a moved folder but are not in `M`: they are neither scanned as referring notes nor treated as link targets that moved. For each recognized link in a referring note whose pre-move path is `S0` and post-move path is `S1` (equal unless the note itself moved):

- Let `t0 = resolve(link, S0, F_before)`. An unresolved link is never rewritten.
- Let `expected` be `M(t0)` if `t0` moved, else `t0`, and `t1 = resolve(link, S1, F_after)`.
- The link MUST be rewritten when either `t0` moved or the note itself moved, and either `t1 ≠ expected` or the link resolved at the relative step before the move but not after it. It MUST be left byte-for-byte unchanged otherwise.

The second condition keeps a relative link relative: a relative link that only still finds its target through the by-name fallback is rewritten, because other Markdown renderers do not have that fallback.

This covers both halves of a move: links into the moved files, and the moved notes' own outgoing links whose meaning depends on where the note lives (relative links, and by-name links whose tie-break changed). A link in an unmoved note to an unmoved file is never rewritten, even if the move changed what it resolves to — see [Open Questions](#open-questions). A link that resolved to a destination file replaced with `overwrite: true` keeps resolving to that path, now holding the moved content, and is not rewritten.

### Rewritten text

- Only the linkpath is replaced. The `!` embed marker, `#heading` / `#^block` suffix, `|alias`, Markdown link text, title, angle brackets, and all surrounding bytes MUST be preserved exactly.
- The new linkpath for target `T` (the post-move path of the file the link must keep pointing at) keeps the link's style:

  | Original link | New linkpath |
  |---|---|
  | Wikilink by bare name (no `/`, not relative) | `T`'s file name, if `resolve` of it from `S1` yields `T`; otherwise `T`'s vault-relative path |
  | Wikilink with a vault path | `T`'s vault-relative path |
  | Relative (`./` or `../`) wikilink or Markdown link, or a Markdown link that resolved at step 1 | The relative path from `S1`'s folder to `T`, starting with `./` iff the original did and the result does not start with `../` |
  | Markdown link that resolved at step 2 | `T`'s vault-relative path, with a leading `/` iff the original had one |
  | Markdown link that resolved at step 3 | as for a bare-name wikilink |

- The new linkpath carries `T`'s actual extension (`icon.png`, `report.pdf`, `note.markdown`), with one exception: a `.md` extension is omitted iff the original linkpath carried no extension and `T` ends in `.md`.
- In a Markdown link the new linkpath is percent-encoded so that decoding it gives `T`'s path back: `%`, `#`, `\`, `<`, and `>` are always encoded (`%25`, `%23`, `%5C`, `%3C`, `%3E`), and without angle brackets so are spaces, `(`, and `)`. Inside angle brackets spaces, `(`, and `)` are written as is. Wikilinks are written unencoded.
- Every rewritten link MUST resolve, from `S1` after the move, to `T`. When the form the table gives does not, because another file shadows it, the first of these fallbacks that does resolve to `T` is used instead: the relative form (the relative path from `S1`'s folder to `T`, written `./…` when it does not start with `../`), then the vault-absolute form (`/`-prefixed for a Markdown link, the vault path for a wikilink). The extension and encoding rules above apply to the fallback too. Only a note in which some link has no form at all that resolves to `T` is reported in `failed`, and it is left unchanged.

### Applying rewrites

- The note is read under the [containment precondition](index.md#path-operations) for reads; a note that fails it is reported in `failed` with `invalid_path`.
- All rewrites of one note MUST be applied as one atomic write of that note and reindexed, exactly as `PUT` writes and reindexes a note, and serialized with other writes to it. Nothing but the rewritten linkpaths changes; line endings and every other byte are preserved.
- The rewrite MUST be computed from the note's bytes as read while holding its lock, so no ob write to that note is lost. A rewrite replaces the note it read; it never claims a new path, so the no-replace destination rule of [Path operations](index.md#path-operations) does not apply. Like `PUT` and `PATCH`, it cannot exclude a writer outside ob (Obsidian Sync) that changes or removes the note in the instant between that read and the atomic write; that window is a known limit shared with every in-place write, not specific to moves.
- A note that cannot be read or written, or that vanishes, is reported in `links.failed` with the error's `code` and left as it is; the remaining notes are still rewritten. A failed write removes only the temporary file it created itself, never the note, per the failure rule in [Path operations](index.md#path-operations).
- Each note write is held to the [containment precondition](index.md#path-operations): the symlink check on the note's parent chain runs immediately before the temporary file is created, again immediately before it is renamed over the note, and before a failed write removes it. A note whose chain fails a check is reported in `failed` with `invalid_path` and not written.
- `links.updated` lists every rewritten note once, by its post-move path, in path order, with the number of link occurrences rewritten in it and `indexed`, which is `false` when the note's text was written but its reindex failed. Such a note stays in `updated` — its links were rewritten — and also makes the move's top-level `indexed` `false`.

#### Scenario: Bare-name wikilink follows a rename

- **GIVEN** `notes/old.md` and `a.md` containing `[[old]] and [[old#Intro|the intro]]`
- **WHEN** `notes/old.md` is moved to `notes/new.md`
- **THEN** `a.md` contains `[[new]] and [[new#Intro|the intro]]` and is reported with `links: 2`

#### Scenario: Path-qualified wikilink follows a folder move

- **GIVEN** `projects/alpha/plan.md` and `index.md` containing `![[projects/alpha/plan]]`
- **WHEN** the folder `projects/alpha` is moved to `archive/alpha`
- **THEN** `index.md` contains `![[archive/alpha/plan]]`

#### Scenario: Bare name that would become ambiguous is qualified

- **GIVEN** `inbox/todo.md`, `work/todo.md`, and `a.md` in the vault root containing `[[todo]]`, which resolves to `inbox/todo.md`: neither candidate is in `a.md`'s folder, both have two segments, and `inbox/todo.md` comes first in path order
- **WHEN** `inbox/todo.md` is moved to `archive/2026/todo.md`
- **THEN** `[[todo]]` would now resolve to `work/todo.md`, so `a.md` contains `[[archive/2026/todo]]`

#### Scenario: Moved note's relative Markdown links are updated

- **GIVEN** `notes/a.md` containing `![diagram](img/d%201.png)` and the file `notes/img/d 1.png`
- **WHEN** `notes/a.md` is moved to `archive/a.md`
- **THEN** `archive/a.md` contains `![diagram](../notes/img/d%201.png)`, even though the old text would still have found the image by name

#### Scenario: Vault-absolute Markdown link keeps its leading slash

- **GIVEN** `assets/logo.png` and `notes/a.md` containing `![logo](/assets/logo.png)`
- **WHEN** `assets/logo.png` is moved to `media/logo.png`
- **THEN** `notes/a.md` contains `![logo](/media/logo.png)`, because a destination starting with `/` resolves at the vault-absolute step and keeps that style

#### Scenario: Shadowed vault path falls back to a relative link

- **GIVEN** `old/spec.md`, `docs/new/spec.md`, and `docs/n.md` containing `[spec](old/spec.md)`, which resolves at the vault-absolute step because `docs/old/spec.md` does not exist
- **WHEN** `old/spec.md` is moved to `new/spec.md`
- **THEN** the table's form `new/spec.md` would resolve relatively to `docs/new/spec.md`, so `docs/n.md` contains `[spec](../new/spec.md)`, the relative fallback, which resolves to `new/spec.md`

#### Scenario: Attachment move updates embeds

- **GIVEN** `assets/logo.png` and `readme.md` containing `![[logo.png]]`
- **WHEN** `assets/logo.png` is moved to `assets/brand/logo.png`
- **THEN** `readme.md` is unchanged, because `[[logo.png]]` still resolves to the moved file by name

#### Scenario: Code is never rewritten

- **GIVEN** `notes/old.md` and `a.md` containing `` `[[old]]` `` and a fenced block containing `[[old]]`
- **WHEN** `notes/old.md` is moved to `notes/new.md`
- **THEN** `a.md` is unchanged and not reported

#### Scenario: One failing note does not undo the move

- **GIVEN** `notes/old.md`, and `a.md` and `locked/b.md` both linking `[[old]]`, where the folder `locked/` cannot be written
- **WHEN** `notes/old.md` is moved to `notes/new.md`
- **THEN** the response is `200`, `notes/new.md` exists, `a.md` is rewritten and listed in `links.updated`, and `locked/b.md` is listed in `links.failed` and unchanged

## Open Questions

- **Tie-break fidelity.** Obsidian's resolution of a bare name shared by several files is undocumented; ob picks same folder, then fewest segments, then path order. **Default**: keep ob's rule; revisit if a real vault shows Obsidian resolving differently.
- **Links whose meaning a move changes without touching their target.** Moving a file can make an unrelated bare-name link in an unmoved note resolve to the moved file instead of what it resolved to before. Obsidian does not correct this either. **Default**: not rewritten.
- **Frontmatter `aliases` and canvas files.** Links by alias and links inside `.canvas` files are not maintained. **Default**: out of scope until requested.

/**
 * Lint-level test for the containment precondition (REST API › Path
 * operations): move, copy, and rewrite code MUST NOT call a filesystem
 * function that creates, writes, links, renames, or removes a path except
 * inside a `guarded(…)` or `stagingInterior(…)` call. The source files are
 * scanned as text: every mutating `fs.x(` must lie within the argument list
 * of one of those two helpers, and no other route to a mutating function
 * (a sync variant, a direct `node:fs/promises` import, `Bun.write`) may
 * appear at all.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const FILES = ["paths.ts", "copy.ts", "links.ts", "parents.ts"];
const SRC = join(import.meta.dir, "..", "..", "src", "vault");

const MUTATING =
  /\bfs\.(mkdir|mkdtemp|open|writeFile|appendFile|link|symlink|rename|unlink|rmdir|rm|cp|copyFile|truncate|chmod|chown|lchown|utimes|lutimes)\(/g;

/** `[start, end)` of every `guarded(` / `stagingInterior(` call's argument list. */
function helperRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  for (const m of text.matchAll(/\b(guarded|stagingInterior)\(/g)) {
    const open = (m.index as number) + m[0].length - 1;
    let depth = 0;
    for (let i = open; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) {
        ranges.push([open, i]);
        break;
      }
    }
  }
  return ranges;
}

/** Mutating calls in `text` that are not inside a helper call. */
function unguardedCalls(text: string): string[] {
  const ranges = helperRanges(text);
  const bad: string[] = [];
  for (const m of text.matchAll(MUTATING)) {
    const at = m.index as number;
    if (!ranges.some(([s, e]) => at > s && at < e)) {
      const line = text.slice(0, at).split("\n").length;
      bad.push(`${m[0]} at line ${line}`);
    }
  }
  if (/\b\w+Sync\(/.test(text.replace(/\/\/.*$/gm, ""))) bad.push("a synchronous fs call");
  if (/from "node:fs\/promises"/.test(text)) bad.push("a direct node:fs/promises import");
  if (/\bBun\.write\(/.test(text)) bad.push("Bun.write");
  return bad;
}

describe("move, copy, and rewrite code reach mutating fs only through guarded / stagingInterior", () => {
  for (const file of FILES) {
    test(file, () => {
      expect(unguardedCalls(readFileSync(join(SRC, file), "utf8"))).toEqual([]);
    });
  }

  test("the scanner itself catches an unguarded call, a sync variant, and a direct import", () => {
    expect(unguardedCalls("await fs.unlink(p);")).toEqual(["fs.unlink( at line 1"]);
    expect(unguardedCalls("await guarded(g, s, [p], () => fs.unlink(p));")).toEqual([]);
    expect(unguardedCalls("await stagingInterior(st, t, () => fs.mkdir(t));")).toEqual([]);
    expect(unguardedCalls("await guarded(g, s, [p], () => x());\nfs.rename(a, b);")).toEqual([
      "fs.rename( at line 2",
    ]);
    expect(unguardedCalls("rmSync(p);")).toEqual(["a synchronous fs call"]);
    expect(unguardedCalls('import { rm } from "node:fs/promises";')).toEqual([
      "a direct node:fs/promises import",
    ]);
    expect(unguardedCalls("await Bun.write(p, b);")).toEqual(["Bun.write"]);
  });
});

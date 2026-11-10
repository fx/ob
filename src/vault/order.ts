/**
 * The one path order every path operation lists, pages, and reports in
 * (REST API › Path operations): paths compared segment by segment (split on
 * `/`), each segment by raw code point, a path sorting before every path it
 * is a proper segment-prefix of. That is the pre-order of a walk that sorts
 * each directory's entries by `compareSegments`.
 */

/** Compare two strings by raw code point (not UTF-16 code unit). */
export function compareSegments(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; ) {
    const ca = a.codePointAt(i) as number;
    const cb = b.codePointAt(i) as number;
    if (ca !== cb) return ca < cb ? -1 : 1;
    // Equal code points have equal UTF-16 width, so one step serves both.
    i += ca > 0xffff ? 2 : 1;
  }
  return Math.sign(a.length - b.length);
}

/**
 * Segment-wise path order: split on `/`, compare segment by segment by raw
 * code point; a path sorts before every path it is a proper segment-prefix of.
 */
export function comparePaths(a: string, b: string): number {
  const sa = a.split("/");
  const sb = b.split("/");
  const n = Math.min(sa.length, sb.length);
  for (let i = 0; i < n; i++) {
    const c = compareSegments(sa[i] as string, sb[i] as string);
    if (c !== 0) return c;
  }
  return Math.sign(sa.length - sb.length);
}

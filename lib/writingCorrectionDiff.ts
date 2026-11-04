export type CorrectionDiffPart = { text: string; added: boolean };
export type CorrectionSidePart = { text: string; changed: boolean };

/**
 * Full-document, exact character diff. A bounded Myers search handles ordinary
 * small edits in O((n + m) * editDistance); exact Hirschberg LCS handles broader
 * rewrites with linear working memory. Neither path approximates the result.
 * No teacher locations, edit provenance, persisted ranges or rewrite heuristic.
 * Code points keep astral characters intact; whitespace is never normalized.
 * Common edges are stripped at every recursion, making ordinary typing cheap.
 * Worst-case time is O(original.length * current.length), space O(n + m).
 */
export function writingCorrectionDiff(original: string, current: string): CorrectionDiffPart[] {
  const sides = writingCorrectionDiffSides(original, current);
  return sides.current;
}

/**
 * Same exact matching, returned for both documents. The original side marks
 * the characters that did not survive, so deletions can be rendered in place.
 * Current-side output is byte-identical to writingCorrectionDiff.
 */
export function writingCorrectionDiffSides(
  original: string,
  current: string
): { original: CorrectionSidePart[]; current: CorrectionDiffPart[] } {
  if (original === current) {
    return {
      original: current ? [{ text: current, changed: false }] : [],
      current: current ? [{ text: current, added: false }] : []
    };
  }
  const left = Array.from(original);
  const right = Array.from(current);
  const matched = new Uint8Array(right.length);
  const originalMatched = new Uint8Array(left.length);

  function smallEditDiff(): boolean {
    // Bound trace memory, NOT text length or the number of supported changes.
    // If this search runs out, the exact linear-space algorithm below takes over.
    const limit = Math.min(128, left.length + right.length);
    const offset = limit + 1;
    const frontier = new Int32Array(2 * limit + 3).fill(-1);
    frontier[offset + 1] = 0;
    const trace: Int32Array[] = [];
    for (let distance = 0; distance <= limit; distance++) {
      trace.push(frontier.slice());
      for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
        const index = offset + diagonal;
        let x = diagonal === -distance || (diagonal !== distance && frontier[index - 1] < frontier[index + 1])
          ? frontier[index + 1] : frontier[index - 1] + 1;
        let y = x - diagonal;
        while (x < left.length && y < right.length && left[x] === right[y]) { x++; y++; }
        frontier[index] = x;
        if (x < left.length || y < right.length) continue;
        // Walk the shortest edit path back; only surviving current characters
        // are marked equal. Deleted characters never generate output nodes.
        for (let depth = distance; depth >= 0; depth--) {
          const previous = trace[depth];
          const k = x - y;
          const previousK = k === -depth || (k !== depth && previous[offset + k - 1] < previous[offset + k + 1]) ? k + 1 : k - 1;
          const previousX = previous[offset + previousK];
          const previousY = previousX - previousK;
          while (x > previousX && y > previousY) {
            y--; x--;
            matched[y] = 1;
            originalMatched[x] = 1;
          }
          x = previousX; y = previousY;
        }
        return true;
      }
    }
    return false;
  }

  function lengths(a0: number, a1: number, b0: number, b1: number, reverse: boolean) {
    const width = b1 - b0;
    const row = new Uint32Array(width + 1);
    for (let i = 0; i < a1 - a0; i++) {
      let diagonal = 0;
      const a = left[reverse ? a1 - 1 - i : a0 + i];
      for (let j = 1; j <= width; j++) {
        const above = row[j];
        row[j] = a === right[reverse ? b1 - j : b0 + j - 1]
          ? diagonal + 1 : Math.max(above, row[j - 1]);
        diagonal = above;
      }
    }
    return row;
  }

  function split(a0: number, a1: number, b0: number, b1: number, mid: number) {
    // The rows are released before recursing, rather than retained per level.
    const forward = lengths(a0, mid, b0, b1, false);
    const backward = lengths(mid, a1, b0, b1, true);
    let best = -1;
    let offset = 0;
    for (let j = 0; j <= b1 - b0; j++) {
      const score = forward[j] + backward[b1 - b0 - j];
      if (score > best) { best = score; offset = j; }
    }
    return b0 + offset;
  }

  function match(a0: number, a1: number, b0: number, b1: number): void {
    while (a0 < a1 && b0 < b1 && left[a0] === right[b0]) {
      matched[b0++] = 1;
      originalMatched[a0++] = 1;
    }
    while (a0 < a1 && b0 < b1 && left[a1 - 1] === right[b1 - 1]) {
      matched[--b1] = 1;
      originalMatched[--a1] = 1;
    }
    if (a0 === a1 || b0 === b1) return;
    if (a1 - a0 === 1) {
      for (let j = b0; j < b1; j++) {
        if (right[j] === left[a0]) { matched[j] = 1; originalMatched[a0] = 1; break; }
      }
      return;
    }
    // Entirely unrelated passages need no quadratic work.
    const alphabet = new Set(left.slice(a0, a1));
    if (!right.slice(b0, b1).some((char) => alphabet.has(char))) return;
    const mid = a0 + Math.floor((a1 - a0) / 2);
    const boundary = split(a0, a1, b0, b1, mid);
    match(a0, mid, b0, boundary);
    match(mid, a1, boundary, b1);
  }
  if (!smallEditDiff()) match(0, left.length, 0, right.length);
  return {
    original: groupSide(left, originalMatched),
    current: groupSide(right, matched).map((part) => ({
      text: part.text,
      added: part.changed
    }))
  };
}

function groupSide(
  characters: string[],
  flags: Uint8Array
): CorrectionSidePart[] {
  const parts: CorrectionSidePart[] = [];
  let start = 0;
  while (start < characters.length) {
    let end = start + 1;
    while (end < characters.length && flags[end] === flags[start]) end++;
    parts.push({
      text: characters.slice(start, end).join(""),
      changed: flags[start] === 0
    });
    start = end;
  }
  return parts;
}

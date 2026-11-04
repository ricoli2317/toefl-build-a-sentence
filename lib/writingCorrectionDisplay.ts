import {
  writingCorrectionDiffSides,
  type CorrectionDiffPart,
  type CorrectionSidePart
} from "./writingCorrectionDiff.ts";

export const WRITING_CORRECTION_CHANGE_STYLE = {
  backgroundColor: "#E8F2FF",
  color: "#2457A6"
} as const;

/** Existing overtime colour reused for removed text. No new palette. */
export const WRITING_CORRECTION_DELETION_STYLE = {
  color: "#8f1025",
  textDecoration: "line-through"
} as const;

export type CorrectionSideDiff = {
  original: CorrectionSidePart[];
  current: CorrectionSidePart[];
};

/**
 * Display-only normalization of the exact character diff. Never changes the
 * source text, stored draft, or the Myers/Hirschberg matching decisions.
 *
 * Expand changed letters to their Latin word (including contractions,
 * hyphenated words and combining marks), then join changed words only across
 * whitespace on the same line. Complete unchanged words, punctuation and line
 * boundaries remain anchors; there is no sentence-wide/short-word heuristic.
 * Pure deletion has no inserted code points and therefore no painted placeholder.
 * Non-Latin prose and emoji retain the core's code-point-safe granularity.
 */
export function writingCorrectionDisplayDiff(
  original: string,
  current: string
): CorrectionDiffPart[] {
  return writingCorrectionDisplaySides(original, current).current.map((part) => ({
    text: part.text,
    added: part.changed
  }));
}

/** The same normalization applied to both documents for the comparison view. */
export function writingCorrectionDisplaySides(
  original: string,
  current: string
): CorrectionSideDiff {
  const raw = writingCorrectionDiffSides(original, current);
  return {
    original: expandChanged(original, raw.original),
    current: expandChanged(
      current,
      raw.current.map((part) => ({ text: part.text, changed: part.added }))
    )
  };
}

function expandChanged(
  text: string,
  parts: Array<{ text: string; changed: boolean }>
): CorrectionSidePart[] {
  const changed = new Uint8Array(text.length);
  let offset = 0;
  for (const part of parts) {
    if (part.changed) changed.fill(1, offset, offset + part.text.length);
    offset += part.text.length;
  }
  const words = new RegExp("[\\p{Script=Latin}\\p{N}\\p{M}]+(?:['’\\-][\\p{Script=Latin}\\p{N}\\p{M}]+)*", "gu");
  for (const word of Array.from(text.matchAll(words))) {
    const start = word.index;
    const end = start + word[0].length;
    if (changed.subarray(start, end).some(Boolean)) changed.fill(1, start, end);
  }
  // Highlighting a separator adds no layout styles. Do not swallow an unchanged
  // word, punctuation, paragraph, or the rest of a sentence to connect regions.
  for (const space of Array.from(text.matchAll(/[^\S\r\n]+/g))) {
    const start = space.index;
    const end = start + space[0].length;
    if (start > 0 && end < text.length && changed[start - 1] && changed[end]) {
      changed.fill(1, start, end);
    }
  }
  const result: CorrectionSidePart[] = [];
  for (let start = 0; start < text.length;) {
    let end = start + 1;
    while (end < text.length && changed[end] === changed[start]) end++;
    result.push({ text: text.slice(start, end), changed: changed[start] === 1 });
    start = end;
  }
  return result;
}

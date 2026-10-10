// Input capacity only: deliberately independent of spelling normalization and
// grading. Spaces, hyphens, apostrophes and other non-ASCII letters stay intact.
export const spellingLetterCount = (value: string) => (value.match(/[A-Za-z]/g) ?? []).length;
export const spellingLetterLimit = (shape: string) => (shape.match(/_/g) ?? []).length;
export function insertReviewSpelling(shape: string, previous: string, start: number, end: number, inserted: string) {
  const before = previous.slice(0, start), after = previous.slice(end);
  let remaining = Math.max(0, spellingLetterLimit(shape) - spellingLetterCount(before + after));
  let accepted = "";
  for (const char of Array.from(inserted)) {
    if (/[A-Za-z]/.test(char)) { if (!remaining) continue; remaining--; }
    // Retain the existing 300-character native/API ceiling as well.
    if (before.length + accepted.length + char.length + after.length > 300) break;
    accepted += char;
  }
  return { value: before + accepted + after, caret: before.length + accepted.length };
}
/** Fallback for non-cancelable Safari input, autofill and IME commit. Compare
 * the edit, not the entire string, so an insertion never discards the suffix. */
export function constrainReviewSpelling(shape: string, previous: string, next: string) {
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  let end = previous.length, nextEnd = next.length;
  while (end > start && nextEnd > start && previous[end - 1] === next[nextEnd - 1]) { end--; nextEnd--; }
  return insertReviewSpelling(shape, previous, start, end, next.slice(start, nextEnd));
}

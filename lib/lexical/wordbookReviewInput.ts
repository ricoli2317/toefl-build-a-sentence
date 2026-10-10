// The one native input holds only editable characters. Fixed spaces belong to
// the shape, not the buffer; submission restores them without changing grading.
export const spellingInputValue = (value: string) => value.replace(/\s/g, "");
export const spellingLetterCount = (value: string) => Array.from(spellingInputValue(value)).length;
export const spellingLetterLimit = (shape: string) => Array.from(spellingInputValue(shape)).length;
export function formatReviewSpelling(shape: string, input: string) {
  const typed = Array.from(spellingInputValue(input)); let position = 0, value = "";
  for (const char of Array.from(shape)) {
    if (position >= typed.length) break;
    value += /\s/.test(char) ? char : typed[position++];
  }
  return value;
}
export function insertReviewSpelling(shape: string, previous: string, start: number, end: number, inserted: string) {
  const buffer = spellingInputValue(previous), before = buffer.slice(0, start), after = buffer.slice(end);
  const remaining = Math.max(0, spellingLetterLimit(shape) - spellingLetterCount(before + after));
  const accepted = Array.from(spellingInputValue(inserted)).slice(0, remaining).join("");
  return { value: formatReviewSpelling(shape, before + accepted + after), caret: before.length + accepted.length };
}
/** Non-cancelable Safari input, autofill and IME commit: constrain the edit,
 * preserving its untouched suffix rather than truncating the entire value. */
export function constrainReviewSpelling(shape: string, previous: string, next: string) {
  previous = spellingInputValue(previous); next = spellingInputValue(next);
  let start = 0;
  while (start < previous.length && start < next.length && previous[start] === next[start]) start++;
  let end = previous.length, nextEnd = next.length;
  while (end > start && nextEnd > start && previous[end - 1] === next[nextEnd - 1]) { end--; nextEnd--; }
  return insertReviewSpelling(shape, previous, start, end, next.slice(start, nextEnd));
}

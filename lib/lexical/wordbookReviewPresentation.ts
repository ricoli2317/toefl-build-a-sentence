import type { ReviewState } from "./wordbookReview.ts";

export type ReviewExamplePart = { text: string; target?: boolean };
export type ReviewPresentation = { expression: string; pos: string | null; meaning: string;
  examples: { text: string; kind: string }[] };

/** Only an exact, word-bounded saved target can authorize showing an example.
 * Uncertain inflections/fragments are omitted, never guessed or AI-generated. */
export function reviewExample(text: string, expression: string, mask: boolean): ReviewExamplePart[] | null {
  const escaped = expression.trim().split(/\s+/).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
  if (!escaped) return null;
  const pattern = new RegExp(`(?<![A-Za-z])${escaped}(?![A-Za-z])`, "gi");
  const parts: ReviewExamplePart[] = []; let offset = 0;
  for (const match of Array.from(text.matchAll(pattern))) {
    if (match.index! > offset) parts.push({ text: text.slice(offset, match.index) });
    parts.push({ text: mask ? "" : match[0], target: true });
    offset = match.index! + match[0].length;
  }
  if (!parts.length) return null;
  if (offset < text.length) parts.push({ text: text.slice(offset) });
  return parts;
}
export function spellingShape(expression: string) {
  return Array.from(expression).map(char => /[A-Za-z]/.test(char) ? "_" : char).join("");
}
/** Explicit API allowlist: raw spelling and unmasked examples never cross the
 * test boundary; study deliberately exposes the same saved source sense. */
export function presentReviewState(raw: ReviewState & { presentation: ReviewPresentation }): ReviewState {
  const { presentation, ...state } = raw;
  const study = state.flow?.phase === "study";
  const mask = !study && state.item.kind === "spelling_pos";
  const examples = [...(presentation.examples ?? [])].sort((a, b) => Number(b.kind === "sentence") - Number(a.kind === "sentence"));
  const example = examples.map(e => reviewExample(e.text, presentation.expression, mask)).find(Boolean) ?? null;
  return { ...state, item: { ...state.item, example,
    ...(study ? { study: { expression: presentation.expression, pos: presentation.pos, meaning: presentation.meaning } }
      : state.item.kind === "spelling_pos" ? { spellingShape: spellingShape(presentation.expression) } : {}) } };
}

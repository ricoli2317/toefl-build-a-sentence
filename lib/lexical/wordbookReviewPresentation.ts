import type { ReviewState } from "./wordbookReview.ts";

export type ReviewExamplePart = { text: string; target?: boolean };
export type ReviewPresentation = { expression: string; pos: string | null; meaning: string;
  examples: { text: string; kind: string }[] };

/** Saved examples are content, not proof to re-authorize. A known occurrence
 * surface (e.g. yields for yield) decorates that same saved sense. No guessing. */
export function reviewExample(text: string, expression: string, mask: boolean, forms: string[] = []): ReviewExamplePart[] | null {
  if (!text.trim()) return null;
  const escaped = Array.from(new Set([expression, ...forms].filter(s => s.trim()).map(s => s.trim())))
    .sort((a, b) => b.length - a.length).map(s => s.split(/\s+/).map(s => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+")).join("|");
  if (!escaped) return [{ text }];
  const pattern = new RegExp(`(?<![A-Za-z])(?:${escaped})(?![A-Za-z])`, "gi");
  const parts: ReviewExamplePart[] = []; let offset = 0;
  for (const match of Array.from(text.matchAll(pattern))) {
    if (match.index! > offset) parts.push({ text: text.slice(offset, match.index) });
    parts.push({ text: mask ? "" : match[0], target: true });
    offset = match.index! + match[0].length;
  }
  if (!parts.length) return [{ text }];
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

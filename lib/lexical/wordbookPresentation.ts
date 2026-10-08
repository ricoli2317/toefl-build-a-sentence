// Display-only mappings. Never change the immutable context_pos snapshot.
const POS: Record<string, string> = {
  noun: "n.", verb: "v.", adjective: "adj.", adverb: "adv.", pronoun: "pron.",
  preposition: "prep.", conjunction: "conj.", interjection: "interj.",
  "phrasal verb": "phr. v.", phrasal_verb: "phr. v.", proper_noun: "prop. n.",
  "proper noun": "prop. n.", determiner: "det.", auxiliary: "aux.",
  "auxiliary verb": "aux. v.", modal: "modal", particle: "part.", numeral: "num."
};
export function wordbookPos(value: string | null) {
  return value === null || value === "" ? "—" : POS[value.trim().toLowerCase()] ?? value;
}

/** Binary search over graphemes (not UTF-16 units), preserving the full source.
 * The caller measures real DOM wrapping including an inline clickable suffix. */
export function twoLinePrefix(text: string, fits: (prefix: string, toggle: boolean) => boolean) {
  if (fits(text, false)) return null;
  const graphemes = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text));
  const prefix = (count: number) => text.slice(0, count < graphemes.length ? graphemes[count].index : text.length).trimEnd();
  let low = 0, high = graphemes.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (fits(prefix(mid), true)) low = mid; else high = mid - 1;
  }
  return prefix(low);
}

// Keep a source grapheme beside the atomic button, so the ellipsis cannot wrap
// onto a line of its own. Both the probe and visible DOM use this exact split.
export function wordbookExampleTail(text: string) {
  const last = Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)).at(-1);
  return last ? [text.slice(0, last.index), last.segment] as const : ["", ""] as const;
}

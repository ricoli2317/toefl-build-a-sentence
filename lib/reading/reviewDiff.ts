import type { ReadingOption, ReadingQuestion } from "./types.ts";

export type ReadingInlineDiffSegment = {
  text: string;
  changed: boolean;
};

export type ReadingInlineDiff = {
  existing: ReadingInlineDiffSegment[];
  incoming: ReadingInlineDiffSegment[];
};

const SENTENCE_SELECTION_INSTRUCTION = /\s*select\s+the\s+sentence\s+to\s+make\s+your\s+choice\s*\.?\s*$/i;

/** Comparison-only normalization. Source/canonical strings are never mutated. */
export function normalizeReadingReviewText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u201a\u201b\u2032\u2035\u275b\u275c\u02bc\uff07]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033\u2036\u275d\u275e\u301d-\u301f\uff02]/g, '"')
    .replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g, "-")
    .replace(/\u2026/g, "...")
    .toLocaleLowerCase("en-US")
    .replace(/\b([ap])\.?\s*m\.?\b/g, "$1m")
    .replace(/[!-/:-@[-`{-~\u00a1-\u00bf\u2000-\u206f\u20a0-\u20cf\u25a0\s]+/g, "")
    .trim();
}

export function normalizeReadingQuestionStem(
  questionType: ReadingQuestion["questionType"],
  value: string
) {
  return normalizeReadingReviewText(
    questionType === "rap_sentence_selection"
      ? stripRapSentenceSelectionInstruction(value)
      : value
  );
}

export function stripRapSentenceSelectionInstruction(value: string) {
  return value.replace(SENTENCE_SELECTION_INSTRUCTION, "").trim();
}

export function sameReadingReviewText(left: string, right: string) {
  return normalizeReadingReviewText(left) === normalizeReadingReviewText(right);
}

export function readingUnorderedPairKey(leftIdentity: string, rightIdentity: string) {
  return [leftIdentity, rightIdentity].sort().join("\u001f");
}

/** Produces a compact character-level change with bounded surrounding context. */
export function buildReadingInlineDiff(
  existing: string,
  incoming: string,
  contextLength = 48
): ReadingInlineDiff {
  const left = Array.from(existing);
  const right = Array.from(incoming);
  let prefix = 0;
  while (prefix < left.length && prefix < right.length && left[prefix] === right[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < left.length - prefix
    && suffix < right.length - prefix
    && left[left.length - 1 - suffix] === right[right.length - 1 - suffix]
  ) suffix += 1;

  const start = Math.max(0, prefix - contextLength);
  const leftEnd = Math.min(left.length, left.length - suffix + contextLength);
  const rightEnd = Math.min(right.length, right.length - suffix + contextLength);
  const sharedPrefix = `${start > 0 ? "…" : ""}${left.slice(start, prefix).join("")}`;
  const sharedLeftSuffix = `${left.slice(left.length - suffix, leftEnd).join("")}${leftEnd < left.length ? "…" : ""}`;
  const sharedRightSuffix = `${right.slice(right.length - suffix, rightEnd).join("")}${rightEnd < right.length ? "…" : ""}`;

  return {
    existing: compactSegments([
      { text: sharedPrefix, changed: false },
      { text: boundedChangedText(left.slice(prefix, left.length - suffix), contextLength), changed: true },
      { text: sharedLeftSuffix, changed: false }
    ]),
    incoming: compactSegments([
      { text: sharedPrefix, changed: false },
      { text: boundedChangedText(right.slice(prefix, right.length - suffix), contextLength), changed: true },
      { text: sharedRightSuffix, changed: false }
    ])
  };
}

function boundedChangedText(characters: string[], contextLength: number) {
  if (characters.length <= contextLength * 2) return characters.join("");
  return `${characters.slice(0, contextLength).join("")}…${characters.slice(-contextLength).join("")}`;
}

export function alignChangedReadingOptions(
  existing: ReadingOption[],
  incoming: ReadingOption[]
): Array<{ existing: ReadingOption | null; incoming: ReadingOption | null }> {
  const incomingRemaining = new Set(incoming.map((_, index) => index));
  const existingRemaining = new Set(existing.map((_, index) => index));

  for (let leftIndex = 0; leftIndex < existing.length; leftIndex += 1) {
    const normalized = normalizeReadingReviewText(existing[leftIndex].text);
    const rightIndex = Array.from(incomingRemaining).find(
      (index) => normalizeReadingReviewText(incoming[index].text) === normalized
    );
    if (rightIndex === undefined) continue;
    existingRemaining.delete(leftIndex);
    incomingRemaining.delete(rightIndex);
  }

  const left = Array.from(existingRemaining).map((index) => existing[index]);
  const right = Array.from(incomingRemaining).map((index) => incoming[index]);
  const pairs: Array<{ existing: ReadingOption | null; incoming: ReadingOption | null }> = [];
  while (left.length > 0 && right.length > 0) {
    let bestLeft = 0;
    let bestRight = 0;
    let bestScore = -1;
    for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
      for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
        const score = commonAffixScore(left[leftIndex].text, right[rightIndex].text);
        if (score > bestScore) {
          bestScore = score;
          bestLeft = leftIndex;
          bestRight = rightIndex;
        }
      }
    }
    pairs.push({ existing: left.splice(bestLeft, 1)[0], incoming: right.splice(bestRight, 1)[0] });
  }
  pairs.push(...left.map((option) => ({ existing: option, incoming: null })));
  pairs.push(...right.map((option) => ({ existing: null, incoming: option })));
  return pairs;
}

function compactSegments(segments: ReadingInlineDiffSegment[]) {
  return segments.filter((segment) => segment.changed || segment.text.length > 0);
}

function commonAffixScore(left: string, right: string) {
  const a = Array.from(normalizeReadingReviewText(left));
  const b = Array.from(normalizeReadingReviewText(right));
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix
    && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix += 1;
  return prefix + suffix;
}

import {
  normalizeCtwAnswer,
  reconstructCompletedCtwPassage
} from "./ctwLogicalIdentity.ts";
import type { ReadingCtwDuplicateDifference } from "./duplicateResolutionModel.ts";
import type { CtwQuestion, CtwSlot } from "./types.ts";

type PassageToken = { raw: string; normalized: string };

// RegExp construction preserves Unicode property escapes with this project's
// TypeScript output target. These values are presentation diagnostics only and
// never participate in CTW logical identity.
const PASSAGE_WORD = new RegExp("[\\p{L}\\p{N}]+(?:[’'][\\p{L}\\p{N}]+)*", "gu");
const PASSAGE_PUNCTUATION = new RegExp("[^\\p{L}\\p{N}\\s]+", "gu");

export function buildCtwDuplicateDifferences(
  incoming: CtwQuestion,
  candidate: CtwQuestion
): ReadingCtwDuplicateDifference[] {
  const incomingPassage = reconstructCompletedCtwPassage(incoming);
  const candidatePassage = reconstructCompletedCtwPassage(candidate);
  const incomingSlots = orderedSlots(incoming.payload.slots);
  const candidateSlots = orderedSlots(candidate.payload.slots);

  return [
    ...passageLexicalDifferences(incomingPassage, candidatePassage),
    ...slotValueDifferences("answer", "答案", incomingSlots, candidateSlots, (slot) => slot.answer),
    ...answerOrderDifferences(incomingSlots, candidateSlots),
    ...slotValueDifferences("prefix", "前缀", incomingSlots, candidateSlots, (slot) => slot.prefix),
    ...sequenceDifferences(
      "punctuation",
      "正文标点",
      incomingPassage.match(PASSAGE_PUNCTUATION) ?? [],
      candidatePassage.match(PASSAGE_PUNCTUATION) ?? []
    ),
    ...sequenceDifferences(
      "whitespace",
      "正文空白",
      incomingPassage.match(/\s+/g) ?? [],
      candidatePassage.match(/\s+/g) ?? []
    ),
    ...slotValueDifferences("display", "填空显示", incomingSlots, candidateSlots, (slot) => slot.displayText)
  ];
}

function passageLexicalDifferences(
  incoming: string,
  candidate: string
): ReadingCtwDuplicateDifference[] {
  const left = passageTokens(incoming);
  const right = passageTokens(candidate);
  const matches = longestCommonSubsequence(left, right);
  const boundaries = [[-1, -1], ...matches, [left.length, right.length]];
  return boundaries.slice(1).flatMap(([leftEnd, rightEnd], index) => {
    const [leftStart, rightStart] = boundaries[index];
    const incomingWords = left.slice(leftStart + 1, leftEnd).map((token) => token.raw);
    const candidateWords = right.slice(rightStart + 1, rightEnd).map((token) => token.raw);
    if (incomingWords.length === 0 && candidateWords.length === 0) return [];
    const wordNumber = Math.min(leftStart + 2, left.length || 1);
    return [{
      kind: "passage_lexical" as const,
      location: `完整正文第 ${wordNumber} 个词`,
      incoming: incomingWords.join(" ") || "∅",
      candidate: candidateWords.join(" ") || "∅"
    }];
  });
}

function passageTokens(value: string): PassageToken[] {
  return (value.match(PASSAGE_WORD) ?? []).map((raw) => ({
    raw,
    normalized: normalizeCtwAnswer(raw)
  }));
}

function longestCommonSubsequence(
  left: PassageToken[],
  right: PassageToken[]
): Array<[number, number]> {
  const lengths = Array.from(
    { length: left.length + 1 },
    () => Array<number>(right.length + 1).fill(0)
  );
  for (let leftIndex = left.length - 1; leftIndex >= 0; leftIndex -= 1) {
    for (let rightIndex = right.length - 1; rightIndex >= 0; rightIndex -= 1) {
      lengths[leftIndex][rightIndex] = left[leftIndex].normalized === right[rightIndex].normalized
        ? lengths[leftIndex + 1][rightIndex + 1] + 1
        : Math.max(lengths[leftIndex + 1][rightIndex], lengths[leftIndex][rightIndex + 1]);
    }
  }
  const result: Array<[number, number]> = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    if (left[leftIndex].normalized === right[rightIndex].normalized) {
      result.push([leftIndex, rightIndex]);
      leftIndex += 1;
      rightIndex += 1;
    } else if (lengths[leftIndex + 1][rightIndex] >= lengths[leftIndex][rightIndex + 1]) {
      leftIndex += 1;
    } else {
      rightIndex += 1;
    }
  }
  return result;
}

function slotValueDifferences(
  kind: Extract<ReadingCtwDuplicateDifference["kind"], "answer" | "prefix" | "display">,
  label: string,
  incoming: CtwSlot[],
  candidate: CtwSlot[],
  value: (slot: CtwSlot) => string
): ReadingCtwDuplicateDifference[] {
  return sequenceDifferences(
    kind,
    label,
    incoming.map(value),
    candidate.map(value),
    incoming.map((slot) => slot.slotOrder)
  );
}

function answerOrderDifferences(
  incoming: CtwSlot[],
  candidate: CtwSlot[]
): ReadingCtwDuplicateDifference[] {
  const left = incoming.map((slot) => normalizeCtwAnswer(slot.answer));
  const right = candidate.map((slot) => normalizeCtwAnswer(slot.answer));
  if (arraysEqual(left, right) || !arraysEqual([...left].sort(), [...right].sort())) return [];
  return [{
    kind: "answer_order",
    location: "答案顺序",
    incoming: incoming.map((slot) => slot.answer).join(" → "),
    candidate: candidate.map((slot) => slot.answer).join(" → ")
  }];
}

function sequenceDifferences(
  kind: ReadingCtwDuplicateDifference["kind"],
  label: string,
  incoming: string[],
  candidate: string[],
  slotOrders?: number[]
): ReadingCtwDuplicateDifference[] {
  const length = Math.max(incoming.length, candidate.length);
  return Array.from({ length }, (_, index) => {
    const left = incoming[index];
    const right = candidate[index];
    if (left === right) return null;
    const position = slotOrders?.[index] ?? index + 1;
    return {
      kind,
      location: slotOrders ? `第 ${position} 空${label}` : `${label}第 ${position} 处`,
      incoming: left ?? "∅",
      candidate: right ?? "∅"
    };
  }).filter((difference): difference is ReadingCtwDuplicateDifference => difference !== null);
}

function orderedSlots(slots: CtwSlot[]) {
  return [...slots].sort((left, right) => left.slotOrder - right.slotOrder);
}

function arraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

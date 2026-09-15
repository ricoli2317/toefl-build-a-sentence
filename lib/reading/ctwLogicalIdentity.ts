import type { CtwQuestion, CtwSlot, ReadingImportPackage } from "./types.ts";

export const CTW_LOGICAL_IDENTITY_VERSION = "ctw-masked-framework-v2";
type CtwLogicalIdentityQuestion = Pick<CtwQuestion, "questionId" | "payload">;

const UNICODE_PUNCTUATION = new RegExp("\\p{P}+", "gu");
const BLANK_PLACEHOLDER = /<BLANK_(\d+)>/g;

export type CtwLogicalIdentity = {
  version: typeof CTW_LOGICAL_IDENTITY_VERSION;
  normalizedMaskedParagraphs: string[];
  orderedBlankSequence: number[];
  blankCount: number;
};

export type CtwSlotContentConflict = {
  kind: "prefix_conflict" | "answer_conflict" | "prefix_and_answer_conflict";
  slots: Array<{
    slotOrder: number;
    differenceKinds: Array<"prefix" | "answer">;
    leftPrefix: string;
    rightPrefix: string;
    leftAnswer: string;
    rightAnswer: string;
    leftReviewText: string;
    rightReviewText: string;
  }>;
};

export type CtwLogicalIdentityComparison = {
  sameLogicalItem: boolean;
  leftIdentity: CtwLogicalIdentity;
  rightIdentity: CtwLogicalIdentity;
  /** Canonical-content review signals. These never change logical identity. */
  nonIdentityConflicts: CtwSlotContentConflict[];
};

/** Debug/content helper only. Completed answers never participate in identity. */
export function reconstructCompletedCtwPassage(question: CtwLogicalIdentityQuestion): string {
  const slotById = uniqueSlotsById(question.payload.slots);
  return ordered(question.payload.paragraphs, (paragraph) => paragraph.paragraphOrder)
    .map((paragraph) => paragraph.segments.map((segment) => {
      if (segment.kind === "text") return segment.text;
      const slot = slotById.get(segment.slotId);
      if (!slot) {
        throw new Error(
          `CTW content reconstruction cannot resolve slot ${segment.slotId} in question ${question.questionId}`
        );
      }
      return slot.answer;
    }).join(""))
    .join("\n");
}

/** Builds identity text only from structured paragraph/segment/slot topology. */
export function buildCtwMaskedFramework(question: CtwLogicalIdentityQuestion): string[] {
  const slotById = uniqueSlotsById(question.payload.slots);
  const encountered = new Set<string>();
  const paragraphs = ordered(question.payload.paragraphs, (paragraph) => paragraph.paragraphOrder)
    .map((paragraph) => paragraph.segments.map((segment) => {
      if (segment.kind === "text") return segment.text;
      const slot = slotById.get(segment.slotId);
      if (!slot) {
        throw new Error(
          `CTW masked framework cannot resolve slot ${segment.slotId} in question ${question.questionId}`
        );
      }
      if (encountered.has(segment.slotId)) {
        throw new Error(`CTW masked framework found repeated slot ${segment.slotId}`);
      }
      encountered.add(segment.slotId);
      return ` <BLANK_${slot.slotOrder}> `;
    }).join(""));
  if (encountered.size !== slotById.size) {
    const missing = Array.from(slotById.keys()).filter((slotId) => !encountered.has(slotId));
    throw new Error(`CTW masked framework has unplaced slots: ${missing.join(", ")}`);
  }
  return paragraphs;
}

export function normalizeCtwMaskedFramework(paragraphs: string[]): string[] {
  return paragraphs.map((paragraph) => {
    const pieces: string[] = [];
    let cursor = 0;
    for (const match of Array.from(paragraph.matchAll(BLANK_PLACEHOLDER))) {
      const text = normalizeCtwIdentityText(paragraph.slice(cursor, match.index));
      if (text) pieces.push(text);
      pieces.push(`<BLANK_${match[1]}>`);
      cursor = (match.index ?? 0) + match[0].length;
    }
    const tail = normalizeCtwIdentityText(paragraph.slice(cursor));
    if (tail) pieces.push(tail);
    return pieces.join(" ").replace(/\s+/g, " ").trim();
  });
}

/** Public normalization primitive retained for audit/debug callers. */
export function normalizeCtwIdentityPassage(value: string): string {
  return normalizeCtwIdentityText(value);
}

export function normalizeCtwAnswer(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ")
    .trim();
}

/** Debug/content helper only. Ordered answers are explicitly outside identity. */
export function normalizeCtwOrderedAnswers(question: CtwLogicalIdentityQuestion): string[] {
  return orderedSlots(question.payload.slots).map((slot) => normalizeCtwAnswer(slot.answer));
}

export function buildCtwLogicalIdentity(question: CtwLogicalIdentityQuestion): CtwLogicalIdentity {
  const normalizedMaskedParagraphs = normalizeCtwMaskedFramework(
    buildCtwMaskedFramework(question)
  );
  const orderedBlankSequence = normalizedMaskedParagraphs.flatMap((paragraph) =>
    Array.from(paragraph.matchAll(BLANK_PLACEHOLDER), (match) => Number(match[1]))
  );
  return {
    version: CTW_LOGICAL_IDENTITY_VERSION,
    normalizedMaskedParagraphs,
    orderedBlankSequence,
    blankCount: orderedBlankSequence.length
  };
}

/** Stable SHA-256 input. Hashing this value belongs in the server-only module. */
export function serializeCtwLogicalIdentity(identity: CtwLogicalIdentity): string {
  return JSON.stringify([
    identity.version,
    identity.normalizedMaskedParagraphs,
    identity.orderedBlankSequence
  ]);
}

export function ctwQuestionFromPackage(packageData: ReadingImportPackage): CtwQuestion {
  const question = packageData.questions[0];
  if (
    packageData.item.module !== "ctw"
    || packageData.questions.length !== 1
    || question?.questionType !== "ctw"
  ) {
    throw new Error(
      `CTW logical identity requires one complete CTW question in ${packageData.item.logicalItemId}`
    );
  }
  return question;
}

export function buildCtwPackageLogicalIdentity(
  packageData: ReadingImportPackage
): CtwLogicalIdentity {
  return buildCtwLogicalIdentity(ctwQuestionFromPackage(packageData));
}

export function compareCtwPackageLogicalIdentity(
  left: ReadingImportPackage,
  right: ReadingImportPackage
): CtwLogicalIdentityComparison {
  return compareCtwLogicalIdentity(
    ctwQuestionFromPackage(left),
    ctwQuestionFromPackage(right)
  );
}

export function compareCtwLogicalIdentity(
  left: CtwLogicalIdentityQuestion,
  right: CtwLogicalIdentityQuestion
): CtwLogicalIdentityComparison {
  const leftIdentity = buildCtwLogicalIdentity(left);
  const rightIdentity = buildCtwLogicalIdentity(right);
  const sameLogicalItem = serializeCtwLogicalIdentity(leftIdentity)
    === serializeCtwLogicalIdentity(rightIdentity);
  return {
    sameLogicalItem,
    leftIdentity,
    rightIdentity,
    nonIdentityConflicts: sameLogicalItem
      ? slotContentConflicts(left.payload.slots, right.payload.slots)
      : []
  };
}

export function ctwSlotReviewText(slot: Pick<CtwSlot, "answer" | "prefix">) {
  const prefixLength = Array.from(slot.prefix).length;
  const answerLength = Array.from(slot.answer).length;
  const missingLength = Math.max(0, answerLength - prefixLength);
  return `${slot.prefix}${"_".repeat(missingLength)} → ${slot.answer}`;
}

function slotContentConflicts(left: CtwSlot[], right: CtwSlot[]): CtwSlotContentConflict[] {
  const leftSlots = orderedSlots(left);
  const rightSlots = orderedSlots(right);
  if (leftSlots.length !== rightSlots.length) return [];
  const slots = leftSlots.flatMap((leftSlot, index) => {
    const rightSlot = rightSlots[index];
    if (!rightSlot || leftSlot.slotOrder !== rightSlot.slotOrder) return [];
    const prefixDiffers = normalizeCtwAnswer(leftSlot.prefix) !== normalizeCtwAnswer(rightSlot.prefix);
    const answerDiffers = normalizeCtwAnswer(leftSlot.answer) !== normalizeCtwAnswer(rightSlot.answer);
    if (!prefixDiffers && !answerDiffers) return [];
    const differenceKinds: Array<"prefix" | "answer"> = [
      ...(prefixDiffers ? ["prefix" as const] : []),
      ...(answerDiffers ? ["answer" as const] : [])
    ];
    return [{
      slotOrder: leftSlot.slotOrder,
      differenceKinds,
      leftPrefix: leftSlot.prefix,
      rightPrefix: rightSlot.prefix,
      leftAnswer: leftSlot.answer,
      rightAnswer: rightSlot.answer,
      leftReviewText: ctwSlotReviewText(leftSlot),
      rightReviewText: ctwSlotReviewText(rightSlot)
    }];
  });
  return slots.map((slot) => ({
    kind: slot.differenceKinds.length === 2
      ? "prefix_and_answer_conflict" as const
      : slot.differenceKinds[0] === "prefix"
        ? "prefix_conflict" as const
        : "answer_conflict" as const,
    slots: [slot]
  }));
}

function normalizeCtwIdentityText(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g, "-")
    .replace(UNICODE_PUNCTUATION, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniqueSlotsById(slots: CtwSlot[]) {
  const result = new Map<string, CtwSlot>();
  for (const slot of slots) {
    if (result.has(slot.slotId)) {
      throw new Error(`CTW logical identity found duplicate slot ID ${slot.slotId}`);
    }
    result.set(slot.slotId, slot);
  }
  return result;
}

function orderedSlots(slots: CtwSlot[]) {
  const result = ordered(slots, (slot) => slot.slotOrder);
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1].slotOrder === result[index].slotOrder) {
      throw new Error(`CTW logical identity found duplicate slot order ${result[index].slotOrder}`);
    }
  }
  return result;
}

function ordered<T>(values: T[], order: (value: T) => number) {
  return [...values].sort((left, right) => order(left) - order(right));
}

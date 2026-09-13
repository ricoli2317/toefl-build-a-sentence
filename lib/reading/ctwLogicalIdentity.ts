import { createHash } from "node:crypto";
import type { CtwQuestion, CtwSlot, ReadingImportPackage } from "./types.ts";

export const CTW_LOGICAL_IDENTITY_VERSION = "ctw-logical-identity-v1";
type CtwLogicalIdentityQuestion = Pick<CtwQuestion, "questionId" | "payload">;

// RegExp construction keeps Unicode property escapes available at runtime
// while this project's TypeScript output target remains ES5.
const UNICODE_PUNCTUATION = new RegExp("\\p{P}+", "gu");

export type CtwLogicalIdentity = {
  version: typeof CTW_LOGICAL_IDENTITY_VERSION;
  normalizedCompletedPassage: string;
  orderedNormalizedAnswers: string[];
  key: string;
};

export type CtwPrefixConflict = {
  kind: "prefix_conflict";
  slots: Array<{
    slotOrder: number;
    leftPrefix: string;
    rightPrefix: string;
  }>;
};

export type CtwLogicalIdentityComparison = {
  sameLogicalItem: boolean;
  leftIdentity: CtwLogicalIdentity;
  rightIdentity: CtwLogicalIdentity;
  /** Presentation/content-review signals. These never change logical identity. */
  nonIdentityConflicts: CtwPrefixConflict[];
};

/**
 * Replaces every CTW blank with its complete correct answer and returns the
 * natural passage in paragraph/segment order. Raw display text, prefixes,
 * underscore counts, and missing-text serialization are intentionally unused.
 */
export function reconstructCompletedCtwPassage(question: CtwLogicalIdentityQuestion): string {
  const slotById = uniqueSlotsById(question.payload.slots);
  return ordered(question.payload.paragraphs, (paragraph) => paragraph.paragraphOrder)
    .map((paragraph) => paragraph.segments.map((segment) => {
      if (segment.kind === "text") return segment.text;
      const slot = slotById.get(segment.slotId);
      if (!slot) {
        throw new Error(
          `CTW logical identity cannot resolve slot ${segment.slotId} in question ${question.questionId}`
        );
      }
      return slot.answer;
    }).join(""))
    .join("\n");
}

/**
 * Canonical comparison text for a completed CTW passage. Unicode punctuation
 * (including underscores, dashes, quotes, apostrophes, and brackets) is
 * treated only as a word boundary and cannot participate in identity.
 */
export function normalizeCtwIdentityPassage(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g, "-")
    .replace(UNICODE_PUNCTUATION, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCtwAnswer(value: string): string {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("en-US")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeCtwOrderedAnswers(question: CtwLogicalIdentityQuestion): string[] {
  return orderedSlots(question.payload.slots).map((slot) => normalizeCtwAnswer(slot.answer));
}

/**
 * The only CTW logical identity value: normalized completed passage plus the
 * ordered normalized complete answers. The hash contains no presentation or
 * blank-boundary fields.
 */
export function buildCtwLogicalIdentity(question: CtwLogicalIdentityQuestion): CtwLogicalIdentity {
  const normalizedCompletedPassage = normalizeCtwIdentityPassage(
    reconstructCompletedCtwPassage(question)
  );
  const orderedNormalizedAnswers = normalizeCtwOrderedAnswers(question);
  const canonicalValue = JSON.stringify([
    normalizedCompletedPassage,
    orderedNormalizedAnswers
  ]);
  return {
    version: CTW_LOGICAL_IDENTITY_VERSION,
    normalizedCompletedPassage,
    orderedNormalizedAnswers,
    key: createHash("sha256").update(canonicalValue).digest("hex")
  };
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
  const sameLogicalItem =
    leftIdentity.normalizedCompletedPassage === rightIdentity.normalizedCompletedPassage
    && arraysEqual(
      leftIdentity.orderedNormalizedAnswers,
      rightIdentity.orderedNormalizedAnswers
    );

  return {
    sameLogicalItem,
    leftIdentity,
    rightIdentity,
    nonIdentityConflicts: sameLogicalItem
      ? prefixConflicts(left.payload.slots, right.payload.slots)
      : []
  };
}

function prefixConflicts(left: CtwSlot[], right: CtwSlot[]): CtwPrefixConflict[] {
  const leftSlots = orderedSlots(left);
  const rightSlots = orderedSlots(right);
  if (leftSlots.length !== rightSlots.length) return [];
  const slots = leftSlots.flatMap((leftSlot, index) => {
    const rightSlot = rightSlots[index];
    const leftPrefix = normalizeCtwAnswer(leftSlot.prefix);
    const rightPrefix = normalizeCtwAnswer(rightSlot.prefix);
    return leftPrefix === rightPrefix
      ? []
      : [{ slotOrder: leftSlot.slotOrder, leftPrefix, rightPrefix }];
  });
  return slots.length > 0 ? [{ kind: "prefix_conflict", slots }] : [];
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

function arraysEqual(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

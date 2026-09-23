import type { PracticeTaskType } from "./practiceImporter/types.ts";
import type { ReadingCorrectionAnswerPresentation } from "./reading/correctionResult.ts";
import type { ReadingAnswer, ReadingAnswerState } from "./reading/practiceState.ts";
import type { SubmittedReadingReviewItem } from "./reading/review.ts";
import type { StudentReadingPracticePayload } from "./reading/studentPractice.ts";
import type { ReadingModule } from "./reading/types.ts";
import { READING_PRODUCT_NAMES } from "./reading/product.ts";
import { assertCanonicalCtwTitle } from "./reading/ctwTitles.ts";
import { assertCanonicalRdlTitle } from "./reading/rdlTitles.ts";
import type { OccurrenceDateCount } from "./catalogOccurrenceDates.ts";

export const TEACHER_READING_BANK_PAGE_SIZE = 10;

export type TeacherQuestionBankTaskType = PracticeTaskType | ReadingModule;

export type TeacherReadingBankCatalogItem = {
  itemId: string;
  module: ReadingModule;
  displayNumber: string;
  title: string;
  firstSeenDate: string;
  latestSeenDate: string;
  occurrenceDates: string[];
  occurrenceDateCounts: OccurrenceDateCount[];
  occurrenceCount: number;
  category: string;
  searchText: string;
  questionCount: number;
  scoringPointCount: number;
};

export type TeacherReadingBankCatalog = {
  module: ReadingModule;
  items: TeacherReadingBankCatalogItem[];
};

export type TeacherReadingBankAnswerKeyEntry = {
  answerId: string;
  questionId: string;
  slotId: string | null;
  order: number;
  /**
   * Answer-key value for the shared read-only workspace: CTW fills the blank
   * characters, single-answer questions mark the correct option / anchor /
   * sentence.
   */
  answer: ReadingAnswer | null;
  ctwCharacters: string[] | null;
};

export type TeacherReadingBankAnswerKey = {
  entries: TeacherReadingBankAnswerKeyEntry[];
  presentations: Record<string, ReadingCorrectionAnswerPresentation>;
};

export type TeacherReadingBankItemDetail = {
  /** Canonical student-safe question content, identical to the student practice payload. */
  practice: StudentReadingPracticePayload;
  /** Correct answers only; never a student attempt or attempt answer row. */
  answerKey: TeacherReadingBankAnswerKey | null;
};

/**
 * Adapts a teacher answer key to the shared read-only renderer props. The
 * correct answers fill the same answer state a fully-correct student response
 * would, and the answer-key context hides student-answer rows.
 */
export function buildTeacherReadingAnswerKeyView(
  answerKey: TeacherReadingBankAnswerKey | null
): {
  answers: ReadingAnswerState;
  disclosures: Record<string, ReadingCorrectionAnswerPresentation>;
  reviewItems: SubmittedReadingReviewItem[];
} {
  const answers: ReadingAnswerState = {};
  const disclosures: Record<string, ReadingCorrectionAnswerPresentation> = {};
  const reviewItems: SubmittedReadingReviewItem[] = [];

  for (const entry of answerKey?.entries ?? []) {
    const presentation = answerKey?.presentations[entry.answerId];
    if (presentation) disclosures[entry.answerId] = presentation;
    reviewItems.push({
      answerId: entry.answerId,
      order: entry.order,
      isAnswered: true,
      isCorrect: true,
      questionId: entry.questionId,
      slotId: entry.slotId,
      questionTimeSeconds: null
    });

    if (entry.ctwCharacters && entry.slotId) {
      const current = answers[entry.questionId];
      const slots = current?.kind === "ctw" ? { ...current.slots } : {};
      slots[entry.slotId] = entry.ctwCharacters;
      answers[entry.questionId] = { kind: "ctw", slots };
      continue;
    }
    if (entry.answer) answers[entry.questionId] = entry.answer;
  }

  return { answers, disclosures, reviewItems };
}

export function isReadingModuleTaskType(
  value: unknown
): value is ReadingModule {
  return value === "ctw" || value === "rdl" || value === "rap";
}

export function isTeacherQuestionBankTaskType(
  value: unknown
): value is TeacherQuestionBankTaskType {
  return isReadingModuleTaskType(value)
    || value === "build_sentence"
    || value === "email"
    || value === "academic_discussion";
}

export function readingBankItemTitle(input: {
  module: ReadingModule;
  title: string | null;
  displayNumber: string;
}) {
  if (input.module === "ctw") {
    return assertCanonicalCtwTitle(
      input.title ?? "",
      `CTW title for ${input.displayNumber}`
    );
  }
  if (input.module === "rdl") {
    return assertCanonicalRdlTitle(
      input.title ?? "",
      `RDL title for ${input.displayNumber}`
    );
  }
  return input.title?.trim() || READING_PRODUCT_NAMES[input.module];
}

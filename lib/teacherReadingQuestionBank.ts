import type { PracticeTaskType } from "./practiceImporter/types.ts";
import type { ReadingModule } from "./reading/types.ts";
import { READING_PRODUCT_NAMES } from "./reading/product.ts";
import { assertCanonicalRdlTitle } from "./reading/rdlTitles.ts";

export const TEACHER_READING_BANK_PAGE_SIZE = 10;

export type TeacherQuestionBankTaskType = PracticeTaskType | ReadingModule;

export type TeacherReadingBankCatalogItem = {
  itemId: string;
  module: ReadingModule;
  displayNumber: string;
  title: string;
  firstSeenDate: string;
  occurrenceDates: string[];
  questionCount: number;
  scoringPointCount: number;
};

export type TeacherReadingBankCatalog = {
  module: ReadingModule;
  page: number;
  pageSize: number;
  totalItems: number;
  totalPages: number;
  items: TeacherReadingBankCatalogItem[];
};

export type TeacherReadingBankOption = {
  optionId: string;
  optionOrder: number;
  text: string;
  isCorrect: boolean;
};

export type TeacherReadingBankCtwSegment =
  | { kind: "text"; text: string }
  | { kind: "blank"; slotId: string; displayText: string; answer: string };

export type TeacherReadingBankQuestion = {
  questionId: string;
  questionOrder: number;
  questionType:
    | "ctw"
    | "rdl"
    | "rap_multiple_choice"
    | "rap_sentence_insertion"
    | "rap_sentence_selection";
  stem: string;
  options: TeacherReadingBankOption[];
  ctwParagraphs: Array<{
    paragraphId: string;
    paragraphOrder: number;
    segments: TeacherReadingBankCtwSegment[];
  }>;
  insertSentence: string | null;
  correctAnchorId: string | null;
  anchors: Array<{
    anchorId: string;
    anchorOrder: number;
    paragraphId: string;
    boundaryIndex: number;
    afterSentenceText: string | null;
  }>;
  targetParagraphId: string | null;
  correctSentenceId: string | null;
  correctSentenceText: string | null;
};

export type TeacherReadingBankItemDetail = {
  item: TeacherReadingBankCatalogItem;
  material: {
    materialId: string;
    title: string;
    materialType: string | null;
    imageUrl: string | null;
  } | null;
  passage: {
    passageId: string;
    title: string;
    paragraphs: Array<{
      paragraphId: string;
      paragraphOrder: number;
      text: string;
      sentences: Array<{ sentenceId: string; sentenceOrder: number; text: string }>;
    }>;
  } | null;
  questions: TeacherReadingBankQuestion[];
};

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
  if (input.module === "ctw") return `套题${input.displayNumber}`;
  if (input.module === "rdl") {
    return assertCanonicalRdlTitle(
      input.title ?? "",
      `RDL title for ${input.displayNumber}`
    );
  }
  return input.title?.trim() || READING_PRODUCT_NAMES[input.module];
}

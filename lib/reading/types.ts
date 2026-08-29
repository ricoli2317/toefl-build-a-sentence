import type { RdlMaterialType } from "./materialTypes.ts";

export const READING_QUESTION_TYPES = [
  "ctw",
  "rdl",
  "rap_multiple_choice",
  "rap_sentence_insertion",
  "rap_sentence_selection"
] as const;

export type ReadingQuestionType = (typeof READING_QUESTION_TYPES)[number];
export type ReadingModule = "ctw" | "rdl" | "rap";
export type ReadingTestModule = "m1" | "m2";

export type ReadingLogicalItem = {
  logicalItemId: string;
  module: ReadingModule;
  title: string | null;
  firstSeenDate: string;
  firstSeenSourceLabel: string;
  firstSeenSourceOrder: number;
  dedupFingerprint: string;
  questionCount: number;
  scoredItemCount: number;
  isActive: boolean;
};

export type ReadingQuestionSource = {
  questionId: string;
  sourceQuestionStart: number;
  sourceQuestionEnd: number;
};

export type ReadingSourceOccurrence = {
  occurrenceId: string;
  logicalItemId: string;
  sourceKind: string;
  sourceLabel: string;
  occurrenceDate: string;
  yearMonth: string;
  sourceQuestionFile: string;
  sourceAnswerFile: string;
  sourceModule: ReadingTestModule;
  sourceOrder: number;
  sourceQuestionStart: number;
  sourceQuestionEnd: number;
  questionSources: ReadingQuestionSource[];
};

export type ReadingOption = {
  optionId: string;
  optionOrder: number;
  text: string;
};

export type ReadingMaterial = {
  materialId: string;
  title: string | null;
  materialType: RdlMaterialType | null;
  source: string;
  sourceDate: string | null;
  yearMonth: string;
  bindingStatus: "bound" | "pending";
  imageAssetPath: string | null;
  hitboxDataPath: string | null;
};

export type ReadingPassageSentence = {
  sentenceId: string;
  sentenceOrder: number;
  text: string;
};

export type ReadingPassageParagraph = {
  paragraphId: string;
  paragraphOrder: number;
  text: string;
  rawText: string;
  sentences: ReadingPassageSentence[];
};

export type ReadingPassage = {
  passageId: string;
  logicalItemId: string;
  title: string;
  paragraphs: ReadingPassageParagraph[];
};

export type CtwTextSegment = { kind: "text"; text: string };
export type CtwBlankSegment = { kind: "blank"; slotId: string };
export type CtwSegment = CtwTextSegment | CtwBlankSegment;

export type CtwParagraph = {
  paragraphId: string;
  paragraphOrder: number;
  rawText: string;
  segments: CtwSegment[];
};

export type CtwSlot = {
  slotId: string;
  slotOrder: number;
  paragraphId: string;
  answer: string;
  prefix: string;
  displayText: string;
  missingText: string;
  missingLength: number;
};

export type ReadingInsertionAnchor = {
  anchorId: string;
  anchorOrder: number;
  paragraphId: string;
  boundaryIndex: number;
  afterSentenceId: string | null;
};

type ReadingQuestionBase<TType extends ReadingQuestionType, TPayload> = {
  questionId: string;
  logicalItemId: string;
  questionOrder: number;
  questionType: TType;
  stem: string;
  rawDisplayText: string | null;
  payload: TPayload;
};

export type CtwQuestion = ReadingQuestionBase<"ctw", {
  paragraphs: CtwParagraph[];
  slots: CtwSlot[];
}>;

export type RdlQuestion = ReadingQuestionBase<"rdl", {
  materialId: string;
  options: ReadingOption[];
  correctOptionId: string;
}>;

export type RapMultipleChoiceQuestion = ReadingQuestionBase<"rap_multiple_choice", {
  passageId: string;
  options: ReadingOption[];
  correctOptionId: string;
}>;

export type RapSentenceInsertionQuestion = ReadingQuestionBase<"rap_sentence_insertion", {
  passageId: string;
  insertSentence: string;
  anchors: ReadingInsertionAnchor[];
  correctAnchorId: string;
}>;

export type RapSentenceSelectionQuestion = ReadingQuestionBase<"rap_sentence_selection", {
  passageId: string;
  targetParagraphId: string;
  correctSentenceId: string;
}>;

export type ReadingQuestion =
  | CtwQuestion
  | RdlQuestion
  | RapMultipleChoiceQuestion
  | RapSentenceInsertionQuestion
  | RapSentenceSelectionQuestion;

export type ReadingImportPackage = {
  schemaVersion: 2;
  item: ReadingLogicalItem;
  occurrences: ReadingSourceOccurrence[];
  materials: ReadingMaterial[];
  passages: ReadingPassage[];
  questions: ReadingQuestion[];
};

export type ReadingSourceDescriptor = {
  sourceKind: string;
  sourceLabel: string;
  occurrenceDate: string;
  yearMonth: string;
  sourceQuestionFile: string;
  sourceAnswerFile: string;
  sourceModule: ReadingTestModule;
  sourceOrder: number;
  sourceQuestionStart: number;
  sourceQuestionEnd: number;
};

type WithSourceRange<T> = T extends ReadingQuestion
  ? Omit<T, "logicalItemId"> & { sourceQuestionStart: number; sourceQuestionEnd: number }
  : never;

export type ReadingSourceQuestion = WithSourceRange<ReadingQuestion>;

export type ReadingSourceOccurrenceCandidate = {
  sourceOccurrenceId: string;
  module: ReadingModule;
  title: string | null;
  source: ReadingSourceDescriptor;
  materials: ReadingMaterial[];
  passages: Array<Omit<ReadingPassage, "logicalItemId">>;
  questions: ReadingSourceQuestion[];
};

export type ReadingSourcePackage = {
  schemaVersion: 1;
  sourceKind: string;
  sourceLabel: string;
  occurrences: ReadingSourceOccurrenceCandidate[];
};

export interface ReadingSourceAdapter<TSource> {
  readonly sourceKind: string;
  convert(source: TSource): Promise<ReadingSourcePackage>;
}

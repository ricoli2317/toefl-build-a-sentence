export type PracticeTaskType = "build_sentence" | "email" | "academic_discussion";

export type DuplicateClassification = "AUTO_MERGE" | "NEW_ITEM" | "NEEDS_REVIEW";

export type PracticeOccurrence = {
  occurredOn: string;
  sourceLabel: string;
};

export type BuildSentenceQuestionInput = {
  questionId: string;
  questionOrder: number;
  sentenceTemplate: string;
  blankCount: number;
  correctOrderText: string;
  optionsText: string;
  distractorsText: string;
  finalSentence: string;
};

export type EmailIdentityInput = {
  scenario: string;
  taskInstruction: string;
  requirements: [string, string, string];
  recipient: string;
};

export type AcademicDiscussionIdentityInput = {
  professorPrompt: string;
  studentResponses: [string, string];
};

export type LogicalCandidate<T> = {
  itemId: string;
  content: T;
};

export type ClassificationResult = {
  classification: DuplicateClassification;
  candidateItemId: string | null;
  similaritySummary: Record<string, unknown>;
};

export type BuildSentenceMapRow = {
  sourceQuestionId: string;
  sourceQuestionOrder: number;
  logicalQuestionOrder: number;
  questionFingerprint: string;
};

export type NumberingReconciliationReason =
  | "historical_new_item_insert"
  | "earlier_duplicate_occurrence";

export type NumberingReconciliationItem = {
  itemId: string;
  reason: NumberingReconciliationReason;
};

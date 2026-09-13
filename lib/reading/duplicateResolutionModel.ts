import type { ReadingModule } from "./types.ts";

export type ReadingDuplicateIdentityScope = "logical_item" | "material" | "passage";

export type ReadingDuplicateResolutionChoice =
  | {
      action: "reuse_existing";
      logicalItemId: string;
    }
  | {
      action: "create_new";
    };

export type ReadingDuplicateResolutionInput = ReadingDuplicateResolutionChoice & {
  resolutionId: string;
  questionType: ReadingModule;
};

export type ReadingDuplicateSourceOccurrencePreview = {
  sourceLabel: string;
  occurrenceDate: string;
  sourceModule: string;
  sourceOrder: number;
  sourceQuestionRange: string;
};

type ReadingDuplicatePreviewBase = ReadingDuplicateSourceOccurrencePreview & {
  logicalItemId: string;
  title: string | null;
};

export type ReadingCtwDuplicatePreview = ReadingDuplicatePreviewBase & {
  questionType: "ctw";
  detail: {
    passage: string;
    orderedBlanks: string[];
    correctAnswers: string[];
  };
};

export type ReadingCtwDuplicateDifference = {
  kind:
    | "passage_lexical"
    | "answer"
    | "answer_order"
    | "prefix"
    | "punctuation"
    | "whitespace"
    | "display";
  location: string;
  incoming: string;
  candidate: string;
};

export type ReadingRdlDuplicatePreview = ReadingDuplicatePreviewBase & {
  questionType: "rdl";
  detail: {
    materialId: string;
    materialType: string | null;
    materialTitle: string | null;
    materialSource: string;
    imageAssetPath: string | null;
    hitboxDataPath: string | null;
    questions: string[];
  };
};

export type ReadingRapDuplicatePreview = ReadingDuplicatePreviewBase & {
  questionType: "rap";
  detail: {
    passageId: string;
    passageTitle: string;
    passage: string;
    questionTypes: string[];
    questions: string[];
  };
};

export type ReadingDuplicatePreview =
  | ReadingCtwDuplicatePreview
  | ReadingRdlDuplicatePreview
  | ReadingRapDuplicatePreview;

export type ReadingDuplicateCandidate = ReadingDuplicatePreview & {
  firstSeenDate: string;
  firstSeenSourceLabel: string;
  sourceOccurrences: ReadingDuplicateSourceOccurrencePreview[];
  detectedDifferences?: ReadingCtwDuplicateDifference[];
  reviewDifferences: Array<{
    label: string;
    existing: string;
    incoming: string;
  }>;
};

export type ReadingDuplicateResolutionItem = {
  resolutionId: string;
  questionType: ReadingModule;
  identityScope: ReadingDuplicateIdentityScope;
  reasonCode: "possible_ctw_duplicate" | "possible_rdl_material" | "possible_rap_passage";
  reason: string;
  addedOccurrenceCount: number;
  existingOccurrenceCount: number;
  incoming: ReadingDuplicatePreview;
  candidates: ReadingDuplicateCandidate[];
  resolution: ReadingDuplicateResolutionChoice | null;
};

export function readingDuplicateIdentityScope(questionType: ReadingModule): ReadingDuplicateIdentityScope {
  if (questionType === "rdl") return "material";
  if (questionType === "rap") return "passage";
  return "logical_item";
}

export function readingDuplicateReasonCode(questionType: ReadingModule) {
  if (questionType === "rdl") return "possible_rdl_material" as const;
  if (questionType === "rap") return "possible_rap_passage" as const;
  return "possible_ctw_duplicate" as const;
}

export function assertReadingPendingResolutionInvariant(input: {
  hasPendingDuplicates: boolean;
  pendingResolutionItems: ReadingDuplicateResolutionItem[];
}) {
  if (input.hasPendingDuplicates && input.pendingResolutionItems.length === 0) {
    throw Object.assign(
      new Error("Reading pending duplicate invariant failed: pending flag has no actionable resolution items"),
      { code: "READING_PENDING_RESOLUTION_INVARIANT" }
    );
  }
  if (!input.hasPendingDuplicates && input.pendingResolutionItems.length > 0) {
    throw Object.assign(
      new Error("Reading pending duplicate invariant failed: actionable resolution items have no pending flag"),
      { code: "READING_PENDING_RESOLUTION_INVARIANT" }
    );
  }
  for (const item of input.pendingResolutionItems) {
    if (item.candidates.length === 0) {
      throw Object.assign(
        new Error(`Reading pending duplicate invariant failed: ${item.resolutionId} has no candidates`),
        { code: "READING_PENDING_RESOLUTION_INVARIANT" }
      );
    }
    if (item.incoming.questionType !== item.questionType
      || item.candidates.some((candidate) => candidate.questionType !== item.questionType)) {
      throw Object.assign(
        new Error(`Reading pending duplicate invariant failed: ${item.resolutionId} mixes question types`),
        { code: "READING_PENDING_RESOLUTION_INVARIANT" }
      );
    }
  }
}

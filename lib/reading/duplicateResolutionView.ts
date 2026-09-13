import type { ReadingDuplicateReviewPlan } from "./duplicateResolution.ts";
import type {
  ReadingDuplicateCandidate,
  ReadingDuplicatePreview,
  ReadingDuplicateResolutionItem,
  ReadingDuplicateSourceOccurrencePreview
} from "./duplicateResolutionModel.ts";
import type { ReadingImportPackage, ReadingQuestion } from "./types.ts";

export function buildReadingDuplicateResolutionItem(
  review: ReadingDuplicateReviewPlan,
  historicalOccurrences: Map<string, ReadingDuplicateSourceOccurrencePreview[]>
): ReadingDuplicateResolutionItem {
  return {
    resolutionId: review.resolutionId,
    questionType: review.questionType,
    identityScope: review.identityScope,
    reasonCode: review.reasonCode,
    reason: review.reason,
    addedOccurrenceCount: review.incoming.addedOccurrenceCount,
    existingOccurrenceCount:
      review.incoming.packageData.occurrences.length - review.incoming.addedOccurrenceCount,
    incoming: readingDuplicatePreview(review.incoming.packageData),
    candidates: review.candidates.map((candidate) => ({
      ...readingDuplicatePreview(candidate),
      firstSeenDate: candidate.item.firstSeenDate,
      firstSeenSourceLabel: candidate.item.firstSeenSourceLabel,
      sourceOccurrences: candidate.occurrences.length > 0
        ? candidate.occurrences.map(readingSourceOccurrencePreview)
        : historicalOccurrences.get(candidate.item.logicalItemId) ?? []
    })),
    resolution: null
  };
}

export function readingDuplicatePreview(packageData: ReadingImportPackage): ReadingDuplicatePreview {
  const occurrence = packageData.occurrences[0];
  const common = {
    logicalItemId: packageData.item.logicalItemId,
    title: packageData.item.title,
    sourceLabel: occurrence?.sourceLabel ?? packageData.item.firstSeenSourceLabel,
    occurrenceDate: occurrence?.occurrenceDate ?? packageData.item.firstSeenDate,
    sourceModule: occurrence?.sourceModule ?? "",
    sourceOrder: occurrence?.sourceOrder ?? packageData.item.firstSeenSourceOrder,
    sourceQuestionRange: occurrence
      ? readingQuestionRange(occurrence.sourceQuestionStart, occurrence.sourceQuestionEnd)
      : ""
  };
  if (packageData.item.module === "ctw") {
    const question = packageData.questions[0];
    if (!question || question.questionType !== "ctw") {
      throw new Error(`CTW duplicate preview cannot resolve ${packageData.item.logicalItemId}`);
    }
    const orderedSlots = [...question.payload.slots].sort((left, right) => left.slotOrder - right.slotOrder);
    return {
      ...common,
      questionType: "ctw",
      detail: {
        passage: question.payload.paragraphs.map((paragraph) => paragraph.rawText).join("\n\n"),
        orderedBlanks: orderedSlots.map((slot) => `${slot.slotOrder}. ${slot.displayText}`),
        correctAnswers: orderedSlots.map((slot) => `${slot.slotOrder}. ${slot.answer}`)
      }
    };
  }
  if (packageData.item.module === "rdl") {
    const material = packageData.materials[0];
    if (!material) throw new Error(`RDL duplicate preview cannot resolve ${packageData.item.logicalItemId}`);
    return {
      ...common,
      questionType: "rdl",
      detail: {
        materialId: material.materialId,
        materialType: material.materialType,
        materialTitle: material.title,
        materialSource: material.source,
        imageAssetPath: material.imageAssetPath,
        hitboxDataPath: material.hitboxDataPath,
        questions: packageData.questions.map(readingQuestionPreviewText)
      }
    };
  }
  const passage = packageData.passages[0];
  if (!passage) throw new Error(`RAP duplicate preview cannot resolve ${packageData.item.logicalItemId}`);
  return {
    ...common,
    questionType: "rap",
    detail: {
      passageId: passage.passageId,
      passageTitle: passage.title,
      passage: passage.paragraphs.map((paragraph) => paragraph.text).join("\n\n"),
      questionTypes: packageData.questions.map((question) => question.questionType),
      questions: packageData.questions.map(readingQuestionPreviewText)
    }
  };
}

export function readingQuestionPreviewText(question: ReadingQuestion) {
  const heading = `${question.questionOrder}. ${question.stem}`;
  if (question.questionType === "rdl" || question.questionType === "rap_multiple_choice") {
    return [
      heading,
      ...question.payload.options.map((option) =>
        `${option.optionOrder}. ${option.text}${option.optionId === question.payload.correctOptionId ? " ✓" : ""}`
      )
    ].join("\n");
  }
  if (question.questionType === "rap_sentence_insertion") {
    return `${heading}\nInsert: ${question.payload.insertSentence}`;
  }
  if (question.questionType === "rap_sentence_selection") {
    return `${heading}\nCorrect sentence: ${question.payload.correctSentenceId}`;
  }
  return heading;
}

export function readingSourceOccurrencePreview(
  occurrence: ReadingImportPackage["occurrences"][number]
): ReadingDuplicateSourceOccurrencePreview {
  return {
    sourceLabel: occurrence.sourceLabel,
    occurrenceDate: occurrence.occurrenceDate,
    sourceModule: occurrence.sourceModule,
    sourceOrder: occurrence.sourceOrder,
    sourceQuestionRange: readingQuestionRange(
      occurrence.sourceQuestionStart,
      occurrence.sourceQuestionEnd
    )
  };
}

export function readingQuestionRange(start: number, end: number) {
  return start === end ? String(start) : `${start}–${end}`;
}

export type ReadingDuplicateCandidateOccurrence = ReadingDuplicateCandidate["sourceOccurrences"][number];

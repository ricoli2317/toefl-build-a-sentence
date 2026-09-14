import type { ReadingDuplicateReviewPlan } from "./duplicateResolution.ts";
import type {
  ReadingDuplicateCandidate,
  ReadingDuplicatePreview,
  ReadingDuplicateResolutionItem,
  ReadingDuplicateSourceOccurrencePreview
} from "./duplicateResolutionModel.ts";
import type { ReadingImportPackage, ReadingQuestion } from "./types.ts";
import { buildCtwDuplicateDifferences } from "./ctwDuplicateDifferences.ts";
import { ctwQuestionFromPackage } from "./ctwLogicalIdentity.ts";
import { buildReadingContentConflict } from "./contentReconciliation.ts";
import { resolveReadingAssetUrl } from "./assets.ts";
import { buildReadingInlineDiff } from "./reviewDiff.ts";

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
    candidates: review.candidates.map((candidate) => {
      const incomingPreview = readingDuplicatePreview(review.incoming.packageData);
      const candidatePreview = readingDuplicatePreview(candidate);
      const detectedDifferences = review.questionType === "ctw"
        ? buildCtwDuplicateDifferences(
            ctwQuestionFromPackage(review.incoming.packageData),
            ctwQuestionFromPackage(candidate)
          )
        : undefined;
      return {
        ...candidatePreview,
        firstSeenDate: candidate.item.firstSeenDate,
        firstSeenSourceLabel: candidate.item.firstSeenSourceLabel,
        sourceOccurrences: candidate.occurrences.length > 0
          ? candidate.occurrences.map(readingSourceOccurrencePreview)
          : historicalOccurrences.get(candidate.item.logicalItemId) ?? [],
        detectedDifferences,
        reviewDifferences: duplicateReviewDifferences(
          candidate,
          review.incoming.packageData,
          candidatePreview,
          incomingPreview,
          detectedDifferences
        )
      };
    }),
    resolution: null
  };
}

function duplicateReviewDifferences(
  existingPackage: ReadingImportPackage,
  incomingPackage: ReadingImportPackage,
  existing: ReadingDuplicatePreview,
  incoming: ReadingDuplicatePreview,
  ctwDifferences?: NonNullable<ReadingDuplicateCandidate["detectedDifferences"]>
): ReadingDuplicateCandidate["reviewDifferences"] {
  if (existing.questionType !== incoming.questionType) {
    return [reviewDifference("题型", existing.questionType, incoming.questionType)];
  }
  if (existing.questionType === "ctw" && incoming.questionType === "ctw") {
    const answerPairs = new Set((ctwDifferences ?? [])
      .filter((difference) => difference.kind === "answer")
      .map((difference) => `${difference.incoming}\u001f${difference.candidate}`));
    return (ctwDifferences ?? []).flatMap((difference) => {
      if (difference.kind === "display" || difference.kind === "prefix"
        || difference.kind === "punctuation" || difference.kind === "whitespace") return [];
      if (difference.kind === "passage_lexical"
        && answerPairs.has(`${difference.incoming}\u001f${difference.candidate}`)) return [];
      return [{
        label: difference.location,
        existing: difference.candidate,
        incoming: difference.incoming,
        inlineDiff: buildReadingInlineDiff(difference.candidate, difference.incoming)
      }];
    });
  }
  if (existing.questionType === "rdl" && incoming.questionType === "rdl") {
    return [
      ...changedFields([
        ["素材类型", existing.detail.materialType ?? "未提供", incoming.detail.materialType ?? "未提供"],
        ["素材标题", existing.detail.materialTitle ?? "无标题", incoming.detail.materialTitle ?? "无标题"]
      ]),
      ...contentReviewDifferences(existingPackage, incomingPackage)
    ];
  }
  if (existing.questionType === "rap" && incoming.questionType === "rap") {
    return contentReviewDifferences(existingPackage, incomingPackage);
  }
  return [];
}

function changedFields(
  values: Array<[string, string, string]>
): ReadingDuplicateCandidate["reviewDifferences"] {
  return values.flatMap(([label, existing, incoming]) => existing === incoming
    ? []
    : [reviewDifference(label, existing, incoming)]);
}

function contentReviewDifferences(
  existing: ReadingImportPackage,
  incoming: ReadingImportPackage
): ReadingDuplicateCandidate["reviewDifferences"] {
  const conflict = buildReadingContentConflict(existing, incoming);
  if (!conflict) return [];
  return [...conflict.passageConflicts, ...conflict.questionConflicts.flatMap((question) =>
    question.differences.map((difference) => ({
      ...difference,
      label: `题目 ${question.sourceQuestionNumber ?? question.questionOrder} · ${difference.label}`
    }))
  )].map(({ label, existing: left, incoming: right, inlineDiff }) => ({
    label,
    existing: left,
    incoming: right,
    inlineDiff
  }));
}

function reviewDifference(label: string, existing: string, incoming: string) {
  return { label, existing, incoming, inlineDiff: buildReadingInlineDiff(existing, incoming) };
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
        imageUrl: resolveOptionalImageUrl(material.imageAssetPath)
      }
    };
  }
  const passage = packageData.passages[0];
  if (!passage) throw new Error(`RAP duplicate preview cannot resolve ${packageData.item.logicalItemId}`);
  return {
    ...common,
    questionType: "rap",
    detail: {
      passageTitle: passage.title
    }
  };
}

export function readingQuestionPreviewText(question: ReadingQuestion, packageData?: ReadingImportPackage) {
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
    const paragraph = packageData?.passages.flatMap((passage) => passage.paragraphs).find(
      (candidate) => candidate.paragraphId === question.payload.targetParagraphId
    );
    const selected = paragraph?.sentences.find(
      (sentence) => sentence.sentenceId === question.payload.correctSentenceId
    )?.text;
    return `${heading}\nCorrect sentence: ${selected ?? "Unresolved"}`;
  }
  return heading;
}

function resolveOptionalImageUrl(objectKey: string | null) {
  if (!objectKey) return null;
  try {
    return resolveReadingAssetUrl(objectKey.replace(/^\/+/, ""));
  } catch {
    return null;
  }
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

import type {
  ReadingImportPackage,
  ReadingInsertionAnchor,
  ReadingPassage,
  ReadingQuestion
} from "./types.ts";
import { resolveReadingAssetUrl } from "./assets.ts";
import {
  insertionPhysicalPositionsEqual,
  resolveInsertionAnchorPhysicalPosition
} from "./insertionBoundary.ts";

export type ReadingReviewSentenceContext = {
  paragraphOrder: number;
  sentenceOrder: number;
  text: string;
};

export type ReadingInsertionPositionReview = {
  paragraphOrder: number;
  paragraphIndex: number;
  boundaryIndex: number;
  sentenceCount: number;
  resolutionStatus: "resolved" | "unresolved";
  resolutionReason: string | null;
  textOffset: number | null;
  normalizedOffset: number | null;
  normalizedParagraphLength: number;
  normalizedLeftContext: string | null;
  normalizedRightContext: string | null;
  semanticKey: string;
  label: string;
  previousSentence: ReadingReviewSentenceContext | null;
  nextSentence: ReadingReviewSentenceContext | null;
};

export type ReadingInsertionDuplicateReview = {
  position: ReadingInsertionPositionReview;
  locationNumbers: number[];
};

export type ReadingInsertionAnchorSetReview = {
  resolvedAnchors: Array<{
    anchorId: string;
    locationNumber: number;
    position: ReadingInsertionPositionReview;
  }>;
  uniquePositions: ReadingInsertionPositionReview[];
  duplicates: ReadingInsertionDuplicateReview[];
};

export type ReadingReviewMarker = ReadingInsertionPositionReview & {
  questionNumber: number;
  locationNumber: number;
  comparisonStatus: "common" | "existing_only" | "incoming_only";
  duplicate: boolean;
};

export type ReadingReviewVersion = {
  module: ReadingImportPackage["item"]["module"];
  title: string | null;
  material: {
    title: string | null;
    source: string;
    imageUrl: string | null;
  } | null;
  ctwParagraphs: string[];
  passage: {
    title: string;
    paragraphs: Array<{
      paragraphOrder: number;
      text: string;
      sentences: Array<{ sentenceOrder: number; text: string }>;
      markers: ReadingReviewMarker[];
    }>;
  } | null;
  questions: Array<{
    questionOrder: number;
    sourceQuestionNumber: number | null;
    stem: string;
    detailLines: string[];
  }>;
};

export function resolveReadingInsertionPosition(
  passage: ReadingPassage,
  anchor: ReadingInsertionAnchor
): ReadingInsertionPositionReview {
  const paragraphs = [...passage.paragraphs].sort((left, right) => left.paragraphOrder - right.paragraphOrder);
  const paragraphIndex = paragraphs.findIndex((paragraph) => paragraph.paragraphId === anchor.paragraphId);
  const paragraph = paragraphs[paragraphIndex];
  if (!paragraph) throw new Error(`Reading insertion position cannot resolve paragraph ${anchor.paragraphId}`);
  const sentences = [...paragraph.sentences].sort((left, right) => left.sentenceOrder - right.sentenceOrder);
  if (anchor.boundaryIndex < 0 || anchor.boundaryIndex > sentences.length) {
    throw new Error(`Reading insertion boundary ${anchor.boundaryIndex} is outside paragraph ${paragraph.paragraphOrder}`);
  }
  const expectedAfter = anchor.boundaryIndex === 0 ? null : sentences[anchor.boundaryIndex - 1]?.sentenceId ?? null;
  if (anchor.afterSentenceId !== expectedAfter) {
    throw new Error(`Reading insertion boundary ${anchor.boundaryIndex} has inconsistent afterSentenceId`);
  }

  const physicalPosition = resolveInsertionAnchorPhysicalPosition(passage, anchor);

  const previous = anchor.boundaryIndex > 0
    ? sentences[anchor.boundaryIndex - 1]
    : orderedSentences(paragraphs[paragraphIndex - 1]).at(-1) ?? null;
  const next = anchor.boundaryIndex < sentences.length
    ? sentences[anchor.boundaryIndex]
    : orderedSentences(paragraphs[paragraphIndex + 1])[0] ?? null;
  const label = anchor.boundaryIndex === 0
    ? `第 ${paragraph.paragraphOrder} 段开头`
    : anchor.boundaryIndex === sentences.length
      ? `第 ${paragraph.paragraphOrder} 段末尾`
      : `第 ${paragraph.paragraphOrder} 段第 ${anchor.boundaryIndex} 句之后`;
  return {
    ...physicalPosition,
    label,
    previousSentence: sentenceContext(previous, paragraphs),
    nextSentence: sentenceContext(next, paragraphs)
  };
}

/**
 * Resolves insertion candidates to physical paragraph-text boundaries before
 * reconciliation. Anchor IDs, sentence IDs, location numbers, boundary
 * ordinals, and array order are excluded from resolved semantic identity.
 */
export function buildReadingInsertionAnchorSet(
  passage: ReadingPassage,
  anchors: ReadingInsertionAnchor[]
): ReadingInsertionAnchorSetReview {
  const resolvedAnchors = [...anchors]
    .sort((left, right) => left.anchorOrder - right.anchorOrder)
    .map((anchor) => ({
      anchorId: anchor.anchorId,
      locationNumber: anchor.anchorOrder,
      position: resolveReadingInsertionPosition(passage, anchor)
    }));
  const bySemanticKey = new Map<string, typeof resolvedAnchors>();
  const unresolved = resolvedAnchors.filter((anchor) => anchor.position.resolutionStatus === "unresolved");
  for (const anchor of resolvedAnchors.filter((item) => item.position.resolutionStatus === "resolved")) {
    bySemanticKey.set(anchor.position.semanticKey, [
      ...(bySemanticKey.get(anchor.position.semanticKey) ?? []),
      anchor
    ]);
  }
  return {
    resolvedAnchors,
    uniquePositions: [
      ...Array.from(bySemanticKey.values(), (matches) => matches[0].position),
      ...unresolved.map((anchor) => anchor.position)
    ],
    duplicates: Array.from(bySemanticKey.values())
      .filter((matches) => matches.length > 1)
      .map((matches) => ({
        position: matches[0].position,
        locationNumbers: matches.map((match) => match.locationNumber)
      }))
  };
}

export { insertionPhysicalPositionsEqual };

export function buildReadingReviewVersion(
  packageData: ReadingImportPackage,
  markers: ReadingReviewMarker[] = []
): ReadingReviewVersion {
  const occurrence = packageData.occurrences[0];
  const passage = packageData.passages[0];
  const material = packageData.materials[0];
  const sourceNumberByQuestion = new Map(occurrence?.questionSources.map((source) => [
    source.questionId,
    source.sourceQuestionStart
  ]) ?? []);
  const version: ReadingReviewVersion = {
    module: packageData.item.module,
    title: packageData.item.title,
    material: material ? {
      title: material.title,
      source: material.source,
      imageUrl: optionalImageUrl(material.imageAssetPath)
    } : null,
    ctwParagraphs: [],
    passage: passage ? {
      title: passage.title,
      paragraphs: [...passage.paragraphs]
        .sort((left, right) => left.paragraphOrder - right.paragraphOrder)
        .map((paragraph) => ({
          paragraphOrder: paragraph.paragraphOrder,
          text: paragraph.text,
          sentences: [...paragraph.sentences]
            .sort((left, right) => left.sentenceOrder - right.sentenceOrder)
            .map((sentence) => ({ sentenceOrder: sentence.sentenceOrder, text: sentence.text })),
          markers: markers.filter((marker) => marker.paragraphOrder === paragraph.paragraphOrder)
        }))
    } : null,
    questions: [...packageData.questions]
      .sort((left, right) => left.questionOrder - right.questionOrder)
      .map((question) => ({
        questionOrder: question.questionOrder,
        sourceQuestionNumber: sourceNumberByQuestion.get(question.questionId) ?? null,
        stem: question.stem,
        detailLines: questionDetailLines(question, packageData)
      }))
  };
  const ctw = packageData.questions.find((question) => question.questionType === "ctw");
  if (ctw?.questionType === "ctw") {
    version.ctwParagraphs = [...ctw.payload.paragraphs]
      .sort((left, right) => left.paragraphOrder - right.paragraphOrder)
      .map((paragraph) => paragraph.rawText);
  }
  return version;
}

function questionDetailLines(question: ReadingQuestion, packageData: ReadingImportPackage) {
  if (question.questionType === "rdl" || question.questionType === "rap_multiple_choice") {
    return [...question.payload.options]
      .sort((left, right) => left.optionOrder - right.optionOrder)
      .map((option) => `${optionLabel(option.optionOrder)}. ${option.text}${option.optionId === question.payload.correctOptionId ? " ✓" : ""}`);
  }
  if (question.questionType === "ctw") {
    return [...question.payload.slots]
      .sort((left, right) => left.slotOrder - right.slotOrder)
      .map((slot) => `第 ${slot.slotOrder} 空：${slot.answer}`);
  }
  const passage = packageData.passages.find((candidate) => candidate.passageId === question.payload.passageId);
  if (!passage) return [];
  if (question.questionType === "rap_sentence_insertion") {
    const correct = question.payload.anchors.find((anchor) => anchor.anchorId === question.payload.correctAnchorId);
    return [
      `待插入句子：${question.payload.insertSentence}`,
      correct ? `正确位置：${resolveReadingInsertionPosition(passage, correct).label}` : "正确位置：未解析"
    ];
  }
  const paragraph = passage.paragraphs.find((candidate) => candidate.paragraphId === question.payload.targetParagraphId);
  const sentence = paragraph?.sentences.find((candidate) => candidate.sentenceId === question.payload.correctSentenceId);
  return [`正确句子：${sentence?.text ?? "未解析"}`];
}

function orderedSentences(paragraph: ReadingPassage["paragraphs"][number] | undefined) {
  return paragraph ? [...paragraph.sentences].sort((left, right) => left.sentenceOrder - right.sentenceOrder) : [];
}

function sentenceContext(
  sentence: ReadingPassage["paragraphs"][number]["sentences"][number] | null,
  paragraphs: ReadingPassage["paragraphs"]
): ReadingReviewSentenceContext | null {
  if (!sentence) return null;
  const paragraph = paragraphs.find((candidate) => candidate.sentences.some((item) => item.sentenceId === sentence.sentenceId));
  return paragraph ? {
    paragraphOrder: paragraph.paragraphOrder,
    sentenceOrder: sentence.sentenceOrder,
    text: sentence.text
  } : null;
}

function optionalImageUrl(objectKey: string | null) {
  if (!objectKey) return null;
  try { return resolveReadingAssetUrl(objectKey.replace(/^\/+/, "")); } catch { return null; }
}

function optionLabel(order: number) {
  return order >= 1 && order <= 26 ? String.fromCharCode(64 + order) : String(order);
}

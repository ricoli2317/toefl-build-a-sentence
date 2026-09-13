import type {
  CtwQuestion,
  ReadingImportPackage,
  ReadingInsertionAnchor,
  ReadingOption,
  ReadingPassage,
  ReadingQuestion
} from "./types.ts";
import { compareCtwLogicalIdentity } from "./ctwLogicalIdentity.ts";

export type ReadingContentDifferenceKind =
  | "question_type"
  | "stem"
  | "options"
  | "option_order"
  | "correct_answer"
  | "ctw_slot_content"
  | "insert_sentence"
  | "insertion_anchors"
  | "correct_insertion_location"
  | "target_sentence_structure"
  | "selected_sentence";

export type ReadingContentDifference = {
  kind: ReadingContentDifferenceKind;
  label: string;
  substantive: boolean;
};

export type ReadingContentOptionPreview = {
  label: string;
  text: string;
  correct: boolean;
};

export type ReadingContentQuestionVersion = {
  questionType: ReadingQuestion["questionType"];
  stem: string;
  options?: ReadingContentOptionPreview[];
  correctAnswer?: string;
  ctwPassage?: string;
  ctwBlanks?: string[];
  insertSentence?: string;
  insertionAnchors?: string[];
  correctInsertionLocation?: string;
  targetSentenceStructure?: string[];
  selectedSentence?: string;
};

export type ReadingCtwSlotConflictPreview = {
  slotOrder: number;
  differenceKinds: Array<"prefix" | "answer">;
  existing: string;
  incoming: string;
  existingAnswer: string;
  incomingAnswer: string;
};

export type ReadingQuestionContentConflict = {
  questionOrder: number;
  sourceQuestionNumber: number | null;
  differences: ReadingContentDifference[];
  correctAnswerSemanticallyDifferent: boolean;
  ctwSlotConflicts?: ReadingCtwSlotConflictPreview[];
  existing: ReadingContentQuestionVersion;
  incoming: ReadingContentQuestionVersion;
};

export type ReadingContentConflictItem = {
  resolutionId: string;
  questionType: ReadingImportPackage["item"]["module"];
  logicalItemId: string;
  sourceLabel: string;
  occurrenceDate: string;
  sourceModule: string;
  sourceOrder: number;
  sourceQuestionRange: string;
  passageTitle: string | null;
  materialId: string | null;
  questionConflicts: ReadingQuestionContentConflict[];
};

export type ReadingContentConflictResolution = {
  resolutionId: string;
  action: "keep_existing" | "update_from_source";
};

export function indexReadingContentConflictResolutions(
  items: ReadingContentConflictItem[],
  inputs: ReadingContentConflictResolution[]
) {
  const itemById = new Map(items.map((item) => [item.resolutionId, item]));
  const result = new Map<string, ReadingContentConflictResolution>();
  for (const input of inputs) {
    if (!itemById.has(input.resolutionId)) {
      throw contentResolutionError(`题目内容冲突 ${input.resolutionId} 不存在或已经失效。`);
    }
    if (result.has(input.resolutionId)) {
      throw contentResolutionError(`题目内容冲突 ${input.resolutionId} 重复提交。`);
    }
    result.set(input.resolutionId, input);
  }
  return result;
}

const DIFFERENCE_LABELS: Record<ReadingContentDifferenceKind, string> = {
  question_type: "Question type different",
  stem: "Stem different",
  options: "Options different",
  option_order: "Option order different",
  correct_answer: "Correct answer different",
  ctw_slot_content: "CTW blank content different",
  insert_sentence: "Insert sentence different",
  insertion_anchors: "Insert anchors different",
  correct_insertion_location: "Correct insertion location different",
  target_sentence_structure: "Target sentence structure different",
  selected_sentence: "Selected sentence different"
};

const PRESENTATION_ONLY = new Set<ReadingContentDifferenceKind>(["option_order"]);

/** Reconciliation normalization deliberately ignores display-only noise. It is
 * stricter than identity matching about words, but looser about case, spacing,
 * punctuation glyphs, dash variants, insertion markers, and OCR word spacing. */
export function normalizeReadingReconciliationText(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[\u2018\u2019\u02bc\uff07]/g, "'")
    .replace(/[\u201c\u201d\uff02]/g, '"')
    .replace(/[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g, "-")
    .toLocaleLowerCase("en-US")
    .replace(/\b([ap])\.?\s*m\.?\b/g, "$1m")
    .replace(/[!-/:-@[-`{-~\u00a1-\u00bf\u2000-\u206f\u20a0-\u20cf\u25a0\s]+/g, "")
    .trim();
}

export function buildReadingContentConflict(
  existing: ReadingImportPackage,
  incoming: ReadingImportPackage
): ReadingContentConflictItem | null {
  if (existing.item.module !== incoming.item.module) {
    throw new Error("Reading content reconciliation requires the same module");
  }
  const existingByOrder = new Map(existing.questions.map((question) => [question.questionOrder, question]));
  const incomingByOrder = new Map(incoming.questions.map((question) => [question.questionOrder, question]));
  const orders = Array.from(new Set([
    ...Array.from(existingByOrder.keys()),
    ...Array.from(incomingByOrder.keys())
  ])).sort((a, b) => a - b);
  const questionConflicts = orders.flatMap<ReadingQuestionContentConflict>((questionOrder) => {
    const existingQuestion = existingByOrder.get(questionOrder);
    const incomingQuestion = incomingByOrder.get(questionOrder);
    if (!existingQuestion || !incomingQuestion) return [];
    const differences = compareQuestion(existingQuestion, incomingQuestion, existing, incoming);
    if (!differences.some((difference) => difference.substantive)) return [];
    const ctwSlotConflicts = existingQuestion.questionType === "ctw"
      && incomingQuestion.questionType === "ctw"
      ? buildCtwSlotConflictPreviews(existingQuestion, incomingQuestion)
      : undefined;
    return [{
      questionOrder,
      sourceQuestionNumber: sourceQuestionNumber(incoming, incomingQuestion.questionId),
      differences,
      correctAnswerSemanticallyDifferent: differences.some((difference) =>
        difference.kind === "correct_answer"
        || difference.kind === "correct_insertion_location"
        || difference.kind === "selected_sentence"
      ) || Boolean(ctwSlotConflicts?.some((conflict) => conflict.differenceKinds.includes("answer"))),
      ctwSlotConflicts,
      existing: questionVersion(existingQuestion, existing),
      incoming: questionVersion(incomingQuestion, incoming)
    }];
  });
  if (questionConflicts.length === 0) return null;
  const occurrence = incoming.occurrences[0];
  const title = incoming.item.module === "rap"
    ? incoming.passages[0]?.title ?? incoming.item.title
    : incoming.item.title;
  return {
    resolutionId: [
      "reading-content",
      incoming.item.module,
      existing.item.logicalItemId,
      occurrence?.occurrenceId ?? incoming.item.logicalItemId
    ].join(":"),
    questionType: incoming.item.module,
    logicalItemId: existing.item.logicalItemId,
    sourceLabel: occurrence?.sourceLabel ?? incoming.item.firstSeenSourceLabel,
    occurrenceDate: occurrence?.occurrenceDate ?? incoming.item.firstSeenDate,
    sourceModule: occurrence?.sourceModule ?? "",
    sourceOrder: occurrence?.sourceOrder ?? incoming.item.firstSeenSourceOrder,
    sourceQuestionRange: occurrence
      ? range(occurrence.sourceQuestionStart, occurrence.sourceQuestionEnd)
      : "",
    passageTitle: title,
    materialId: incoming.item.module === "rdl" ? incoming.materials[0]?.materialId ?? null : null,
    questionConflicts
  };
}

function compareQuestion(
  existing: ReadingQuestion,
  incoming: ReadingQuestion,
  existingPackage: ReadingImportPackage,
  incomingPackage: ReadingImportPackage
) {
  const kinds: ReadingContentDifferenceKind[] = [];
  if (existing.questionType !== incoming.questionType) {
    kinds.push("question_type");
  }
  if (!sameText(existing.stem, incoming.stem)) kinds.push("stem");
  if (existing.questionType !== incoming.questionType) return differences(kinds);

  if (isChoice(existing) && isChoice(incoming)) {
    const existingTexts = optionTexts(existing.payload.options);
    const incomingTexts = optionTexts(incoming.payload.options);
    if (!sameArray([...existingTexts].sort(), [...incomingTexts].sort())) kinds.push("options");
    else if (!sameArray(existingTexts, incomingTexts)) kinds.push("option_order");
    if (!sameText(correctOptionText(existing), correctOptionText(incoming))) kinds.push("correct_answer");
    return differences(kinds);
  }
  if (existing.questionType === "ctw" && incoming.questionType === "ctw") {
    const identity = compareCtwLogicalIdentity(existing, incoming);
    if (!identity.sameLogicalItem) {
      throw Object.assign(
        new Error("CTW content reconciliation cannot cross logical identities"),
        { code: "READING_CTW_IDENTITY_CLUSTER_INVARIANT" }
      );
    }
    if (identity.nonIdentityConflicts.length > 0) kinds.push("ctw_slot_content");
    return differences(kinds);
  }
  if (existing.questionType === "rap_sentence_insertion" && incoming.questionType === "rap_sentence_insertion") {
    if (!sameText(existing.payload.insertSentence, incoming.payload.insertSentence)) kinds.push("insert_sentence");
    const existingPassage = requiredPassage(existingPackage, existing.payload.passageId);
    const incomingPassage = requiredPassage(incomingPackage, incoming.payload.passageId);
    const existingAnchors = existing.payload.anchors
      .map((anchor) => anchorIdentity(anchor, existingPassage))
      .sort();
    const incomingAnchors = incoming.payload.anchors
      .map((anchor) => anchorIdentity(anchor, incomingPassage))
      .sort();
    if (!sameArray(existingAnchors, incomingAnchors)) kinds.push("insertion_anchors");
    if (!sameText(
      correctAnchorIdentity(existing, existingPassage),
      correctAnchorIdentity(incoming, incomingPassage)
    )) kinds.push("correct_insertion_location");
    return differences(kinds);
  }
  if (existing.questionType === "rap_sentence_selection" && incoming.questionType === "rap_sentence_selection") {
    const existingTarget = targetParagraph(existingPackage, existing.payload.targetParagraphId);
    const incomingTarget = targetParagraph(incomingPackage, incoming.payload.targetParagraphId);
    const existingStructure = orderedSentences(existingTarget?.sentences ?? []);
    const incomingStructure = orderedSentences(incomingTarget?.sentences ?? []);
    if (!sameArray(existingStructure, incomingStructure)) kinds.push("target_sentence_structure");
    if (!sameText(selectedSentence(existing, existingPackage), selectedSentence(incoming, incomingPackage))) {
      kinds.push("selected_sentence");
    }
  }
  return differences(kinds);
}

function buildCtwSlotConflictPreviews(
  existing: CtwQuestion,
  incoming: CtwQuestion
): ReadingCtwSlotConflictPreview[] {
  return compareCtwLogicalIdentity(existing, incoming).nonIdentityConflicts.flatMap((conflict) =>
    conflict.slots.map((slot) => ({
      slotOrder: slot.slotOrder,
      differenceKinds: slot.differenceKinds,
      existing: slot.leftReviewText,
      incoming: slot.rightReviewText,
      existingAnswer: slot.leftAnswer,
      incomingAnswer: slot.rightAnswer
    }))
  );
}

function questionVersion(question: ReadingQuestion, packageData: ReadingImportPackage): ReadingContentQuestionVersion {
  const base = { questionType: question.questionType, stem: question.stem };
  if (isChoice(question)) {
    const orderedOptions = [...question.payload.options].sort((left, right) => left.optionOrder - right.optionOrder);
    const correct = orderedOptions.find((option) => option.optionId === question.payload.correctOptionId);
    return {
      ...base,
      options: orderedOptions.map((option) => ({
        label: optionLabel(option.optionOrder),
        text: option.text,
        correct: option.optionId === question.payload.correctOptionId
      })),
      correctAnswer: correct ? `${optionLabel(correct.optionOrder)} — ${correct.text}` : "Unresolved"
    };
  }
  if (question.questionType === "ctw") {
    const slots = [...question.payload.slots].sort((left, right) => left.slotOrder - right.slotOrder);
    return {
      ...base,
      ctwPassage: question.payload.paragraphs.map((paragraph) => paragraph.rawText).join("\n\n"),
      ctwBlanks: slots.map((slot) => `${slot.slotOrder}. ${slot.displayText}`),
      correctAnswer: slots.map((slot) => `${slot.slotOrder}. ${slot.answer}`).join("\n")
    };
  }
  if (question.questionType === "rap_sentence_insertion") {
    const passage = requiredPassage(packageData, question.payload.passageId);
    const anchors = [...question.payload.anchors].sort((left, right) => left.anchorOrder - right.anchorOrder);
    const correct = anchors.find((anchor) => anchor.anchorId === question.payload.correctAnchorId);
    return {
      ...base,
      insertSentence: question.payload.insertSentence,
      insertionAnchors: anchors.map((anchor) => anchorDisplay(anchor, passage)),
      correctInsertionLocation: correct ? anchorDisplay(correct, passage) : "Unresolved"
    };
  }
  const target = targetParagraph(packageData, question.payload.targetParagraphId);
  return {
    ...base,
    targetSentenceStructure: target?.sentences.map((sentence) =>
      `${sentence.sentenceOrder}. ${sentence.text}`
    ) ?? [],
    selectedSentence: selectedSentence(question, packageData)
  };
}

function differences(kinds: ReadingContentDifferenceKind[]): ReadingContentDifference[] {
  return Array.from(new Set(kinds)).map((kind) => ({
    kind,
    label: DIFFERENCE_LABELS[kind],
    substantive: !PRESENTATION_ONLY.has(kind)
  }));
}

function isChoice(question: ReadingQuestion): question is Extract<ReadingQuestion, { questionType: "rdl" | "rap_multiple_choice" }> {
  return question.questionType === "rdl" || question.questionType === "rap_multiple_choice";
}

function optionTexts(options: ReadingOption[]) {
  return [...options]
    .sort((left, right) => left.optionOrder - right.optionOrder)
    .map((option) => normalizeReadingReconciliationText(option.text));
}

function correctOptionText(question: Extract<ReadingQuestion, { questionType: "rdl" | "rap_multiple_choice" }>) {
  return question.payload.options.find((option) => option.optionId === question.payload.correctOptionId)?.text ?? "";
}

function orderedSentences(sentences: Array<{ sentenceOrder: number; text: string }>) {
  return [...sentences]
    .sort((left, right) => left.sentenceOrder - right.sentenceOrder)
    .map((sentence) => normalizeReadingReconciliationText(sentence.text));
}

function anchorIdentity(anchor: ReadingInsertionAnchor, passage: ReadingPassage) {
  const paragraph = targetParagraphInPassage(passage, anchor.paragraphId);
  const afterSentence = anchor.afterSentenceId
    ? paragraph?.sentences.find((sentence) => sentence.sentenceId === anchor.afterSentenceId)?.text ?? ""
    : "<start>";
  return [
    paragraph?.paragraphOrder ?? "missing",
    anchor.boundaryIndex,
    normalizeReadingReconciliationText(afterSentence)
  ].join(":");
}

function correctAnchorIdentity(
  question: Extract<ReadingQuestion, { questionType: "rap_sentence_insertion" }>,
  passage: ReadingPassage
) {
  const anchor = question.payload.anchors.find((candidate) => candidate.anchorId === question.payload.correctAnchorId);
  return anchor ? anchorIdentity(anchor, passage) : "<unresolved>";
}

function anchorDisplay(anchor: ReadingInsertionAnchor, passage: ReadingPassage) {
  const paragraph = targetParagraphInPassage(passage, anchor.paragraphId);
  const after = anchor.afterSentenceId
    ? paragraph?.sentences.find((sentence) => sentence.sentenceId === anchor.afterSentenceId)
    : null;
  return after
    ? `Location ${anchor.anchorOrder}: paragraph ${paragraph?.paragraphOrder ?? "?"}, after “${after.text}”`
    : `Location ${anchor.anchorOrder}: paragraph ${paragraph?.paragraphOrder ?? "?"}, before the first sentence`;
}

function selectedSentence(
  question: Extract<ReadingQuestion, { questionType: "rap_sentence_selection" }>,
  packageData: ReadingImportPackage
) {
  return targetParagraph(packageData, question.payload.targetParagraphId)?.sentences.find(
    (sentence) => sentence.sentenceId === question.payload.correctSentenceId
  )?.text ?? "Unresolved";
}

function requiredPassage(packageData: ReadingImportPackage, passageId: string) {
  const passage = packageData.passages.find((candidate) => candidate.passageId === passageId);
  if (!passage) throw new Error(`Reading content reconciliation cannot resolve passage ${passageId}`);
  return passage;
}

function targetParagraph(packageData: ReadingImportPackage, paragraphId: string) {
  return packageData.passages.flatMap((passage) => passage.paragraphs)
    .find((paragraph) => paragraph.paragraphId === paragraphId);
}

function targetParagraphInPassage(passage: ReadingPassage, paragraphId: string) {
  return passage.paragraphs.find((paragraph) => paragraph.paragraphId === paragraphId);
}

function sameText(left: string, right: string) {
  return normalizeReadingReconciliationText(left) === normalizeReadingReconciliationText(right);
}

function sameArray(left: string[], right: string[]) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sourceQuestionNumber(packageData: ReadingImportPackage, questionId: string) {
  for (const occurrence of packageData.occurrences) {
    const source = occurrence.questionSources.find((candidate) => candidate.questionId === questionId);
    if (source) return source.sourceQuestionStart;
  }
  return null;
}

function optionLabel(order: number) {
  return order >= 1 && order <= 26 ? String.fromCharCode(64 + order) : String(order);
}

function range(start: number, end: number) {
  return start === end ? String(start) : `${start}–${end}`;
}

function contentResolutionError(message: string) {
  return Object.assign(new Error(message), {
    code: "READING_CONTENT_CONFLICT_REQUIRED",
    operation: "resolve Reading content conflicts"
  });
}

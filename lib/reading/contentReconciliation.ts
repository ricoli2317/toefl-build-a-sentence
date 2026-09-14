import type {
  CtwQuestion,
  ReadingImportPackage,
  ReadingInsertionAnchor,
  ReadingPassage,
  ReadingQuestion
} from "./types.ts";
import { compareCtwLogicalIdentity } from "./ctwLogicalIdentity.ts";
import {
  alignChangedReadingOptions,
  buildReadingInlineDiff,
  normalizeReadingQuestionStem,
  normalizeReadingReviewText,
  type ReadingInlineDiff
} from "./reviewDiff.ts";

export type ReadingContentDifferenceKind =
  | "passage_title"
  | "passage"
  | "question_type"
  | "stem"
  | "options"
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
  substantive: true;
  existing: string;
  incoming: string;
  inlineDiff: ReadingInlineDiff;
};

export type ReadingCtwSlotConflictPreview = {
  slotOrder: number;
  differenceKinds: Array<"prefix" | "answer">;
  existing: string;
  incoming: string;
  existingAnswer: string;
  incomingAnswer: string;
  inlineDiff: ReadingInlineDiff;
};

export type ReadingQuestionContentConflict = {
  questionOrder: number;
  sourceQuestionNumber: number | null;
  differences: ReadingContentDifference[];
  correctAnswerSemanticallyDifferent: boolean;
  ctwSlotConflicts?: ReadingCtwSlotConflictPreview[];
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
  passageConflicts: ReadingContentDifference[];
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
  passage_title: "文章标题",
  passage: "文章正文",
  question_type: "题型",
  stem: "题干",
  options: "选项",
  correct_answer: "正确答案",
  ctw_slot_content: "填空内容",
  insert_sentence: "待插入句子",
  insertion_anchors: "可插入位置",
  correct_insertion_location: "正确插入位置",
  target_sentence_structure: "目标段落句子",
  selected_sentence: "正确句子"
};

export const normalizeReadingReconciliationText = normalizeReadingReviewText;

export function buildReadingContentConflict(
  existing: ReadingImportPackage,
  incoming: ReadingImportPackage
): ReadingContentConflictItem | null {
  if (existing.item.module !== incoming.item.module) {
    throw new Error("Reading content reconciliation requires the same module");
  }
  const passageConflicts = existing.item.module === "rap"
    ? compareRapPassages(existing.passages, incoming.passages)
    : [];
  const existingByOrder = new Map(existing.questions.map((question) => [question.questionOrder, question]));
  const incomingByOrder = new Map(incoming.questions.map((question) => [question.questionOrder, question]));
  const orders = Array.from(new Set([
    ...Array.from(existingByOrder.keys()),
    ...Array.from(incomingByOrder.keys())
  ])).sort((left, right) => left - right);
  const questionConflicts = orders.flatMap<ReadingQuestionContentConflict>((questionOrder) => {
    const existingQuestion = existingByOrder.get(questionOrder);
    const incomingQuestion = incomingByOrder.get(questionOrder);
    if (!existingQuestion || !incomingQuestion) return [];
    const differences = compareQuestion(existingQuestion, incomingQuestion, existing, incoming);
    if (differences.length === 0) return [];
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
      ctwSlotConflicts
    }];
  });
  if (passageConflicts.length === 0 && questionConflicts.length === 0) return null;
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
    passageConflicts,
    questionConflicts
  };
}

function compareRapPassages(existing: ReadingPassage[], incoming: ReadingPassage[]) {
  const result: ReadingContentDifference[] = [];
  const count = Math.max(existing.length, incoming.length);
  for (let passageIndex = 0; passageIndex < count; passageIndex += 1) {
    const left = existing[passageIndex];
    const right = incoming[passageIndex];
    if (!left || !right) {
      result.push(difference("passage", left?.title ?? "未提供", right?.title ?? "未提供"));
      continue;
    }
    if (!sameText(left.title, right.title)) {
      result.push(difference("passage_title", left.title, right.title));
    }
    const leftByOrder = new Map(left.paragraphs.map((paragraph) => [paragraph.paragraphOrder, paragraph]));
    const rightByOrder = new Map(right.paragraphs.map((paragraph) => [paragraph.paragraphOrder, paragraph]));
    const orders = Array.from(new Set([
      ...Array.from(leftByOrder.keys()),
      ...Array.from(rightByOrder.keys())
    ])).sort((a, b) => a - b);
    for (const order of orders) {
      const leftText = leftByOrder.get(order)?.text ?? "未提供";
      const rightText = rightByOrder.get(order)?.text ?? "未提供";
      if (!sameText(leftText, rightText)) {
        result.push(difference("passage", leftText, rightText, `文章第 ${order} 段`));
      }
    }
  }
  return result;
}

function compareQuestion(
  existing: ReadingQuestion,
  incoming: ReadingQuestion,
  existingPackage: ReadingImportPackage,
  incomingPackage: ReadingImportPackage
): ReadingContentDifference[] {
  const result: ReadingContentDifference[] = [];
  if (existing.questionType !== incoming.questionType) {
    return [difference("question_type", existing.questionType, incoming.questionType)];
  }
  if (
    normalizeReadingQuestionStem(existing.questionType, existing.stem)
      !== normalizeReadingQuestionStem(incoming.questionType, incoming.stem)
  ) result.push(difference("stem", existing.stem, incoming.stem));

  if (isChoice(existing) && isChoice(incoming)) {
    for (const pair of alignChangedReadingOptions(existing.payload.options, incoming.payload.options)) {
      const left = pair.existing?.text ?? "未提供";
      const right = pair.incoming?.text ?? "未提供";
      const optionName = pair.existing
        ? optionLabel(pair.existing.optionOrder)
        : pair.incoming ? optionLabel(pair.incoming.optionOrder) : "?";
      result.push(difference("options", left, right, `选项 ${optionName}`));
    }
    const existingCorrect = correctOptionText(existing);
    const incomingCorrect = correctOptionText(incoming);
    if (!sameText(existingCorrect, incomingCorrect)) {
      result.push(difference("correct_answer", existingCorrect, incomingCorrect));
    }
    return result;
  }
  if (existing.questionType === "ctw" && incoming.questionType === "ctw") {
    const identity = compareCtwLogicalIdentity(existing, incoming);
    if (!identity.sameLogicalItem) {
      throw Object.assign(
        new Error("CTW content reconciliation cannot cross logical identities"),
        { code: "READING_CTW_IDENTITY_CLUSTER_INVARIANT" }
      );
    }
    if (identity.nonIdentityConflicts.length > 0) {
      result.push(difference("ctw_slot_content", "", ""));
    }
    return result;
  }
  if (existing.questionType === "rap_sentence_insertion" && incoming.questionType === "rap_sentence_insertion") {
    if (!sameText(existing.payload.insertSentence, incoming.payload.insertSentence)) {
      result.push(difference("insert_sentence", existing.payload.insertSentence, incoming.payload.insertSentence));
    }
    const existingPassage = requiredPassage(existingPackage, existing.payload.passageId);
    const incomingPassage = requiredPassage(incomingPackage, incoming.payload.passageId);
    const existingAnchors = existing.payload.anchors.map((anchor) => anchorIdentity(anchor, existingPassage)).sort();
    const incomingAnchors = incoming.payload.anchors.map((anchor) => anchorIdentity(anchor, incomingPassage)).sort();
    if (!sameArray(existingAnchors, incomingAnchors)) {
      result.push(difference("insertion_anchors", existingAnchors.join("\n"), incomingAnchors.join("\n")));
    }
    const existingCorrect = correctAnchorDisplay(existing, existingPassage);
    const incomingCorrect = correctAnchorDisplay(incoming, incomingPassage);
    if (!sameText(existingCorrect, incomingCorrect)) {
      result.push(difference("correct_insertion_location", existingCorrect, incomingCorrect));
    }
    return result;
  }
  if (existing.questionType === "rap_sentence_selection" && incoming.questionType === "rap_sentence_selection") {
    const existingTarget = targetParagraph(existingPackage, existing.payload.targetParagraphId);
    const incomingTarget = targetParagraph(incomingPackage, incoming.payload.targetParagraphId);
    const existingStructure = displaySentences(existingTarget?.sentences ?? []);
    const incomingStructure = displaySentences(incomingTarget?.sentences ?? []);
    if (!sameArray(existingStructure.map(normalizeReadingReviewText), incomingStructure.map(normalizeReadingReviewText))) {
      result.push(difference("target_sentence_structure", existingStructure.join("\n"), incomingStructure.join("\n")));
    }
    const existingSelected = selectedSentence(existing, existingPackage);
    const incomingSelected = selectedSentence(incoming, incomingPackage);
    if (!sameText(existingSelected, incomingSelected)) {
      result.push(difference("selected_sentence", existingSelected, incomingSelected));
    }
  }
  return result;
}

function buildCtwSlotConflictPreviews(existing: CtwQuestion, incoming: CtwQuestion) {
  return compareCtwLogicalIdentity(existing, incoming).nonIdentityConflicts.flatMap((conflict) =>
    conflict.slots.map((slot) => ({
      slotOrder: slot.slotOrder,
      differenceKinds: slot.differenceKinds,
      existing: slot.leftReviewText,
      incoming: slot.rightReviewText,
      existingAnswer: slot.leftAnswer,
      incomingAnswer: slot.rightAnswer,
      inlineDiff: buildReadingInlineDiff(slot.leftReviewText, slot.rightReviewText)
    }))
  );
}

function difference(
  kind: ReadingContentDifferenceKind,
  existing: string,
  incoming: string,
  label = DIFFERENCE_LABELS[kind]
): ReadingContentDifference {
  return {
    kind,
    label,
    substantive: true,
    existing,
    incoming,
    inlineDiff: buildReadingInlineDiff(existing, incoming)
  };
}

function isChoice(question: ReadingQuestion): question is Extract<ReadingQuestion, { questionType: "rdl" | "rap_multiple_choice" }> {
  return question.questionType === "rdl" || question.questionType === "rap_multiple_choice";
}

function correctOptionText(question: Extract<ReadingQuestion, { questionType: "rdl" | "rap_multiple_choice" }>) {
  return question.payload.options.find((option) => option.optionId === question.payload.correctOptionId)?.text ?? "未解析";
}

function displaySentences(sentences: Array<{ sentenceOrder: number; text: string }>) {
  return [...sentences]
    .sort((left, right) => left.sentenceOrder - right.sentenceOrder)
    .map((sentence) => `${sentence.sentenceOrder}. ${sentence.text}`);
}

function anchorIdentity(anchor: ReadingInsertionAnchor, passage: ReadingPassage) {
  const paragraph = targetParagraphInPassage(passage, anchor.paragraphId);
  const afterSentence = anchor.afterSentenceId
    ? paragraph?.sentences.find((sentence) => sentence.sentenceId === anchor.afterSentenceId)?.text ?? ""
    : "段落开头";
  return `第 ${paragraph?.paragraphOrder ?? "?"} 段 · ${anchor.boundaryIndex === 0 ? "段落开头" : `在“${afterSentence}”之后`}`;
}

function correctAnchorDisplay(
  question: Extract<ReadingQuestion, { questionType: "rap_sentence_insertion" }>,
  passage: ReadingPassage
) {
  const anchor = question.payload.anchors.find((candidate) => candidate.anchorId === question.payload.correctAnchorId);
  return anchor ? anchorIdentity(anchor, passage) : "未解析";
}

function selectedSentence(
  question: Extract<ReadingQuestion, { questionType: "rap_sentence_selection" }>,
  packageData: ReadingImportPackage
) {
  return targetParagraph(packageData, question.payload.targetParagraphId)?.sentences.find(
    (sentence) => sentence.sentenceId === question.payload.correctSentenceId
  )?.text ?? "未解析";
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
  return normalizeReadingReviewText(left) === normalizeReadingReviewText(right);
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

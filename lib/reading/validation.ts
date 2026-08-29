import {
  READING_QUESTION_TYPES,
  type CtwParagraph,
  type CtwSlot,
  type ReadingImportPackage,
  type ReadingInsertionAnchor,
  type ReadingMaterial,
  type ReadingOption,
  type ReadingPassage,
  type ReadingQuestion
} from "./types.ts";
import { fingerprintReadingSourceOccurrence } from "./grouping.ts";
import { isRdlMaterialType } from "./materialTypes.ts";

type RecordValue = Record<string, unknown>;

export class ReadingValidationError extends Error {
  readonly logicalItemId: string | null;
  readonly questionId: string | null;
  readonly path: string;

  constructor(message: string, context: { logicalItemId?: string; questionId?: string; path: string }) {
    const location = [
      context.logicalItemId ? `item=${context.logicalItemId}` : null,
      context.questionId ? `question=${context.questionId}` : null,
      context.path
    ].filter(Boolean).join(" ");
    super(`${location}: ${message}`);
    this.name = "ReadingValidationError";
    this.logicalItemId = context.logicalItemId ?? null;
    this.questionId = context.questionId ?? null;
    this.path = context.path;
  }
}

export function validateReadingImportPackage(input: unknown): ReadingImportPackage {
  const root = record(input, "$", {});
  if (root.schemaVersion !== 2) fail("schemaVersion must be 2", "$.schemaVersion", {});

  const item = record(root.item, "$.item", {});
  const logicalItemId = nonEmptyString(item.logicalItemId, "$.item.logicalItemId", {});
  const context = { logicalItemId };
  if (!isReadingModule(item.module)) fail("unsupported Reading module", "$.item.module", context);
  if (item.module === "ctw") {
    if (item.title !== null) fail("CTW logical title must be null", "$.item.title", context);
  } else {
    nonEmptyString(item.title, "$.item.title", context);
  }
  date(item.firstSeenDate, "$.item.firstSeenDate", context);
  nonEmptyString(item.firstSeenSourceLabel, "$.item.firstSeenSourceLabel", context);
  positiveInteger(item.firstSeenSourceOrder, "$.item.firstSeenSourceOrder", context);
  if (typeof item.dedupFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(item.dedupFingerprint)) {
    fail("must be a SHA-256 fingerprint", "$.item.dedupFingerprint", context);
  }
  positiveInteger(item.questionCount, "$.item.questionCount", context, true);
  positiveInteger(item.scoredItemCount, "$.item.scoredItemCount", context, true);
  if (typeof item.isActive !== "boolean") fail("must be a boolean", "$.item.isActive", context);

  const materials = array(root.materials, "$.materials", context);
  const passages = array(root.passages, "$.passages", context);
  const questions = array(root.questions, "$.questions", context);

  const materialIds = uniqueIds(
    materials.map((value, index) =>
      validateMaterial(value, `$.materials[${index}]`, context)
    ),
    "materialId",
    "$.materials",
    context
  );
  const passageById = new Map<string, ReadingPassage>();
  for (let index = 0; index < passages.length; index += 1) {
    const passage = validatePassage(passages[index], `$.passages[${index}]`, context);
    if (passage.logicalItemId !== logicalItemId) {
      fail("logicalItemId must match package item", `$.passages[${index}].logicalItemId`, context);
    }
    if (passageById.has(passage.passageId)) {
      fail(`duplicate passageId ${passage.passageId}`, "$.passages", context);
    }
    passageById.set(passage.passageId, passage);
  }

  const questionIds = new Set<string>();
  const questionOrders = new Set<number>();
  for (let index = 0; index < questions.length; index += 1) {
    const question = validateQuestion(
      questions[index],
      `$.questions[${index}]`,
      context,
      materialIds,
      passageById
    );
    if (question.logicalItemId !== logicalItemId) {
      fail("logicalItemId must match package item", `$.questions[${index}].logicalItemId`, {
        logicalItemId,
        questionId: question.questionId
      });
    }
    if (questionIds.has(question.questionId)) {
      fail(`duplicate questionId ${question.questionId}`, "$.questions", {
        logicalItemId,
        questionId: question.questionId
      });
    }
    if (questionOrders.has(question.questionOrder)) {
      fail(`duplicate questionOrder ${question.questionOrder}`, "$.questions", {
        logicalItemId,
        questionId: question.questionId
      });
    }
    questionIds.add(question.questionId);
    questionOrders.add(question.questionOrder);
  }

  if (item.questionCount !== questions.length) {
    fail(
      `questionCount ${String(item.questionCount)} does not match ${questions.length} questions`,
      "$.item.questionCount",
      context
    );
  }
  const scoredItemCount = (questions as ReadingQuestion[]).reduce(
    (count, question) => count + (question.questionType === "ctw" ? question.payload.slots.length : 1),
    0
  );
  if (item.scoredItemCount !== scoredItemCount) {
    fail(
      `scoredItemCount ${String(item.scoredItemCount)} does not match ${scoredItemCount} scored items`,
      "$.item.scoredItemCount",
      context
    );
  }
  for (let order = 1; order <= questions.length; order += 1) {
    if (!questionOrders.has(order)) {
      fail(`questionOrder must be contiguous; missing ${order}`, "$.questions", context);
    }
  }

  validateItemShape(item.module, materials.length, passages.length, questions as ReadingQuestion[], context);
  validateOccurrences(
    root.occurrences,
    logicalItemId,
    new Map((questions as ReadingQuestion[]).map((question) => [question.questionId, question])),
    item,
    context
  );
  const computedFingerprint = fingerprintReadingSourceOccurrence({
    sourceOccurrenceId: "validation",
    module: item.module as "ctw" | "rdl" | "rap",
    title: item.title as string | null,
    source: {
      sourceKind: "validation",
      sourceLabel: "validation",
      occurrenceDate: item.firstSeenDate as string,
      yearMonth: String(item.firstSeenDate).slice(0, 7),
      sourceQuestionFile: "validation",
      sourceAnswerFile: "validation",
      sourceModule: "m1",
      sourceOrder: 1,
      sourceQuestionStart: 1,
      sourceQuestionEnd: 1
    },
    materials: materials as ReadingMaterial[],
    passages: (passages as ReadingPassage[]).map(({ logicalItemId: _, ...passage }) => passage),
    questions: (questions as ReadingQuestion[]).map(({ logicalItemId: _, ...question }) => ({
      ...question,
      sourceQuestionStart: 1,
      sourceQuestionEnd: question.questionType === "ctw" ? question.payload.slots.length : 1
    }))
  });
  if (computedFingerprint !== item.dedupFingerprint) {
    fail("dedupFingerprint does not match logical item content", "$.item.dedupFingerprint", context);
  }

  return input as ReadingImportPackage;
}

function validateItemShape(
  module: unknown,
  materialCount: number,
  passageCount: number,
  questions: ReadingQuestion[],
  context: ValidationContext
) {
  if (module === "ctw") {
    if (materialCount !== 0 || passageCount !== 0 || questions.length !== 1 || questions[0]?.questionType !== "ctw") {
      fail("CTW item must contain one complete CTW interaction and no RDL/RAP content", "$", context);
    }
  } else if (module === "rdl") {
    if (materialCount !== 1 || passageCount !== 0 || questions.some((question) => question.questionType !== "rdl")) {
      fail("RDL item must contain one material and its complete RDL question group", "$", context);
    }
  } else if (module === "rap") {
    if (materialCount !== 0 || passageCount !== 1 || questions.some((question) => !question.questionType.startsWith("rap_"))) {
      fail("RAP item must contain one passage and its complete RAP question group", "$", context);
    }
  }
}

function validateOccurrences(
  value: unknown,
  logicalItemId: string,
  questionById: Map<string, ReadingQuestion>,
  item: RecordValue,
  context: ValidationContext
) {
  const occurrences = array(value, "$.occurrences", context);
  if (occurrences.length === 0) fail("must contain at least one source occurrence", "$.occurrences", context);
  const occurrenceIds = new Set<string>();
  const ordered: Array<{ occurrenceDate: string; sourceLabel: string; sourceOrder: number }> = [];
  occurrences.forEach((occurrenceValue, index) => {
    const occurrencePath = `$.occurrences[${index}]`;
    const occurrence = record(occurrenceValue, occurrencePath, context);
    const occurrenceId = nonEmptyString(occurrence.occurrenceId, `${occurrencePath}.occurrenceId`, context);
    if (occurrenceIds.has(occurrenceId)) fail(`duplicate occurrenceId ${occurrenceId}`, "$.occurrences", context);
    occurrenceIds.add(occurrenceId);
    if (nonEmptyString(occurrence.logicalItemId, `${occurrencePath}.logicalItemId`, context) !== logicalItemId) {
      fail("logicalItemId must match package item", `${occurrencePath}.logicalItemId`, context);
    }
    nonEmptyString(occurrence.sourceKind, `${occurrencePath}.sourceKind`, context);
    const sourceLabel = nonEmptyString(occurrence.sourceLabel, `${occurrencePath}.sourceLabel`, context);
    const occurrenceDate = date(occurrence.occurrenceDate, `${occurrencePath}.occurrenceDate`, context);
    const occurrenceMonth = yearMonth(occurrence.yearMonth, `${occurrencePath}.yearMonth`, context);
    if (!occurrenceDate.startsWith(occurrenceMonth)) {
      fail("yearMonth must match occurrenceDate", `${occurrencePath}.yearMonth`, context);
    }
    nonEmptyString(occurrence.sourceQuestionFile, `${occurrencePath}.sourceQuestionFile`, context);
    nonEmptyString(occurrence.sourceAnswerFile, `${occurrencePath}.sourceAnswerFile`, context);
    if (occurrence.sourceModule !== "m1" && occurrence.sourceModule !== "m2") {
      fail('must be "m1" or "m2"', `${occurrencePath}.sourceModule`, context);
    }
    const sourceOrder = positiveInteger(occurrence.sourceOrder, `${occurrencePath}.sourceOrder`, context);
    const sourceStart = positiveInteger(occurrence.sourceQuestionStart, `${occurrencePath}.sourceQuestionStart`, context);
    const sourceEnd = positiveInteger(occurrence.sourceQuestionEnd, `${occurrencePath}.sourceQuestionEnd`, context);
    if (sourceEnd < sourceStart) fail("must not precede sourceQuestionStart", `${occurrencePath}.sourceQuestionEnd`, context);
    const questionSources = array(occurrence.questionSources, `${occurrencePath}.questionSources`, context);
    if (questionSources.length !== questionById.size) {
      fail("must map every logical question exactly once", `${occurrencePath}.questionSources`, context);
    }
    const mappedIds = new Set<string>();
    let mappedStart = Number.POSITIVE_INFINITY;
    let mappedEnd = 0;
    questionSources.forEach((mappingValue, mappingIndex) => {
      const mappingPath = `${occurrencePath}.questionSources[${mappingIndex}]`;
      const mapping = record(mappingValue, mappingPath, context);
      const questionId = nonEmptyString(mapping.questionId, `${mappingPath}.questionId`, context);
      const question = questionById.get(questionId);
      if (!question) fail("questionId does not exist in logical item", `${mappingPath}.questionId`, context);
      if (mappedIds.has(questionId)) fail(`duplicate questionId ${questionId}`, `${occurrencePath}.questionSources`, context);
      mappedIds.add(questionId);
      const start = positiveInteger(mapping.sourceQuestionStart, `${mappingPath}.sourceQuestionStart`, context);
      const end = positiveInteger(mapping.sourceQuestionEnd, `${mappingPath}.sourceQuestionEnd`, context);
      if (end < start) fail("must not precede sourceQuestionStart", `${mappingPath}.sourceQuestionEnd`, context);
      if (question.questionType === "ctw") {
        if (end - start + 1 !== question.payload.slots.length) {
          fail("CTW source range must match logical slot count", mappingPath, context);
        }
      } else if (start !== end) {
        fail("non-CTW question source range must contain one question", mappingPath, context);
      }
      mappedStart = Math.min(mappedStart, start);
      mappedEnd = Math.max(mappedEnd, end);
    });
    if (mappedStart !== sourceStart || mappedEnd !== sourceEnd) {
      fail("occurrence source range must cover its question mappings", occurrencePath, context);
    }
    ordered.push({ occurrenceDate, sourceLabel, sourceOrder });
  });
  ordered.sort((left, right) => left.occurrenceDate.localeCompare(right.occurrenceDate)
    || new Intl.Collator("en", { numeric: true }).compare(left.sourceLabel, right.sourceLabel)
    || left.sourceOrder - right.sourceOrder);
  const first = ordered[0];
  if (item.firstSeenDate !== first.occurrenceDate
    || item.firstSeenSourceLabel !== first.sourceLabel
    || item.firstSeenSourceOrder !== first.sourceOrder) {
    fail("first-seen fields must match the earliest real source occurrence", "$.item", context);
  }
}

function validateMaterial(value: unknown, path: string, context: ValidationContext): ReadingMaterial {
  const material = record(value, path, context);
  nonEmptyString(material.materialId, `${path}.materialId`, context);
  nullableString(material.title, `${path}.title`, context);
  const materialType = material.materialType ?? null;
  if (materialType !== null && !isRdlMaterialType(materialType)) {
    fail("must be a supported RDL material type or null", `${path}.materialType`, context);
  }
  material.materialType = materialType;
  nonEmptyString(material.source, `${path}.source`, context);
  nullableDate(material.sourceDate, `${path}.sourceDate`, context);
  yearMonth(material.yearMonth, `${path}.yearMonth`, context);
  if (material.bindingStatus !== "bound" && material.bindingStatus !== "pending") {
    fail('must be "bound" or "pending"', `${path}.bindingStatus`, context);
  }
  nullableString(material.imageAssetPath, `${path}.imageAssetPath`, context);
  nullableString(material.hitboxDataPath, `${path}.hitboxDataPath`, context);
  if (
    material.bindingStatus === "bound" &&
    (!isNonEmptyString(material.imageAssetPath) || !isNonEmptyString(material.hitboxDataPath))
  ) {
    fail(
      "bound material requires imageAssetPath and hitboxDataPath",
      path,
      context
    );
  }
  if (
    material.bindingStatus === "pending" &&
    (material.imageAssetPath !== null || material.hitboxDataPath !== null)
  ) {
    fail("pending material paths must both be null", path, context);
  }
  return value as ReadingMaterial;
}

function validatePassage(value: unknown, path: string, context: ValidationContext): ReadingPassage {
  const passage = record(value, path, context);
  const passageId = nonEmptyString(passage.passageId, `${path}.passageId`, context);
  nonEmptyString(passage.logicalItemId, `${path}.logicalItemId`, context);
  nonEmptyString(passage.title, `${path}.title`, context);
  const paragraphs = array(passage.paragraphs, `${path}.paragraphs`, context);
  if (paragraphs.length === 0) fail("must contain at least one paragraph", `${path}.paragraphs`, context);
  const paragraphIds = new Set<string>();
  const paragraphOrders = new Set<number>();
  const sentenceIds = new Set<string>();
  paragraphs.forEach((paragraphValue, paragraphIndex) => {
    const paragraphPath = `${path}.paragraphs[${paragraphIndex}]`;
    const paragraph = record(paragraphValue, paragraphPath, context);
    const paragraphId = nonEmptyString(paragraph.paragraphId, `${paragraphPath}.paragraphId`, context);
    const paragraphOrder = positiveInteger(
      paragraph.paragraphOrder,
      `${paragraphPath}.paragraphOrder`,
      context
    );
    const paragraphText = nonEmptyString(paragraph.text, `${paragraphPath}.text`, context);
    const rawParagraphText = nonEmptyString(paragraph.rawText, `${paragraphPath}.rawText`, context);
    if (rawParagraphText.replace(/\s*■\s*/g, " ").trim() !== paragraphText) {
      fail("rawText with insertion markers removed must exactly equal paragraph text", paragraphPath, context);
    }
    if (paragraphIds.has(paragraphId)) fail(`duplicate paragraphId ${paragraphId}`, paragraphPath, context);
    if (paragraphOrders.has(paragraphOrder)) fail(`duplicate paragraphOrder ${paragraphOrder}`, paragraphPath, context);
    paragraphIds.add(paragraphId);
    paragraphOrders.add(paragraphOrder);

    const sentences = array(paragraph.sentences, `${paragraphPath}.sentences`, context);
    if (sentences.length === 0) fail("must contain explicit sentence boundaries", `${paragraphPath}.sentences`, context);
    const sentenceOrders = new Set<number>();
    let paragraphCursor = 0;
    sentences.forEach((sentenceValue, sentenceIndex) => {
      const sentencePath = `${paragraphPath}.sentences[${sentenceIndex}]`;
      const sentence = record(sentenceValue, sentencePath, context);
      const sentenceId = nonEmptyString(sentence.sentenceId, `${sentencePath}.sentenceId`, context);
      const sentenceOrder = positiveInteger(sentence.sentenceOrder, `${sentencePath}.sentenceOrder`, context);
      const sentenceText = nonEmptyString(sentence.text, `${sentencePath}.text`, context);
      if (sentenceIds.has(sentenceId)) fail(`duplicate sentenceId ${sentenceId}`, sentencePath, context);
      if (sentenceOrders.has(sentenceOrder)) fail(`duplicate sentenceOrder ${sentenceOrder}`, sentencePath, context);
      sentenceIds.add(sentenceId);
      sentenceOrders.add(sentenceOrder);
      const sentenceStart = paragraphText.indexOf(sentenceText, paragraphCursor);
      if (sentenceStart < 0) {
        fail("sentence text must occur in paragraph text in declared order", `${sentencePath}.text`, context);
      }
      if (paragraphText.slice(paragraphCursor, sentenceStart).trim()) {
        fail("sentence boundaries leave non-whitespace paragraph text uncovered", `${sentencePath}.text`, context);
      }
      paragraphCursor = sentenceStart + sentenceText.length;
    });
    if (paragraphText.slice(paragraphCursor).trim()) {
      fail("sentence boundaries leave trailing paragraph text uncovered", `${paragraphPath}.sentences`, context);
    }
    requireContiguous(sentenceOrders, sentences.length, `${paragraphPath}.sentences`, context);
  });
  requireContiguous(paragraphOrders, paragraphs.length, `${path}.paragraphs`, context);
  return value as ReadingPassage;
}

function validateQuestion(
  value: unknown,
  path: string,
  context: ValidationContext,
  materialIds: Set<string>,
  passageById: Map<string, ReadingPassage>
): ReadingQuestion {
  const question = record(value, path, context);
  const questionId = nonEmptyString(question.questionId, `${path}.questionId`, context);
  const questionContext = { ...context, questionId };
  nonEmptyString(question.logicalItemId, `${path}.logicalItemId`, questionContext);
  positiveInteger(question.questionOrder, `${path}.questionOrder`, questionContext);
  if (
    typeof question.questionType !== "string" ||
    !READING_QUESTION_TYPES.includes(question.questionType as (typeof READING_QUESTION_TYPES)[number])
  ) {
    fail("unsupported questionType", `${path}.questionType`, questionContext);
  }
  nonEmptyString(question.stem, `${path}.stem`, questionContext);
  nullableString(question.rawDisplayText, `${path}.rawDisplayText`, questionContext);
  const payloadPath = `${path}.payload`;
  const payload = record(question.payload, payloadPath, questionContext);

  switch (question.questionType) {
    case "ctw":
      validateCtwPayload(payload, payloadPath, questionContext);
      break;
    case "rdl": {
      const materialId = nonEmptyString(payload.materialId, `${payloadPath}.materialId`, questionContext);
      if (!materialIds.has(materialId)) {
        fail(
          `material ${materialId} is not declared as bound or pending in this package`,
          `${payloadPath}.materialId`,
          questionContext
        );
      }
      validateOptionsAndAnswer(payload, payloadPath, questionContext);
      break;
    }
    case "rap_multiple_choice": {
      requirePassage(payload, payloadPath, questionContext, passageById);
      validateOptionsAndAnswer(payload, payloadPath, questionContext);
      break;
    }
    case "rap_sentence_insertion": {
      const passage = requirePassage(payload, payloadPath, questionContext, passageById);
      nonEmptyString(payload.insertSentence, `${payloadPath}.insertSentence`, questionContext);
      const anchors = array(payload.anchors, `${payloadPath}.anchors`, questionContext);
      if (anchors.length !== 4) {
        fail("must contain exactly four legal anchors", `${payloadPath}.anchors`, questionContext);
      }
      const anchorIds = new Set<string>();
      const anchorOrders = new Set<number>();
      const anchorBoundaries = new Set<string>();
      anchors.forEach((anchorValue, anchorIndex) => {
        const anchor = validateAnchor(
          anchorValue,
          `${payloadPath}.anchors[${anchorIndex}]`,
          questionContext,
          passage
        );
        if (anchorIds.has(anchor.anchorId)) {
          fail(`duplicate anchorId ${anchor.anchorId}`, `${payloadPath}.anchors`, questionContext);
        }
        if (anchorOrders.has(anchor.anchorOrder)) {
          fail(`duplicate anchorOrder ${anchor.anchorOrder}`, `${payloadPath}.anchors`, questionContext);
        }
        const boundaryKey = `${anchor.paragraphId}:${anchor.boundaryIndex}`;
        if (anchorBoundaries.has(boundaryKey)) {
          fail(`duplicate insertion boundary ${boundaryKey}`, `${payloadPath}.anchors`, questionContext);
        }
        anchorIds.add(anchor.anchorId);
        anchorOrders.add(anchor.anchorOrder);
        anchorBoundaries.add(boundaryKey);
      });
      requireContiguous(anchorOrders, anchors.length, `${payloadPath}.anchors`, questionContext);
      const correctAnchorId = nonEmptyString(
        payload.correctAnchorId,
        `${payloadPath}.correctAnchorId`,
        questionContext
      );
      if (!anchorIds.has(correctAnchorId)) {
        fail("correctAnchorId does not exist in anchors", `${payloadPath}.correctAnchorId`, questionContext);
      }
      break;
    }
    case "rap_sentence_selection": {
      const passage = requirePassage(payload, payloadPath, questionContext, passageById);
      const targetParagraphId = nonEmptyString(
        payload.targetParagraphId,
        `${payloadPath}.targetParagraphId`,
        questionContext
      );
      const targetParagraph = passage.paragraphs.find(
        (paragraph) => paragraph.paragraphId === targetParagraphId
      );
      if (!targetParagraph) {
        fail("targetParagraphId does not exist in passage", `${payloadPath}.targetParagraphId`, questionContext);
      }
      const correctSentenceId = nonEmptyString(
        payload.correctSentenceId,
        `${payloadPath}.correctSentenceId`,
        questionContext
      );
      if (!targetParagraph.sentences.some((sentence) => sentence.sentenceId === correctSentenceId)) {
        fail(
          "correctSentenceId does not exist in target paragraph",
          `${payloadPath}.correctSentenceId`,
          questionContext
        );
      }
      break;
    }
  }
  return value as ReadingQuestion;
}

function validateCtwPayload(
  payload: RecordValue,
  path: string,
  context: ValidationContext
) {
  const paragraphs = array(payload.paragraphs, `${path}.paragraphs`, context);
  const slots = array(payload.slots, `${path}.slots`, context);
  if (paragraphs.length === 0) fail("must contain at least one paragraph", `${path}.paragraphs`, context);
  if (slots.length === 0) fail("must contain at least one slot", `${path}.slots`, context);

  const paragraphById = new Map<string, CtwParagraph>();
  const paragraphOrders = new Set<number>();
  paragraphs.forEach((paragraphValue, index) => {
    const paragraphPath = `${path}.paragraphs[${index}]`;
    const paragraph = record(paragraphValue, paragraphPath, context);
    const paragraphId = nonEmptyString(paragraph.paragraphId, `${paragraphPath}.paragraphId`, context);
    const paragraphOrder = positiveInteger(
      paragraph.paragraphOrder,
      `${paragraphPath}.paragraphOrder`,
      context
    );
    nonEmptyString(paragraph.rawText, `${paragraphPath}.rawText`, context);
    const segments = array(paragraph.segments, `${paragraphPath}.segments`, context);
    if (segments.length === 0) fail("must contain renderable segments", `${paragraphPath}.segments`, context);
    segments.forEach((segmentValue, segmentIndex) => {
      const segmentPath = `${paragraphPath}.segments[${segmentIndex}]`;
      const segment = record(segmentValue, segmentPath, context);
      if (segment.kind === "text") {
        if (typeof segment.text !== "string") fail("text must be a string", `${segmentPath}.text`, context);
      } else if (segment.kind === "blank") {
        nonEmptyString(segment.slotId, `${segmentPath}.slotId`, context);
      } else {
        fail('kind must be "text" or "blank"', `${segmentPath}.kind`, context);
      }
    });
    if (paragraphById.has(paragraphId)) fail(`duplicate paragraphId ${paragraphId}`, paragraphPath, context);
    if (paragraphOrders.has(paragraphOrder)) fail(`duplicate paragraphOrder ${paragraphOrder}`, paragraphPath, context);
    paragraphById.set(paragraphId, paragraphValue as CtwParagraph);
    paragraphOrders.add(paragraphOrder);
  });
  requireContiguous(paragraphOrders, paragraphs.length, `${path}.paragraphs`, context);

  const slotById = new Map<string, CtwSlot>();
  const slotOrders = new Set<number>();
  slots.forEach((slotValue, index) => {
    const slotPath = `${path}.slots[${index}]`;
    const slot = record(slotValue, slotPath, context);
    const slotId = nonEmptyString(slot.slotId, `${slotPath}.slotId`, context);
    const slotOrder = positiveInteger(slot.slotOrder, `${slotPath}.slotOrder`, context);
    const paragraphId = nonEmptyString(slot.paragraphId, `${slotPath}.paragraphId`, context);
    const answer = nonEmptyString(slot.answer, `${slotPath}.answer`, context);
    const prefix = string(slot.prefix, `${slotPath}.prefix`, context);
    const displayText = nonEmptyString(slot.displayText, `${slotPath}.displayText`, context);
    const missingText = nonEmptyString(slot.missingText, `${slotPath}.missingText`, context);
    const missingLength = positiveInteger(slot.missingLength, `${slotPath}.missingLength`, context);
    if (!paragraphById.has(paragraphId)) fail("paragraphId does not exist", `${slotPath}.paragraphId`, context);
    if (`${prefix}${missingText}` !== answer) {
      fail("prefix + missingText must exactly equal answer", slotPath, context);
    }
    if (Array.from(missingText).length !== missingLength) {
      fail("missingLength must equal the number of characters in missingText", `${slotPath}.missingLength`, context);
    }
    const displayPattern = new RegExp(`^${escapeRegExp(prefix)}_(?:\\s*_)*$`);
    if (!displayPattern.test(displayText)) {
      fail("displayText must contain the exact prefix followed only by displayed blanks", `${slotPath}.displayText`, context);
    }
    if ((displayText.match(/_/g) ?? []).length !== missingLength) {
      fail("displayText blank count must equal missingLength", `${slotPath}.displayText`, context);
    }
    if (slotById.has(slotId)) fail(`duplicate slotId ${slotId}`, `${path}.slots`, context);
    if (slotOrders.has(slotOrder)) fail(`duplicate slotOrder ${slotOrder}`, `${path}.slots`, context);
    slotById.set(slotId, slotValue as CtwSlot);
    slotOrders.add(slotOrder);
  });
  requireContiguous(slotOrders, slots.length, `${path}.slots`, context);

  const renderedSlotIds: string[] = [];
  const orderedParagraphs = Array.from(paragraphById.values()).sort(
    (left, right) => left.paragraphOrder - right.paragraphOrder
  );
  for (const paragraph of orderedParagraphs) {
    let reconstructedRawText = "";
    for (const segment of paragraph.segments) {
      if (segment.kind === "text") {
        reconstructedRawText += segment.text;
        continue;
      }
      const slot = slotById.get(segment.slotId);
      if (!slot) fail(`segment references unknown slotId ${segment.slotId}`, `${path}.paragraphs`, context);
      if (slot.paragraphId !== paragraph.paragraphId) {
        fail(`slot ${slot.slotId} belongs to a different paragraph`, `${path}.paragraphs`, context);
      }
      reconstructedRawText += slot.displayText;
      renderedSlotIds.push(slot.slotId);
    }
    if (reconstructedRawText !== paragraph.rawText) {
      fail(`segments do not reconstruct rawText for ${paragraph.paragraphId}`, `${path}.paragraphs`, context);
    }
  }
  if (new Set(renderedSlotIds).size !== renderedSlotIds.length) {
    fail("each slot must appear in exactly one blank segment", `${path}.paragraphs`, context);
  }
  if (renderedSlotIds.length !== slotById.size) {
    fail("every slot must appear in a blank segment", `${path}.paragraphs`, context);
  }
  const orderedSlotIds = Array.from(slotById.values())
    .sort((left, right) => left.slotOrder - right.slotOrder)
    .map((slot) => slot.slotId);
  if (!renderedSlotIds.every((slotId, index) => slotId === orderedSlotIds[index])) {
    fail("slotOrder must match paragraph and segment reading order", `${path}.slots`, context);
  }
}

function validateOptionsAndAnswer(payload: RecordValue, path: string, context: ValidationContext) {
  const options = array(payload.options, `${path}.options`, context);
  if (options.length === 0) fail("options must not be empty", `${path}.options`, context);
  const optionIds = new Set<string>();
  const optionOrders = new Set<number>();
  options.forEach((optionValue, index) => {
    const optionPath = `${path}.options[${index}]`;
    const option = record(optionValue, optionPath, context);
    const optionId = nonEmptyString(option.optionId, `${optionPath}.optionId`, context);
    const optionOrder = positiveInteger(option.optionOrder, `${optionPath}.optionOrder`, context);
    nonEmptyString(option.text, `${optionPath}.text`, context);
    if (optionIds.has(optionId)) fail(`duplicate optionId ${optionId}`, `${path}.options`, context);
    if (optionOrders.has(optionOrder)) fail(`duplicate optionOrder ${optionOrder}`, `${path}.options`, context);
    optionIds.add(optionId);
    optionOrders.add(optionOrder);
  });
  requireContiguous(optionOrders, options.length, `${path}.options`, context);
  const correctOptionId = nonEmptyString(payload.correctOptionId, `${path}.correctOptionId`, context);
  if (!optionIds.has(correctOptionId)) {
    fail("correctOptionId does not exist in options", `${path}.correctOptionId`, context);
  }
}

function validateAnchor(
  value: unknown,
  path: string,
  context: ValidationContext,
  passage: ReadingPassage
): ReadingInsertionAnchor {
  const anchor = record(value, path, context);
  nonEmptyString(anchor.anchorId, `${path}.anchorId`, context);
  positiveInteger(anchor.anchorOrder, `${path}.anchorOrder`, context);
  const paragraphId = nonEmptyString(anchor.paragraphId, `${path}.paragraphId`, context);
  const paragraph = passage.paragraphs.find((item) => item.paragraphId === paragraphId);
  if (!paragraph) fail("paragraphId does not exist in passage", `${path}.paragraphId`, context);
  const boundaryIndex = positiveInteger(anchor.boundaryIndex, `${path}.boundaryIndex`, context, true);
  if (boundaryIndex > paragraph.sentences.length) {
    fail("boundaryIndex exceeds paragraph sentence count", `${path}.boundaryIndex`, context);
  }
  if (anchor.afterSentenceId !== null && !isNonEmptyString(anchor.afterSentenceId)) {
    fail("must be a non-empty string or null", `${path}.afterSentenceId`, context);
  }
  const expectedAfterSentenceId =
    boundaryIndex === 0 ? null : paragraph.sentences[boundaryIndex - 1]?.sentenceId ?? null;
  if (anchor.afterSentenceId !== expectedAfterSentenceId) {
    fail(
      `afterSentenceId must match boundaryIndex (expected ${expectedAfterSentenceId ?? "null"})`,
      `${path}.afterSentenceId`,
      context
    );
  }
  return value as ReadingInsertionAnchor;
}

function requirePassage(
  payload: RecordValue,
  path: string,
  context: ValidationContext,
  passageById: Map<string, ReadingPassage>
) {
  const passageId = nonEmptyString(payload.passageId, `${path}.passageId`, context);
  const passage = passageById.get(passageId);
  if (!passage) fail(`passage ${passageId} is not declared in this package`, `${path}.passageId`, context);
  return passage;
}

type ValidationContext = { logicalItemId?: string; questionId?: string };

function record(value: unknown, path: string, context: ValidationContext): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("must be an object", path, context);
  return value as RecordValue;
}

function array(value: unknown, path: string, context: ValidationContext): unknown[] {
  if (!Array.isArray(value)) fail("must be an array", path, context);
  return value;
}

function string(value: unknown, path: string, context: ValidationContext): string {
  if (typeof value !== "string") fail("must be a string", path, context);
  return value;
}

function nonEmptyString(value: unknown, path: string, context: ValidationContext): string {
  const result = string(value, path, context);
  if (!result.trim()) fail("must not be empty", path, context);
  return result;
}

function nullableString(value: unknown, path: string, context: ValidationContext) {
  if (value !== null && typeof value !== "string") fail("must be a string or null", path, context);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && Boolean(value.trim());
}

function positiveInteger(
  value: unknown,
  path: string,
  context: ValidationContext,
  allowZero = false
): number {
  if (!Number.isInteger(value) || (value as number) < (allowZero ? 0 : 1)) {
    fail(`must be ${allowZero ? "a non-negative" : "a positive"} integer`, path, context);
  }
  return value as number;
}

function nullableDate(value: unknown, path: string, context: ValidationContext) {
  if (value === null) return;
  date(value, path, context);
}

function date(value: unknown, path: string, context: ValidationContext): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail("must be YYYY-MM-DD", path, context);
  }
  return value;
}

function yearMonth(value: unknown, path: string, context: ValidationContext): string {
  if (typeof value !== "string" || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    fail("must be YYYY-MM", path, context);
  }
  return value;
}

function isReadingModule(value: unknown): value is "ctw" | "rdl" | "rap" {
  return value === "ctw" || value === "rdl" || value === "rap";
}

function uniqueIds<T extends Record<string, unknown>>(
  values: T[],
  key: keyof T,
  path: string,
  context: ValidationContext
) {
  const result = new Set<string>();
  for (const value of values) {
    const id = String(value[key]);
    if (result.has(id)) fail(`duplicate ${String(key)} ${id}`, path, context);
    result.add(id);
  }
  return result;
}

function requireContiguous(
  orders: Set<number>,
  count: number,
  path: string,
  context: ValidationContext
) {
  for (let order = 1; order <= count; order += 1) {
    if (!orders.has(order)) fail(`orders must be contiguous; missing ${order}`, path, context);
  }
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function fail(message: string, path: string, context: ValidationContext): never {
  throw new ReadingValidationError(message, { ...context, path });
}

import { createHash } from "node:crypto";
import type {
  CtwQuestion,
  ReadingImportPackage,
  ReadingMaterial,
  ReadingPassage,
  ReadingQuestion
} from "./types.ts";

export const READING_SEMANTIC_VERSION = "reading-semantic-v1";

export function normalizeReadingSemanticText(value: string) {
  return value
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2018\u2019\u02bc\uff07]/g, "'")
    .replace(/[\u201c\u201d\uff02]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

export function readingSemanticFingerprint(packageData: ReadingImportPackage) {
  return hash(stableStringify({
    version: READING_SEMANTIC_VERSION,
    identity: readingSemanticIdentity(packageData)
  }));
}

export function readingPossibleDuplicateFingerprint(packageData: ReadingImportPackage) {
  if (packageData.item.module === "ctw") {
    const question = packageData.questions[0];
    return hash(stableStringify({
      module: "ctw",
      passage: question?.questionType === "ctw"
        ? ordered(question.payload.paragraphs, (item) => item.paragraphOrder)
            .map((paragraph) => looseReviewText(paragraph.rawText.replace(/(?:_\s*){2,}/g, " <blank> ")))
        : []
    }));
  }
  if (packageData.item.module === "rdl") {
    return hash(stableStringify({
      module: "rdl",
      material: readingMaterialReviewIdentity(packageData.materials[0])
    }));
  }
  return hash(stableStringify({
    module: "rap",
    passage: rapPassageIdentity(packageData.passages[0], true)
  }));
}

export function arePossibleReadingDuplicates(
  left: ReadingImportPackage,
  right: ReadingImportPackage
) {
  if (left.item.module !== right.item.module) return false;
  if (left.item.module === "rdl") {
    const leftSemantic = stableStringify(readingMaterialSemanticIdentity(left.materials[0]));
    const rightSemantic = stableStringify(readingMaterialSemanticIdentity(right.materials[0]));
    return leftSemantic === rightSemantic
      || stableStringify(readingMaterialReviewIdentity(left.materials[0]))
        === stableStringify(readingMaterialReviewIdentity(right.materials[0]));
  }
  const leftText = reviewPassageText(left);
  const rightText = reviewPassageText(right);
  return leftText === rightText || diceCoefficient(leftText, rightText) >= 0.82;
}

export function readingMaterialSemanticIdentity(material: ReadingMaterial | undefined) {
  if (!material) return null;
  return { materialId: material.materialId };
}

export function readingMaterialStorageIdentity(material: ReadingMaterial | undefined) {
  if (!material) return null;
  const image = normalizeAssetKey(material.imageAssetPath);
  const selectionMap = normalizeAssetKey(material.hitboxDataPath);
  if (material.bindingStatus === "bound" && image && selectionMap) {
    return { binding: [image, selectionMap] };
  }
  return null;
}

export function readingMaterialReviewIdentity(material: ReadingMaterial | undefined) {
  if (!material) return null;
  return {
    title: looseReviewText(material.title ?? ""),
    materialType: material.materialType
  };
}

function readingSemanticIdentity(packageData: ReadingImportPackage) {
  const passageById = new Map(packageData.passages.map((passage) => [passage.passageId, passage]));
  return {
    module: packageData.item.module,
    material: packageData.item.module === "rdl"
      ? readingMaterialSemanticIdentity(packageData.materials[0])
      : undefined,
    passages: packageData.item.module === "rap"
      ? packageData.passages.map((passage) => rapPassageIdentity(passage, false))
      : [],
    questions: ordered(packageData.questions, (question) => question.questionOrder)
      .map((question) => semanticQuestion(question, passageById))
  };
}

function semanticQuestion(question: ReadingQuestion, passageById: Map<string, ReadingPassage>) {
  const common = {
    type: question.questionType,
    stem: normalizeReadingSemanticText(question.stem)
  };
  if (question.questionType === "ctw") return { ...common, ...ctwIdentity(question) };
  if (question.questionType === "rdl" || question.questionType === "rap_multiple_choice") {
    const correct = question.payload.options.find(
      (option) => option.optionId === question.payload.correctOptionId
    );
    if (!correct) throw new Error(`Reading semantic identity cannot resolve correct option for ${question.questionId}`);
    return {
      ...common,
      ...(question.questionType === "rap_multiple_choice"
        ? { highlights: highlightIdentity(question.payload.highlightRanges, requiredPassage(passageById, question.payload.passageId)) }
        : {}),
      options: question.payload.options
        .map((option) => normalizeReadingSemanticText(option.text))
        .sort(),
      correctOptionText: normalizeReadingSemanticText(correct.text)
    };
  }
  const passage = requiredPassage(passageById, question.payload.passageId);
  if (question.questionType === "rap_sentence_insertion") {
    const paragraphOrder = new Map(passage.paragraphs.map((paragraph) => [paragraph.paragraphId, paragraph.paragraphOrder]));
    const anchorPosition = (anchor: (typeof question.payload.anchors)[number]) => ({
      paragraphOrder: requiredMap(paragraphOrder, anchor.paragraphId),
      boundaryIndex: anchor.boundaryIndex
    });
    const correct = question.payload.anchors.find((anchor) => anchor.anchorId === question.payload.correctAnchorId);
    if (!correct) throw new Error(`Reading semantic identity cannot resolve insertion answer for ${question.questionId}`);
    return {
      ...common,
      highlights: highlightIdentity(question.payload.highlightRanges, passage),
      insertSentence: normalizeReadingSemanticText(question.payload.insertSentence),
      anchors: question.payload.anchors.map(anchorPosition).sort(comparePosition),
      correctPosition: anchorPosition(correct)
    };
  }
  const targetParagraph = passage.paragraphs.find(
    (paragraph) => paragraph.paragraphId === question.payload.targetParagraphId
  );
  const correctSentence = targetParagraph?.sentences.find(
    (sentence) => sentence.sentenceId === question.payload.correctSentenceId
  );
  if (!targetParagraph || !correctSentence) {
    throw new Error(`Reading semantic identity cannot resolve sentence answer for ${question.questionId}`);
  }
  return {
    ...common,
    highlights: highlightIdentity(question.payload.highlightRanges, passage),
    targetParagraphOrder: targetParagraph.paragraphOrder,
    correctSentenceOrder: correctSentence.sentenceOrder,
    correctSentenceText: normalizeReadingSemanticText(correctSentence.text)
  };
}

function ctwIdentity(question: CtwQuestion) {
  const slotById = new Map(question.payload.slots.map((slot) => [slot.slotId, slot]));
  const paragraphOrder = new Map(
    question.payload.paragraphs.map((paragraph) => [paragraph.paragraphId, paragraph.paragraphOrder])
  );
  return {
    paragraphs: ordered(question.payload.paragraphs, (paragraph) => paragraph.paragraphOrder).map((paragraph) => ({
      segments: paragraph.segments.map((segment) => segment.kind === "text"
        ? { kind: "text", text: normalizeReadingSemanticText(segment.text) }
        : { kind: "blank", slotOrder: requiredMap(slotById, segment.slotId).slotOrder })
    })),
    slots: ordered(question.payload.slots, (slot) => slot.slotOrder).map((slot) => ({
      paragraphOrder: requiredMap(paragraphOrder, slot.paragraphId),
      slotOrder: slot.slotOrder,
      prefix: normalizeReadingSemanticText(slot.prefix),
      missingText: normalizeReadingSemanticText(slot.missingText),
      answer: normalizeReadingSemanticText(slot.answer)
    }))
  };
}

function rapPassageIdentity(passage: ReadingPassage | undefined, loose: boolean) {
  if (!passage) return null;
  const text = loose ? looseReviewText : normalizeReadingSemanticText;
  return {
    title: text(passage.title),
    paragraphs: ordered(passage.paragraphs, (paragraph) => paragraph.paragraphOrder).map((paragraph) => ({
      text: text(paragraph.text),
      sentences: ordered(paragraph.sentences, (sentence) => sentence.sentenceOrder)
        .map((sentence) => text(sentence.text))
    }))
  };
}

function highlightIdentity(
  ranges: Array<{ paragraphId: string; startOffset: number; endOffset: number }> | undefined,
  passage: ReadingPassage
) {
  const paragraphOrder = new Map(passage.paragraphs.map((paragraph) => [paragraph.paragraphId, paragraph.paragraphOrder]));
  return (ranges ?? []).map((range) => ({
    paragraphOrder: requiredMap(paragraphOrder, range.paragraphId),
    startOffset: range.startOffset,
    endOffset: range.endOffset
  })).sort((left, right) => comparePosition(left, right) || left.endOffset - right.endOffset);
}

function looseReviewText(value: string) {
  return normalizeReadingSemanticText(value)
    .replace(/[!-/:-@[-`{-~\u00a1-\u00bf\u2000-\u206f\u20a0-\u20cf]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function reviewPassageText(packageData: ReadingImportPackage) {
  if (packageData.item.module === "rap") {
    const passage = packageData.passages[0];
    return looseReviewText([
      passage?.title ?? "",
      ...(passage?.paragraphs ?? []).map((paragraph) => paragraph.text)
    ].join(" "));
  }
  const question = packageData.questions[0];
  return question?.questionType === "ctw"
    ? looseReviewText(question.payload.paragraphs.map((paragraph) => paragraph.rawText).join(" "))
    : "";
}

function diceCoefficient(left: string, right: string) {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const pairs = (value: string) => {
    const result = new Map<string, number>();
    for (let index = 0; index < value.length - 1; index += 1) {
      const pair = value.slice(index, index + 2);
      result.set(pair, (result.get(pair) ?? 0) + 1);
    }
    return result;
  };
  const leftPairs = pairs(left);
  const rightPairs = pairs(right);
  let overlap = 0;
  leftPairs.forEach((count, pair) => {
    overlap += Math.min(count, rightPairs.get(pair) ?? 0);
  });
  const leftCount = Array.from(leftPairs.values()).reduce((sum, count) => sum + count, 0);
  const rightCount = Array.from(rightPairs.values()).reduce((sum, count) => sum + count, 0);
  return (2 * overlap) / (leftCount + rightCount);
}

function normalizeAssetKey(value: string | null) {
  return value ? value.normalize("NFC").replace(/^\/+|\/+$/g, "").trim() : null;
}

function ordered<T>(values: T[], order: (value: T) => number) {
  return [...values].sort((left, right) => order(left) - order(right));
}

function comparePosition(
  left: { paragraphOrder: number; boundaryIndex?: number },
  right: { paragraphOrder: number; boundaryIndex?: number }
) {
  return left.paragraphOrder - right.paragraphOrder
    || (left.boundaryIndex ?? 0) - (right.boundaryIndex ?? 0);
}

function requiredPassage(passages: Map<string, ReadingPassage>, passageId: string) {
  const passage = passages.get(passageId);
  if (!passage) throw new Error(`Reading semantic identity cannot resolve passage ${passageId}`);
  return passage;
}

function requiredMap<K, V>(map: Map<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Reading semantic identity cannot resolve ${String(key)}`);
  return value;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

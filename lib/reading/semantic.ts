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

/** RDL identity is its canonical material; RAP identity is its actual passage. */
export function areReadingPackagesHistoricalSemanticEquivalents(
  left: ReadingImportPackage,
  right: ReadingImportPackage
) {
  if (left.item.module !== right.item.module || left.item.module === "ctw") return false;
  if (left.item.module === "rdl") {
    const leftMaterialId = left.materials[0]?.materialId;
    return Boolean(leftMaterialId && leftMaterialId === right.materials[0]?.materialId);
  }
  return historicalRapPassagesEquivalent(left, right);
}

export function haveSameReadingCanonicalQuestions(
  left: ReadingImportPackage,
  right: ReadingImportPackage
) {
  const identity = (packageData: ReadingImportPackage) => {
    const passageById = new Map(packageData.passages.map((passage) => [passage.passageId, passage]));
    return ordered(packageData.questions, (question) => question.questionOrder)
      .map((question) => semanticQuestion(question, passageById));
  };
  return stableStringify(identity(left)) === stableStringify(identity(right));
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

function historicalRapPassagesEquivalent(
  left: ReadingImportPackage,
  right: ReadingImportPackage
) {
  if (left.passages.length !== right.passages.length) return false;
  const leftPassages = left.passages;
  const rightPassages = right.passages;
  return leftPassages.every((passage, index) => {
    const other = rightPassages[index];
    if (
      !other
      || passage.paragraphs.length !== other.paragraphs.length
    ) return false;
    const paragraphs = ordered(passage.paragraphs, (item) => item.paragraphOrder);
    const otherParagraphs = ordered(other.paragraphs, (item) => item.paragraphOrder);
    return paragraphs.every((paragraph, paragraphIndex) =>
      paragraph.paragraphOrder === otherParagraphs[paragraphIndex]?.paragraphOrder
      && historicalTextEquivalent(paragraph.text, otherParagraphs[paragraphIndex]?.text ?? "")
    );
  });
}

function historicalTextEquivalent(left: string, right: string) {
  const leftTokens = historicalTextTokens(left);
  const rightTokens = historicalTextTokens(right);
  if (leftTokens.length !== rightTokens.length) return false;
  let editCount = 0;
  for (let index = 0; index < leftTokens.length; index += 1) {
    if (leftTokens[index] === rightTokens[index]) continue;
    const distance = boundedEditDistance(leftTokens[index], rightTokens[index], 2);
    if (
      distance === 0
      || distance > (Math.min(leftTokens[index].length, rightTokens[index].length) >= 6 ? 2 : 1)
      || Math.min(leftTokens[index].length, rightTokens[index].length) < 4
    ) return false;
    editCount += distance;
    if (editCount > 2) return false;
  }
  return true;
}

function historicalTextTokens(value: string) {
  return normalizeReadingSemanticText(value)
    .replace(/[\u0406\u0456]/g, (letter) => letter === "\u0406" ? "I" : "i")
    .replace(/[\u0410\u0430\u0412\u0432\u0421\u0441\u0415\u0435\u041d\u043d\u041a\u043a\u041c\u043c\u041e\u043e\u0420\u0440\u0422\u0442\u0425\u0445\u0423\u0443]/g, (letter) => ({
      "\u0410": "A", "\u0430": "a", "\u0412": "B", "\u0432": "b", "\u0421": "C", "\u0441": "c",
      "\u0415": "E", "\u0435": "e", "\u041d": "H", "\u043d": "h", "\u041a": "K", "\u043a": "k",
      "\u041c": "M", "\u043c": "m", "\u041e": "O", "\u043e": "o", "\u0420": "P", "\u0440": "p",
      "\u0422": "T", "\u0442": "t", "\u0425": "X", "\u0445": "x", "\u0423": "Y", "\u0443": "y"
    }[letter] ?? letter))
    .toLocaleLowerCase("en-US")
    .replace(/\b([ap])\.?\s*m\.?\b/g, "$1m")
    .replace(/[-\u2010-\u2015]/g, " ")
    .replace(/[.,:;]+/g, " ")
    .replace(/[!?]+(?=\s*$)/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

function boundedEditDistance(left: string, right: string, maximum: number) {
  if (Math.abs(left.length - right.length) > maximum) return maximum + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    let rowMinimum = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        current[rightIndex - 1] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      );
      rowMinimum = Math.min(rowMinimum, current[rightIndex]);
    }
    if (rowMinimum > maximum) return maximum + 1;
    previous = current;
  }
  return previous[right.length];
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

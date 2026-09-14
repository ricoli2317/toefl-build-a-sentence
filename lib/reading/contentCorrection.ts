import { validateReadingImportPackage } from "./validation.ts";
import { fingerprintReadingSourceOccurrence } from "./grouping.ts";
import { compareCtwPackageLogicalIdentity } from "./ctwLogicalIdentity.ts";
import { buildReadingContentConflict } from "./contentReconciliation.ts";
import { normalizeReadingReviewText } from "./reviewDiff.ts";
import type {
  CtwQuestion,
  ReadingImportPackage,
  ReadingPassage,
  ReadingPassageHighlightRange,
  ReadingQuestion
} from "./types.ts";

/** Builds an incoming-authoritative package while preserving every canonical
 * database identity. The atomic importer can therefore update content without
 * creating a second logical item or breaking historical occurrence bindings. */
export function buildReadingCanonicalContentUpdate(
  existing: ReadingImportPackage,
  incoming: ReadingImportPackage
): ReadingImportPackage {
  if (existing.item.module !== incoming.item.module) {
    throw new Error("Reading canonical correction cannot change module");
  }
  if (
    existing.item.module === "ctw"
    && !compareCtwPackageLogicalIdentity(existing, incoming).sameLogicalItem
  ) {
    throw Object.assign(
      new Error("CTW canonical correction cannot cross logical identities"),
      { code: "READING_CTW_IDENTITY_CLUSTER_INVARIANT" }
    );
  }
  const existingQuestions = ordered(existing.questions, (question) => question.questionOrder);
  const incomingQuestions = ordered(incoming.questions, (question) => question.questionOrder);
  requireSameOrders(existingQuestions, incomingQuestions, "question");
  const conflict = buildReadingContentConflict(existing, incoming);
  const changedQuestionOrders = new Set(
    conflict?.questionConflicts.map((question) => question.questionOrder) ?? []
  );

  const passageIds = new Map<string, string>();
  const paragraphIds = new Map<string, string>();
  const sentenceIds = new Map<string, string>();
  const passages = (conflict?.passageConflicts.length ?? 0) === 0
    ? preserveCanonicalPassages(
        existing.passages,
        incoming.passages,
        passageIds,
        paragraphIds,
        sentenceIds
      )
    : remapPassages(existing.passages, incoming.passages, passageIds, paragraphIds, sentenceIds);
  const existingByOrder = new Map(existingQuestions.map((question) => [question.questionOrder, question]));
  const questions = incomingQuestions.map((question) => {
    const existingQuestion = requiredMap(existingByOrder, question.questionOrder, "canonical question");
    if (!changedQuestionOrders.has(question.questionOrder)) return existingQuestion;
    return remapQuestion(
      existingQuestion,
      question,
      existing.item.logicalItemId,
      passageIds,
      paragraphIds,
      sentenceIds
    );
  });
  const canonicalQuestionByOrder = new Map(questions.map((question) => [question.questionOrder, question]));
  const occurrences = incoming.occurrences.map((occurrence) => ({
    ...occurrence,
    logicalItemId: existing.item.logicalItemId,
    questionSources: occurrence.questionSources.map((source, index) => ({
      ...source,
      questionId: requiredMap(
        canonicalQuestionByOrder,
        incomingQuestions[index]?.questionOrder,
        "canonical occurrence question"
      ).questionId
    }))
  }));

  const draft: ReadingImportPackage = {
    ...incoming,
    item: {
      ...incoming.item,
      logicalItemId: existing.item.logicalItemId
    },
    materials: existing.item.module === "rdl"
      ? existing.materials.map((material) => {
          const incomingMaterial = incoming.materials.find((candidate) =>
            candidate.materialId === material.materialId
          );
          return incomingMaterial ? { ...material, title: incomingMaterial.title } : material;
        })
      : incoming.materials,
    passages,
    questions,
    occurrences
  };
  // CTW keeps its historical compatibility key. RDL/RAP retain a strict
  // fingerprint for the corrected canonical representation; the atomic RPC
  // permits this only for an explicitly reviewed canonical replacement.
  draft.item.dedupFingerprint = draft.item.module === "ctw"
    ? existing.item.dedupFingerprint
    : fingerprintReadingSourceOccurrence({
      sourceOccurrenceId: "canonical-correction",
      module: draft.item.module,
      title: draft.item.title,
      source: {
        sourceKind: "canonical_correction",
        sourceLabel: draft.item.firstSeenSourceLabel,
        occurrenceDate: draft.item.firstSeenDate,
        yearMonth: draft.item.firstSeenDate.slice(0, 7),
        sourceQuestionFile: "canonical_correction",
        sourceAnswerFile: "canonical_correction",
        sourceModule: draft.occurrences[0]?.sourceModule ?? "m1",
        sourceOrder: draft.item.firstSeenSourceOrder,
        sourceQuestionStart: draft.occurrences[0]?.sourceQuestionStart ?? 1,
        sourceQuestionEnd: draft.occurrences[0]?.sourceQuestionEnd ?? draft.questions.length
      },
      materials: draft.materials,
      passages: draft.passages.map(({ logicalItemId: _, ...passage }) => passage),
      questions: draft.questions.map((question) => {
        const occurrenceSource = draft.occurrences[0]?.questionSources.find(
          (source) => source.questionId === question.questionId
        );
        return {
          ...question,
          sourceQuestionStart: occurrenceSource?.sourceQuestionStart ?? question.questionOrder,
          sourceQuestionEnd: occurrenceSource?.sourceQuestionEnd ?? question.questionOrder
        };
      })
    });
  return validateReadingImportPackage(draft);
}

function preserveCanonicalPassages(
  existingPassages: ReadingPassage[],
  incomingPassages: ReadingPassage[],
  passageIds: Map<string, string>,
  paragraphIds: Map<string, string>,
  sentenceIds: Map<string, string>
) {
  if (existingPassages.length !== incomingPassages.length) {
    throw new Error("Reading canonical correction cannot safely map a different passage count");
  }
  for (let passageIndex = 0; passageIndex < incomingPassages.length; passageIndex += 1) {
    const incomingPassage = incomingPassages[passageIndex];
    const existingPassage = existingPassages[passageIndex];
    passageIds.set(incomingPassage.passageId, existingPassage.passageId);
    const existingParagraphs = ordered(existingPassage.paragraphs, (paragraph) => paragraph.paragraphOrder);
    const incomingParagraphs = ordered(incomingPassage.paragraphs, (paragraph) => paragraph.paragraphOrder);
    requireSameOrders(existingParagraphs, incomingParagraphs, "passage paragraph");
    for (const incomingParagraph of incomingParagraphs) {
      const existingParagraph = requiredByOrder(
        existingParagraphs,
        incomingParagraph.paragraphOrder,
        "canonical paragraph"
      );
      paragraphIds.set(incomingParagraph.paragraphId, existingParagraph.paragraphId);
      const existingByText = new Map(existingParagraph.sentences.map((sentence) => [
        normalizeReadingReviewText(sentence.text),
        sentence.sentenceId
      ]));
      for (const incomingSentence of incomingParagraph.sentences) {
        const existingSentenceId = existingByText.get(normalizeReadingReviewText(incomingSentence.text));
        if (existingSentenceId) sentenceIds.set(incomingSentence.sentenceId, existingSentenceId);
      }
    }
  }
  return existingPassages;
}

function remapPassages(
  existingPassages: ReadingPassage[],
  incomingPassages: ReadingPassage[],
  passageIds: Map<string, string>,
  paragraphIds: Map<string, string>,
  sentenceIds: Map<string, string>
) {
  if (existingPassages.length !== incomingPassages.length) {
    throw new Error("Reading canonical correction cannot safely map a different passage count");
  }
  return incomingPassages.map((incomingPassage, passageIndex): ReadingPassage => {
    const existingPassage = existingPassages[passageIndex];
    passageIds.set(incomingPassage.passageId, existingPassage.passageId);
    const existingParagraphs = ordered(existingPassage.paragraphs, (paragraph) => paragraph.paragraphOrder);
    const incomingParagraphs = ordered(incomingPassage.paragraphs, (paragraph) => paragraph.paragraphOrder);
    requireSameOrders(existingParagraphs, incomingParagraphs, "passage paragraph");
    return {
      passageId: existingPassage.passageId,
      logicalItemId: existingPassage.logicalItemId,
      title: incomingPassage.title,
      paragraphs: incomingParagraphs.map((incomingParagraph) => {
        const existingParagraph = requiredByOrder(existingParagraphs, incomingParagraph.paragraphOrder, "canonical paragraph");
        paragraphIds.set(incomingParagraph.paragraphId, existingParagraph.paragraphId);
        const existingSentences = ordered(existingParagraph.sentences, (sentence) => sentence.sentenceOrder);
        const incomingSentences = ordered(incomingParagraph.sentences, (sentence) => sentence.sentenceOrder);
        requireSameOrders(existingSentences, incomingSentences, "passage sentence");
        return {
          ...incomingParagraph,
          paragraphId: existingParagraph.paragraphId,
          sentences: incomingSentences.map((incomingSentence) => {
            const existingSentence = requiredByOrder(existingSentences, incomingSentence.sentenceOrder, "canonical sentence");
            sentenceIds.set(incomingSentence.sentenceId, existingSentence.sentenceId);
            return { ...incomingSentence, sentenceId: existingSentence.sentenceId };
          })
        };
      })
    };
  });
}

function remapQuestion(
  existing: ReadingQuestion,
  incoming: ReadingQuestion,
  logicalItemId: string,
  passageIds: Map<string, string>,
  paragraphIds: Map<string, string>,
  sentenceIds: Map<string, string>
): ReadingQuestion {
  const base = {
    questionId: existing.questionId,
    logicalItemId,
    questionOrder: incoming.questionOrder,
    stem: incoming.stem,
    rawDisplayText: incoming.rawDisplayText
  };
  if (incoming.questionType === "ctw") {
    if (existing.questionType !== "ctw") {
      throw new Error("Reading canonical correction cannot safely change a non-CTW question to CTW");
    }
    return { ...base, questionType: "ctw", payload: remapCtw(existing, incoming) };
  }
  if (incoming.questionType === "rdl") {
    const canonicalOptions = existing.questionType === "rdl" ? existing.payload.options : [];
    const payload = remapOptions(canonicalOptions, incoming.payload.options, incoming.payload.correctOptionId, existing.questionId);
    return {
      ...base,
      questionType: "rdl",
      payload: {
        materialId: existing.questionType === "rdl" ? existing.payload.materialId : incoming.payload.materialId,
        ...payload
      }
    };
  }
  const passageId = requiredMap(passageIds, incoming.payload.passageId, "canonical passage");
  const highlightRanges = remapHighlights(incoming.payload.highlightRanges, paragraphIds);
  if (incoming.questionType === "rap_multiple_choice") {
    const canonicalOptions = existing.questionType === "rap_multiple_choice" ? existing.payload.options : [];
    return {
      ...base,
      questionType: "rap_multiple_choice",
      payload: {
        passageId,
        highlightRanges,
        ...remapOptions(canonicalOptions, incoming.payload.options, incoming.payload.correctOptionId, existing.questionId)
      }
    };
  }
  if (incoming.questionType === "rap_sentence_insertion") {
    const existingAnchors = existing.questionType === "rap_sentence_insertion"
      ? ordered(existing.payload.anchors, (anchor) => anchor.anchorOrder)
      : [];
    const incomingAnchors = ordered(incoming.payload.anchors, (anchor) => anchor.anchorOrder);
    if (existingAnchors.length > 0) requireSameOrders(existingAnchors, incomingAnchors, "insertion anchor");
    const anchorIds = new Map<string, string>();
    const anchors = incomingAnchors.map((anchor, index) => {
      const anchorId = existingAnchors[index]?.anchorId ?? `${existing.questionId}-anchor-${anchor.anchorOrder}`;
      anchorIds.set(anchor.anchorId, anchorId);
      return {
        ...anchor,
        anchorId,
        paragraphId: requiredMap(paragraphIds, anchor.paragraphId, "canonical anchor paragraph"),
        afterSentenceId: anchor.afterSentenceId
          ? requiredMap(sentenceIds, anchor.afterSentenceId, "canonical anchor sentence")
          : null
      };
    });
    return {
      ...base,
      questionType: "rap_sentence_insertion",
      payload: {
        passageId,
        highlightRanges,
        insertSentence: incoming.payload.insertSentence,
        anchors,
        correctAnchorId: requiredMap(anchorIds, incoming.payload.correctAnchorId, "canonical correct anchor")
      }
    };
  }
  return {
    ...base,
    questionType: "rap_sentence_selection",
    payload: {
      passageId,
      highlightRanges,
      targetParagraphId: requiredMap(paragraphIds, incoming.payload.targetParagraphId, "canonical target paragraph"),
      correctSentenceId: requiredMap(sentenceIds, incoming.payload.correctSentenceId, "canonical selected sentence")
    }
  };
}

function remapCtw(existing: CtwQuestion, incoming: CtwQuestion) {
  const existingParagraphs = ordered(existing.payload.paragraphs, (paragraph) => paragraph.paragraphOrder);
  const incomingParagraphs = ordered(incoming.payload.paragraphs, (paragraph) => paragraph.paragraphOrder);
  const existingSlots = ordered(existing.payload.slots, (slot) => slot.slotOrder);
  const incomingSlots = ordered(incoming.payload.slots, (slot) => slot.slotOrder);
  requireSameOrders(existingParagraphs, incomingParagraphs, "CTW paragraph");
  requireSameOrders(existingSlots, incomingSlots, "CTW slot");
  const paragraphIds = new Map(incomingParagraphs.map((paragraph) => [
    paragraph.paragraphId,
    requiredByOrder(existingParagraphs, paragraph.paragraphOrder, "canonical CTW paragraph").paragraphId
  ]));
  const slotIds = new Map(incomingSlots.map((slot) => [
    slot.slotId,
    requiredByOrder(existingSlots, slot.slotOrder, "canonical CTW slot").slotId
  ]));
  return {
    paragraphs: incomingParagraphs.map((paragraph) => ({
      ...paragraph,
      paragraphId: requiredMap(paragraphIds, paragraph.paragraphId, "canonical CTW paragraph"),
      segments: paragraph.segments.map((segment) => segment.kind === "text"
        ? segment
        : { ...segment, slotId: requiredMap(slotIds, segment.slotId, "canonical CTW slot") })
    })),
    slots: incomingSlots.map((slot) => ({
      ...slot,
      slotId: requiredMap(slotIds, slot.slotId, "canonical CTW slot"),
      paragraphId: requiredMap(paragraphIds, slot.paragraphId, "canonical CTW paragraph")
    }))
  };
}

function remapOptions(
  existingOptions: Array<{ optionId: string; optionOrder: number; text: string }>,
  incomingOptions: Array<{ optionId: string; optionOrder: number; text: string }>,
  incomingCorrectOptionId: string,
  questionId: string
) {
  const canonical = ordered(existingOptions, (option) => option.optionOrder);
  const source = ordered(incomingOptions, (option) => option.optionOrder);
  if (canonical.length > 0) requireSameOrders(canonical, source, "question option");
  const correctOrder = source.find((option) => option.optionId === incomingCorrectOptionId)?.optionOrder;
  if (!correctOrder) throw new Error(`Reading canonical correction cannot resolve correct option for ${questionId}`);
  const options = source.map((option, index) => ({
    ...option,
    optionId: canonical[index]?.optionId ?? `${questionId}-opt-${option.optionOrder}`
  }));
  const correctOptionId = options.find((option) => option.optionOrder === correctOrder)?.optionId;
  if (!correctOptionId) throw new Error(`Reading canonical correction cannot map correct option for ${questionId}`);
  return { options, correctOptionId };
}

function remapHighlights(ranges: ReadingPassageHighlightRange[], paragraphIds: Map<string, string>) {
  return ranges.map((range) => ({
    ...range,
    paragraphId: requiredMap(paragraphIds, range.paragraphId, "canonical highlight paragraph")
  }));
}

function ordered<T>(values: T[], order: (value: T) => number) {
  return [...values].sort((left, right) => order(left) - order(right));
}

function requireSameOrders<T>(left: T[], right: T[], label: string) {
  if (left.length !== right.length) {
    throw new Error(`Reading canonical correction cannot safely map a different ${label} count`);
  }
}

function requiredByOrder<T>(values: T[], order: number, label: string): T {
  const value = values.find((candidate) => Number((candidate as { paragraphOrder?: number; sentenceOrder?: number; slotOrder?: number }).paragraphOrder
    ?? (candidate as { sentenceOrder?: number }).sentenceOrder
    ?? (candidate as { slotOrder?: number }).slotOrder) === order);
  if (!value) throw new Error(`Reading canonical correction cannot resolve ${label} order ${order}`);
  return value;
}

function requiredMap<K, V>(values: Map<K, V>, key: K, label: string): V {
  const value = values.get(key);
  if (!value) throw new Error(`Reading canonical correction cannot resolve ${label} ${String(key)}`);
  return value;
}

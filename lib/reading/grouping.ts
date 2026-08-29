import { createHash } from "node:crypto";
import type {
  CtwQuestion,
  ReadingImportPackage,
  ReadingLogicalItem,
  ReadingModule,
  ReadingPassage,
  ReadingQuestion,
  ReadingSourceOccurrence,
  ReadingSourceOccurrenceCandidate,
  ReadingSourceQuestion
} from "./types.ts";

type DedupReport = {
  schemaVersion: 1;
  rawOccurrenceCounts: Record<ReadingModule, number>;
  logicalItemCounts: Record<ReadingModule, number>;
  exactDuplicateGroups: Array<{
    logicalItemId: string;
    module: ReadingModule;
    title: string | null;
    occurrences: string[];
  }>;
  possibleDuplicates: Array<{
    module: ReadingModule;
    reason: string;
    sourceOccurrences: string[];
  }>;
};

export type ReadingGroupingResult = {
  packages: ReadingImportPackage[];
  report: DedupReport;
};

const sourceLabelCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

export function groupReadingSourceOccurrences(
  candidates: ReadingSourceOccurrenceCandidate[]
): ReadingGroupingResult {
  const exactGroups = new Map<string, ReadingSourceOccurrenceCandidate[]>();
  const possibleGroups = new Map<string, Array<{ fingerprint: string; candidate: ReadingSourceOccurrenceCandidate }>>();

  for (const candidate of candidates) {
    assertSourceCandidate(candidate);
    const fingerprint = fingerprintReadingSourceOccurrence(candidate);
    const exactKey = `${candidate.module}:${fingerprint}`;
    exactGroups.set(exactKey, [...(exactGroups.get(exactKey) ?? []), candidate]);
    const possibleKey = possibleDuplicateKey(candidate);
    possibleGroups.set(possibleKey, [
      ...(possibleGroups.get(possibleKey) ?? []),
      { fingerprint, candidate }
    ]);
  }

  const packages = Array.from(exactGroups.entries()).map(([exactKey, grouped]) => {
    const fingerprint = exactKey.slice(exactKey.indexOf(":") + 1);
    const ordered = [...grouped].sort(compareSourceCandidates);
    return buildLogicalPackage(ordered, fingerprint);
  }).sort((left, right) => compareLogicalItems(left.item, right.item));

  const exactDuplicateGroups = packages
    .filter((item) => item.occurrences.length > 1)
    .map((item) => ({
      logicalItemId: item.item.logicalItemId,
      module: item.item.module,
      title: item.item.title,
      occurrences: item.occurrences.map((occurrence) => occurrence.sourceLabel)
    }));

  const possibleDuplicates = Array.from(possibleGroups.values()).flatMap((group) => {
    const fingerprints = new Set(group.map((item) => item.fingerprint));
    if (fingerprints.size < 2) return [];
    return [{
      module: group[0].candidate.module,
      reason: possibleDuplicateReason(group[0].candidate.module),
      sourceOccurrences: group
        .map((item) => item.candidate.source.sourceLabel)
        .sort((left, right) => sourceLabelCollator.compare(left, right))
    }];
  });

  return {
    packages,
    report: {
      schemaVersion: 1,
      rawOccurrenceCounts: countByModule(candidates.map((candidate) => candidate.module)),
      logicalItemCounts: countByModule(packages.map((item) => item.item.module)),
      exactDuplicateGroups,
      possibleDuplicates
    }
  };
}

export function computeReadingDisplayRanks(items: ReadingLogicalItem[]) {
  const result = new Map<string, { rank: number; label: string }>();
  for (const readingModule of ["ctw", "rdl", "rap"] as const) {
    const ordered = items.filter((item) => item.module === readingModule).sort(compareLogicalItems);
    ordered.forEach((item, index) => {
      const rank = index + 1;
      result.set(item.logicalItemId, {
        rank,
        label: `${readingModule === "ctw" ? "套题" : "题目"}${String(rank).padStart(3, "0")}`
      });
    });
  }
  return result;
}

export function compareLogicalItems(left: ReadingLogicalItem, right: ReadingLogicalItem) {
  return left.firstSeenDate.localeCompare(right.firstSeenDate)
    || sourceLabelCollator.compare(left.firstSeenSourceLabel, right.firstSeenSourceLabel)
    || left.firstSeenSourceOrder - right.firstSeenSourceOrder
    || left.logicalItemId.localeCompare(right.logicalItemId);
}

function buildLogicalPackage(
  candidates: ReadingSourceOccurrenceCandidate[],
  fingerprint: string
): ReadingImportPackage {
  const canonical = candidates[0];
  const logicalItemId = `reading-${canonical.module}-${fingerprint.slice(0, 24)}`;
  const remapped = remapCanonicalContent(canonical, logicalItemId);
  const occurrences = candidates.map((candidate) => buildOccurrence(candidate, logicalItemId, remapped.questions));
  const scoredItemCount = remapped.questions.reduce(
    (count, question) => count + (question.questionType === "ctw" ? question.payload.slots.length : 1),
    0
  );
  return {
    schemaVersion: 2,
    item: {
      logicalItemId,
      module: canonical.module,
      title: canonical.module === "ctw" ? null : canonical.title,
      firstSeenDate: canonical.source.occurrenceDate,
      firstSeenSourceLabel: canonical.source.sourceLabel,
      firstSeenSourceOrder: canonical.source.sourceOrder,
      dedupFingerprint: fingerprint,
      questionCount: remapped.questions.length,
      scoredItemCount,
      isActive: false
    },
    occurrences,
    materials: remapped.materials,
    passages: remapped.passages,
    questions: remapped.questions
  };
}

function buildOccurrence(
  candidate: ReadingSourceOccurrenceCandidate,
  logicalItemId: string,
  logicalQuestions: ReadingQuestion[]
): ReadingSourceOccurrence {
  const sourceQuestions = [...candidate.questions].sort((left, right) => left.questionOrder - right.questionOrder);
  if (sourceQuestions.length !== logicalQuestions.length) {
    throw new Error(`source occurrence ${candidate.sourceOccurrenceId} question count differs from its logical item`);
  }
  return {
    occurrenceId: candidate.sourceOccurrenceId,
    logicalItemId,
    ...candidate.source,
    questionSources: logicalQuestions.map((question, index) => ({
      questionId: question.questionId,
      sourceQuestionStart: sourceQuestions[index].sourceQuestionStart,
      sourceQuestionEnd: sourceQuestions[index].sourceQuestionEnd
    }))
  };
}

function remapCanonicalContent(candidate: ReadingSourceOccurrenceCandidate, logicalItemId: string) {
  const sourceQuestions = [...candidate.questions].sort((left, right) => left.questionOrder - right.questionOrder);
  const passageMap = new Map<string, ReadingPassage>();
  const paragraphIds = new Map<string, string>();
  const sentenceIds = new Map<string, string>();
  const passages = candidate.passages.map((sourcePassage, passageIndex) => {
    const passageId = `${logicalItemId}-passage-${String(passageIndex + 1).padStart(2, "0")}`;
    const passage: ReadingPassage = {
      passageId,
      logicalItemId,
      title: sourcePassage.title,
      paragraphs: sourcePassage.paragraphs.map((sourceParagraph, paragraphIndex) => {
        const paragraphId = `${passageId}-p${String(paragraphIndex + 1).padStart(2, "0")}`;
        paragraphIds.set(sourceParagraph.paragraphId, paragraphId);
        return {
          paragraphId,
          paragraphOrder: paragraphIndex + 1,
          text: sourceParagraph.text,
          rawText: sourceParagraph.rawText,
          sentences: sourceParagraph.sentences.map((sourceSentence, sentenceIndex) => {
            const sentenceId = `${paragraphId}-s${String(sentenceIndex + 1).padStart(2, "0")}`;
            sentenceIds.set(sourceSentence.sentenceId, sentenceId);
            return { sentenceId, sentenceOrder: sentenceIndex + 1, text: sourceSentence.text };
          })
        };
      })
    };
    passageMap.set(sourcePassage.passageId, passage);
    return passage;
  });

  const questions = sourceQuestions.map((sourceQuestion, questionIndex): ReadingQuestion => {
    const questionId = `${logicalItemId}-q${String(questionIndex + 1).padStart(2, "0")}`;
    const base = {
      questionId,
      logicalItemId,
      questionOrder: questionIndex + 1,
      questionType: sourceQuestion.questionType,
      stem: sourceQuestion.stem,
      rawDisplayText: sourceQuestion.rawDisplayText
    };
    switch (sourceQuestion.questionType) {
      case "ctw": {
        const ctwParagraphIds = new Map<string, string>();
        const slotIds = new Map<string, string>();
        sourceQuestion.payload.slots.forEach((slot, index) => {
          slotIds.set(slot.slotId, `${questionId}-slot-${String(index + 1).padStart(2, "0")}`);
        });
        const paragraphs = sourceQuestion.payload.paragraphs.map((paragraph, index) => {
          const paragraphId = `${questionId}-p${String(index + 1).padStart(2, "0")}`;
          ctwParagraphIds.set(paragraph.paragraphId, paragraphId);
          return {
            paragraphId,
            paragraphOrder: index + 1,
            rawText: paragraph.rawText,
            segments: paragraph.segments.map((segment) => segment.kind === "text"
              ? { kind: "text" as const, text: segment.text }
              : { kind: "blank" as const, slotId: requiredMap(slotIds, segment.slotId) })
          };
        });
        const slots = sourceQuestion.payload.slots.map((slot, index) => ({
          slotId: requiredMap(slotIds, slot.slotId),
          slotOrder: index + 1,
          paragraphId: requiredMap(ctwParagraphIds, slot.paragraphId),
          answer: slot.answer,
          prefix: slot.prefix,
          displayText: slot.displayText,
          missingText: slot.missingText,
          missingLength: slot.missingLength
        }));
        return { ...base, questionType: "ctw", payload: { paragraphs, slots } } as CtwQuestion;
      }
      case "rdl":
        return {
          ...base,
          questionType: "rdl",
          payload: {
            materialId: sourceQuestion.payload.materialId,
            ...remapOptions(sourceQuestion.payload, questionId)
          }
        };
      case "rap_multiple_choice":
        return {
          ...base,
          questionType: "rap_multiple_choice",
          payload: {
            passageId: requiredMap(passageMap, sourceQuestion.payload.passageId).passageId,
            highlightRanges: remapHighlightRanges(sourceQuestion.payload.highlightRanges, paragraphIds),
            ...remapOptions(sourceQuestion.payload, questionId)
          }
        };
      case "rap_sentence_insertion": {
        const anchors = sourceQuestion.payload.anchors.map((anchor, index) => ({
          anchorId: `${questionId}-anchor-${index + 1}`,
          anchorOrder: index + 1,
          paragraphId: requiredMap(paragraphIds, anchor.paragraphId),
          boundaryIndex: anchor.boundaryIndex,
          afterSentenceId: anchor.afterSentenceId === null ? null : requiredMap(sentenceIds, anchor.afterSentenceId)
        }));
        const correctOrder = sourceQuestion.payload.anchors.findIndex(
          (anchor) => anchor.anchorId === sourceQuestion.payload.correctAnchorId
        );
        if (correctOrder < 0) throw new Error(`invalid insertion answer in ${candidate.sourceOccurrenceId}`);
        return {
          ...base,
          questionType: "rap_sentence_insertion",
          payload: {
            passageId: requiredMap(passageMap, sourceQuestion.payload.passageId).passageId,
            highlightRanges: remapHighlightRanges(sourceQuestion.payload.highlightRanges, paragraphIds),
            insertSentence: sourceQuestion.payload.insertSentence,
            anchors,
            correctAnchorId: anchors[correctOrder].anchorId
          }
        };
      }
      case "rap_sentence_selection":
        return {
          ...base,
          questionType: "rap_sentence_selection",
          payload: {
            passageId: requiredMap(passageMap, sourceQuestion.payload.passageId).passageId,
            highlightRanges: remapHighlightRanges(sourceQuestion.payload.highlightRanges, paragraphIds),
            targetParagraphId: requiredMap(paragraphIds, sourceQuestion.payload.targetParagraphId),
            correctSentenceId: requiredMap(sentenceIds, sourceQuestion.payload.correctSentenceId)
          }
        };
    }
  });
  return { materials: candidate.materials, passages, questions };
}

function remapHighlightRanges(
  ranges: Array<{ paragraphId: string; startOffset: number; endOffset: number }> | undefined,
  paragraphIds: Map<string, string>
) {
  return (ranges ?? []).map((range) => ({
    paragraphId: requiredMap(paragraphIds, range.paragraphId),
    startOffset: range.startOffset,
    endOffset: range.endOffset
  }));
}

function remapOptions(
  payload: { options: Array<{ optionId: string; optionOrder: number; text: string }>; correctOptionId: string },
  questionId: string
) {
  const ordered = [...payload.options].sort((left, right) => left.optionOrder - right.optionOrder);
  const correctIndex = ordered.findIndex((option) => option.optionId === payload.correctOptionId);
  if (correctIndex < 0) throw new Error(`correct option missing for ${questionId}`);
  const options = ordered.map((option, index) => ({
    optionId: `${questionId}-opt-${index + 1}`,
    optionOrder: index + 1,
    text: option.text
  }));
  return { options, correctOptionId: options[correctIndex].optionId };
}

export function fingerprintReadingSourceOccurrence(candidate: ReadingSourceOccurrenceCandidate) {
  return sha256(stableStringify(exactIdentity(candidate)));
}

function exactIdentity(candidate: ReadingSourceOccurrenceCandidate) {
  const passageById = new Map(candidate.passages.map((passage) => [passage.passageId, passage]));
  return {
    module: candidate.module,
    ...(candidate.module === "rdl" ? { materialIds: candidate.materials.map((item) => item.materialId).sort() } : {}),
    passages: candidate.passages.map((passage) => ({
      title: normalizedText(passage.title),
      paragraphs: passage.paragraphs.map((paragraph) => ({
        text: normalizedText(paragraph.text),
        rawText: normalizedText(paragraph.rawText),
        sentences: paragraph.sentences.map((sentence) => normalizedText(sentence.text))
      }))
    })),
    questions: [...candidate.questions]
      .sort((left, right) => left.questionOrder - right.questionOrder)
      .map((question) => canonicalQuestion(question, passageById))
  };
}

function canonicalQuestion(
  question: ReadingSourceQuestion,
  passageById: Map<string, Omit<ReadingPassage, "logicalItemId">>
): unknown {
  const common = {
    type: question.questionType,
    stem: normalizedText(question.stem)
  };
  if (question.questionType === "ctw") {
    const slotOrder = new Map(question.payload.slots.map((slot) => [slot.slotId, slot.slotOrder]));
    const paragraphOrder = new Map(question.payload.paragraphs.map((paragraph) => [paragraph.paragraphId, paragraph.paragraphOrder]));
    return {
      ...common,
      paragraphs: question.payload.paragraphs.map((paragraph) => ({
        rawText: normalizedText(paragraph.rawText),
        segments: paragraph.segments.map((segment) => segment.kind === "text"
          ? { kind: "text", text: normalizedText(segment.text) }
          : { kind: "blank", slotOrder: requiredMap(slotOrder, segment.slotId) })
      })),
      slots: question.payload.slots.map((slot) => ({
        paragraphOrder: requiredMap(paragraphOrder, slot.paragraphId),
        answer: normalizedText(slot.answer),
        prefix: normalizedText(slot.prefix),
        displayText: normalizedText(slot.displayText),
        missingText: normalizedText(slot.missingText),
        missingLength: slot.missingLength
      }))
    };
  }
  if (question.questionType === "rdl" || question.questionType === "rap_multiple_choice") {
    const ordered = [...question.payload.options].sort((left, right) => left.optionOrder - right.optionOrder);
    return {
      ...common,
      options: ordered.map((option) => normalizedText(option.text)),
      correctOptionOrder: ordered.findIndex((option) => option.optionId === question.payload.correctOptionId) + 1
    };
  }
  const passage = requiredMap(passageById, question.payload.passageId);
  const paragraphs = new Map(passage.paragraphs.map((paragraph) => [paragraph.paragraphId, paragraph]));
  if (question.questionType === "rap_sentence_insertion") {
    const ordered = [...question.payload.anchors].sort((left, right) => left.anchorOrder - right.anchorOrder);
    return {
      ...common,
      insertSentence: normalizedText(question.payload.insertSentence),
      anchors: ordered.map((anchor) => ({
        paragraphOrder: requiredMap(paragraphs, anchor.paragraphId).paragraphOrder,
        boundaryIndex: anchor.boundaryIndex
      })),
      correctAnchorOrder: ordered.findIndex((anchor) => anchor.anchorId === question.payload.correctAnchorId) + 1
    };
  }
  const target = requiredMap(paragraphs, question.payload.targetParagraphId);
  return {
    ...common,
    targetParagraphOrder: target.paragraphOrder,
    correctSentenceOrder: requiredMap(
      new Map(target.sentences.map((sentence) => [sentence.sentenceId, sentence.sentenceOrder])),
      question.payload.correctSentenceId
    )
  };
}

function possibleDuplicateKey(candidate: ReadingSourceOccurrenceCandidate) {
  if (candidate.module === "rdl") {
    return `rdl:${candidate.materials.map((material) => material.materialId).sort().join(",")}`;
  }
  if (candidate.module === "rap") {
    return `rap:${sha256(stableStringify(candidate.passages.map((passage) => ({
      title: normalizedText(passage.title),
      paragraphs: passage.paragraphs.map((paragraph) => normalizedText(paragraph.text))
    }))))}`;
  }
  const ctw = candidate.questions[0];
  return `ctw:${sha256(stableStringify(ctw?.questionType === "ctw"
    ? ctw.payload.paragraphs.map((paragraph) => normalizedText(paragraph.rawText))
    : []))}`;
}

function possibleDuplicateReason(module: ReadingModule) {
  if (module === "rdl") return "same canonical material, but the complete question group differs";
  if (module === "rap") return "same passage, but the complete question group differs";
  return "same CTW source passage, but blank interaction or answers differ";
}

function compareSourceCandidates(left: ReadingSourceOccurrenceCandidate, right: ReadingSourceOccurrenceCandidate) {
  return left.source.occurrenceDate.localeCompare(right.source.occurrenceDate)
    || sourceLabelCollator.compare(left.source.sourceLabel, right.source.sourceLabel)
    || left.source.sourceOrder - right.source.sourceOrder
    || left.sourceOccurrenceId.localeCompare(right.sourceOccurrenceId);
}

function normalizedText(value: string) {
  return value.normalize("NFC").replace(/\r\n?/g, "\n").trim();
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function requiredMap<K, V>(map: Map<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`missing source reference ${String(key)}`);
  return value;
}

function countByModule(modules: ReadingModule[]): Record<ReadingModule, number> {
  return {
    ctw: modules.filter((module) => module === "ctw").length,
    rdl: modules.filter((module) => module === "rdl").length,
    rap: modules.filter((module) => module === "rap").length
  };
}

function assertSourceCandidate(candidate: ReadingSourceOccurrenceCandidate) {
  if (!candidate.sourceOccurrenceId || !candidate.source.sourceLabel) throw new Error("source occurrence identity is required");
  if (candidate.questions.length === 0) throw new Error(`${candidate.sourceOccurrenceId} has no questions`);
  if (candidate.module === "ctw" && (candidate.questions.length !== 1 || candidate.questions[0].questionType !== "ctw")) {
    throw new Error(`${candidate.sourceOccurrenceId} is not one complete CTW item`);
  }
  if (candidate.module === "rdl" && (candidate.materials.length !== 1 || candidate.questions.some((item) => item.questionType !== "rdl"))) {
    throw new Error(`${candidate.sourceOccurrenceId} is not one complete RDL material/question group`);
  }
  if (candidate.module === "rap" && (candidate.passages.length !== 1 || candidate.questions.some((item) => !item.questionType.startsWith("rap_")))) {
    throw new Error(`${candidate.sourceOccurrenceId} is not one complete RAP passage/question group`);
  }
}

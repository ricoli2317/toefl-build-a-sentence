import { isVirtualPracticeSetId } from "./studentNavigation.ts";

export type TeacherLogicalQuestionItemRow = {
  item_id: string;
  task_type: string;
  display_number: string | null;
  is_active: boolean;
};

export type TeacherLogicalQuestionSourceRow = {
  source_id: string;
  item_id: string;
  task_type: string;
  source_set_id: string | null;
  is_canonical: boolean;
};

export type TeacherLogicalQuestionMapRow = {
  source_id: string;
  source_question_id: string;
  source_question_order: number;
  logical_question_order: number;
};

export type TeacherLogicalQuestionRawRow = {
  question_id: string;
  set_id: string;
  set_title: string | null;
  question_order: number | null;
  prompt: string | null;
  sentence_template: string | null;
  options_text: string | null;
  correct_order_text: string | null;
  final_sentence: string | null;
};

export type TeacherLogicalQuestionAttemptRow = {
  attempt_id: string;
  student_id: string;
  set_id: string;
};

export type TeacherLogicalQuestionAnswerRow = {
  attempt_answer_id: string;
  attempt_id: string;
  question_id: string;
  student_id: string;
  set_id: string;
  submitted_order_text: string | null;
  is_correct: boolean | null;
  question_time_seconds: number | null;
};

export type TeacherLogicalSourceQuestion = {
  sourceId: string;
  sourceSetId: string;
  sourceQuestionId: string;
  sourceQuestionOrder: number;
};

export type TeacherLogicalRepresentativeQuestion = TeacherLogicalSourceQuestion & {
  setTitle: string;
  prompt: string;
  sentenceTemplate: string;
  optionsText: string;
  correctOrderText: string;
  finalSentence: string;
};

export type TeacherLogicalQuestionSummary = {
  logicalQuestionId: string;
  itemId: string;
  logicalQuestionOrder: number;
  representativeQuestion: TeacherLogicalRepresentativeQuestion | null;
  sourceQuestions: TeacherLogicalSourceQuestion[];
  attemptAnswerIds: string[];
  answerCount: number;
  correctCount: number;
  incorrectCount: number;
  accuracy: number;
};

export type TeacherLogicalItemQuestionStats = {
  itemId: string;
  displayNumber: string;
  isActive: boolean;
  questions: TeacherLogicalQuestionSummary[];
};

export type TeacherLogicalMappedAnswer = {
  itemId: string;
  logicalQuestionOrder: number;
  attemptAnswerId: string;
  attemptId: string;
  studentId: string;
  rawSetId: string;
  rawQuestionId: string;
  submittedOrderText: string;
  isCorrect: boolean;
  questionTimeSeconds: number | null;
};

export type TeacherLogicalQuestionWarning = {
  code:
    | "CANONICAL_SOURCE_COUNT"
    | "CANONICAL_LOGICAL_ORDER_MISSING"
    | "CANONICAL_LOGICAL_ORDER_DUPLICATE"
    | "CANONICAL_QUESTION_NOT_FOUND"
    | "INVALID_LOGICAL_ORDER"
    | "DUPLICATE_SOURCE_QUESTION_MAP"
    | "SOURCE_QUESTION_NOT_FOUND"
    | "ANSWER_MAP_NOT_FOUND";
  itemId: string;
  sourceId: string | null;
  questionId: string | null;
  logicalQuestionOrder: number | null;
  message: string;
};

export function buildTeacherLogicalQuestionStats(input: {
  items: TeacherLogicalQuestionItemRow[];
  sources: TeacherLogicalQuestionSourceRow[];
  questionMaps: TeacherLogicalQuestionMapRow[];
  questions: TeacherLogicalQuestionRawRow[];
  attempts: TeacherLogicalQuestionAttemptRow[];
  answers: TeacherLogicalQuestionAnswerRow[];
}): {
  items: TeacherLogicalItemQuestionStats[];
  mappedAnswers: TeacherLogicalMappedAnswer[];
  warnings: TeacherLogicalQuestionWarning[];
} {
  const warnings: TeacherLogicalQuestionWarning[] = [];
  const basItems = new Map(
    input.items
      .filter((item) => item.task_type === "build_sentence")
      .map((item) => [item.item_id, item])
  );
  const sourcesByItem = new Map<string, TeacherLogicalQuestionSourceRow[]>();
  const sourceBySetId = new Map<string, TeacherLogicalQuestionSourceRow>();
  const sourceById = new Map<string, TeacherLogicalQuestionSourceRow>();

  for (const source of input.sources) {
    const setId = source.source_set_id?.trim() ?? "";
    if (
      source.task_type !== "build_sentence" ||
      !basItems.has(source.item_id) ||
      !setId ||
      isVirtualPracticeSetId(setId)
    ) {
      continue;
    }
    const normalized = { ...source, source_set_id: setId };
    sourcesByItem.set(source.item_id, [...(sourcesByItem.get(source.item_id) ?? []), normalized]);
    sourceBySetId.set(setId, normalized);
    sourceById.set(source.source_id, normalized);
  }

  const questionById = new Map(input.questions.map((question) => [question.question_id, question]));
  const mapsBySource = groupBy(
    input.questionMaps.filter((mapping) => sourceById.has(mapping.source_id)),
    (mapping) => mapping.source_id
  );
  const mapsBySourceQuestion = groupBy(
    input.questionMaps.filter((mapping) => sourceById.has(mapping.source_id)),
    (mapping) => sourceQuestionKey(mapping.source_id, mapping.source_question_id)
  );
  const sourceQuestionsByLogical = new Map<string, TeacherLogicalSourceQuestion[]>();

  for (const mapping of input.questionMaps) {
    const source = sourceById.get(mapping.source_id);
    if (!source || !source.source_set_id) continue;
    const logicalOrder = Number(mapping.logical_question_order);
    if (!isLogicalOrder(logicalOrder)) {
      warnings.push(makeWarning(
        "INVALID_LOGICAL_ORDER",
        source.item_id,
        source.source_id,
        mapping.source_question_id,
        Number.isFinite(logicalOrder) ? logicalOrder : null,
        `Source question maps to invalid logical order ${mapping.logical_question_order}.`
      ));
      continue;
    }
    const rawQuestion = questionById.get(mapping.source_question_id);
    if (!rawQuestion || rawQuestion.set_id !== source.source_set_id) {
      warnings.push(makeWarning(
        "SOURCE_QUESTION_NOT_FOUND",
        source.item_id,
        source.source_id,
        mapping.source_question_id,
        logicalOrder,
        "Mapped source question is missing from its exact raw set."
      ));
    }
    const key = logicalQuestionKey(source.item_id, logicalOrder);
    sourceQuestionsByLogical.set(key, [
      ...(sourceQuestionsByLogical.get(key) ?? []),
      {
        sourceId: source.source_id,
        sourceSetId: source.source_set_id,
        sourceQuestionId: mapping.source_question_id,
        sourceQuestionOrder: Number(mapping.source_question_order)
      }
    ]);
  }

  const attemptById = new Map(input.attempts.map((attempt) => [attempt.attempt_id, attempt]));
  const mappedAnswers: TeacherLogicalMappedAnswer[] = [];
  for (const answer of input.answers) {
    const attempt = attemptById.get(answer.attempt_id);
    if (!attempt || isVirtualPracticeSetId(attempt.set_id)) continue;
    const source = sourceBySetId.get(attempt.set_id);
    if (!source) continue;
    const mappings = mapsBySourceQuestion.get(
      sourceQuestionKey(source.source_id, answer.question_id)
    ) ?? [];
    if (mappings.length !== 1) {
      warnings.push(makeWarning(
        mappings.length > 1 ? "DUPLICATE_SOURCE_QUESTION_MAP" : "ANSWER_MAP_NOT_FOUND",
        source.item_id,
        source.source_id,
        answer.question_id,
        null,
        mappings.length > 1
          ? "Historical answer has multiple logical question mappings."
          : "Historical answer has no logical question mapping."
      ));
      continue;
    }
    const logicalOrder = Number(mappings[0].logical_question_order);
    if (!isLogicalOrder(logicalOrder)) continue;
    mappedAnswers.push({
      itemId: source.item_id,
      logicalQuestionOrder: logicalOrder,
      attemptAnswerId: answer.attempt_answer_id,
      attemptId: answer.attempt_id,
      studentId: answer.student_id,
      rawSetId: attempt.set_id,
      rawQuestionId: answer.question_id,
      submittedOrderText: answer.submitted_order_text ?? "",
      isCorrect: Boolean(answer.is_correct),
      questionTimeSeconds: answer.question_time_seconds
    });
  }
  const answersByLogical = groupBy(
    mappedAnswers,
    (answer) => logicalQuestionKey(answer.itemId, answer.logicalQuestionOrder)
  );

  const itemStats = Array.from(basItems.values()).flatMap((item): TeacherLogicalItemQuestionStats[] => {
    const sources = sourcesByItem.get(item.item_id) ?? [];
    if (sources.length === 0) return [];
    const canonicalSources = sources.filter((source) => source.is_canonical);
    if (canonicalSources.length !== 1) {
      warnings.push(makeWarning(
        "CANONICAL_SOURCE_COUNT",
        item.item_id,
        null,
        null,
        null,
        `Logical item has ${canonicalSources.length} canonical sources; expected exactly one.`
      ));
    }
    const canonical = canonicalSources.length === 1 ? canonicalSources[0] : null;
    const questions = Array.from({ length: 10 }, (_, index): TeacherLogicalQuestionSummary => {
      const logicalOrder = index + 1;
      const key = logicalQuestionKey(item.item_id, logicalOrder);
      const historicalAnswers = answersByLogical.get(key) ?? [];
      const correctCount = historicalAnswers.filter((answer) => answer.isCorrect).length;
      const representativeQuestion = canonical
        ? resolveRepresentativeQuestion({
            canonical,
            logicalOrder,
            mappings: mapsBySource.get(canonical.source_id) ?? [],
            questionById,
            warnings
          })
        : null;

      return {
        logicalQuestionId: key,
        itemId: item.item_id,
        logicalQuestionOrder: logicalOrder,
        representativeQuestion,
        sourceQuestions: (sourceQuestionsByLogical.get(key) ?? [])
          .sort((left, right) =>
            left.sourceSetId.localeCompare(right.sourceSetId) ||
            left.sourceQuestionId.localeCompare(right.sourceQuestionId)
          ),
        attemptAnswerIds: historicalAnswers.map((answer) => answer.attemptAnswerId),
        answerCount: historicalAnswers.length,
        correctCount,
        incorrectCount: historicalAnswers.length - correctCount,
        accuracy: historicalAnswers.length === 0 ? 0 : correctCount / historicalAnswers.length
      };
    });

    return [{
      itemId: item.item_id,
      displayNumber: item.display_number?.trim() ?? "",
      isActive: item.is_active,
      questions
    }];
  });

  return { items: itemStats, mappedAnswers, warnings };
}

function resolveRepresentativeQuestion(input: {
  canonical: TeacherLogicalQuestionSourceRow;
  logicalOrder: number;
  mappings: TeacherLogicalQuestionMapRow[];
  questionById: Map<string, TeacherLogicalQuestionRawRow>;
  warnings: TeacherLogicalQuestionWarning[];
}): TeacherLogicalRepresentativeQuestion | null {
  const matches = input.mappings.filter(
    (mapping) => Number(mapping.logical_question_order) === input.logicalOrder
  );
  if (matches.length !== 1) {
    input.warnings.push(makeWarning(
      matches.length === 0
        ? "CANONICAL_LOGICAL_ORDER_MISSING"
        : "CANONICAL_LOGICAL_ORDER_DUPLICATE",
      input.canonical.item_id,
      input.canonical.source_id,
      null,
      input.logicalOrder,
      matches.length === 0
        ? `Canonical source has no mapping for logical Q${input.logicalOrder}.`
        : `Canonical source has multiple mappings for logical Q${input.logicalOrder}.`
    ));
    return null;
  }
  const mapping = matches[0];
  const rawQuestion = input.questionById.get(mapping.source_question_id);
  if (!rawQuestion || rawQuestion.set_id !== input.canonical.source_set_id) {
    input.warnings.push(makeWarning(
      "CANONICAL_QUESTION_NOT_FOUND",
      input.canonical.item_id,
      input.canonical.source_id,
      mapping.source_question_id,
      input.logicalOrder,
      `Canonical raw question for logical Q${input.logicalOrder} is missing.`
    ));
    return null;
  }
  return {
    sourceId: input.canonical.source_id,
    sourceSetId: input.canonical.source_set_id!,
    sourceQuestionId: mapping.source_question_id,
    sourceQuestionOrder: Number(mapping.source_question_order),
    setTitle: rawQuestion.set_title ?? rawQuestion.set_id,
    prompt: rawQuestion.prompt ?? "",
    sentenceTemplate: rawQuestion.sentence_template ?? "",
    optionsText: rawQuestion.options_text ?? "",
    correctOrderText: rawQuestion.correct_order_text ?? "",
    finalSentence: rawQuestion.final_sentence ?? ""
  };
}

function logicalQuestionKey(itemId: string, logicalOrder: number) {
  return `${itemId}:${logicalOrder}`;
}

function sourceQuestionKey(sourceId: string, questionId: string) {
  return `${sourceId}:${questionId}`;
}

function isLogicalOrder(value: number) {
  return Number.isInteger(value) && value >= 1 && value <= 10;
}

function groupBy<T>(rows: T[], key: (row: T) => string) {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const groupKey = key(row);
    groups.set(groupKey, [...(groups.get(groupKey) ?? []), row]);
  }
  return groups;
}

function makeWarning(
  code: TeacherLogicalQuestionWarning["code"],
  itemId: string,
  sourceId: string | null,
  questionId: string | null,
  logicalQuestionOrder: number | null,
  message: string
): TeacherLogicalQuestionWarning {
  return { code, itemId, sourceId, questionId, logicalQuestionOrder, message };
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { mapWithConcurrency } from "../mapWithConcurrency.ts";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import {
  buildReadingFullSetWrongbookQueue,
  type ReadingFullSetWrongQuestionAnswer,
  type ReadingFullSetWrongQuestionAttempt,
  type ReadingFullSetWrongbookCorrectionAttempt,
  type ReadingFullSetWrongbookQueueItem
} from "@/lib/wrongQuestions";
import type { ReadingWrongbookPreservedAnswer } from "./wrongbook";

type AttemptRow = {
  attempt_id: string;
  completed_at: string;
  full_set_id: string;
};

type ModuleRow = {
  attempt_id: string;
  module_attempt_id: string;
  module_number: number;
};

type AnswerRow = {
  attempt_id?: string;
  is_correct: boolean;
  logical_item_id: string;
  module_attempt_id?: string;
  occurrence_id?: string;
  question_id: string;
  slot_id: string | null;
  source_occurrence_id?: string | null;
};

type OccurrenceRow = {
  occurrence_id: string;
  source_question_start: number;
};

type QuestionOrderRow = {
  module: "ctw" | "rdl" | "rap";
  question_id: string;
  question_order: number;
};

type CorrectionAttemptRow = {
  attempt_id: string;
  source_attempt_id: string;
  submitted_at: string;
};

export type ReadingFullSetWrongbookData = {
  fullSetAnswers: ReadingFullSetWrongQuestionAnswer[];
  fullSetAttempts: ReadingFullSetWrongQuestionAttempt[];
  fullSetCorrectionAnswers: ReadingFullSetWrongQuestionAnswer[];
  fullSetCorrectionAttempts: ReadingFullSetWrongbookCorrectionAttempt[];
};

export async function loadReadingFullSetWrongbookData(
  db: SupabaseClient,
  studentId: string,
  sourceAttemptId?: string | null
): Promise<ReadingFullSetWrongbookData> {
  const [attemptResult, correctionAttemptResult] = await Promise.all([
    readAllSupabaseRows<AttemptRow>((from, to) => {
      let query = db.from("reading_full_set_attempts")
        .select("attempt_id,full_set_id,completed_at")
        .eq("student_id", studentId)
        .eq("status", "completed");
      if (sourceAttemptId) query = query.eq("attempt_id", sourceAttemptId);
      return query.order("attempt_id", { ascending: true }).range(from, to);
    }),
    readAllSupabaseRows<CorrectionAttemptRow>((from, to) => {
      let query = db.from("reading_wrongbook_attempts")
        .select("attempt_id,source_attempt_id,submitted_at")
        .eq("student_id", studentId)
        .eq("task_type", "full_set")
        .eq("status", "submitted");
      if (sourceAttemptId) query = query.eq("source_attempt_id", sourceAttemptId);
      return query.order("attempt_id", { ascending: true }).range(from, to);
    })
  ]);
  const initialError = attemptResult.error ?? correctionAttemptResult.error;
  if (initialError) throw new Error(initialError.message);

  const attemptRows = attemptResult.data ?? [];
  const attemptIds = attemptRows.map((attempt) => attempt.attempt_id);
  const correctionRows = correctionAttemptResult.data ?? [];
  const [moduleResult, correctionAnswerResult] = await Promise.all([
    readByIds<ModuleRow>(db, "reading_full_set_module_attempts", "attempt_id,module_attempt_id,module_number", "attempt_id", attemptIds),
    readByIds<AnswerRow>(
      db,
      "reading_wrongbook_attempt_answers",
      "attempt_id,logical_item_id,question_id,slot_id,is_correct,source_occurrence_id",
      "attempt_id",
      correctionRows.map((attempt) => attempt.attempt_id)
    )
  ]);
  const middleError = moduleResult.error ?? correctionAnswerResult.error;
  if (middleError) throw new Error(middleError.message);
  const modules = moduleResult.data ?? [];
  const moduleIds = modules.map((module) => module.module_attempt_id);
  const answerResult = await readByIds<AnswerRow>(
    db,
    "reading_full_set_answers",
    "module_attempt_id,occurrence_id,logical_item_id,question_id,slot_id,is_correct",
    "module_attempt_id",
    moduleIds
  );
  if (answerResult.error) throw new Error(answerResult.error.message);

  const answers = answerResult.data ?? [];
  const questionIds = Array.from(new Set([
    ...answers.map((answer) => answer.question_id),
    ...(correctionAnswerResult.data ?? []).map((answer) => answer.question_id)
  ]));
  const occurrenceIds = Array.from(new Set(answers
    .map((answer) => answer.occurrence_id)
    .filter((value): value is string => Boolean(value))));
  const [questionResult, slotResult, occurrenceResult] = await Promise.all([
    readByIds<QuestionOrderRow>(
      db, "reading_questions", "question_id,question_order,module", "question_id", questionIds
    ),
    readByIds<{ question_id: string; slot_id: string; slot_order: number }>(
      db, "reading_ctw_slots", "question_id,slot_id,slot_order", "question_id", questionIds
    ),
    readByIds<OccurrenceRow>(
      db, "reading_source_occurrences", "occurrence_id,source_question_start", "occurrence_id", occurrenceIds
    )
  ]);
  const orderError = questionResult.error ?? slotResult.error ?? occurrenceResult.error;
  if (orderError) throw new Error(orderError.message);

  const occurrenceById = new Map((occurrenceResult.data ?? [])
    .map((occurrence) => [occurrence.occurrence_id, occurrence]));
  const moduleById = new Map(modules.map((moduleAttempt) => [moduleAttempt.module_attempt_id, moduleAttempt]));
  const questionOrder = new Map((questionResult.data ?? []).map((question) => [question.question_id, question.question_order]));
  const questionModule = new Map((questionResult.data ?? []).map((question) => [question.question_id, question.module]));
  const slotOrder = new Map((slotResult.data ?? []).map((slot) => [`${slot.question_id}:${slot.slot_id}`, slot.slot_order]));
  const sourceAnswerByKey = new Map<string, ReadingFullSetWrongQuestionAnswer>();

  const fullSetAnswers = answers.flatMap((answer): ReadingFullSetWrongQuestionAnswer[] => {
    const moduleAttempt = answer.module_attempt_id ? moduleById.get(answer.module_attempt_id) : undefined;
    const occurrence = answer.occurrence_id ? occurrenceById.get(answer.occurrence_id) : undefined;
    const taskType = questionModule.get(answer.question_id);
    if (!moduleAttempt || !occurrence || !taskType || (moduleAttempt.module_number !== 1 && moduleAttempt.module_number !== 2)) return [];
    const localOrder = answer.slot_id
      ? slotOrder.get(`${answer.question_id}:${answer.slot_id}`)
      : questionOrder.get(answer.question_id);
    if (!localOrder) return [];
    const normalized = {
      attemptId: moduleAttempt.attempt_id,
      isCorrect: Boolean(answer.is_correct),
      logicalItemId: answer.logical_item_id,
      moduleNumber: moduleAttempt.module_number,
      occurrenceId: answer.occurrence_id!,
      order: occurrence.source_question_start + localOrder - 1,
      questionId: answer.question_id,
      slotId: answer.slot_id,
      taskType
    } satisfies ReadingFullSetWrongQuestionAnswer;
    sourceAnswerByKey.set(sourceKey(moduleAttempt.attempt_id, normalized), normalized);
    return [normalized];
  });

  const correctionAttemptById = new Map(correctionRows.map((attempt) => [attempt.attempt_id, attempt]));
  const fullSetCorrectionAnswers = (correctionAnswerResult.data ?? []).flatMap((answer): ReadingFullSetWrongQuestionAnswer[] => {
    const correction = answer.attempt_id ? correctionAttemptById.get(answer.attempt_id) : undefined;
    const occurrenceId = answer.source_occurrence_id ?? "";
    if (!correction || !occurrenceId) return [];
    const source = sourceAnswerByKey.get(sourceKey(correction.source_attempt_id, {
      logicalItemId: answer.logical_item_id,
      occurrenceId,
      questionId: answer.question_id,
      slotId: answer.slot_id
    }));
    return source ? [{ ...source, attemptId: correction.attempt_id, isCorrect: Boolean(answer.is_correct) }] : [];
  });

  return {
    fullSetAnswers,
    fullSetAttempts: attemptRows.map((attempt): ReadingFullSetWrongQuestionAttempt => ({
        attemptId: attempt.attempt_id,
        completedAt: attempt.completed_at,
        fullSetId: attempt.full_set_id,
        title: attempt.full_set_id
      })),
    fullSetCorrectionAnswers,
    fullSetCorrectionAttempts: correctionRows.map((attempt) => ({
      attemptId: attempt.attempt_id,
      sourceAttemptId: attempt.source_attempt_id,
      submittedAt: attempt.submitted_at
    }))
  };
}

export async function loadReadingFullSetWrongbookQueue(input: {
  db: SupabaseClient;
  scope: "history" | "today";
  sourceAttemptId?: string | null;
  studentId: string;
  todayEnd: number;
  todayStart: number;
}): Promise<ReadingFullSetWrongbookQueueItem[]> {
  return buildReadingFullSetWrongbookQueue({
    ...(await loadReadingFullSetWrongbookData(input.db, input.studentId, input.sourceAttemptId)),
    scope: input.scope,
    sourceAttemptId: input.sourceAttemptId,
    todayEnd: input.todayEnd,
    todayStart: input.todayStart
  });
}

export async function loadReadingFullSetPreservedAnswers(input: {
  before?: string;
  db: SupabaseClient;
  excludeAttemptId?: string;
  sourceAttemptId: string;
  targets: ReadingFullSetWrongbookQueueItem["targets"];
}) {
  const ctwOccurrences = Array.from(new Set(input.targets
    .filter((target) => target.taskType === "ctw")
    .map((target) => target.occurrenceId)));
  if (!ctwOccurrences.length) return {} as Record<string, ReadingWrongbookPreservedAnswer[]>;
  const moduleResult = await input.db.from("reading_full_set_module_attempts")
    .select("module_attempt_id")
    .eq("attempt_id", input.sourceAttemptId);
  if (moduleResult.error) throw new Error(moduleResult.error.message);
  const moduleIds = (moduleResult.data ?? []).map((row) => row.module_attempt_id);
  if (!moduleIds.length) throw new Error("READING_FULL_SET_SOURCE_MODULES_MISSING");
  const answerResult = await input.db.from("reading_full_set_answers")
    .select("occurrence_id,question_id,slot_id,answer_kind,student_answer,is_correct")
    .in("module_attempt_id", moduleIds)
    .in("occurrence_id", ctwOccurrences)
    .eq("is_correct", true);
  if (answerResult.error) throw new Error(answerResult.error.message);
  let correctionAttemptQuery = input.db.from("reading_wrongbook_attempts")
    .select("attempt_id")
    .eq("source_attempt_id", input.sourceAttemptId)
    .eq("task_type", "full_set")
    .eq("status", "submitted");
  if (input.before) correctionAttemptQuery = correctionAttemptQuery.lte("submitted_at", input.before);
  if (input.excludeAttemptId) correctionAttemptQuery = correctionAttemptQuery.neq("attempt_id", input.excludeAttemptId);
  const correctionAttemptResult = await correctionAttemptQuery;
  if (correctionAttemptResult.error) throw new Error(correctionAttemptResult.error.message);
  const correctionAttemptIds = (correctionAttemptResult.data ?? []).map((row) => row.attempt_id);
  const correctionResult = correctionAttemptIds.length
    ? await input.db.from("reading_wrongbook_attempt_answers")
        .select("source_occurrence_id,question_id,slot_id,answer_kind,student_answer,is_correct")
        .in("attempt_id", correctionAttemptIds)
        .in("source_occurrence_id", ctwOccurrences)
        .eq("is_correct", true)
    : { data: [], error: null };
  if (correctionResult.error) throw new Error(correctionResult.error.message);
  const byOccurrence: Record<string, ReadingWrongbookPreservedAnswer[]> = {};
  for (const row of [
    ...(answerResult.data ?? []).map((answer) => ({ ...answer, source_occurrence_id: answer.occurrence_id })),
    ...(correctionResult.data ?? [])
  ]) {
    if (!row.slot_id || row.answer_kind !== "ctw_slot" || !row.student_answer?.trim()) continue;
    const occurrenceId = row.source_occurrence_id;
    if (!occurrenceId) continue;
    const next = {
      answerKind: "ctw_slot",
      isCorrect: true,
      questionId: row.question_id,
      slotId: row.slot_id,
      studentAnswer: row.student_answer.trim()
    } satisfies ReadingWrongbookPreservedAnswer;
    const current = byOccurrence[occurrenceId] ?? [];
    byOccurrence[occurrenceId] = [
      ...current.filter((answer) => answer.questionId !== next.questionId || answer.slotId !== next.slotId),
      next
    ];
  }
  return byOccurrence;
}

async function readByIds<T>(
  db: SupabaseClient,
  table: string,
  select: string,
  column: string,
  ids: string[]
) {
  if (!ids.length) return { data: [] as T[], error: null };
  const results = await mapWithConcurrency(chunk(ids), 4, (values) => readAllSupabaseRows<T>(async (from, to) => {
    const page = await db.from(table).select(select).in(column, values).range(from, to);
    return { data: page.data as T[] | null, error: page.error };
  }));
  return {
    data: results.flatMap((result) => result.data ?? []),
    error: results.find((result) => result.error)?.error ?? null
  };
}

function sourceKey(
  attemptId: string,
  target: Pick<ReadingFullSetWrongQuestionAnswer, "logicalItemId" | "occurrenceId" | "questionId" | "slotId">
) {
  return [attemptId, target.occurrenceId, target.logicalItemId, target.questionId, target.slotId ?? "question"].join(":");
}

function chunk<T>(values: T[], size = 100) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

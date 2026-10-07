import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { mapWithConcurrency } from "@/lib/mapWithConcurrency";
import {
  readingCorrectionEvents,
  readingWrongAnswerEvents,
  type WrongQuestionBankEvent
} from "@/lib/wrongQuestionBank";
import { applyStudentWrongQuestionEvents } from "@/lib/wrongQuestionBank.server";
import type { ReadingModule } from "./types";

type ReadingAnswerRow = {
  is_correct: boolean | null;
  logical_item_id: string | null;
  question_id: string;
  slot_id: string | null;
};

type ReadingModuleRow = {
  logical_item_id: string;
  module: ReadingModule;
};

/**
 * Formal Reading practice (ordinary CTW/RDL/RAP attempts) creates pending
 * wrong questions for the freshly submitted answers.
 */
export async function applyReadingAttemptWrongEvents(
  db: SupabaseClient,
  input: {
    attemptId: string;
    logicalItemId: string;
    practiceDate: string;
    studentId: string;
    taskType: ReadingModule;
  }
) {
  const answers = await readAnswers(db, "reading_attempt_answers", { attemptId: input.attemptId });
  await applyReadingGradedWrongEvents(db, {
    ...input,
    answers,
  });
}

/** Shared normal-practice event path: persisted ordinary attempts or authoritative partial grading. */
export async function applyReadingGradedWrongEvents(
  db: SupabaseClient,
  input: {
    studentId: string;
    practiceDate: string;
    logicalItemId: string;
    taskType: ReadingModule;
    answers: Array<{ questionId: string; slotId: string | null; isCorrect: boolean }>;
  }
) {
  await applyStudentWrongQuestionEvents(db, input.studentId, input.practiceDate, readingWrongAnswerEvents(input));
}

/**
 * Correction submissions clear pending state only for the clearing flows
 * (`today` practice and formal-result entry corrections). History practice is
 * excluded so it can never reduce today's pending list.
 */
export async function applyReadingCorrectionAttemptEvents(
  db: SupabaseClient,
  input: {
    appliesToPending: boolean;
    attemptId: string;
    practiceDate: string;
    studentId: string;
  }
) {
  const attemptResult = await readAllSupabaseRows<{
    logical_item_id: string | null;
    task_type: string;
  }>((from, to) => db.from("reading_wrongbook_attempts")
    .select("attempt_id,logical_item_id,task_type")
    .eq("attempt_id", input.attemptId)
    .eq("student_id", input.studentId)
    .order("attempt_id", { ascending: true })
    .range(from, to));
  if (attemptResult.error || (attemptResult.data ?? []).length === 0) return;
  const attempt = attemptResult.data![0];
  const answers = await readAnswers(db, "reading_wrongbook_attempt_answers", {
    attemptId: input.attemptId
  });

  if (attempt.logical_item_id) {
    await applyStudentWrongQuestionEvents(db, input.studentId, input.practiceDate, readingCorrectionEvents({
      answers,
      appliesToPending: input.appliesToPending,
      logicalItemId: String(attempt.logical_item_id),
      taskType: attempt.task_type as ReadingModule
    }));
    return;
  }

  // Full Set corrections carry one occurrence per answer; the canonical bank
  // identity intentionally drops the occurrence.
  const moduleByItem = await loadItemModules(db, answers
    .map((answer) => answer.logicalItemId)
    .filter((value): value is string => Boolean(value)));
  const events: WrongQuestionBankEvent[] = [];
  for (const answer of answers) {
    const moduleType = answer.logicalItemId ? moduleByItem.get(answer.logicalItemId) : null;
    if (!moduleType) continue;
    events.push(...readingCorrectionEvents({
      answers: [answer],
      appliesToPending: input.appliesToPending,
      logicalItemId: answer.logicalItemId!,
      taskType: moduleType
    }));
  }
  await applyStudentWrongQuestionEvents(db, input.studentId, input.practiceDate, events);
}

/**
 * Full Set module submission: every wrong answer of the module becomes pending
 * state for its own module (CTW / RDL / RAP).
 */
export async function applyFullSetModuleWrongEvents(
  db: SupabaseClient,
  input: { moduleAttemptId: string; practiceDate: string; studentId: string }
) {
  const answerResult = await readAllSupabaseRows<ReadingAnswerRow>((from, to) => db
    .from("reading_full_set_answers")
    .select("logical_item_id,question_id,slot_id,is_correct")
    .eq("module_attempt_id", input.moduleAttemptId)
    .order("answer_id", { ascending: true })
    .range(from, to));
  if (answerResult.error) return;
  const answers = answerResult.data ?? [];
  const moduleByItem = await loadItemModules(db, answers
    .map((answer) => answer.logical_item_id)
    .filter((value): value is string => Boolean(value)));
  const events: WrongQuestionBankEvent[] = [];
  for (const answer of answers) {
    // Correct only when explicitly scored correct; pending false / null rows
    // (unanswered Full Set answers) are wrong questions too.
    if (answer.is_correct === true || !answer.logical_item_id) continue;
    const moduleType = moduleByItem.get(answer.logical_item_id);
    if (!moduleType) continue;
    events.push(...readingWrongAnswerEvents({
      answers: [{ isCorrect: false, questionId: answer.question_id, slotId: answer.slot_id }],
      logicalItemId: answer.logical_item_id,
      taskType: moduleType
    }));
  }
  await applyStudentWrongQuestionEvents(db, input.studentId, input.practiceDate, events);
}

async function readAnswers(
  db: SupabaseClient,
  table: "reading_attempt_answers" | "reading_wrongbook_attempt_answers",
  input: { attemptId: string }
) {
  const result = await readAllSupabaseRows<ReadingAnswerRow>((from, to) => db.from(table)
    .select("logical_item_id,question_id,slot_id,is_correct")
    .eq("attempt_id", input.attemptId)
    .range(from, to));
  if (result.error) throw new Error(result.error.message);
  // A missing / unanswered scoring row is wrong too: `is_correct` is treated
  // as "correct only when explicitly true", so an unanswered slot can never be
  // dropped from the wrong-question candidate set.
  return (result.data ?? [])
    .map((answer) => ({
      isCorrect: answer.is_correct === true,
      logicalItemId: answer.logical_item_id ? String(answer.logical_item_id) : null,
      questionId: String(answer.question_id),
      slotId: answer.slot_id ? String(answer.slot_id) : null
    }));
}

async function loadItemModules(db: SupabaseClient, itemIds: string[]) {
  const unique = Array.from(new Set(itemIds));
  if (unique.length === 0) return new Map<string, ReadingModule>();
  const results = await mapWithConcurrency(chunkValues(unique, 100), 4, (batch) =>
    readAllSupabaseRows<ReadingModuleRow>((from, to) => db.from("reading_logical_items")
      .select("logical_item_id,module")
      .in("logical_item_id", batch)
      .order("logical_item_id", { ascending: true })
      .range(from, to))
  );
  const error = results.find((result) => result.error)?.error;
  if (error) throw new Error(error.message);
  return new Map(results.flatMap((result) => result.data ?? [])
    .map((row) => [String(row.logical_item_id), row.module]));
}

function chunkValues<T>(values: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import {
  buildReadingWrongbookQueue,
  type ReadingWrongQuestionAnswer,
  type ReadingWrongQuestionAttempt,
  type ReadingWrongbookCorrectionAttempt,
  type ReadingWrongbookQueueItem
} from "@/lib/wrongQuestions";
import { readingCatalogDisplayNumber } from "./catalog";
import type { ReadingModule } from "./types";

type ReadingAttemptRow = {
  attempt_id: string;
  logical_item_id: string;
  submitted_at: string;
  task_type: ReadingModule;
};

type ReadingAnswerRow = {
  attempt_id: string;
  is_correct: boolean;
  question_id: string;
  slot_id: string | null;
};

type ReadingCorrectionAttemptRow = ReadingAttemptRow & {
  scope: "history" | "today";
};

type ReadingItemRow = {
  first_seen_date: string;
  first_seen_source_label: string;
  first_seen_source_order: number;
  logical_item_id: string;
  module: ReadingModule;
  title: string | null;
};

export type ReadingWrongbookData = {
  readingAnswers: ReadingWrongQuestionAnswer[];
  readingAttempts: ReadingWrongQuestionAttempt[];
  readingCorrectionAnswers: ReadingWrongQuestionAnswer[];
  readingCorrectionAttempts: ReadingWrongbookCorrectionAttempt[];
  readingTitles: Map<string, string>;
};

export async function loadReadingWrongbookData(
  db: SupabaseClient,
  studentId: string
): Promise<ReadingWrongbookData> {
  const [attemptResult, correctionAttemptResult, itemResult] = await Promise.all([
    readAllSupabaseRows<ReadingAttemptRow>((from, to) =>
      db.from("reading_attempts")
        .select("attempt_id,logical_item_id,task_type,submitted_at")
        .eq("student_id", studentId)
        .eq("status", "submitted")
        .order("attempt_id", { ascending: true })
        .range(from, to)
    ),
    readAllSupabaseRows<ReadingCorrectionAttemptRow>((from, to) =>
      db.from("reading_wrongbook_attempts")
        .select("attempt_id,logical_item_id,task_type,scope,submitted_at")
        .eq("student_id", studentId)
        .eq("status", "submitted")
        .order("attempt_id", { ascending: true })
        .range(from, to)
    ),
    readAllSupabaseRows<ReadingItemRow>((from, to) =>
      db.from("reading_logical_items")
        .select("logical_item_id,module,title,first_seen_date,first_seen_source_label,first_seen_source_order")
        .order("logical_item_id", { ascending: true })
        .range(from, to)
    )
  ]);
  const firstError = attemptResult.error ?? correctionAttemptResult.error ?? itemResult.error;
  if (firstError) throw new Error(firstError.message);

  const readingAttempts = (attemptResult.data ?? []).map(normalizeAttempt);
  const readingCorrectionAttempts = (correctionAttemptResult.data ?? []).map((attempt) => ({
    ...normalizeAttempt(attempt),
    scope: attempt.scope
  }));
  const [answerResult, correctionAnswerResult] = await Promise.all([
    readAnswers(db, "reading_attempt_answers", readingAttempts.map((attempt) => attempt.attemptId)),
    readAnswers(
      db,
      "reading_wrongbook_attempt_answers",
      readingCorrectionAttempts.map((attempt) => attempt.attemptId)
    )
  ]);
  const answerError = answerResult.error ?? correctionAnswerResult.error;
  if (answerError) throw new Error(answerError.message);

  return {
    readingAnswers: (answerResult.data ?? []).map(normalizeAnswer),
    readingAttempts,
    readingCorrectionAnswers: (correctionAnswerResult.data ?? []).map(normalizeAnswer),
    readingCorrectionAttempts,
    readingTitles: buildReadingTitles(itemResult.data ?? [])
  };
}

export async function loadReadingWrongbookQueue(input: {
  db: SupabaseClient;
  itemId?: string | null;
  scope: "history" | "today";
  studentId: string;
  taskType: ReadingModule;
  todayEnd: number;
  todayStart: number;
}): Promise<ReadingWrongbookQueueItem[]> {
  const data = await loadReadingWrongbookData(input.db, input.studentId);
  const queue = buildReadingWrongbookQueue({
    ...data,
    scope: input.scope,
    taskType: input.taskType,
    todayEnd: input.todayEnd,
    todayStart: input.todayStart
  });
  return input.itemId
    ? queue.filter((item) => item.logicalItemId === input.itemId)
    : queue;
}

function normalizeAttempt(attempt: ReadingAttemptRow): ReadingWrongQuestionAttempt {
  return {
    attemptId: String(attempt.attempt_id),
    logicalItemId: String(attempt.logical_item_id),
    submittedAt: attempt.submitted_at,
    taskType: attempt.task_type
  };
}

function normalizeAnswer(answer: ReadingAnswerRow): ReadingWrongQuestionAnswer {
  return {
    attemptId: String(answer.attempt_id),
    isCorrect: Boolean(answer.is_correct),
    questionId: String(answer.question_id),
    slotId: answer.slot_id ? String(answer.slot_id) : null
  };
}

async function readAnswers(
  db: SupabaseClient,
  table: "reading_attempt_answers" | "reading_wrongbook_attempt_answers",
  attemptIds: string[]
) {
  if (attemptIds.length === 0) return { data: [] as ReadingAnswerRow[], error: null };
  const results = await Promise.all(chunk(attemptIds).map((ids) =>
    readAllSupabaseRows<ReadingAnswerRow>((from, to) =>
      db.from(table)
        .select("attempt_id,question_id,slot_id,is_correct")
        .in("attempt_id", ids)
        .order("attempt_id", { ascending: true })
        .order("question_id", { ascending: true })
        .order("slot_id", { ascending: true })
        .range(from, to)
    )
  ));
  return {
    data: results.flatMap((result) => result.data ?? []),
    error: results.find((result) => result.error)?.error ?? null
  };
}

function buildReadingTitles(items: ReadingItemRow[]) {
  const byModule = new Map<ReadingModule, ReadingItemRow[]>();
  for (const item of items) {
    byModule.set(item.module, [...(byModule.get(item.module) ?? []), item]);
  }
  return new Map(items.map((item) => {
    const number = readingCatalogDisplayNumber(byModule.get(item.module) ?? [], item.logical_item_id);
    const fallback = `${item.module === "ctw" ? "套题" : "题目"}${number ?? ""}`;
    return [item.logical_item_id, item.module === "ctw" ? fallback : item.title?.trim() || fallback];
  }));
}

function chunk<T>(values: T[], size = 100) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

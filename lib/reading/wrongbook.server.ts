import type { SupabaseClient } from "@supabase/supabase-js";
import { mapWithConcurrency } from "../mapWithConcurrency.ts";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import {
  profileSupabaseQuery,
  type ServerDebugTrace
} from "@/lib/supabase/debugMetrics.server";
import {
  buildReadingWrongbookQueue,
  type ReadingWrongQuestionAnswer,
  type ReadingWrongQuestionAttempt,
  type ReadingWrongbookCorrectionAttempt,
  type ReadingWrongbookQueueItem
} from "@/lib/wrongQuestions";
import {
  readingCatalogDisplayNumber,
  readingCatalogDisplayNumbers
} from "./catalog";
import type { ReadingModule } from "./types";
import type { ReadingWrongbookPreservedAnswer } from "./wrongbook";
import { readingWrongbookTargetKey } from "./wrongbook";

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

type PreservedAnswerRow = {
  answer_kind: "ctw_slot" | "option" | "insertion_anchor" | "sentence_selection";
  attempt_answer_id: string;
  attempt_id: string;
  is_correct: boolean;
  question_id: string;
  question_time_seconds: number | null;
  slot_id: string | null;
  student_answer: string | null;
};

type ReadingCorrectionAttemptRow = ReadingAttemptRow & {
  scope: "history" | "today";
};

type ReadingItemRow = {
  display_number?: string | null;
  first_seen_date: string;
  first_seen_source_label: string;
  first_seen_source_order: number;
  logical_item_id: string;
  module: ReadingModule;
  title: string | null;
};

type ReadingItemIdentityRow = Pick<
  ReadingItemRow,
  "first_seen_date" | "first_seen_source_label" | "first_seen_source_order" | "logical_item_id"
>;

export type ReadingWrongbookData = {
  readingAnswers: ReadingWrongQuestionAnswer[];
  readingAttempts: ReadingWrongQuestionAttempt[];
  readingCorrectionAnswers: ReadingWrongQuestionAnswer[];
  readingCorrectionAttempts: ReadingWrongbookCorrectionAttempt[];
  readingTitles: Map<string, string>;
};

export async function loadReadingWrongbookData(
  db: SupabaseClient,
  studentId: string,
  filters: { itemId?: string | null; taskType?: ReadingModule } = {},
  profile?: ServerDebugTrace
): Promise<ReadingWrongbookData> {
  const [attemptResult, correctionAttemptResult] = await Promise.all([
    profileSupabaseQuery(
      { query: "reading_formal_attempts", dependsOn: ["student/account validation"] },
      () => readAllSupabaseRows<ReadingAttemptRow>((from, to) => {
        let query = db.from("reading_attempts")
          .select("attempt_id,logical_item_id,task_type,submitted_at")
          .eq("student_id", studentId)
          .eq("status", "submitted");
        if (filters.itemId) query = query.eq("logical_item_id", filters.itemId);
        if (filters.taskType) query = query.eq("task_type", filters.taskType);
        return query.order("attempt_id", { ascending: true }).range(from, to);
      })
    ),
    profileSupabaseQuery(
      { query: "reading_correction_attempts", dependsOn: ["student/account validation"] },
      () => readAllSupabaseRows<ReadingCorrectionAttemptRow>((from, to) => {
        let query = db.from("reading_wrongbook_attempts")
          .select("attempt_id,logical_item_id,task_type,scope,submitted_at")
          .eq("student_id", studentId)
          .eq("status", "submitted")
          .neq("task_type", "full_set");
        if (filters.itemId) query = query.eq("logical_item_id", filters.itemId);
        if (filters.taskType) query = query.eq("task_type", filters.taskType);
        return query.order("attempt_id", { ascending: true }).range(from, to);
      })
    )
  ]);
  const firstError = attemptResult.error ?? correctionAttemptResult.error;
  if (firstError) throw new Error(firstError.message);

  const readingAttempts = (attemptResult.data ?? []).map(normalizeAttempt);
  const readingCorrectionAttempts = (correctionAttemptResult.data ?? []).map((attempt) => ({
    ...normalizeAttempt(attempt),
    scope: attempt.scope
  }));
  const logicalItemIds = Array.from(new Set([
    ...readingAttempts.map((attempt) => attempt.logicalItemId),
    ...readingCorrectionAttempts.map((attempt) => attempt.logicalItemId)
  ]));
  const [answerResult, correctionAnswerResult, itemResult] = await Promise.all([
    profileSupabaseQuery(
      { query: "reading_formal_answers", dependsOn: ["reading_formal_attempts"] },
      () => readAnswers(db, "reading_attempt_answers", readingAttempts.map((attempt) => attempt.attemptId))
    ),
    profileSupabaseQuery(
      { query: "reading_correction_answers", dependsOn: ["reading_correction_attempts"] },
      () => readAnswers(
        db,
        "reading_wrongbook_attempt_answers",
        readingCorrectionAttempts.map((attempt) => attempt.attemptId)
      )
    ),
    readItems(db, logicalItemIds, profile)
  ]);
  const answerError = answerResult.error ?? correctionAnswerResult.error ?? itemResult.error;
  if (answerError) throw new Error(answerError.message);

  const aggregationStartedAt = performance.now();
  const result = {
    readingAnswers: (answerResult.data ?? []).map(normalizeAnswer),
    readingAttempts,
    readingCorrectionAnswers: (correctionAnswerResult.data ?? []).map(normalizeAnswer),
    readingCorrectionAttempts,
    readingTitles: buildReadingTitles(itemResult.data ?? [])
  };
  profile?.record(
    "ordinary Reading JS aggregation",
    performance.now() - aggregationStartedAt,
    ["reading_formal_answers", "reading_correction_answers", "reading_item_metadata"],
    result.readingAnswers.length + result.readingCorrectionAnswers.length + result.readingTitles.size
  );
  return result;
}

export async function loadReadingWrongbookQueue(input: {
  db: SupabaseClient;
  itemId?: string | null;
  scope: "history" | "today";
  studentId: string;
  taskType: ReadingModule;
  todayEnd: number;
  todayStart: number;
  profile?: ServerDebugTrace;
}): Promise<ReadingWrongbookQueueItem[]> {
  const data = await loadReadingWrongbookData(input.db, input.studentId, {
    itemId: input.itemId,
    taskType: input.taskType
  }, input.profile);
  const queue = input.profile?.measureSync(
    "correction queue calculation",
    ["reading_formal_answers", "reading_correction_answers", "reading_item_metadata"],
    () => buildReadingWrongbookQueue({
      ...data,
      scope: input.scope,
      taskType: input.taskType,
      todayEnd: input.todayEnd,
      todayStart: input.todayStart
    }),
    (value) => value.length
  ) ?? buildReadingWrongbookQueue({
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

/**
 * Restores only answers the student actually submitted and that were graded
 * correct. The frozen source attempt carried by each target is preferred; older
 * genuine correct submissions are used only as a compatibility fallback.
 */
export async function loadReadingWrongbookPreservedAnswers(input: {
  before: string;
  db: SupabaseClient;
  logicalItemId: string;
  studentId: string;
  targets: Array<{ questionId: string; sourceAttemptId?: string; slotId: string | null }>;
}): Promise<PreservedAnswerRow[]> {
  const targetKeys = new Set(input.targets.map(readingWrongbookTargetKey));
  const preferredIds = Array.from(new Set(input.targets
    .map((target) => target.sourceAttemptId)
    .filter((value): value is string => Boolean(value))));
  const preferred = new Set(preferredIds);
  const [ordinaryAttemptsResult, priorCorrectionResult] = await Promise.all([
    profileSupabaseQuery(
      { query: "reading_preserved_formal_attempts", dependsOn: ["reading_get_or_create_attempt"] },
      () => readAllSupabaseRows<{
        attempt_id: string;
        submitted_at: string;
      }>((from, to) => input.db.from("reading_attempts")
        .select("attempt_id,submitted_at")
        .eq("student_id", input.studentId)
        .eq("logical_item_id", input.logicalItemId)
        .eq("status", "submitted")
        .order("submitted_at", { ascending: false })
        .order("attempt_id", { ascending: true })
        .range(from, to))
    ),
    profileSupabaseQuery(
      { query: "reading_preserved_correction_attempts", dependsOn: ["reading_get_or_create_attempt"] },
      () => readAllSupabaseRows<{
        attempt_id: string;
        submitted_at: string;
      }>((from, to) => input.db.from("reading_wrongbook_attempts")
        .select("attempt_id,submitted_at")
        .eq("student_id", input.studentId)
        .eq("logical_item_id", input.logicalItemId)
        .eq("status", "submitted")
        .lte("submitted_at", input.before)
        .order("submitted_at", { ascending: false })
        .order("attempt_id", { ascending: true })
        .range(from, to))
    )
  ]);
  if (ordinaryAttemptsResult.error) throw new Error(ordinaryAttemptsResult.error.message);
  if (priorCorrectionResult.error) throw new Error(priorCorrectionResult.error.message);
  const ordinaryIds = (ordinaryAttemptsResult.data ?? [])
    .filter((attempt) => preferred.has(attempt.attempt_id)
      || Date.parse(attempt.submitted_at) <= Date.parse(input.before))
    .map((attempt) => attempt.attempt_id);
  const correctionIds = (priorCorrectionResult.data ?? []).map((attempt) => attempt.attempt_id);

  const [ordinaryAnswers, correctionAnswers] = await Promise.all([
    profileSupabaseQuery(
      {
        query: "reading_preserved_formal_answers",
        dependsOn: ["reading_preserved_formal_attempts", "reading_preserved_correction_attempts"]
      },
      () => readPreservedAnswerRows(input.db, "reading_attempt_answers", ordinaryIds)
    ),
    profileSupabaseQuery(
      {
        query: "reading_preserved_correction_answers",
        dependsOn: ["reading_preserved_formal_attempts", "reading_preserved_correction_attempts"]
      },
      () => readPreservedAnswerRows(input.db, "reading_wrongbook_attempt_answers", correctionIds)
    )
  ]);
  const rank = new Map([
    ...preferredIds,
    ...ordinaryIds.filter((id) => !preferred.has(id)),
    ...correctionIds
  ].map((id, index) => [id, index]));
  const rows = [...ordinaryAnswers, ...correctionAnswers]
    .filter((answer) => answer.is_correct && Boolean(answer.student_answer?.trim()))
    .filter((answer) => !targetKeys.has(readingWrongbookTargetKey({
      questionId: answer.question_id,
      slotId: answer.slot_id
    })))
    .sort((left, right) =>
      (rank.get(left.attempt_id) ?? Number.MAX_SAFE_INTEGER)
      - (rank.get(right.attempt_id) ?? Number.MAX_SAFE_INTEGER)
    );
  const byTarget = new Map<string, PreservedAnswerRow>();
  for (const row of rows) {
    const key = readingWrongbookTargetKey({ questionId: row.question_id, slotId: row.slot_id });
    if (!byTarget.has(key)) byTarget.set(key, row);
  }
  return Array.from(byTarget.values());
}

export function toReadingWrongbookPreservedAnswers(
  rows: PreservedAnswerRow[]
): ReadingWrongbookPreservedAnswer[] {
  return rows.map((row) => ({
    answerKind: row.answer_kind,
    isCorrect: true,
    questionId: row.question_id,
    slotId: row.slot_id,
    studentAnswer: row.student_answer!.trim()
  }));
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
  const results = await mapWithConcurrency(chunk(attemptIds), 4, (ids) =>
    readAllSupabaseRows<ReadingAnswerRow>((from, to) =>
      db.from(table)
        .select("attempt_id,question_id,slot_id,is_correct")
        .in("attempt_id", ids)
        .order("attempt_id", { ascending: true })
        .order("question_id", { ascending: true })
        .order("slot_id", { ascending: true })
        .range(from, to)
    )
  );
  return {
    data: results.flatMap((result) => result.data ?? []),
    error: results.find((result) => result.error)?.error ?? null
  };
}

async function readPreservedAnswerRows(
  db: SupabaseClient,
  table: "reading_attempt_answers" | "reading_wrongbook_attempt_answers",
  attemptIds: string[]
) {
  if (attemptIds.length === 0) return [] as PreservedAnswerRow[];
  const results = await mapWithConcurrency(chunk(attemptIds), 4, (ids) =>
    readAllSupabaseRows<PreservedAnswerRow>((from, to) => db.from(table)
      .select("attempt_answer_id,attempt_id,question_id,slot_id,answer_kind,student_answer,is_correct,question_time_seconds")
      .in("attempt_id", ids)
      .range(from, to))
  );
  const error = results.find((result) => result.error)?.error;
  if (error) throw new Error(error.message);
  return results.flatMap((result) => result.data ?? []);
}

async function readItems(db: SupabaseClient, itemIds: string[], profile?: ServerDebugTrace) {
  if (itemIds.length === 0) return { data: [] as ReadingItemRow[], error: null };
  const results = await profileSupabaseQuery(
    {
      query: "reading_item_metadata",
      dependsOn: ["reading_formal_attempts", "reading_correction_attempts"]
    },
    () => mapWithConcurrency(chunk(itemIds), 4, (ids) =>
      readAllSupabaseRows<ReadingItemRow>((from, to) => db.from("reading_logical_items")
        .select("logical_item_id,module,title,first_seen_date,first_seen_source_label,first_seen_source_order")
        .in("logical_item_id", ids)
        .order("logical_item_id", { ascending: true })
        .range(from, to))
    )
  );
  const firstError = results.find((result) => result.error)?.error ?? null;
  if (firstError) return { data: null, error: firstError };
  const selected = results.flatMap((result) => result.data ?? []);
  const ctwDates = Array.from(new Set(selected
    .filter((item) => item.module === "ctw")
    .map((item) => item.first_seen_date)));
  const latestCtwDate = [...ctwDates].sort().at(-1);
  const ctwCatalogResult = latestCtwDate
    ? await profileSupabaseQuery(
        { query: "reading_ctw_rank_catalog", dependsOn: ["reading_item_metadata"] },
        () => readAllSupabaseRows<ReadingItemIdentityRow>((from, to) => db.from("reading_logical_items")
          .select("logical_item_id,first_seen_date,first_seen_source_label,first_seen_source_order")
          .eq("module", "ctw")
          .lte("first_seen_date", latestCtwDate)
          .order("logical_item_id", { ascending: true })
          .range(from, to))
      )
    : { data: [] as ReadingItemRow[], error: null };
  const displayNumberById = readingCatalogDisplayNumbers(ctwCatalogResult.data ?? []);
  return {
    data: ctwCatalogResult.error
      ? null
      : selected.map((item) => ({
          ...item,
          display_number: displayNumberById.get(item.logical_item_id) ?? null
        })),
    error: ctwCatalogResult.error
  };
}

function buildReadingTitles(items: ReadingItemRow[]) {
  const byModule = new Map<ReadingModule, ReadingItemRow[]>();
  for (const item of items) {
    byModule.set(item.module, [...(byModule.get(item.module) ?? []), item]);
  }
  return new Map(items.map((item) => {
    const number = item.display_number
      ?? readingCatalogDisplayNumber(byModule.get(item.module) ?? [], item.logical_item_id);
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

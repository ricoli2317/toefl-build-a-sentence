import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { mapWithConcurrency } from "./mapWithConcurrency.ts";
import { loadReadingWrongbookTitles } from "./reading/wrongbook.server.ts";
import {
  buildReadingSessionGroups,
  shuffleWrongQuestionTargets,
  wrongQuestionPracticeCount,
  WRONG_QUESTION_BANK_TASK_TYPES,
  type WrongQuestionBankEvent,
  type WrongQuestionBankRow,
  type WrongQuestionBankTaskType,
  type WrongQuestionPendingCounts,
  type WrongQuestionPracticeSession,
  type WrongQuestionSessionGroup,
  type WrongQuestionSessionManifest,
  type WrongQuestionSessionProgress
} from "./wrongQuestionBank.ts";

const BANK_TABLE = "student_wrong_questions";
const SESSION_TABLE = "student_wrong_question_sessions";

type BankRow = {
  first_wrong_at: string;
  logical_item_id: string | null;
  pending_date: string | null;
  question_id: string;
  question_key: string;
  slot_id: string | null;
  task_type: WrongQuestionBankTaskType;
};

type SessionRow = {
  amount: number | null;
  created_at: string;
  manifest: WrongQuestionSessionManifest;
  mode: "history" | "today";
  progress: Record<string, WrongQuestionSessionProgress> | null;
  session_id: string;
  status: "active" | "completed";
  task_type: WrongQuestionBankTaskType;
};

export function emptyWrongQuestionPendingCounts(): WrongQuestionPendingCounts {
  return { bas: 0, ctw: 0, rdl: 0, rap: 0 };
}

/**
 * Applies wrong/corrected transitions to the canonical bank. Events are
 * idempotent, so repeated submissions can never double count pending rows.
 *
 * `practiceDate` is the server-side business date: a formal wrong stamps that
 * date as the row's pending date (re-dating an older pending row), while a
 * correction clears it. Rows pending for an older date simply stop matching
 * today's summary; no midnight cleanup is required.
 */
export async function applyStudentWrongQuestionEvents(
  db: SupabaseClient,
  studentId: string,
  practiceDate: string,
  events: WrongQuestionBankEvent[]
) {
  const unique = new Map<string, WrongQuestionBankEvent>();
  for (const event of events) {
    if (!event.questionKey || !event.questionId) continue;
    unique.set(`${event.event}:${event.taskType}:${event.questionKey}`, event);
  }
  const pending = Array.from(unique.values());
  if (pending.length === 0) return;
  for (const chunk of chunkValues(pending, 200)) {
    const { error } = await db.rpc("apply_student_wrong_question_events", {
      p_events: chunk,
      p_practice_date: practiceDate,
      p_student_id: studentId
    });
    if (error) throw new Error(`Failed to update wrong-question state: ${error.message}`);
  }
}

/** Home summary: four counts, one small query over today's pending rows only. */
export async function loadWrongQuestionPendingCounts(
  db: SupabaseClient,
  studentId: string,
  practiceDate: string
): Promise<WrongQuestionPendingCounts> {
  const result = await readAllSupabaseRows<{ task_type: WrongQuestionBankTaskType }>(
    (from, to) => db.from(BANK_TABLE)
      .select("task_type")
      .eq("student_id", studentId)
      .eq("pending_date", practiceDate)
      .order("task_type", { ascending: true })
      .range(from, to)
  );
  if (result.error) throw new Error(result.error.message);
  const counts = emptyWrongQuestionPendingCounts();
  for (const row of result.data ?? []) {
    if ((WRONG_QUESTION_BANK_TASK_TYPES as readonly string[]).includes(row.task_type)) {
      counts[row.task_type] += 1;
    }
  }
  return counts;
}

/** History modal: one exact-count query, never a history scan with joins. */
export async function loadWrongQuestionHistoryCount(
  db: SupabaseClient,
  studentId: string,
  taskType: WrongQuestionBankTaskType
) {
  const { count, error } = await db.from(BANK_TABLE)
    .select("question_key", { count: "exact", head: true })
    .eq("student_id", studentId)
    .eq("task_type", taskType);
  if (error) throw new Error(error.message);
  return count ?? 0;
}

export async function loadWrongQuestionBankRows(
  db: SupabaseClient,
  studentId: string,
  taskType: WrongQuestionBankTaskType,
  options: { pendingDate?: string } = {}
): Promise<WrongQuestionBankRow[]> {
  const result = await readAllSupabaseRows<BankRow>((from, to) => {
    let query = db.from(BANK_TABLE)
      .select("question_key,question_id,logical_item_id,slot_id,pending_date,first_wrong_at,task_type")
      .eq("student_id", studentId)
      .eq("task_type", taskType);
    if (options.pendingDate) query = query.eq("pending_date", options.pendingDate);
    return query
      .order("first_wrong_at", { ascending: true })
      .order("question_key", { ascending: true })
      .range(from, to);
  });
  if (result.error) throw new Error(result.error.message);
  return (result.data ?? []).map((row) => ({
    firstWrongAt: row.first_wrong_at,
    logicalItemId: row.logical_item_id ? String(row.logical_item_id) : null,
    pendingDate: row.pending_date ? String(row.pending_date) : null,
    questionId: String(row.question_id),
    questionKey: String(row.question_key),
    slotId: row.slot_id ? String(row.slot_id) : null
  }));
}

/** BAS bank practice hydration source (today's pending only). */
export async function loadPendingBasQuestionIds(
  db: SupabaseClient,
  studentId: string,
  practiceDate: string
) {
  const rows = await loadWrongQuestionBankRows(db, studentId, "bas", { pendingDate: practiceDate });
  return Array.from(new Set(rows.map((row) => row.questionId)));
}

/**
 * Creates the frozen practice manifest for a history session (or today's
 * pending sweep). Reading groups keep the draw order; questions inside a group
 * keep the canonical question order. Nothing but identity data is stored, so a
 * 20-question session never downloads materials up front.
 */
export async function createWrongQuestionPracticeSession(input: {
  amount?: number | null;
  db: SupabaseClient;
  mode: "history" | "today";
  practiceDate: string;
  studentId: string;
  taskType: WrongQuestionBankTaskType;
}): Promise<WrongQuestionPracticeSession> {
  const rows = await loadWrongQuestionBankRows(input.db, input.studentId, input.taskType, {
    pendingDate: input.mode === "today" ? input.practiceDate : undefined
  });
  const pool = input.mode === "history"
    ? shuffleWrongQuestionTargets(rows)
    : rows;
  const amount = input.mode === "history"
    ? wrongQuestionPracticeCount(input.amount ?? rows.length, rows.length)
    : null;
  const selected = input.mode === "history" && typeof amount === "number"
    ? pool.slice(0, amount)
    : pool;

  const manifest: WrongQuestionSessionManifest = input.taskType === "bas"
    ? { kind: "bas", questionIds: selected.map((row) => row.questionId) }
    : {
        kind: "reading",
        groups: await buildReadingGroups(input.db, selected)
      };
  if (
    (manifest.kind === "bas" && manifest.questionIds.length === 0)
    || (manifest.kind === "reading" && manifest.groups.length === 0)
  ) {
    throw new Error("WRONG_QUESTION_SESSION_EMPTY");
  }

  const { data, error } = await input.db.from(SESSION_TABLE)
    .insert({
      amount,
      manifest,
      mode: input.mode,
      student_id: input.studentId,
      task_type: input.taskType
    })
    .select("session_id,student_id,task_type,mode,amount,manifest,progress,status,created_at")
    .single();
  if (error || !data) throw new Error(error?.message ?? "Failed to create wrong-question session");
  return toWrongQuestionPracticeSession(data as SessionRow);
}

export async function loadWrongQuestionPracticeSession(
  db: SupabaseClient,
  studentId: string,
  sessionId: string
): Promise<WrongQuestionPracticeSession | null> {
  const { data, error } = await db.from(SESSION_TABLE)
    .select("session_id,student_id,task_type,mode,amount,manifest,progress,status,created_at")
    .eq("session_id", sessionId)
    .eq("student_id", studentId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return toWrongQuestionPracticeSession(data as SessionRow);
}

/**
 * Whole-session elapsed time: the sum of the session's recorded per-source
 * attempts — the same number the session result page shows. It is returned with
 * the session manifest (first-screen data) so the review never has to recompute
 * it (and therefore never changes the displayed time) as sources load.
 */
export async function loadWrongQuestionSessionElapsedSeconds(
  db: SupabaseClient,
  session: WrongQuestionPracticeSession
): Promise<number | null> {
  if (session.taskType === "bas") return null;
  const attemptIds = Array.from(new Set(
    Object.values(session.progress ?? {})
      .map((entry) => entry?.attemptId ? String(entry.attemptId) : "")
      .filter(Boolean)
  ));
  if (attemptIds.length === 0) return null;
  const { data, error } = await db
    .from("reading_wrongbook_attempts")
    .select("attempt_id,elapsed_seconds")
    .in("attempt_id", attemptIds);
  if (error) throw new Error(error.message);
  const rows = data ?? [];
  // A missing source row means the total is unknown; never guess a partial sum.
  if (rows.length !== attemptIds.length) return null;
  return rows.reduce((sum, row) => {
    const value = Number(row.elapsed_seconds ?? 0);
    return sum + (Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0);
  }, 0);
}

/**
 * Records one finished Reading group. When every group has been submitted the
 * session completes; partial progress is what makes refresh/resume continue the
 * same frozen session.
 */
export async function recordWrongQuestionSessionGroupProgress(input: {
  db: SupabaseClient;
  group: WrongQuestionSessionGroup;
  progress: WrongQuestionSessionProgress;
  sessionId: string;
  studentId: string;
}) {
  const session = await loadWrongQuestionPracticeSession(
    input.db,
    input.studentId,
    input.sessionId
  );
  if (!session || !session.groups) return;
  if (!session.groups.some((group) => group.logicalItemId === input.group.logicalItemId)) return;
  const progress: Record<string, WrongQuestionSessionProgress> = {
    ...session.progress,
    [input.group.logicalItemId]: input.progress
  };
  const completed = session.groups.every((group) => Boolean(progress[group.logicalItemId]));
  const { error } = await input.db.from(SESSION_TABLE)
    .update({
      completed_at: completed ? new Date().toISOString() : null,
      progress,
      status: completed ? "completed" : "active",
      updated_at: new Date().toISOString()
    })
    .eq("session_id", input.sessionId)
    .eq("student_id", input.studentId);
  if (error) throw new Error(error.message);
}

export type BasBankQuestion = {
  blank_count: number;
  correct_order_text: string;
  distractors_text: string;
  final_sentence: string;
  grammar_tags_text: string;
  options_text: string;
  prompt: string;
  question_id: string;
  question_order: number;
  sentence_template: string;
  set_id: string;
  set_title: string;
};

type BasQuestionRow = {
  blank_count: number | null;
  correct_order_text: string | null;
  distractors_text: string | null;
  final_sentence: string | null;
  grammar_tags_text: string | null;
  options_text: string | null;
  prompt: string | null;
  question_id: string;
  question_order: number | null;
  sentence_template: string | null;
  set_id: string;
  set_title: string | null;
};

/**
 * Hydrates BAS practice questions for the bank-driven today / entry / history
 * flows. Content is read only when a practice page is actually opened.
 */
export async function loadBasQuestionsByIds(
  db: SupabaseClient,
  questionIds: string[]
): Promise<BasBankQuestion[]> {
  const unique = Array.from(new Set(questionIds.filter(Boolean)));
  if (unique.length === 0) return [];
  const results = await mapWithConcurrency(chunkValues(unique, 100), 4, (batch) =>
    readAllSupabaseRows<BasQuestionRow>((from, to) => db.from("questions")
      .select("question_id,set_id,set_title,question_order,prompt,sentence_template,blank_count,options_text,correct_order_text,distractors_text,final_sentence,grammar_tags_text")
      .in("question_id", batch)
      .order("question_id", { ascending: true })
      .range(from, to))
  );
  const error = results.find((result) => result.error)?.error;
  if (error) throw new Error(error.message);
  const orderById = new Map(unique.map((questionId, index) => [questionId, index]));
  const bestByKey = new Map<string, BasBankQuestion>();
  for (const question of results.flatMap((result) => result.data ?? [])) {
    const normalized: BasBankQuestion = {
      blank_count: question.blank_count ?? 0,
      correct_order_text: question.correct_order_text ?? "",
      distractors_text: question.distractors_text ?? "",
      final_sentence: question.final_sentence ?? "",
      grammar_tags_text: question.grammar_tags_text ?? "",
      options_text: question.options_text ?? "",
      prompt: question.prompt ?? "",
      question_id: String(question.question_id),
      question_order: question.question_order ?? 0,
      sentence_template: question.sentence_template ?? "",
      set_id: String(question.set_id),
      set_title: question.set_title ?? String(question.set_id)
    };
    // Content-level dedupe keeps the canonical BAS identity stable across sets.
    const sentence = normalized.final_sentence.replace(/\s+/g, " ").trim();
    const key = sentence ? `sentence:${sentence}` : `question:${normalized.question_id}`;
    const existing = bestByKey.get(key);
    const order = orderById.get(normalized.question_id) ?? Number.MAX_SAFE_INTEGER;
    const existingOrder = existing
      ? orderById.get(existing.question_id) ?? Number.MAX_SAFE_INTEGER
      : Number.MAX_SAFE_INTEGER;
    if (!existing || order < existingOrder) bestByKey.set(key, normalized);
  }
  return Array.from(bestByKey.values()).sort((left, right) =>
    (orderById.get(left.question_id) ?? Number.MAX_SAFE_INTEGER)
      - (orderById.get(right.question_id) ?? Number.MAX_SAFE_INTEGER)
    || left.question_order - right.question_order
  );
}

async function buildReadingGroups(
  db: SupabaseClient,
  rows: WrongQuestionBankRow[]
): Promise<WrongQuestionSessionGroup[]> {
  const targets = rows.map((row) => ({
    logicalItemId: row.logicalItemId,
    questionId: row.questionId,
    slotId: row.slotId
  }));
  const itemIds = Array.from(new Set(targets
    .map((target) => target.logicalItemId)
    .filter((value): value is string => Boolean(value))));
  if (itemIds.length === 0) return [];

  const [orderById, titles] = await Promise.all([
    loadReadingQuestionOrders(db, itemIds),
    loadReadingWrongbookTitles(db, itemIds)
  ]);
  return buildReadingSessionGroups({
    questionOrderById: orderById,
    targets,
    titles
  });
}

async function loadReadingQuestionOrders(db: SupabaseClient, itemIds: string[]) {
  const results = await mapWithConcurrency(chunkValues(itemIds, 100), 4, (ids) =>
    readAllSupabaseRows<{ logical_item_id: string; question_id: string; question_order: number }>(
      (from, to) => db.from("reading_questions")
        .select("question_id,logical_item_id,question_order")
        .in("logical_item_id", ids)
        .order("question_id", { ascending: true })
        .range(from, to)
    )
  );
  const error = results.find((result) => result.error)?.error;
  if (error) throw new Error(error.message);
  return new Map(results.flatMap((result) => result.data ?? [])
    .map((row) => [String(row.question_id), Number(row.question_order) || 0]));
}

function toWrongQuestionPracticeSession(row: SessionRow): WrongQuestionPracticeSession {
  const manifest = row.manifest ?? { kind: "bas", questionIds: [] };
  return {
    amount: row.amount ?? null,
    createdAt: row.created_at,
    groups: manifest.kind === "reading" ? manifest.groups : undefined,
    mode: row.mode,
    progress: row.progress ?? {},
    questionIds: manifest.kind === "bas" ? manifest.questionIds : undefined,
    sessionId: String(row.session_id),
    status: row.status,
    taskType: row.task_type
  };
}

function chunkValues<T>(values: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

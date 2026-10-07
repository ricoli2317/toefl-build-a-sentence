import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "../supabasePagination.ts";
import { wrongQuestionAmountOptions } from "../wrongQuestionBank.ts";
import { loadReadingWrongbookTitles } from "./wrongbook.server.ts";
import {
  CATEGORY_SESSION_TABLE,
  drawCategoryManifest,
  type CategorySession,
  type ReadingQuestionCategory
} from "./questionCategory.ts";
import { CATEGORY_ANSWER_TABLE, categoryAnswerRows, categoryResultAnswers, categorySessionTitle, type CategoryAnswer } from "./questionCategory.ts";
import { loadStudentReadingPractice } from "./studentPractice.ts";
import { selectReadingTargetPractice } from "./wrongbook.ts";
import { buildSubmittedReadingAnswerState, buildSubmittedReadingReviewItems } from "./review.ts";
import { loadReadingAnswerDisclosures } from "./reviewDisclosures.server.ts";
import { buildReadingWrongbookSessionReviewPayload, findReadingWrongbookSessionShapeIndex } from "./wrongbookSession.ts";

export class CategoryRequestError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/** Called only after requireReadingAttemptStudent verifies the active account.
 * service_role is deliberately server-only: clients cannot submit a manifest.
 * Both this draw and the counts RPC use exactly module='rap' + category.
 */
export async function createCategorySession(
  db: SupabaseClient, studentId: string, questionCategory: ReadingQuestionCategory, amount: 5 | 10 | 15 | 20
): Promise<CategorySession> {
  const pool = await readAllSupabaseRows<{
    question_id: string; logical_item_id: string; question_order: number;
  }>((from, to) => db.from("reading_questions")
    .select("question_id,logical_item_id,question_order")
    .eq("module", "rap").eq("question_category", questionCategory)
    .order("question_id").range(from, to));
  if (pool.error) throw new Error(pool.error.message);
  const rows = pool.data ?? [];
  if (!wrongQuestionAmountOptions(rows.length).find((option) => option.amount === amount)?.enabled) {
    throw new CategoryRequestError(rows.length ? "请选择当前可用的题目数量。" : "该题型暂无可练习题目。", 409);
  }
  const manifest = drawCategoryManifest({ questionCategory, amount, rows, titles: new Map() });
  const titles = await loadReadingWrongbookTitles(db, manifest.groups.map((group) => group.logicalItemId));
  manifest.groups = manifest.groups.map((group) => ({ ...group, title: titles.get(group.logicalItemId) || group.title }));
  const result = await db.from(CATEGORY_SESSION_TABLE).insert({
    student_id: studentId, question_category: questionCategory, amount, manifest
  }).select("session_id,created_at").single();
  if (result.error || !result.data) throw new Error(result.error?.message ?? "Category session creation failed");
  return {
    sessionId: result.data.session_id, questionCategory, amount, groups: manifest.groups,
    progress: {}, status: "active", elapsedSeconds: 0, totalPoints: 0, correctPoints: 0,
    createdAt: result.data.created_at, completedAt: null
  };
}

/** Existing teacher result/review UI, with category data. Result = grading only;
 * question drill-down hydrates its source + one next source, never the whole run.
 * Caller MUST authorize teacher scope before this service-role helper.
 */
export async function loadTeacherCategorySessionDetail(db: SupabaseClient, studentId: string, sessionId: string, questionIndex?: number) {
  const result = await db.from(CATEGORY_SESSION_TABLE).select("*")
    .eq("session_id", sessionId).eq("student_id", studentId).eq("status", "completed").maybeSingle();
  if (result.error) throw new Error(result.error.message);
  if (!result.data) return null;
  const row = result.data;
  const session: CategorySession = {
    sessionId, questionCategory: row.question_category, amount: row.amount, groups: row.manifest.groups,
    progress: row.progress, status: row.status, elapsedSeconds: row.elapsed_seconds, correctPoints: row.correct_points,
    totalPoints: row.total_points, createdAt: row.created_at, completedAt: row.completed_at
  };
  const answerResult = await db.from(CATEGORY_ANSWER_TABLE)
    .select("answer_id,logical_item_id,question_id,answer_kind,student_answer,is_correct,question_time_seconds").eq("session_id", sessionId);
  if (answerResult.error) throw new Error(answerResult.error.message);
  const answers: CategoryAnswer[] = (answerResult.data ?? []).map((answer) => ({
    answerId: answer.answer_id, logicalItemId: answer.logical_item_id, questionId: answer.question_id,
    answerKind: answer.answer_kind, studentAnswer: answer.student_answer, isCorrect: answer.is_correct,
    questionTimeSeconds: answer.question_time_seconds
  }));
  const ordered = categoryResultAnswers(session, answers);
  const shapes = session.groups.map((group) => ({ logicalItemId: group.logicalItemId, itemCount: group.targets.length,
    items: ordered.filter((answer) => answer.logicalItemId === group.logicalItemId) }));
  const index = questionIndex === undefined ? -1 : findReadingWrongbookSessionShapeIndex(shapes, questionIndex);
  const groupReviews = await Promise.all(session.groups.slice(Math.max(0, index), index === -1 ? 0 : index + 2).map(async (group) => {
    const practice = selectReadingTargetPractice(await loadStudentReadingPractice(db, group.logicalItemId), group.targets);
    const rows = categoryAnswerRows(answers.filter((answer) => answer.logicalItemId === group.logicalItemId));
    return { group, payload: { practice, attempt: { attemptId: sessionId },
      answers: buildSubmittedReadingAnswerState(practice, rows), reviewItems: buildSubmittedReadingReviewItems(practice, rows),
      disclosures: await loadReadingAnswerDisclosures(db, rows) } };
  }));
  return {
    summary: { title: categorySessionTitle(session.questionCategory), correctPoints: session.correctPoints,
      totalPoints: session.totalPoints, elapsedSeconds: session.elapsedSeconds, submittedAt: session.completedAt! },
    review: buildReadingWrongbookSessionReviewPayload({ groupReviews, shapes, sessionId, taskType: "rap",
      title: categorySessionTitle(session.questionCategory), totalElapsedSeconds: session.elapsedSeconds, reviewHref: () => "" })
  };
}

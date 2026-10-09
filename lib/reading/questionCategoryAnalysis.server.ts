import type { SupabaseClient } from "@supabase/supabase-js";
import { mapWithConcurrency } from "../mapWithConcurrency.ts";
import { READING_QUESTION_CATEGORIES, type ReadingQuestionCategory } from "./questionCategory.ts";

export type QuestionCategoryErrorCount = { questionCategory: ReadingQuestionCategory; count: number };

/**
 * Historical wrong EVENTS, not distinct questions or current wrongbook state.
 * Ordinary RAP: submitted reading_attempts + is_correct=false (includes unanswered).
 * Full Set: whole attempt completed AND module submitted; RAP questions only.
 * Submitted Full Set grading persists unanswered as false too; defensive null
 * handling follows the existing Full Set wrong-event path (only true is correct).
 * Category sessions are independent tables, not ordinary RAP child attempts, so
 * they are intentionally excluded; corrections never touch either source here.
 * Caller MUST authorize the active student before supplying a server-only service
 * client: Full Set tables deliberately deny direct authenticated SELECT. Every
 * query is scoped to the verified student ID, never an ID supplied by a client.
 */
export async function loadQuestionCategoryAnalysis(db: SupabaseClient, studentId: string): Promise<QuestionCategoryErrorCount[]> {
  // Fixed 20 HEAD/COUNT queries, at most four in flight. Postgres does all answer
  // counting; no historical answers, question content or passages leave the DB.
  // This avoids adding a grouping RPC/schema migration for this small taxonomy.
  const queries = READING_QUESTION_CATEGORIES.flatMap((questionCategory) => [
    { questionCategory, source: "rap" as const }, { questionCategory, source: "full_set" as const }
  ]);
  const counts = await mapWithConcurrency(queries, 4, async ({ questionCategory, source }) => {
    const query = source === "rap"
      ? db.from("reading_attempt_answers")
        .select("reading_questions!inner(),reading_attempts!inner()", { count: "exact", head: true })
        .eq("is_correct", false)
        .eq("reading_attempts.student_id", studentId)
        .eq("reading_attempts.status", "submitted")
        .eq("reading_attempts.task_type", "rap")
      : db.from("reading_full_set_answers")
        .select("reading_questions!inner(),reading_full_set_module_attempts!inner(reading_full_set_attempts!inner())", { count: "exact", head: true })
        .or("is_correct.eq.false,is_correct.is.null")
        .eq("reading_full_set_module_attempts.status", "submitted")
        .eq("reading_full_set_module_attempts.reading_full_set_attempts.student_id", studentId)
        .eq("reading_full_set_module_attempts.reading_full_set_attempts.status", "completed");
    const result = await query.eq("reading_questions.module", "rap")
      .eq("reading_questions.question_category", questionCategory);
    if (result.error) throw new Error(result.error.message);
    if (result.count === null) throw new Error("Reading category count unavailable");
    return result.count;
  });
  return READING_QUESTION_CATEGORIES.map((questionCategory, index) => ({
    questionCategory, count: counts[index * 2] + counts[index * 2 + 1]
  })).filter((row) => row.count > 0)
    // Stable ties retain the fixed ten-category order.
    .sort((a, b) => b.count - a.count).slice(0, 5);
}

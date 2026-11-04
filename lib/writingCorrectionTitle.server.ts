import type { SupabaseClient } from "@supabase/supabase-js";
import { loadWritingHistoricalPracticeDisplayResolver } from "./historicalPracticeDisplay.ts";
import { frozenWritingCorrectionSource } from "./writingCorrection.ts";
import type { WritingAttempt } from "./writing.ts";

/** Same canonical title contract as ordinary Writing, with frozen custom titles. */
export async function correctionDisplayName(db: SupabaseClient, attempt: Pick<WritingAttempt, "task_type" | "question_id" | "set_id" | "assignment_id" | "correction_source_snapshot" | "attempt_kind">) {
  const source = frozenWritingCorrectionSource(attempt);
  const resolver = await loadWritingHistoricalPracticeDisplayResolver(db, attempt.task_type, [attempt.question_id]);
  return resolver.resolveWritingAttempt({
    assignmentId: attempt.assignment_id ?? null,
    assignmentDisplayName: source.question.set_title,
    fallbackDisplayName: source.question.set_title || attempt.set_id || attempt.question_id,
    questionSource: source.question_source,
    rawQuestionId: attempt.question_id,
    taskType: attempt.task_type
  }).displayName;
}

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildReadingFullSetResultPayload,
  type ReadingFullSetResultAnswerRow,
  type ReadingFullSetResultModuleRow,
  type ReadingFullSetResultPayload,
  type ReadingFullSetResultQuestionRow,
  type ReadingFullSetResultSlotRow
} from "./fullSetResults.ts";
import { findValidReadingFullSet } from "./fullSets.ts";
import { loadReadingFullSets } from "./fullSets.server.ts";

export type OwnedReadingFullSetResultAttempt = {
  attempt_id: string;
  full_set_id: string;
  status: string;
  completed_at: string | null;
};

export async function loadReadingFullSetResult(
  db: SupabaseClient,
  attempt: OwnedReadingFullSetResultAttempt
): Promise<ReadingFullSetResultPayload> {
  if (attempt.status !== "completed" || !attempt.completed_at) {
    throw new Error("READING_FULL_SET_RESULT_NOT_COMPLETED");
  }
  const fullSet = findValidReadingFullSet(await loadReadingFullSets(db), attempt.full_set_id);
  if (!fullSet) throw new Error("READING_FULL_SET_RESULT_SET_MISSING");
  const moduleResult = await db.from("reading_full_set_module_attempts")
    .select("module_attempt_id,module_number")
    .eq("attempt_id", attempt.attempt_id);
  if (moduleResult.error) throw new Error(moduleResult.error.message);
  const modules = (moduleResult.data ?? []) as ReadingFullSetResultModuleRow[];
  const moduleIds = modules.map((module) => module.module_attempt_id);
  if (moduleIds.length !== 2) throw new Error("READING_FULL_SET_RESULT_MODULES_MISSING");
  const answerResult = await db.from("reading_full_set_answers")
    .select("answer_id,module_attempt_id,occurrence_id,logical_item_id,question_id,slot_id,student_answer,is_correct,question_time_seconds")
    .in("module_attempt_id", moduleIds);
  if (answerResult.error) throw new Error(answerResult.error.message);
  const answers = (answerResult.data ?? []) as ReadingFullSetResultAnswerRow[];
  const questionIds = Array.from(new Set(answers.map((answer) => answer.question_id)));
  const [questionResult, slotResult] = await Promise.all([
    db.from("reading_questions").select("question_id,question_order").in("question_id", questionIds),
    db.from("reading_ctw_slots").select("question_id,slot_id,slot_order").in("question_id", questionIds)
  ]);
  if (questionResult.error || slotResult.error) {
    throw new Error((questionResult.error ?? slotResult.error)!.message);
  }
  return buildReadingFullSetResultPayload({
    attempt: attempt as OwnedReadingFullSetResultAttempt & { completed_at: string },
    fullSet,
    modules,
    answers,
    questions: (questionResult.data ?? []) as ReadingFullSetResultQuestionRow[],
    slots: (slotResult.data ?? []) as ReadingFullSetResultSlotRow[]
  });
}

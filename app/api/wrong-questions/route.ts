import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { requireStudentApiAuth, studentApiJson } from "@/lib/studentRequest.server";
import {
  isWrongQuestionBankTaskType,
  type WrongQuestionBankTaskType
} from "@/lib/wrongQuestionBank";
import {
  loadBasQuestionsByIds,
  loadPendingBasQuestionIds,
  loadWrongQuestionHistoryCount,
  loadWrongQuestionPendingCounts
} from "@/lib/wrongQuestionBank.server";
import { wrongQuestionBusinessDate } from "@/lib/wrongQuestionBusinessDate";

export const dynamic = "force-dynamic";

function jsonError(message: string, status = 500) {
  return studentApiJson({ error: message, questions: [], count: 0 }, status);
}

/**
 * Wrong-question API.
 *
 * The wrongbook home only uses `view=summary` (four pending counts from the
 * incremental bank). History counts load after the student opens the history
 * modal; practice content loads only after a session amount is chosen.
 */
export async function GET(request: Request) {
  try {
    const { auth, error } = await requireStudentApiAuth(request);
    if (error || !auth) return error ?? jsonError("Unauthorized", 401);

    const { searchParams } = new URL(request.url);
    const view = searchParams.get("view");
    // The daily pending date is always derived on the server from the project's
    // one calendar rule (Asia/Shanghai); clients never send it.
    const practiceDate = wrongQuestionBusinessDate();

    if (view === "summary") {
      const pending = await loadWrongQuestionPendingCounts(auth.db, auth.userId, practiceDate);
      return studentApiJson({ pending, practiceDate });
    }

    if (view === "history-count") {
      const taskType = parseTaskType(searchParams.get("taskType"));
      if (!taskType) return jsonError("Invalid wrong-question task type.", 400);
      const count = await loadWrongQuestionHistoryCount(auth.db, auth.userId, taskType);
      return studentApiJson({ count, taskType });
    }

    const scope = searchParams.get("scope");
    if (scope === "today") {
      const questionIds = await loadPendingBasQuestionIds(auth.db, auth.userId, practiceDate);
      const questions = await loadBasQuestionsByIds(auth.db, questionIds);
      return studentApiJson({ correctionMode: "today", count: questions.length, questions });
    }

    if (scope === "entry") {
      const attemptId = searchParams.get("attemptId")?.trim() ?? "";
      if (!attemptId) return jsonError("Missing BAS correction attempt id.", 400);
      return loadBasEntryPayload(auth.db, auth.userId, attemptId);
    }

    return jsonError("Invalid wrong-question scope.", 400);
  } catch (caught) {
    return jsonError(caught instanceof Error ? caught.message : "Could not load wrong questions.");
  }
}

/**
 * Entry-level correction for one BAS attempt: only that attempt's wrong
 * questions. The correction mode is derived from the source set, never from the
 * client: result-page corrections clear pending, history-practice mistakes stay
 * untouched.
 */
async function loadBasEntryPayload(db: SupabaseClient, studentId: string, attemptId: string) {
  const { data: attempt, error: attemptError } = await db
    .from("attempts")
    .select("attempt_id,set_id")
    .eq("attempt_id", attemptId)
    .eq("student_id", studentId)
    .maybeSingle();
  if (attemptError) return jsonError(attemptError.message);
  if (!attempt) return jsonError("Practice attempt was not found.", 404);

  const answerResult = await readAllSupabaseRows<{ question_id: string }>((from, to) => db
    .from("attempt_answers")
    .select("question_id")
    .eq("attempt_id", attemptId)
    .eq("student_id", studentId)
    .eq("is_correct", false)
    .order("attempt_answer_id", { ascending: true })
    .range(from, to));
  if (answerResult.error) return jsonError(answerResult.error.message);

  const questionIds = Array.from(new Set((answerResult.data ?? [])
    .map((answer) => String(answer.question_id))
    .filter(Boolean)));
  const setId = String(attempt.set_id ?? "").trim().toLocaleLowerCase();
  const correctionMode = setId.startsWith("wrongbook-random-")
    || setId.startsWith("wrongbook-all-")
    || setId.startsWith("grammar-")
    ? "history"
    : "today";
  const questions = await loadBasQuestionsByIds(db, questionIds);
  return studentApiJson({ correctionMode, count: questions.length, questions });
}

function parseTaskType(value: string | null): WrongQuestionBankTaskType | null {
  return isWrongQuestionBankTaskType(value) ? value : null;
}

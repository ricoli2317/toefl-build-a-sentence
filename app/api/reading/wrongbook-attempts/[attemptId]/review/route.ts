import { readingAttemptJson, requireReadingAttemptStudent } from "@/lib/reading/attemptServer";
import {
  buildSubmittedReadingAnswerState,
  buildSubmittedReadingReviewItems,
  type SubmittedReadingAnswerRow
} from "@/lib/reading/review";
import { loadReadingAnswerDisclosures } from "@/lib/reading/reviewDisclosures.server";
import { selectReadingWrongbookPractice } from "@/lib/reading/wrongbook";
import {
  loadReadingCtwContextAnswers,
  loadReadingWrongbookPreservedAnswers
} from "@/lib/reading/wrongbook.server";
import { loadStudentReadingPractice, StudentReadingLoadError } from "@/lib/reading/studentPractice";
import type { ReadingWrongbookTarget } from "@/lib/wrongQuestions";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  loadReadingFullSetWrongbookReviewData,
  type FullSetWrongbookAttemptRow
} from "@/lib/reading/fullSetWrongbookResult.server";

export const dynamic = "force-dynamic";

type ReviewRow = SubmittedReadingAnswerRow & {
  attempt_answer_id: string;
  is_correct: boolean;
};

export async function GET(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client || !auth.userId) {
    return readingAttemptJson({ error: "请先登录后再查看订正作答。" }, { status: 401 });
  }
  if (!isUuid(params.attemptId)) {
    return readingAttemptJson({ error: "无效的订正作答请求。" }, { status: 400 });
  }

  const { data: attempt, error: attemptError } = await auth.client
    .from("reading_wrongbook_attempts")
    .select("attempt_id,logical_item_id,task_type,status,scope,targets,elapsed_seconds,started_at,submitted_at,total_points,correct_points,source_full_set_id,source_attempt_id")
    .eq("attempt_id", params.attemptId)
    .maybeSingle();
  if (attemptError) return serverError("owned correction attempt", attemptError);
  if (!attempt) return readingAttemptJson({ error: "没有找到这次错题订正作答。" }, { status: 404 });
  if (attempt.status !== "submitted" || !attempt.submitted_at) {
    return readingAttemptJson({ error: "这次错题订正尚未提交。" }, { status: 409 });
  }

  const db = createServiceSupabase();
  if (attempt.task_type === "full_set") {
    try {
      const result = await loadReadingFullSetWrongbookReviewData({
        attempt: attempt as FullSetWrongbookAttemptRow,
        db
      });
      return readingAttemptJson({
        attempt: {
          attemptId: attempt.attempt_id,
          correctPoints: attempt.correct_points,
          elapsedSeconds: attempt.elapsed_seconds,
          sourceAttemptId: attempt.source_attempt_id,
          sourceFullSetId: attempt.source_full_set_id,
          status: "submitted",
          submittedAt: attempt.submitted_at,
          taskType: "full_set",
          title: result.title,
          totalPoints: attempt.total_points
        },
        disclosures: result.presentations,
        fullSet: true,
        occurrences: result.occurrences,
        reviewItems: result.reviewItems
      });
    } catch (error) {
      return serverError("Full Set correction review", asError(error));
    }
  }
  const targets = attempt.targets as ReadingWrongbookTarget[];
  // `lite=1`: the client already holds the practice's material content (and,
  // for RDL, its verified image/selection assets) from the practice itself, so
  // the review only needs the answer data. Skipping the content load keeps the
  // per-source request small — no material queries, no RDL image download —
  // which is what makes the session review feel instant when switching.
  const lite = new URL(request.url).searchParams.get("lite") === "1";
  let answerData;
  try {
    answerData = await Promise.all([
      db.from("reading_wrongbook_attempt_answers")
        .select("attempt_answer_id,question_id,slot_id,answer_kind,student_answer,is_correct,question_time_seconds")
        .eq("attempt_id", attempt.attempt_id),
      attempt.task_type === "ctw"
        ? loadReadingWrongbookPreservedAnswers({
            before: attempt.started_at,
            db,
            logicalItemId: attempt.logical_item_id,
            studentId: auth.userId,
            targets
          })
        : Promise.resolve([])
    ]);
  } catch (error) {
    return serverError("correction preserved answers", asError(error));
  }
  const [answerResult, preservedAnswers] = answerData;
  if (answerResult.error) return serverError("correction answers", answerResult.error);

  const correctionRows = (answerResult.data ?? []) as ReviewRow[];
  const rows = [...correctionRows, ...preservedAnswers] as ReviewRow[];
  // The session review renders the whole paragraph, so it can fill untargeted
  // CTW slots with the same read-only context the history practice shows. The
  // client asks for it explicitly (`context=1`) and it is only ever answered
  // for history-scope sessions; target answers are never part of it.
  const wantsContext = new URL(request.url).searchParams.get("context") === "1";
  let contextAnswers: Awaited<ReturnType<typeof loadReadingCtwContextAnswers>> = [];
  if (wantsContext && attempt.task_type === "ctw" && attempt.scope === "history") {
    try {
      contextAnswers = await loadReadingCtwContextAnswers({
        db,
        logicalItemId: attempt.logical_item_id,
        targets
      });
    } catch (contextError) {
      console.error("Reading correction review context answers load failed", {
        attemptId: params.attemptId,
        message: contextError instanceof Error ? contextError.message : "unknown"
      });
    }
  }
  const attemptSummary = {
    attemptId: attempt.attempt_id,
    logicalItemId: attempt.logical_item_id,
    taskType: attempt.task_type,
    status: "submitted",
    elapsedSeconds: attempt.elapsed_seconds,
    startedAt: attempt.started_at,
    submittedAt: attempt.submitted_at,
    totalPoints: attempt.total_points,
    correctPoints: attempt.correct_points,
    incorrectPoints: rows.filter((row) => isTargetRow(row, targets) && answered(row) && !row.is_correct).length,
    unansweredPoints: rows.filter((row) => isTargetRow(row, targets) && !answered(row)).length
  };
  if (lite) {
    try {
      return readingAttemptJson({
        attempt: attemptSummary,
        contextAnswers,
        correctionRows,
        disclosures: await loadReadingAnswerDisclosures(db, rows),
        lite: true,
        preservedRows: preservedAnswers
      });
    } catch (error) {
      return serverError("correction review lite", asError(error));
    }
  }

  let fullPractice: Awaited<ReturnType<typeof loadStudentReadingPractice>>;
  try {
    fullPractice = await loadStudentReadingPractice(db, attempt.logical_item_id);
  } catch (error) {
    if (error instanceof StudentReadingLoadError) {
      console.error("Reading correction review content load failed", {
        attemptId: params.attemptId,
        detail: error.message
      });
    }
    return readingAttemptJson({ error: "订正作答内容暂时无法显示。" }, { status: 500 });
  }

  const practice = selectReadingWrongbookPractice(fullPractice, targets);
  try {
    // Navigation items are exactly this attempt's scoring points (the drawn /
    // entry targets). Preserved rows only fill the rendered paragraph as
    // read-only context and must never become extra question numbers, so the
    // review keeps the same 1..N count as the result page.
    const reviewItems = buildSubmittedReadingReviewItems(practice, correctionRows);
    return readingAttemptJson({
      answers: buildSubmittedReadingAnswerState(practice, rows, {
        // A correction attempt only covers the drawn targets; CTW slots
        // outside the draw are displayed as unanswered blanks.
        tolerateMissingCtwSlots: true,
        contextAnswers
      }),
      attempt: attemptSummary,
      disclosures: await loadReadingAnswerDisclosures(db, rows),
      practice,
      reviewItems
    });
  } catch (error) {
    console.error("Reading correction review mapping failed", {
      attemptId: params.attemptId,
      message: error instanceof Error ? error.message : "unknown",
      taskType: attempt.task_type
    });
    return readingAttemptJson({ error: "订正作答数据暂时无法显示。" }, { status: 500 });
  }
}

function isTargetRow(row: ReviewRow, targets: ReadingWrongbookTarget[]) {
  return targets.some((target) =>
    target.questionId === row.question_id && target.slotId === row.slot_id
  );
}

function answered(row: ReviewRow) {
  return Boolean(row.student_answer?.trim());
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function serverError(scope: string, error: { message?: string } | null) {
  console.error("Reading correction review load failed", { scope, message: error?.message });
  return readingAttemptJson({ error: "订正作答加载失败，请稍后重试。" }, { status: 500 });
}

function asError(error: unknown) {
  return error instanceof Error ? error : null;
}

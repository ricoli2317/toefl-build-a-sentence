import { readingAttemptJson, requireReadingAttemptStudent } from "@/lib/reading/attemptServer";
import {
  buildSubmittedReadingAnswerState,
  type SubmittedReadingAnswerRow
} from "@/lib/reading/review";
import {
  loadStudentReadingPractice,
  StudentReadingLoadError
} from "@/lib/reading/studentPractice";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type ReviewAnswerRow = SubmittedReadingAnswerRow & { is_correct: boolean };

export async function GET(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client) {
    return readingAttemptJson({ error: "请先登录后再查看阅读作答。" }, { status: 401 });
  }
  if (!isUuid(params.attemptId)) {
    return readingAttemptJson({ error: "无效的阅读作答请求。" }, { status: 400 });
  }

  const { data: ownedAttempt, error: attemptError } = await auth.client
    .from("reading_attempts")
    .select("attempt_id,logical_item_id,task_type,status,elapsed_seconds,started_at,submitted_at,total_points,correct_points")
    .eq("attempt_id", params.attemptId)
    .maybeSingle();
  if (attemptError) return serverError("owned attempt", attemptError);
  if (!ownedAttempt) {
    return readingAttemptJson({ error: "没有找到这次阅读作答。" }, { status: 404 });
  }
  if (ownedAttempt.status !== "submitted" || !ownedAttempt.submitted_at) {
    return readingAttemptJson({ error: "这次阅读练习尚未提交。" }, { status: 409 });
  }

  const db = createServiceSupabase();
  let practiceResult: Awaited<ReturnType<typeof loadStudentReadingPractice>>;
  try {
    practiceResult = await loadStudentReadingPractice(db, ownedAttempt.logical_item_id);
  } catch (error) {
    if (error instanceof StudentReadingLoadError) {
      console.error("Submitted Reading review content load failed", {
        attemptId: params.attemptId,
        detail: error.message
      });
    }
    return readingAttemptJson({ error: "阅读作答内容暂时无法显示。" }, { status: 500 });
  }

  const answerResult = await db
    .from("reading_attempt_answers")
    .select("question_id,slot_id,answer_kind,student_answer,is_correct")
    .eq("attempt_id", ownedAttempt.attempt_id);
  if (answerResult.error) return serverError("submitted answers", answerResult.error);

  const rows = (answerResult.data ?? []) as ReviewAnswerRow[];
  try {
    const answers = buildSubmittedReadingAnswerState(practiceResult, rows);
    const unansweredPoints = rows.filter((row) => !normalizedAnswer(row.student_answer)).length;
    const incorrectPoints = rows.filter((row) => normalizedAnswer(row.student_answer) && !row.is_correct).length;
    return readingAttemptJson({
      answers,
      attempt: {
        attemptId: ownedAttempt.attempt_id,
        logicalItemId: ownedAttempt.logical_item_id,
        taskType: ownedAttempt.task_type,
        status: "submitted",
        elapsedSeconds: ownedAttempt.elapsed_seconds,
        startedAt: ownedAttempt.started_at,
        submittedAt: ownedAttempt.submitted_at,
        totalPoints: ownedAttempt.total_points,
        correctPoints: ownedAttempt.correct_points,
        incorrectPoints,
        unansweredPoints
      },
      practice: practiceResult
    });
  } catch (error) {
    console.error("Submitted Reading review mapping failed", {
      attemptId: params.attemptId,
      message: error instanceof Error ? error.message : "unknown"
    });
    return readingAttemptJson({ error: "阅读作答数据暂时无法显示。" }, { status: 500 });
  }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizedAnswer(value: string | null) {
  return value?.trim() ?? "";
}

function serverError(scope: string, error: { message?: string } | null) {
  console.error("Submitted Reading review load failed", { scope, message: error?.message });
  return readingAttemptJson({ error: "阅读作答加载失败，请稍后重试。" }, { status: 500 });
}

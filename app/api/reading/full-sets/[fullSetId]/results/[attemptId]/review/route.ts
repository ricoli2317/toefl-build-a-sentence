import {
  isFullSetId,
  isUuid,
  loadOwnedReadingFullSetAttempt,
  readingFullSetAttemptJson,
  requireReadingFullSetStudent
} from "@/lib/reading/fullSetAttemptServer";
import { loadReadingFullSetResult } from "@/lib/reading/fullSetResultServer";
import { buildReadingFullSetReviewItems } from "@/lib/reading/fullSetReview";
import { buildSubmittedReadingAnswerState } from "@/lib/reading/review";
import { loadStudentReadingPractice } from "@/lib/reading/studentPractice";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: { fullSetId: string; attemptId: string } }
) {
  const auth = await requireReadingFullSetStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client) return readingFullSetAttemptJson({ error: "请先登录。" }, { status: 401 });
  if (!isFullSetId(params.fullSetId) || !isUuid(params.attemptId)) {
    return readingFullSetAttemptJson({ error: "无效的套题作答请求。" }, { status: 400 });
  }
  const owned = await loadOwnedReadingFullSetAttempt(auth.client, params.attemptId);
  if (owned.error || !owned.attempt || owned.attempt.fullSetId !== params.fullSetId) {
    return readingFullSetAttemptJson({ error: "没有找到这次套题作答。" }, { status: 404 });
  }
  if (owned.attempt.status !== "completed" || !owned.attempt.completedAt) {
    return readingFullSetAttemptJson({ error: "这次套题练习尚未完成。" }, { status: 409 });
  }
  try {
    const db = createServiceSupabase();
    const result = await loadReadingFullSetResult(db, {
      attempt_id: owned.attempt.attemptId,
      full_set_id: owned.attempt.fullSetId,
      status: owned.attempt.status,
      completed_at: owned.attempt.completedAt
    });
    const occurrenceMetadata = Array.from(new Map(result.answers.map((answer) => [
      answer.occurrenceId,
      {
        logicalItemId: answer.logicalItemId,
        moduleNumber: answer.moduleNumber,
        occurrenceId: answer.occurrenceId
      }
    ])).values());
    const practices = await Promise.all(occurrenceMetadata.map((occurrence) =>
      loadStudentReadingPractice(db, occurrence.logicalItemId)
    ));
    const answerIds = result.answers.map((answer) => answer.answerId);
    const answerResult = await db.from("reading_full_set_answers")
      .select("answer_id,occurrence_id,question_id,slot_id,answer_kind,student_answer")
      .in("answer_id", answerIds);
    if (answerResult.error) throw new Error(answerResult.error.message);
    const submittedRows = answerResult.data ?? [];
    const occurrences = occurrenceMetadata.map((occurrence, index) => {
      const practice = practices[index];
      if (!practice) throw new Error("READING_FULL_SET_REVIEW_PRACTICE_MISSING");
      return {
        answers: buildSubmittedReadingAnswerState(
          practice,
          submittedRows.filter((row) => row.occurrence_id === occurrence.occurrenceId)
        ),
        moduleNumber: occurrence.moduleNumber,
        occurrenceId: occurrence.occurrenceId,
        practice
      };
    });
    const reviewBaseHref = `/student/reading/full-sets/${encodeURIComponent(params.fullSetId)}/result/${encodeURIComponent(params.attemptId)}/questions`;
    return readingFullSetAttemptJson({
      attempt: {
        attemptId: result.attempt.attemptId,
        fullSetId: result.attempt.fullSetId,
        title: result.attempt.title
      },
      occurrences,
      reviewItems: buildReadingFullSetReviewItems(
        result.answers,
        (sourceAnswerIndex) => `${reviewBaseHref}/${sourceAnswerIndex}`
      )
    });
  } catch (loadError) {
    console.error("Reading Full Set review load failed", {
      attemptId: params.attemptId,
      message: loadError instanceof Error ? loadError.message : "unknown"
    });
    return readingFullSetAttemptJson({ error: "套题作答加载失败，请稍后重试。" }, { status: 500 });
  }
}

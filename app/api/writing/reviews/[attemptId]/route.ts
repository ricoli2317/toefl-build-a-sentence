import { createServiceSupabase } from "@/lib/supabase/server";
import {
  StudentPublishedReviewError,
  loadStudentPublishedWritingReview
} from "@/lib/writingPublishedReviewServer";
import { requireWritingStudent, writingJson } from "@/lib/writingServer";
import {
  loadHistoricalPracticeDisplayResolver,
  logHistoricalPracticeDisplayWarnings
} from "@/lib/historicalPracticeDisplay";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  try {
    const auth = await requireWritingStudent(request);
    if (auth.error) return auth.error;
    if (!auth.userId) {
      return writingJson({ error: "Unauthorized" }, { status: 401 });
    }
    const supabase = createServiceSupabase();
    const [payload, historicalDisplayResolver] = await Promise.all([
      loadStudentPublishedWritingReview(supabase, auth.userId, params.attemptId),
      loadHistoricalPracticeDisplayResolver(supabase)
    ]);
    const display = historicalDisplayResolver.resolveWritingAttempt({
      assignmentId: payload.attempt.assignment_id,
      assignmentDisplayName: payload.question.set_title,
      fallbackDisplayName:
        payload.question.set_title || payload.attempt.set_id || payload.attempt.question_id,
      questionSource: payload.question_source,
      rawQuestionId: payload.attempt.question_id,
      taskType: payload.attempt.task_type
    });
    logHistoricalPracticeDisplayWarnings([display]);
    return writingJson({
      ...payload,
      display_name: display.displayName,
      logical_display_name: display.logicalDisplayName
    });
  } catch (error) {
    if (error instanceof StudentPublishedReviewError) {
      return writingJson(
        { code: error.code, error: error.message },
        { status: error.status }
      );
    }
    return writingJson(
      { error: "暂时无法加载批改结果，请稍后重试。" },
      { status: 500 }
    );
  }
}

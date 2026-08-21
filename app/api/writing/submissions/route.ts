import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { createServiceSupabase } from "@/lib/supabase/server";
import { WRITING_TASK_CONFIG } from "@/lib/writing";
import {
  WritingSubmissionHistoryError,
  loadWritingSubmissionHistory,
  type WritingSubmissionHistoryRepository
} from "@/lib/writingSubmissionHistory";
import {
  parseWritingTaskType,
  requireWritingStudent,
  writingJson
} from "@/lib/writingServer";
import {
  loadHistoricalPracticeDisplayResolver,
  logHistoricalPracticeDisplayWarnings
} from "@/lib/historicalPracticeDisplay";
import {
  createStudentPerformanceTrace,
  type StudentPerformanceTrace
} from "@/lib/studentPerformance.server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const timing = createStudentPerformanceTrace("/api/writing/submissions");
  const respond = (data: unknown, init?: ResponseInit) => writingJson(data, init, timing);
  try {
    const url = new URL(request.url);
    const taskType = parseWritingTaskType(url.searchParams.get("taskType"));
    const questionId = url.searchParams.get("questionId")?.trim() ?? "";
    if (!taskType || !questionId) {
      return respond({ error: "Invalid writing submission history request" }, { status: 400 });
    }
    const auth = await requireWritingStudent(request, timing);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.userId) {
      return respond({ error: "Unauthorized" }, { status: 401 });
    }
    const serviceSupabase = createServiceSupabase();
    const [payload, historicalDisplayResolver] = await Promise.all([
      loadWritingSubmissionHistory(
        { userId: auth.userId, taskType, questionId },
        createRepository(auth.supabase, serviceSupabase, timing),
        timing
      ),
      loadHistoricalPracticeDisplayResolver(serviceSupabase, timing)
    ]);
    const responsePayload = timing.measureSync("processing", "attach_submission_display_name", () => {
      const display = historicalDisplayResolver.resolveWritingAttempt({
        assignmentId: null,
        fallbackDisplayName: payload.question.set_title || questionId,
        rawQuestionId: questionId,
        taskType
      });
      logHistoricalPracticeDisplayWarnings([display]);
      return {
        ...payload,
        question: { ...payload.question, display_name: display.displayName }
      };
    });
    return respond(responsePayload);
  } catch (error) {
    if (error instanceof WritingSubmissionHistoryError) {
      return respond(
        { code: error.code, error: error.message },
        { status: error.status }
      );
    }
    return respond(
      { error: "暂时无法加载写作提交记录，请稍后重试。" },
      { status: 500 }
    );
  }
}

function createRepository(
  ownedSupabase: NonNullable<Awaited<ReturnType<typeof requireWritingStudent>>["supabase"]>,
  serviceSupabase: ReturnType<typeof createServiceSupabase>,
  timing: StudentPerformanceTrace
): WritingSubmissionHistoryRepository {
  return {
    async findOwnedSubmittedAttempts({ userId, taskType, questionId }) {
      const result = await timing.measure("database", "writing_attempts_submission_history", () =>
        readAllSupabaseRows<{
        attempt_id: string;
        submitted_at: string | null;
        word_count: number;
        writing_mode: "exam" | "practice" | null;
        elapsed_seconds: number | null;
        }>((from, to) =>
          ownedSupabase
            .from("writing_attempts")
            .select("attempt_id,submitted_at,word_count,writing_mode,elapsed_seconds")
            .eq("user_id", userId)
            .eq("task_type", taskType)
            .eq("question_id", questionId)
            .eq("status", "submitted")
            .order("submitted_at", { ascending: false })
            .order("attempt_id", { ascending: false })
            .range(from, to)
        )
      );
      return { data: result.data ?? [], error: result.error };
    },
    async findPublishedAttemptIds(attemptIds) {
      const result = await timing.measure("database", "writing_reviews_submission_history", () =>
        readAllSupabaseRows<{ attempt_id: string }>((from, to) =>
          serviceSupabase
            .from("writing_reviews")
            .select("attempt_id")
            .eq("status", "published")
            .in("attempt_id", attemptIds)
            .not("published_at", "is", null)
            .range(from, to)
        )
      );
      return {
        data: (result.data ?? []).map((review) => review.attempt_id),
        error: result.error
      };
    },
    async findQuestion({ taskType, questionId }) {
      const { data, error } = await timing.measure(
        "database",
        `${WRITING_TASK_CONFIG[taskType].questionTable}_submission_history`,
        () => ownedSupabase
          .from(WRITING_TASK_CONFIG[taskType].questionTable)
          .select("question_id,set_title,year_month")
          .eq("question_id", questionId)
          .maybeSingle()
      );
      return { data, error };
    }
  };
}

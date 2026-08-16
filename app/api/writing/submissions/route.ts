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

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const taskType = parseWritingTaskType(url.searchParams.get("taskType"));
    const questionId = url.searchParams.get("questionId")?.trim() ?? "";
    if (!taskType || !questionId) {
      return writingJson({ error: "Invalid writing submission history request" }, { status: 400 });
    }
    const auth = await requireWritingStudent(request);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.userId) {
      return writingJson({ error: "Unauthorized" }, { status: 401 });
    }
    const payload = await loadWritingSubmissionHistory(
      { userId: auth.userId, taskType, questionId },
      createRepository(auth.supabase, createServiceSupabase())
    );
    return writingJson(payload);
  } catch (error) {
    if (error instanceof WritingSubmissionHistoryError) {
      return writingJson(
        { code: error.code, error: error.message },
        { status: error.status }
      );
    }
    return writingJson(
      { error: "暂时无法加载写作提交记录，请稍后重试。" },
      { status: 500 }
    );
  }
}

function createRepository(
  ownedSupabase: NonNullable<Awaited<ReturnType<typeof requireWritingStudent>>["supabase"]>,
  serviceSupabase: ReturnType<typeof createServiceSupabase>
): WritingSubmissionHistoryRepository {
  return {
    async findOwnedSubmittedAttempts({ userId, taskType, questionId }) {
      const result = await readAllSupabaseRows<{
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
      );
      return { data: result.data ?? [], error: result.error };
    },
    async findPublishedAttemptIds(attemptIds) {
      const result = await readAllSupabaseRows<{ attempt_id: string }>((from, to) =>
        serviceSupabase
          .from("writing_reviews")
          .select("attempt_id")
          .eq("status", "published")
          .in("attempt_id", attemptIds)
          .not("published_at", "is", null)
          .range(from, to)
      );
      return {
        data: (result.data ?? []).map((review) => review.attempt_id),
        error: result.error
      };
    },
    async findQuestion({ taskType, questionId }) {
      const { data, error } = await ownedSupabase
        .from(WRITING_TASK_CONFIG[taskType].questionTable)
        .select("question_id,set_title,year_month")
        .eq("question_id", questionId)
        .maybeSingle();
      return { data, error };
    }
  };
}

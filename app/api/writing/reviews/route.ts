import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { createServiceSupabase } from "@/lib/supabase/server";
import { WRITING_TASK_CONFIG, type WritingTaskType } from "@/lib/writing";
import { requireWritingStudent, writingJson } from "@/lib/writingServer";

export const dynamic = "force-dynamic";

type AttemptRow = {
  attempt_id: string;
  task_type: WritingTaskType;
  question_id: string;
  set_id: string;
  submitted_at: string | null;
};

type ReviewRow = { attempt_id: string; published_at: string };
type QuestionRow = { question_id: string; set_title: string; year_month: string };

export async function GET(request: Request) {
  try {
    const auth = await requireWritingStudent(request);
    if (auth.error) return auth.error;
    if (!auth.userId) {
      return writingJson({ error: "Unauthorized" }, { status: 401 });
    }
    const supabase = createServiceSupabase();
    const attemptResult = await readAllSupabaseRows<AttemptRow>((from, to) =>
      supabase
        .from("writing_attempts")
        .select("attempt_id,task_type,question_id,set_id,submitted_at")
        .eq("user_id", auth.userId!)
        .eq("status", "submitted")
        .order("submitted_at", { ascending: false })
        .range(from, to)
    );
    if (attemptResult.error) {
      return writingJson({ error: "暂时无法加载批改记录。" }, { status: 500 });
    }
    const attempts = attemptResult.data ?? [];
    if (attempts.length === 0) return writingJson({ reviews: [] });

    const reviewResult = await readAllSupabaseRows<ReviewRow>((from, to) =>
      supabase
        .from("writing_reviews")
        .select("attempt_id,published_at")
        .eq("status", "published")
        .in("attempt_id", attempts.map((attempt) => attempt.attempt_id))
        .not("published_at", "is", null)
        .order("published_at", { ascending: false })
        .range(from, to)
    );
    if (reviewResult.error) {
      return writingJson({ error: "暂时无法加载批改记录。" }, { status: 500 });
    }
    const publishedByAttempt = new Map(
      (reviewResult.data ?? []).map((review) => [review.attempt_id, review.published_at])
    );
    const publishedAttempts = attempts.filter((attempt) =>
      publishedByAttempt.has(attempt.attempt_id)
    );
    if (publishedAttempts.length === 0) return writingJson({ reviews: [] });

    const questionMaps = await Promise.all(
      (["email", "academic_discussion"] as const).map(async (taskType) => {
        const questionIds = Array.from(
          new Set(
            publishedAttempts
              .filter((attempt) => attempt.task_type === taskType)
              .map((attempt) => attempt.question_id)
          )
        );
        if (questionIds.length === 0) return [taskType, new Map<string, QuestionRow>()] as const;
        const result = await readAllSupabaseRows<QuestionRow>((from, to) =>
          supabase
            .from(WRITING_TASK_CONFIG[taskType].questionTable)
            .select("question_id,set_title,year_month")
            .in("question_id", questionIds)
            .range(from, to)
        );
        if (result.error) throw new Error("question read failed");
        return [
          taskType,
          new Map((result.data ?? []).map((question) => [question.question_id, question]))
        ] as const;
      })
    );
    const questionByType = new Map(questionMaps);
    const reviews = publishedAttempts
      .map((attempt) => {
        const question = questionByType.get(attempt.task_type)?.get(attempt.question_id);
        if (!question) return null;
        return {
          attempt_id: attempt.attempt_id,
          task_type: attempt.task_type,
          set_id: attempt.set_id,
          set_title: question.set_title,
          year_month: question.year_month,
          submitted_at: attempt.submitted_at,
          published_at: publishedByAttempt.get(attempt.attempt_id)
        };
      })
      .filter(Boolean)
      .sort(
        (left, right) =>
          Date.parse(right?.published_at ?? "") - Date.parse(left?.published_at ?? "")
      );
    return writingJson({ reviews });
  } catch (error) {
    return writingJson({ error: "暂时无法加载批改记录。" }, { status: 500 });
  }
}

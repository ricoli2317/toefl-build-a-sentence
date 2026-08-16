import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  compareWritingSetTitles,
  formatWritingMonthLabel,
  WRITING_TASK_CONFIG,
  type WritingAttempt,
  type WritingCatalogSet,
} from "@/lib/writing";
import {
  parseWritingTaskType,
  requireWritingStudent,
  writingJson
} from "@/lib/writingServer";
import { buildWritingSubmissionHistory } from "@/lib/writingSubmissionHistory";

export const dynamic = "force-dynamic";

type QuestionCatalogRow = {
  question_id: string;
  set_id: string;
  set_title: string;
  year_month: string;
};

export async function GET(request: Request) {
  try {
    const taskType = parseWritingTaskType(new URL(request.url).searchParams.get("taskType"));
    if (!taskType) return writingJson({ error: "Invalid writing task type" }, { status: 400 });

    const auth = await requireWritingStudent(request);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.userId) return writingJson({ error: "Unauthorized" }, { status: 401 });

    const [questionResult, attemptResult] = await Promise.all([
      readAllSupabaseRows<QuestionCatalogRow>((from, to) =>
        auth.supabase!
          .from(WRITING_TASK_CONFIG[taskType].questionTable)
          .select("question_id,set_id,set_title,year_month")
          .order("year_month", { ascending: false })
          .order("set_title", { ascending: true })
          .range(from, to)
      ),
      readAllSupabaseRows<WritingAttempt>((from, to) =>
        auth.supabase!
          .from("writing_attempts")
          .select(
            "attempt_id,user_id,task_type,question_id,set_id,response_text,word_count,status,time_limit_seconds,remaining_seconds,writing_mode,elapsed_seconds,overtime_ranges,started_at,saved_at,submitted_at,created_at,updated_at"
          )
          .eq("user_id", auth.userId!)
          .eq("task_type", taskType)
          .order("updated_at", { ascending: false })
          .range(from, to)
      )
    ]);

    if (questionResult.error) {
      return writingJson({ error: questionResult.error.message }, { status: 500 });
    }
    if (attemptResult.error) {
      return writingJson({ error: attemptResult.error.message }, { status: 500 });
    }

    const attempts = attemptResult.data ?? [];
    const submittedAttemptIds = attempts
      .filter((attempt) => attempt.status === "submitted")
      .map((attempt) => attempt.attempt_id);
    const publishedAttemptIds = new Set<string>();
    if (submittedAttemptIds.length > 0) {
      const service = createServiceSupabase();
      const publishedResult = await readAllSupabaseRows<{ attempt_id: string }>((from, to) =>
        service
          .from("writing_reviews")
          .select("attempt_id")
          .eq("status", "published")
          .in("attempt_id", submittedAttemptIds)
          .not("published_at", "is", null)
          .range(from, to)
      );
      if (publishedResult.error) {
        return writingJson({ error: "暂时无法加载写作批改状态。" }, { status: 500 });
      }
      for (const review of publishedResult.data ?? []) {
        publishedAttemptIds.add(review.attempt_id);
      }
    }

    const attemptsByQuestion = new Map<string, WritingAttempt[]>();
    for (const attempt of attempts) {
      attemptsByQuestion.set(attempt.question_id, [
        ...(attemptsByQuestion.get(attempt.question_id) ?? []),
        attempt
      ]);
    }

    const sets: WritingCatalogSet[] = (questionResult.data ?? [])
      .map((question) => {
        const attempts = attemptsByQuestion.get(question.question_id) ?? [];
        const draft = attempts.find((attempt) => attempt.status === "draft") ?? null;
        const submittedAttempts = buildWritingSubmissionHistory(
          attempts
            .filter((attempt) => attempt.status === "submitted")
            .map((attempt) => ({
              attempt_id: attempt.attempt_id,
              submitted_at: attempt.submitted_at,
              word_count: attempt.word_count,
              writing_mode: attempt.writing_mode,
              elapsed_seconds: attempt.elapsed_seconds
            })),
          publishedAttemptIds
        );
        const submitted = submittedAttempts[0] ?? null;
        return {
          question_id: String(question.question_id),
          set_id: String(question.set_id),
          set_title: question.set_title,
          year_month: question.year_month,
          status: draft
            ? ("draft" as const)
            : submitted
              ? ("submitted" as const)
              : ("not_started" as const),
          draft_attempt_id: draft?.attempt_id ?? null,
          draft_word_count: draft?.word_count ?? null,
          draft_saved_at: draft?.saved_at ?? draft?.updated_at ?? null,
          submitted_attempt_id: submitted?.attempt_id ?? null,
          submitted_at: submitted?.submitted_at ?? null,
          submitted_attempt_count: submittedAttempts.length,
          published_review_attempt_id:
            submitted?.has_published_review
              ? submitted.attempt_id
              : null
        };
      })
      .sort(
        (left, right) =>
          Number(right.year_month) - Number(left.year_month) ||
          compareWritingSetTitles(left.set_title, right.set_title)
      );

    const monthMap = new Map<string, number>();
    for (const set of sets) monthMap.set(set.year_month, (monthMap.get(set.year_month) ?? 0) + 1);
    const months = Array.from(monthMap, ([monthKey, setCount]) => ({
      month_key: monthKey,
      month_label: formatWritingMonthLabel(monthKey),
      set_count: setCount
    })).sort((left, right) => Number(left.month_key) - Number(right.month_key));
    const latestDraft = [...sets]
      .filter((set) => set.status === "draft")
      .sort((left, right) => Date.parse(right.draft_saved_at ?? "") - Date.parse(left.draft_saved_at ?? ""))[0] ?? null;

    return writingJson({ latestDraft, months, sets });
  } catch (error) {
    return writingJson(
      { error: error instanceof Error ? error.message : "Could not load writing catalog." },
      { status: 500 }
    );
  }
}

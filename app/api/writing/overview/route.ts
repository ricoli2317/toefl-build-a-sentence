import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { createServiceSupabase } from "@/lib/supabase/server";
import { requireWritingStudent, writingJson } from "@/lib/writingServer";

export const dynamic = "force-dynamic";

type SubmittedAttemptRow = {
  attempt_id: string;
  status: "submitted";
  submitted_at: string | null;
};

export async function GET(request: Request) {
  try {
    const auth = await requireWritingStudent(request);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.userId) return writingJson({ error: "Unauthorized" }, { status: 401 });

    const result = await readAllSupabaseRows<SubmittedAttemptRow>((from, to) =>
      auth.supabase!
        .from("writing_attempts")
        .select("attempt_id,status,submitted_at")
        .eq("user_id", auth.userId!)
        .eq("status", "submitted")
        .order("submitted_at", { ascending: false })
        .range(from, to)
    );
    if (result.error) return writingJson({ error: result.error.message }, { status: 500 });

    const attempts = result.data ?? [];
    let pendingFeedbackCount = 0;
    if (attempts.length > 0) {
      const service = createServiceSupabase();
      const reviewResult = await readAllSupabaseRows<{ attempt_id: string }>((from, to) =>
        service
          .from("writing_reviews")
          .select("attempt_id")
          .eq("status", "published")
          .in("attempt_id", attempts.map((attempt) => attempt.attempt_id))
          .not("published_at", "is", null)
          .range(from, to)
      );
      if (reviewResult.error) {
        return writingJson({ error: "暂时无法加载写作批改概览。" }, { status: 500 });
      }
      pendingFeedbackCount = reviewResult.data?.length ?? 0;
    }
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth();
    const learningDates = Array.from(
      new Set(
        attempts.flatMap((attempt) => {
          if (!attempt.submitted_at) return [];
          const date = new Date(attempt.submitted_at);
          return Number.isNaN(date.getTime()) ? [] : [localDateKey(date)];
        })
      )
    );
    const currentMonthCount = attempts.filter((attempt) => {
      if (!attempt.submitted_at) return false;
      const date = new Date(attempt.submitted_at);
      return date.getFullYear() === currentYear && date.getMonth() === currentMonth;
    }).length;

    return writingJson({
      submittedCount: attempts.length,
      currentMonthCount,
      learningDates,
      pendingFeedbackCount
    });
  } catch (error) {
    return writingJson(
      { error: error instanceof Error ? error.message : "Could not load writing overview." },
      { status: 500 }
    );
  }
}

function localDateKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(
    date.getDate()
  ).padStart(2, "0")}`;
}

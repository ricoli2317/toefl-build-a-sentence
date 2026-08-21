import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { createServiceSupabase } from "@/lib/supabase/server";
import { requireWritingStudent, writingJson } from "@/lib/writingServer";
import { createStudentPerformanceTrace } from "@/lib/studentPerformance.server";

export const dynamic = "force-dynamic";

type SubmittedAttemptRow = {
  attempt_id: string;
  status: "submitted";
  submitted_at: string | null;
};

export async function GET(request: Request) {
  const timing = createStudentPerformanceTrace("/api/writing/overview");
  const respond = (data: unknown, init?: ResponseInit) => writingJson(data, init, timing);
  try {
    const auth = await requireWritingStudent(request, timing);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.userId) return respond({ error: "Unauthorized" }, { status: 401 });

    const result = await timing.measure("database", "writing_attempts_submitted_overview", () =>
      readAllSupabaseRows<SubmittedAttemptRow>((from, to) =>
        auth.supabase!
          .from("writing_attempts")
          .select("attempt_id,status,submitted_at")
          .eq("user_id", auth.userId!)
          .eq("status", "submitted")
          .order("submitted_at", { ascending: false })
          .range(from, to)
      )
    );
    if (result.error) return respond({ error: result.error.message }, { status: 500 });

    const attempts = result.data ?? [];
    let pendingFeedbackCount = 0;
    if (attempts.length > 0) {
      const service = createServiceSupabase();
      const reviewResult = await timing.measure("database", "writing_reviews_published_overview", () =>
        readAllSupabaseRows<{ attempt_id: string }>((from, to) =>
          service
            .from("writing_reviews")
            .select("attempt_id")
            .eq("status", "published")
            .in("attempt_id", attempts.map((attempt) => attempt.attempt_id))
            .not("published_at", "is", null)
            .range(from, to)
        )
      );
      if (reviewResult.error) {
        return respond({ error: "暂时无法加载写作批改概览。" }, { status: 500 });
      }
      pendingFeedbackCount = reviewResult.data?.length ?? 0;
    }
    const payload = timing.measureSync("processing", "build_writing_overview_payload", () => {
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

    return {
      submittedCount: attempts.length,
      currentMonthCount,
      learningDates,
      pendingFeedbackCount
    };
    });
    return respond(payload);
  } catch (error) {
    return respond(
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

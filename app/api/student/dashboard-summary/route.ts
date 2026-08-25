import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { loadCachedPublicPracticeCatalog } from "@/lib/practiceCatalogCache.server";
import { loadLogicalPracticeStudentAttempts } from "@/lib/practiceLogicalCatalog";
import { createServiceSupabase } from "@/lib/supabase/server";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import {
  buildStudentDashboardSummary,
  latestDashboardDraft,
  type StudentDashboardWritingAttemptRow
} from "@/lib/studentDashboardSummary";
import { createStudentPerformanceTrace } from "@/lib/studentPerformance.server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const timing = createStudentPerformanceTrace("/api/student/dashboard-summary");
  const respond = (data: unknown, init?: ResponseInit) =>
    NextResponse.json(data, {
      ...init,
      headers: timing.finishHeaders({ ...init?.headers, "Cache-Control": "no-store" })
    });

  try {
    const auth = await timing.measure("auth", "require_student", () =>
      requireUserWithRole(bearerToken(request), "student")
    );
    if (auth.error || !auth.userId) {
      return respond({ error: auth.error ?? "Unauthorized" }, { status: 401 });
    }

    const db = createServiceSupabase();
    const [buildSentenceCatalog, buildSentenceState, writingResult] = await Promise.all([
      timing.measure("cache", "public_build_sentence_catalog", () =>
        loadCachedPublicPracticeCatalog("build_sentence")
      ),
      loadLogicalPracticeStudentAttempts({
        supabase: db,
        studentId: auth.userId,
        taskType: "build_sentence",
        timing
      }),
      timing.measure("database", "writing_attempts_dashboard", () =>
        readAllSupabaseRows<StudentDashboardWritingAttemptRow>((from, to) =>
          db
            .from("writing_attempts")
            .select(
              "attempt_id,assignment_id,task_type,question_id,word_count,status,saved_at,submitted_at,created_at,updated_at"
            )
            .eq("user_id", auth.userId!)
            .order("updated_at", { ascending: false })
            .order("attempt_id", { ascending: false })
            .range(from, to)
        )
      )
    ]);
    if (writingResult.error) {
      return respond({ error: writingResult.error.message }, { status: 500 });
    }

    const writingAttempts = writingResult.data ?? [];
    const emailDraft = latestDashboardDraft(writingAttempts, "email");
    const discussionDraft = latestDashboardDraft(
      writingAttempts,
      "academic_discussion"
    );
    const submittedAttemptIds = writingAttempts
      .filter((attempt) => attempt.status === "submitted")
      .map((attempt) => attempt.attempt_id);

    const [emailTitle, discussionTitle, publishedResult] = await Promise.all([
      loadDraftTitle(db, "email_questions", emailDraft?.question_id ?? null, timing),
      loadDraftTitle(
        db,
        "academic_discussion_questions",
        discussionDraft?.question_id ?? null,
        timing
      ),
      submittedAttemptIds.length === 0
        ? Promise.resolve({ data: [] as Array<{ attempt_id: string }>, error: null })
        : timing.measure("database", "writing_reviews_published_dashboard", () =>
            readAllSupabaseRows<{ attempt_id: string }>((from, to) =>
              db
                .from("writing_reviews")
                .select("attempt_id")
                .eq("status", "published")
                .in("attempt_id", submittedAttemptIds)
                .not("published_at", "is", null)
                .range(from, to)
            )
          )
    ]);
    if (publishedResult.error) {
      return respond({ error: "暂时无法加载写作批改概览。" }, { status: 500 });
    }

    return respond(
      timing.measureSync("processing", "build_student_dashboard_summary", () =>
        buildStudentDashboardSummary({
          buildSentenceAttempts: buildSentenceState.buildSentenceAttempts ?? [],
          buildSentenceCatalog,
          draftDisplayNames: {
            email: emailTitle,
            academic_discussion: discussionTitle
          },
          pendingFeedbackCount: publishedResult.data?.length ?? 0,
          writingAttempts
        })
      )
    );
  } catch (error) {
    return respond(
      { error: error instanceof Error ? error.message : "Could not load student dashboard." },
      { status: 500 }
    );
  }
}

async function loadDraftTitle(
  db: ReturnType<typeof createServiceSupabase>,
  table: "email_questions" | "academic_discussion_questions",
  questionId: string | null,
  timing: ReturnType<typeof createStudentPerformanceTrace>
) {
  if (!questionId) return undefined;
  const result = await timing.measure("database", `${table}_latest_draft_title`, () =>
    db.from(table).select("set_title").eq("question_id", questionId).maybeSingle()
  );
  if (result.error) throw new Error(result.error.message);
  return result.data?.set_title?.trim() || questionId;
}

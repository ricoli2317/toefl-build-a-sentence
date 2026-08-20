import { buildWritingAttemptUpdate } from "@/lib/writing";
import { normalizeWritingOvertimeRanges } from "@/lib/writingOvertime";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  clampRemainingSeconds,
  readOwnedWritingAttempt,
  readWritingQuestion,
  requireWritingStudent,
  writingJson
} from "@/lib/writingServer";
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
    if (!auth.supabase || !auth.userId) return writingJson({ error: "Unauthorized" }, { status: 401 });

    const attemptResult = await readOwnedWritingAttempt(
      auth.supabase,
      auth.userId,
      params.attemptId
    );
    if (attemptResult.error) return writingJson({ error: attemptResult.error.message }, { status: 500 });
    if (!attemptResult.data) return writingJson({ error: "Writing attempt not found" }, { status: 404 });
    const submissionOnly =
      new URL(request.url).searchParams.get("mode") === "submission";
    if (submissionOnly && attemptResult.data.status !== "submitted") {
      return writingJson({ error: "Submitted writing attempt not found" }, { status: 404 });
    }
    if (attemptResult.data.status === "draft" && attemptResult.data.assignment_id) {
      const assignmentAvailable = await isAssignmentAvailable(
        auth.supabase,
        attemptResult.data.assignment_id
      );
      if (!assignmentAvailable) {
        return writingJson({ error: "这项作业已撤回，不能继续作答。" }, { status: 409 });
      }
    }
    const questionResult = await readWritingQuestion(
      auth.supabase,
      attemptResult.data.task_type,
      attemptResult.data.question_id,
      attemptResult.data.assignment_id
    );
    if (questionResult.error) return writingJson({ error: questionResult.error.message }, { status: 500 });
    if (!questionResult.data) return writingJson({ error: "Writing question not found" }, { status: 404 });

    let hasPublishedReview = false;
    const serviceSupabase = createServiceSupabase();
    if (attemptResult.data.status === "submitted") {
      const reviewResult = await serviceSupabase
        .from("writing_reviews")
        .select("attempt_id")
        .eq("attempt_id", attemptResult.data.attempt_id)
        .eq("status", "published")
        .not("published_at", "is", null)
        .maybeSingle();
      if (reviewResult.error) {
        return writingJson({ error: "暂时无法加载批改状态。" }, { status: 500 });
      }
      hasPublishedReview = Boolean(reviewResult.data);
    }
    const historicalDisplay = submissionOnly
      ? (await loadHistoricalPracticeDisplayResolver(serviceSupabase)).resolveWritingAttempt({
          assignmentId: attemptResult.data.assignment_id ?? null,
          assignmentDisplayName: questionResult.data.set_title,
          fallbackDisplayName:
            questionResult.data.set_title ||
            attemptResult.data.set_id ||
            attemptResult.data.question_id,
          questionSource: questionResult.questionSource,
          rawQuestionId: attemptResult.data.question_id,
          taskType: attemptResult.data.task_type
        })
      : null;
    if (historicalDisplay) logHistoricalPracticeDisplayWarnings([historicalDisplay]);

    return writingJson({
      attempt: attemptResult.data,
      question: questionResult.data,
      display_name: historicalDisplay?.displayName,
      question_source: questionResult.questionSource,
      assignment_available: questionResult.assignmentAvailable ?? true,
      has_published_review: hasPublishedReview
    });
  } catch (error) {
    return writingJson(
      { error: error instanceof Error ? error.message : "Could not load writing attempt." },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  try {
    const auth = await requireWritingStudent(request);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.userId) return writingJson({ error: "Unauthorized" }, { status: 401 });

    const body = (await request.json()) as {
      action?: unknown;
      remainingSeconds?: unknown;
      responseText?: unknown;
      elapsedSeconds?: unknown;
      overtimeRanges?: unknown;
    };
    const action = body.action;
    if (action !== "sync" && action !== "save" && action !== "submit") {
      return writingJson({ error: "Invalid writing attempt action" }, { status: 400 });
    }

    const attemptResult = await readOwnedWritingAttempt(
      auth.supabase,
      auth.userId,
      params.attemptId
    );
    if (attemptResult.error) return writingJson({ error: attemptResult.error.message }, { status: 500 });
    const attempt = attemptResult.data;
    if (!attempt) return writingJson({ error: "Writing attempt not found" }, { status: 404 });

    if (attempt.status === "submitted") {
      if (action === "submit") return writingJson({ attempt, alreadySubmitted: true });
      return writingJson({ error: "Submitted writing attempts cannot be modified." }, { status: 409 });
    }
    if (attempt.assignment_id) {
      const assignmentAvailable = await isAssignmentAvailable(auth.supabase, attempt.assignment_id);
      if (!assignmentAvailable) {
        return writingJson({ error: "这项作业已撤回，不能继续作答。" }, { status: 409 });
      }
    }
    const requestedRemaining = clampRemainingSeconds(
      body.remainingSeconds,
      attempt.time_limit_seconds
    );
    const requestedElapsed = Number(body.elapsedSeconds);
    const elapsedSeconds = Math.max(
      attempt.elapsed_seconds ?? 0,
      Number.isFinite(requestedElapsed) && requestedElapsed >= 0
        ? Math.floor(requestedElapsed)
        : attempt.elapsed_seconds ?? 0
    );
    const practiceMode = attempt.writing_mode === "practice";
    const remainingSeconds = practiceMode
      ? attempt.remaining_seconds
      : Math.min(attempt.remaining_seconds, requestedRemaining);
    const responseText = typeof body.responseText === "string" ? body.responseText : attempt.response_text;
    const overtimeRanges = practiceMode
      ? normalizeWritingOvertimeRanges(body.overtimeRanges, responseText.length)
      : [];
    const now = new Date().toISOString();
    const update = buildWritingAttemptUpdate({
      action,
      now,
      elapsedSeconds,
      overtimeRanges,
      remainingSeconds,
      responseText
    });
    if (!update) {
      return writingJson({ error: "responseText is required" }, { status: 400 });
    }

    const { data, error } = await auth.supabase
      .from("writing_attempts")
      .update(update)
      .eq("attempt_id", attempt.attempt_id)
      .eq("user_id", auth.userId)
      .eq("status", "draft")
      .select("*")
      .single();
    if (error || !data) {
      return writingJson({ error: "写作记录保存失败，请稍后重试。" }, { status: 500 });
    }

    return writingJson({ attempt: data });
  } catch (error) {
    return writingJson(
      { error: "写作记录保存失败，请稍后重试。" },
      { status: 500 }
    );
  }
}

async function isAssignmentAvailable(
  supabase: NonNullable<Awaited<ReturnType<typeof requireWritingStudent>>["supabase"]>,
  assignmentId: string
) {
  const { data, error } = await supabase
    .from("writing_assignments")
    .select("assignment_id")
    .eq("assignment_id", assignmentId)
    .eq("status", "active")
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

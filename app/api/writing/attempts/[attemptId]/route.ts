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
  createHistoricalPracticeDisplayResolver,
  loadWritingHistoricalPracticeDisplayResolver,
  logHistoricalPracticeDisplayWarnings
} from "@/lib/historicalPracticeDisplay";
import { createStudentPerformanceTrace } from "@/lib/studentPerformance.server";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  const timing = createStudentPerformanceTrace("/api/writing/attempts/[attemptId]");
  const respond = (data: unknown, init?: ResponseInit) => writingJson(data, init, timing);
  try {
    const auth = await requireWritingStudent(request, timing);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.userId) return respond({ error: "Unauthorized" }, { status: 401 });

    const attemptResult = await readOwnedWritingAttempt(
      auth.supabase,
      auth.userId,
      params.attemptId,
      timing
    );
    if (attemptResult.error) return respond({ error: attemptResult.error.message }, { status: 500 });
    if (!attemptResult.data) return respond({ error: "Writing attempt not found" }, { status: 404 });
    const submissionOnly =
      new URL(request.url).searchParams.get("mode") === "submission";
    if (submissionOnly && attemptResult.data.status !== "submitted") {
      return respond({ error: "Submitted writing attempt not found" }, { status: 404 });
    }
    if (attemptResult.data.status === "draft" && attemptResult.data.assignment_id) {
      const assignmentAvailable = await isAssignmentAvailable(
        auth.supabase,
        attemptResult.data.assignment_id,
        timing
      );
      if (!assignmentAvailable) {
        return respond({ error: "这项作业已撤回，不能继续作答。" }, { status: 409 });
      }
    }
    const questionResult = await readWritingQuestion(
      auth.supabase,
      attemptResult.data.task_type,
      attemptResult.data.question_id,
      attemptResult.data.assignment_id,
      timing
    );
    if (questionResult.error) return respond({ error: questionResult.error.message }, { status: 500 });
    if (!questionResult.data) return respond({ error: "Writing question not found" }, { status: 404 });

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
        return respond({ error: "暂时无法加载批改状态。" }, { status: 500 });
      }
      hasPublishedReview = Boolean(reviewResult.data);
    }
    const displayResolver = questionResult.questionSource === "custom"
      ? createHistoricalPracticeDisplayResolver({ items: [], sources: [] })
      : await loadWritingHistoricalPracticeDisplayResolver(
          serviceSupabase,
          attemptResult.data.task_type,
          [attemptResult.data.question_id],
          timing
        );
    const historicalDisplay = displayResolver.resolveWritingAttempt({
      assignmentId: attemptResult.data.assignment_id ?? null,
      assignmentDisplayName: questionResult.data.set_title,
      fallbackDisplayName:
        questionResult.data.set_title ||
        attemptResult.data.set_id ||
        attemptResult.data.question_id,
      questionSource: questionResult.questionSource,
      rawQuestionId: attemptResult.data.question_id,
      taskType: attemptResult.data.task_type
    });
    logHistoricalPracticeDisplayWarnings([historicalDisplay]);

    const payload = timing.measureSync("processing", "build_writing_practice_payload", () => ({
      attempt: attemptResult.data,
      question: questionResult.data,
      display_name: historicalDisplay.displayName,
      question_source: questionResult.questionSource,
      assignment_available: questionResult.assignmentAvailable ?? true,
      has_published_review: hasPublishedReview
    }));
    return respond(payload);
  } catch (error) {
    return respond(
      { error: error instanceof Error ? error.message : "Could not load writing attempt." },
      { status: 500 }
    );
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  const timing = createStudentPerformanceTrace("/api/writing/attempts/[attemptId]");
  const respond = (data: unknown, init?: ResponseInit) => writingJson(data, init, timing);
  try {
    const auth = await requireWritingStudent(request, timing);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.userId) return respond({ error: "Unauthorized" }, { status: 401 });

    const body = await timing.measure("processing", "parse_writing_attempt_update", () =>
      request.json() as Promise<{
        action?: unknown;
        remainingSeconds?: unknown;
        responseText?: unknown;
        elapsedSeconds?: unknown;
        overtimeRanges?: unknown;
      }>
    );
    const action = body.action;
    if (action !== "sync" && action !== "save" && action !== "submit") {
      return respond({ error: "Invalid writing attempt action" }, { status: 400 });
    }

    const attemptResult = await readOwnedWritingAttempt(
      auth.supabase,
      auth.userId,
      params.attemptId,
      timing
    );
    if (attemptResult.error) return respond({ error: attemptResult.error.message }, { status: 500 });
    const attempt = attemptResult.data;
    if (!attempt) return respond({ error: "Writing attempt not found" }, { status: 404 });

    if (attempt.status === "submitted") {
      if (action === "submit") return respond({ attempt, alreadySubmitted: true });
      return respond({ error: "Submitted writing attempts cannot be modified." }, { status: 409 });
    }
    if (attempt.assignment_id) {
      const assignmentAvailable = await isAssignmentAvailable(
        auth.supabase,
        attempt.assignment_id,
        timing
      );
      if (!assignmentAvailable) {
        return respond({ error: "这项作业已撤回，不能继续作答。" }, { status: 409 });
      }
    }
    const update = timing.measureSync("processing", "prepare_writing_attempt_update", () => {
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
      const responseText = typeof body.responseText === "string"
        ? body.responseText
        : attempt.response_text;
      const overtimeRanges = practiceMode
        ? normalizeWritingOvertimeRanges(body.overtimeRanges, responseText.length)
        : [];
      return buildWritingAttemptUpdate({
        action,
        now: new Date().toISOString(),
        elapsedSeconds,
        overtimeRanges,
        remainingSeconds,
        responseText
      });
    });
    if (!update) {
      return respond({ error: "responseText is required" }, { status: 400 });
    }

    const writeMetricName = action === "submit"
      ? "writing_attempt_response_save_and_submitted_status_update"
      : `writing_attempt_${action}_update`;
    const { data, error } = await timing.measure("database", writeMetricName, () =>
      auth.supabase!
        .from("writing_attempts")
        .update(update)
        .eq("attempt_id", attempt.attempt_id)
        .eq("user_id", auth.userId!)
        .eq("status", "draft")
        .select("*")
        .single()
    );
    if (error || !data) {
      return respond({ error: "写作记录保存失败，请稍后重试。" }, { status: 500 });
    }

    return respond({ attempt: data });
  } catch {
    return respond(
      { error: "写作记录保存失败，请稍后重试。" },
      { status: 500 }
    );
  }
}

async function isAssignmentAvailable(
  supabase: NonNullable<Awaited<ReturnType<typeof requireWritingStudent>>["supabase"]>,
  assignmentId: string,
  timing?: ReturnType<typeof createStudentPerformanceTrace>
) {
  const operation = () =>
    supabase
      .from("writing_assignments")
      .select("assignment_id")
      .eq("assignment_id", assignmentId)
      .eq("status", "active")
      .is("deleted_at", null)
      .maybeSingle();
  const { data, error } = timing
    ? await timing.measure("database", "writing_assignment_available", operation)
    : await operation();
  if (error) throw error;
  return Boolean(data);
}

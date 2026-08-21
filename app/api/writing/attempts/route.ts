import {
  WRITING_TASK_CONFIG,
  countEnglishWords,
  isWritingMode,
  type WritingAttempt
} from "@/lib/writing";
import {
  WritingAttemptLifecycleError,
  getOrCreateWritingDraft,
  type WritingAttemptDatabaseError,
  type WritingDraftRepository
} from "@/lib/writingAttemptLifecycle";
import {
  parseWritingTaskType,
  readWritingQuestion,
  requireWritingStudent,
  writingJson
} from "@/lib/writingServer";
import {
  getStudentWritingModeAvailability,
  isStudentWritingModeAllowed,
  writingModeUnavailableMessage
} from "@/lib/writingModePolicy";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  createHistoricalPracticeDisplayResolver,
  loadWritingHistoricalPracticeDisplayResolver,
  logHistoricalPracticeDisplayWarnings
} from "@/lib/historicalPracticeDisplay";
import { createStudentPerformanceTrace } from "@/lib/studentPerformance.server";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const timing = createStudentPerformanceTrace("/api/writing/attempts");
  const respond = (data: unknown, init?: ResponseInit) => writingJson(data, init, timing);
  try {
    const auth = await requireWritingStudent(request, timing);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.userId) return respond({ error: "Unauthorized" }, { status: 401 });

    const body = (await request.json()) as {
      forceNew?: unknown;
      assignmentId?: unknown;
      questionId?: unknown;
      taskType?: unknown;
      writingMode?: unknown;
    };
    const taskType = parseWritingTaskType(body.taskType);
    const questionId = typeof body.questionId === "string" ? body.questionId : "";
    const assignmentId = typeof body.assignmentId === "string"
      ? body.assignmentId.trim()
      : "";
    const writingMode = isWritingMode(body.writingMode) ? body.writingMode : null;
    if (!taskType || !questionId || !writingMode) {
      return respond({ error: "Invalid writing attempt request" }, { status: 400 });
    }

    const modeAvailability = await getStudentWritingModeAvailability(
      auth.supabase,
      auth.userId
    );
    if (modeAvailability.error || !modeAvailability.data) {
      return respond({ error: "暂时无法验证写作模式，请稍后重试。" }, { status: 500 });
    }
    if (!isStudentWritingModeAllowed(modeAvailability.data, writingMode)) {
      return respond(
        { error: writingModeUnavailableMessage(writingMode) },
        { status: 403 }
      );
    }

    if (assignmentId) {
      const availability = await readAvailableStudentAssignment(
        auth.supabase,
        auth.userId,
        assignmentId
      );
      if (availability.error) {
        return respond({ error: "暂时无法加载作业，请稍后重试。" }, { status: 500 });
      }
      if (!availability.assigned) {
        return respond({ error: "未找到这项写作作业。" }, { status: 404 });
      }
      if (!availability.available) {
        return respond({ error: "该作业已被教师撤回。" }, { status: 409 });
      }
    }

    const questionResult = await readWritingQuestion(
      auth.supabase,
      taskType,
      questionId,
      assignmentId || null,
      timing
    );
    if (questionResult.error) {
      return respond({ error: "暂时无法加载写作题目，请稍后重试。" }, { status: 500 });
    }
    if (!questionResult.data) return respond({ error: "Writing question not found" }, { status: 404 });

    const repository = createWritingDraftRepository(auth.supabase);
    const draft = await getOrCreateWritingDraft(
      {
        userId: auth.userId,
        assignmentId: assignmentId || null,
        taskType,
        questionId,
        question: questionResult.data,
        writingMode
      },
      repository
    );

    if (!isStudentWritingModeAllowed(modeAvailability.data, draft.attempt.writing_mode)) {
      return respond(
        {
          error: writingModeUnavailableMessage(
            draft.attempt.writing_mode === "practice" ? "practice" : "exam"
          )
        },
        { status: 403 }
      );
    }

    const displayResolver = questionResult.questionSource === "custom"
      ? createHistoricalPracticeDisplayResolver({ items: [], sources: [] })
      : await loadWritingHistoricalPracticeDisplayResolver(
          createServiceSupabase(),
          taskType,
          [questionId],
          timing
        );
    const display = displayResolver.resolveWritingAttempt({
      assignmentId: draft.attempt.assignment_id ?? null,
      assignmentDisplayName: questionResult.data.set_title,
      fallbackDisplayName:
        questionResult.data.set_title ||
        draft.attempt.set_id ||
        draft.attempt.question_id,
      questionSource: questionResult.questionSource,
      rawQuestionId: draft.attempt.question_id,
      taskType: draft.attempt.task_type
    });
    logHistoricalPracticeDisplayWarnings([display]);

    const payload = timing.measureSync("processing", "build_writing_practice_payload", () => ({
        attempt: draft.attempt,
        question: questionResult.data,
        display_name: display.displayName,
        question_source: questionResult.questionSource,
        assignment_available: true,
        resumed: draft.resumed
      }));
    return respond(payload, { status: draft.resumed ? 200 : 201 });
  } catch (error) {
    if (error instanceof WritingAttemptLifecycleError) {
      logWritingAttemptError("get_or_create_draft", error.cause);
      return respond({ error: error.message }, { status: 500 });
    }
    return respond(
      { error: "暂时无法进入写作练习，请稍后重试。" },
      { status: 500 }
    );
  }
}

function createWritingDraftRepository(
  supabase: NonNullable<Awaited<ReturnType<typeof requireWritingStudent>>["supabase"]>
): WritingDraftRepository {
  return {
    async findDraft({ assignmentId, userId, taskType, questionId }) {
      let query = supabase
        .from("writing_attempts")
        .select("*")
        .eq("user_id", userId)
        .eq("task_type", taskType)
        .eq("question_id", questionId)
        .eq("status", "draft");
      query = assignmentId
        ? query.eq("assignment_id", assignmentId)
        : query.is("assignment_id", null);
      const { data, error } = await query
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return {
        data: data as WritingAttempt | null,
        error: error as WritingAttemptDatabaseError | null
      };
    },

    async insertDraft({ assignmentId, userId, taskType, question, now, writingMode }) {
      const timeLimitSeconds = WRITING_TASK_CONFIG[taskType].timeLimitSeconds;
      const { data, error } = await supabase
        .from("writing_attempts")
        .insert({
          assignment_id: assignmentId ?? null,
          user_id: userId,
          task_type: taskType,
          question_id: question.question_id,
          set_id: question.set_id,
          response_text: "",
          word_count: countEnglishWords(""),
          status: "draft",
          time_limit_seconds: timeLimitSeconds,
          remaining_seconds: timeLimitSeconds,
          started_at: now,
          writing_mode: writingMode,
          elapsed_seconds: 0,
          overtime_ranges: []
        })
        .select("*")
        .single();
      return {
        data: data as WritingAttempt | null,
        error: error as WritingAttemptDatabaseError | null
      };
    }
  };
}

async function readAvailableStudentAssignment(
  supabase: NonNullable<Awaited<ReturnType<typeof requireWritingStudent>>["supabase"]>,
  userId: string,
  assignmentId: string
) {
  const membership = await supabase
    .from("writing_assignment_students")
    .select("assignment_id")
    .eq("assignment_id", assignmentId)
    .eq("student_id", userId)
    .maybeSingle();
  if (membership.error) {
    return { assigned: false, available: false, error: membership.error };
  }
  if (!membership.data) return { assigned: false, available: false, error: null };

  const assignment = await supabase
    .from("writing_assignments")
    .select("assignment_id")
    .eq("assignment_id", assignmentId)
    .eq("status", "active")
    .is("deleted_at", null)
    .maybeSingle();
  return {
    assigned: true,
    available: Boolean(assignment.data),
    error: assignment.error
  };
}

function logWritingAttemptError(stage: string, cause: unknown) {
  const databaseError = cause as WritingAttemptDatabaseError | null | undefined;
  console.error("Writing attempt operation failed", {
    stage,
    code: databaseError?.code ?? null,
    message: databaseError?.message ?? "Unknown error"
  });
}

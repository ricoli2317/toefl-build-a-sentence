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

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const auth = await requireWritingStudent(request);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.userId) return writingJson({ error: "Unauthorized" }, { status: 401 });

    const body = (await request.json()) as {
      forceNew?: unknown;
      questionId?: unknown;
      taskType?: unknown;
      writingMode?: unknown;
    };
    const taskType = parseWritingTaskType(body.taskType);
    const questionId = typeof body.questionId === "string" ? body.questionId : "";
    const writingMode = isWritingMode(body.writingMode) ? body.writingMode : null;
    if (!taskType || !questionId || !writingMode) {
      return writingJson({ error: "Invalid writing attempt request" }, { status: 400 });
    }

    const questionResult = await readWritingQuestion(auth.supabase, taskType, questionId);
    if (questionResult.error) {
      return writingJson({ error: "暂时无法加载写作题目，请稍后重试。" }, { status: 500 });
    }
    if (!questionResult.data) return writingJson({ error: "Writing question not found" }, { status: 404 });

    const repository = createWritingDraftRepository(auth.supabase);
    const draft = await getOrCreateWritingDraft(
      {
        userId: auth.userId,
        taskType,
        questionId,
        question: questionResult.data,
        writingMode
      },
      repository
    );

    return writingJson(
      {
        attempt: draft.attempt,
        question: questionResult.data,
        resumed: draft.resumed
      },
      { status: draft.resumed ? 200 : 201 }
    );
  } catch (error) {
    if (error instanceof WritingAttemptLifecycleError) {
      logWritingAttemptError("get_or_create_draft", error.cause);
      return writingJson({ error: error.message }, { status: 500 });
    }
    return writingJson(
      { error: "暂时无法进入写作练习，请稍后重试。" },
      { status: 500 }
    );
  }
}

function createWritingDraftRepository(
  supabase: NonNullable<Awaited<ReturnType<typeof requireWritingStudent>>["supabase"]>
): WritingDraftRepository {
  return {
    async findDraft({ userId, taskType, questionId }) {
      const { data, error } = await supabase
        .from("writing_attempts")
        .select("*")
        .eq("user_id", userId)
        .eq("task_type", taskType)
        .eq("question_id", questionId)
        .eq("status", "draft")
        .order("updated_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      return {
        data: data as WritingAttempt | null,
        error: error as WritingAttemptDatabaseError | null
      };
    },

    async insertDraft({ userId, taskType, question, now, writingMode }) {
      const timeLimitSeconds = WRITING_TASK_CONFIG[taskType].timeLimitSeconds;
      const { data, error } = await supabase
        .from("writing_attempts")
        .insert({
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

function logWritingAttemptError(stage: string, cause: unknown) {
  const databaseError = cause as WritingAttemptDatabaseError | null | undefined;
  console.error("Writing attempt operation failed", {
    stage,
    code: databaseError?.code ?? null,
    message: databaseError?.message ?? "Unknown error"
  });
}

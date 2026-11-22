import {
  WritingIdeaAssistantError,
  assertWritingIdeaAttemptAllowed,
  getWritingIdeaAssistantResult
} from "@/lib/writingIdeaAssistant";
import { generateWritingIdeaPool } from "@/lib/writingIdeaAssistantAi";
import { createWritingIdeaRepository } from "@/lib/writingIdeaAssistantServer";
import { createStudentPerformanceTrace } from "@/lib/studentPerformance.server";
import {
  readOwnedWritingAttempt,
  readWritingQuestion,
  requireWritingStudent,
  writingJson
} from "@/lib/writingServer";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(request: Request) {
  const timing = createStudentPerformanceTrace("/api/writing/idea-assistant");
  const respond = (data: unknown, init?: ResponseInit) =>
    writingJson(data, init, timing);

  try {
    const auth = await requireWritingStudent(request, timing);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.userId) {
      return respond({ error: "Unauthorized" }, { status: 401 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return respond({ error: "Invalid writing idea request" }, { status: 400 });
    }
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some((key) => key !== "attemptId")
    ) {
      return respond({ error: "Invalid writing idea fields" }, { status: 400 });
    }
    const attemptId = typeof (body as { attemptId?: unknown }).attemptId === "string"
      ? (body as { attemptId: string }).attemptId.trim()
      : "";
    if (!attemptId || attemptId.length > 100 || !UUID_PATTERN.test(attemptId)) {
      return respond({ error: "Invalid writing idea request" }, { status: 400 });
    }

    const attemptResult = await readOwnedWritingAttempt(
      auth.supabase,
      auth.userId,
      attemptId,
      timing
    );
    if (attemptResult.error) {
      return respond({ error: "暂时无法加载写作记录，请稍后重试。" }, { status: 500 });
    }
    const attempt = attemptResult.data;
    if (!attempt) {
      return respond({ error: "Writing attempt not found" }, { status: 404 });
    }
    assertWritingIdeaAttemptAllowed(attempt);

    const questionResult = await readWritingQuestion(
      auth.supabase,
      attempt.task_type,
      attempt.question_id,
      attempt.assignment_id ?? null,
      timing
    );
    if (questionResult.error) {
      return respond({ error: "暂时无法加载写作题目，请稍后重试。" }, { status: 500 });
    }
    if (!questionResult.data || !questionResult.questionSource) {
      return respond({ error: "Writing question not found" }, { status: 404 });
    }

    const result = await getWritingIdeaAssistantResult(
      {
        attempt,
        question: questionResult.data,
        questionSource: questionResult.questionSource,
        assignmentAvailable: questionResult.assignmentAvailable
      },
      {
        repository: createWritingIdeaRepository(),
        generatePool: (input) => generateWritingIdeaPool(input),
        onDiagnostic: (event, detail) => {
          console.warn("[writing-idea-assistant]", event, detail);
        }
      }
    );

    if (result.status === "generating") {
      return respond(
        {
          status: "generating",
          retryAfterMs: result.retryAfterMs
        },
        {
          status: 202,
          headers: {
            "Retry-After": String(Math.max(1, Math.ceil(result.retryAfterMs / 1000)))
          }
        }
      );
    }

    return respond({
      status: "ready",
      selection: result.selection,
      generated: result.generated
    });
  } catch (error) {
    if (error instanceof WritingIdeaAssistantError) {
      return respond({ error: error.message }, { status: error.status });
    }
    console.error("[writing-idea-assistant] unhandled_error", {
      name: error instanceof Error ? error.name : "unknown"
    });
    return respond(
      { error: "写作思路助手暂时不可用，请稍后重试。" },
      { status: 500 }
    );
  }
}

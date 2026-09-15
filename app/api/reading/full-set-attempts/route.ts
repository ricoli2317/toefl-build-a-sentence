import {
  buildReadingFullSetRunnerPayload,
  isFullSetId,
  loadOwnedReadingFullSetAttempt,
  loadReadingFullSetOccurrencePracticePayload,
  loadReadingFullSetReviewCompletedQuestionNumbers,
  readingFullSetAttemptError,
  readingFullSetAttemptJson,
  requireReadingFullSetStudent
} from "@/lib/reading/fullSetAttemptServer";
import {
  isReadingFullSetAttemptSummary,
  readingFullSetBootstrapOccurrence,
  readingFullSetAttemptPhase
} from "@/lib/reading/fullSetAttempts";
import { buildReadingFullSetCatalogStates } from "@/lib/reading/fullSets";
import { loadReadingFullSet } from "@/lib/reading/fullSets.server";
import {
  ReadingFullSetTimeoutError,
  withReadingFullSetTimeout
} from "@/lib/reading/fullSetTimeout";
import { createServiceSupabase } from "@/lib/supabase/server";
import { createStudentPerformanceTrace } from "@/lib/studentPerformance.server";

export const dynamic = "force-dynamic";

const ROUTE = "/api/reading/full-set-attempts";
const BOOTSTRAP_TIMEOUT_MS = 15_000;

export async function GET(request: Request) {
  const auth = await requireReadingFullSetStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client) return readingFullSetAttemptJson({ error: "请先登录。" }, { status: 401 });
  const fullSetId = new URL(request.url).searchParams.get("fullSetId")?.trim() ?? "";
  if (!isFullSetId(fullSetId)) {
    return readingFullSetAttemptJson({ error: "无效的套题练习请求。" }, { status: 400 });
  }
  const { data, error } = await createServiceSupabase().from("reading_full_set_attempts")
    .select("attempt_id,full_set_id,status,completed_at,created_at")
    .eq("student_id", auth.userId)
    .eq("full_set_id", fullSetId);
  if (error) return readingFullSetAttemptError(error, "套题练习状态加载失败，请稍后重试。");
  const state = buildReadingFullSetCatalogStates(data ?? []).get(fullSetId);
  const attemptId = state?.activeAttemptId ?? state?.latestCompletedAttemptId ?? null;
  if (!attemptId) return readingFullSetAttemptJson({ attempt: null });
  const owned = await loadOwnedReadingFullSetAttempt(auth.client, attemptId);
  if (owned.error) return readingFullSetAttemptError(owned.error, "套题练习状态加载失败，请稍后重试。");
  if (!owned.attempt || !isReadingFullSetAttemptSummary(owned.attempt) || owned.attempt.fullSetId !== fullSetId) {
    return readingFullSetAttemptJson({ error: "套题练习状态返回了无效数据。" }, { status: 500 });
  }
  return readingFullSetAttemptJson({ attempt: owned.attempt });
}

export async function POST(request: Request) {
  const timing = createStudentPerformanceTrace(ROUTE, {
    moduleNumber: 1,
    traceId: request.headers.get("x-reading-full-set-trace-id")
  });
  const respond = (data: unknown, init: ResponseInit = {}) => {
    const body = timing.measureSync("processing", "serialization", () => JSON.stringify(data));
    const headers = timing.finishHeaders(init.headers, (init.status ?? 200) < 400);
    headers.set("Content-Type", "application/json");
    return new Response(body, { ...init, headers });
  };

  const auth = await requireReadingFullSetStudent(request, timing);
  if (auth.error || !auth.client) {
    return respond({ code: "AUTH_FAILED", error: "请先登录后再开始套题练习。" }, { status: 401 });
  }
  const body = await request.json().catch(() => ({})) as { fullSetId?: unknown };
  const fullSetId = typeof body.fullSetId === "string" ? body.fullSetId.trim() : "";
  if (!isFullSetId(fullSetId)) {
    return respond({ code: "DEFINITION_FAILED", error: "无效的套题练习请求。" }, { status: 400 });
  }

  try {
    const bootstrap = await withReadingFullSetTimeout(
      buildM1Bootstrap(auth.client, fullSetId, timing),
      BOOTSTRAP_TIMEOUT_MS,
      "BOOTSTRAP_TIMEOUT"
    );
    return respond(bootstrap, { status: bootstrap.runner.attempt.created ? 201 : 200 });
  } catch (error) {
    if (error instanceof ReadingFullSetTimeoutError) {
      console.error("Reading Full Set M1 bootstrap timeout", {
        fullSetId,
        phase: "api_total",
        traceId: timing.traceId
      });
      return respond({ code: error.code, error: "Module 1 准备超时，请重试。" }, { status: 504 });
    }
    const failure = classifiedM1BootstrapFailure(error);
    console.error("Reading Full Set M1 bootstrap failed", {
      code: failure.code,
      fullSetId,
      phase: failure.phase,
      traceId: timing.traceId
    });
    return respond({ code: failure.code, error: failure.message }, { status: failure.status });
  }
}

async function buildM1Bootstrap(
  client: NonNullable<Awaited<ReturnType<typeof requireReadingFullSetStudent>>["client"]>,
  fullSetId: string,
  timing: ReturnType<typeof createStudentPerformanceTrace>
) {
  const db = createServiceSupabase();
  const [attempt, fullSet] = await Promise.all([
    timing.measure("database", "attempt_create_or_reuse", async () => {
      const result = await client.rpc("get_or_create_reading_full_set_attempt", {
        p_full_set_id: fullSetId
      });
      if (result.error?.message?.includes("FULL_SET_NOT_FOUND")) {
        throw new M1BootstrapFailure(
          "DEFINITION_FAILED",
          "attempt_create_or_reuse",
          "没有找到这个完整阅读套题。",
          404,
          { cause: result.error }
        );
      }
      if (result.error?.code === "42501" || result.error?.message?.includes("FULL_SET_STUDENT_REQUIRED")) {
        throw new M1BootstrapFailure(
          "OWNERSHIP_FAILED",
          "attempt_create_or_reuse",
          "无权开始这次套题练习。",
          403,
          { cause: result.error }
        );
      }
      if (result.error || !isReadingFullSetAttemptSummary(result.data) || result.data.fullSetId !== fullSetId) {
        throw new M1BootstrapFailure(
          "M1_PREPARE_FAILED",
          "attempt_create_or_reuse",
          "暂时无法开始 Module 1，请稍后重试。",
          500,
          { cause: result.error ?? undefined }
        );
      }
      return result.data;
    }),
    timing.measure("database", "definition_resolution", async () => {
      const result = await loadReadingFullSet(db, fullSetId);
      if (!result) {
        throw new M1BootstrapFailure(
          "DEFINITION_FAILED",
          "definition_resolution",
          "没有找到这个完整阅读套题。",
          404
        );
      }
      return result;
    })
  ]);

  timing.measureSync("processing", "ownership", () => {
    if (attempt.fullSetId !== fullSetId) {
      throw new M1BootstrapFailure("OWNERSHIP_FAILED", "ownership", "无权读取这次套题练习。", 403);
    }
  });
  const phase = timing.measureSync("processing", "m1_prepare", () => readingFullSetAttemptPhase(attempt));
  if (phase !== "module_1_preparing" && phase !== "module_1_active") {
    throw new M1BootstrapFailure(
      "M1_PREPARE_FAILED",
      "m1_prepare",
      "Module 1 已结束，请按当前套题进度继续。",
      409
    );
  }
  const runner = buildReadingFullSetRunnerPayload(attempt, fullSet);
  const initialRunnerOccurrence = readingFullSetBootstrapOccurrence(runner.occurrences, attempt.module1);
  const initialOccurrence = initialRunnerOccurrence
    ? fullSet.module1.occurrences.find(
      (occurrence) => occurrence.occurrenceId === initialRunnerOccurrence.occurrenceId
    )
    : null;
  if (!initialOccurrence || (attempt.module1.status === "preparing" && initialOccurrence.taskType !== "ctw")) {
    throw new M1BootstrapFailure("CONTENT_FAILED", "first_occurrence_content", "Module 1 当前题目数据不可用。", 409);
  }
  const [firstOccurrence, reviewCompletedQuestionNumbers] = await Promise.all([
    loadReadingFullSetOccurrencePracticePayload({
      db,
      moduleAttempt: attempt.module1,
      occurrence: initialOccurrence,
      timing,
      title: fullSet.title
    }),
    loadReadingFullSetReviewCompletedQuestionNumbers({
      db,
      moduleAttempt: attempt.module1,
      occurrences: runner.occurrences
    })
  ]).catch((error) => {
    throw new M1BootstrapFailure(
      "CONTENT_FAILED",
      "first_occurrence_content",
      "Module 1 首题加载失败，请重试。",
      500,
      { cause: error }
    );
  });

  return {
    firstOccurrence,
    reviewCompletedQuestionNumbers,
    runner,
    traceId: timing.traceId
  };
}

class M1BootstrapFailure extends Error {
  constructor(
    readonly code: "OWNERSHIP_FAILED" | "M1_PREPARE_FAILED" | "DEFINITION_FAILED" | "CONTENT_FAILED",
    readonly phase: string,
    message: string,
    readonly status: number,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "M1BootstrapFailure";
  }
}

function classifiedM1BootstrapFailure(error: unknown) {
  if (error instanceof M1BootstrapFailure) return error;
  return new M1BootstrapFailure(
    "M1_PREPARE_FAILED",
    "api_total",
    "Module 1 准备失败，请稍后重试。",
    500,
    { cause: error }
  );
}

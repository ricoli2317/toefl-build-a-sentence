import {
  buildReadingFullSetRunnerPayload,
  isUuid,
  loadOwnedReadingFullSetAttempt,
  loadReadingFullSetOccurrencePracticePayload,
  loadReadingFullSetReviewCompletedQuestionNumbers,
  requireReadingFullSetStudent
} from "@/lib/reading/fullSetAttemptServer";
import {
  isReadingFullSetAttemptSummary,
  readingFullSetBootstrapOccurrence,
  readingFullSetCurrentModuleAttempt
} from "@/lib/reading/fullSetAttempts";
import { loadReadingFullSet } from "@/lib/reading/fullSets.server";
import {
  ReadingFullSetTimeoutError,
  withReadingFullSetTimeout
} from "@/lib/reading/fullSetTimeout";
import { createServiceSupabase } from "@/lib/supabase/server";
import { createStudentPerformanceTrace } from "@/lib/studentPerformance.server";

export const dynamic = "force-dynamic";

const ROUTE = "/api/reading/full-set-attempts/[attemptId]/modules/2/start";
const BOOTSTRAP_TIMEOUT_MS = 15_000;

export async function POST(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  const timing = createStudentPerformanceTrace(ROUTE, {
    attemptId: params.attemptId,
    moduleNumber: 2,
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
  if (!isUuid(params.attemptId)) {
    return respond({ code: "OWNERSHIP_FAILED", error: "无效的套题练习请求。" }, { status: 400 });
  }

  try {
    const bootstrap = await withReadingFullSetTimeout(
      buildBootstrap(auth.client, params.attemptId, timing),
      BOOTSTRAP_TIMEOUT_MS,
      "BOOTSTRAP_TIMEOUT"
    );
    return respond(bootstrap);
  } catch (error) {
    if (error instanceof ReadingFullSetTimeoutError) {
      console.error("Reading Full Set bootstrap timeout", {
        attemptId: params.attemptId,
        phase: "api_total",
        traceId: timing.traceId
      });
      return respond({ code: error.code, error: "Module 2 准备超时，请重试。" }, { status: 504 });
    }
    const failure = classifiedBootstrapFailure(error);
    console.error("Reading Full Set bootstrap failed", {
      attemptId: params.attemptId,
      code: failure.code,
      phase: failure.phase,
      traceId: timing.traceId
    });
    return respond({ code: failure.code, error: failure.message }, { status: failure.status });
  }
}

async function buildBootstrap(
  client: NonNullable<Awaited<ReturnType<typeof requireReadingFullSetStudent>>["client"]>,
  attemptId: string,
  timing: ReturnType<typeof createStudentPerformanceTrace>
) {
  const ownedAttempt = await timing.measure("database", "ownership", async () => {
    const owned = await loadOwnedReadingFullSetAttempt(client, attemptId);
    if (owned.error || !owned.attempt) {
      throw new BootstrapFailure("OWNERSHIP_FAILED", "ownership", "无权读取这次套题练习。", 403);
    }
    return owned.attempt;
  });
  if (ownedAttempt.status !== "in_progress" || ownedAttempt.module1.status !== "submitted") {
    throw new BootstrapFailure("M2_PREPARE_FAILED", "ownership", "请先完成 Module 1。", 409);
  }

  const [attempt, fullSet] = await Promise.all([
    timing.measure("database", "m2_prepare_rpc", async () => {
      const result = await client.rpc("prepare_reading_full_set_module_2", {
        p_attempt_id: attemptId
      });
      if (result.error || !isReadingFullSetAttemptSummary(result.data)) {
        throw new BootstrapFailure(
          "M2_PREPARE_FAILED",
          "m2_prepare_rpc",
          "暂时无法开始 Module 2，请稍后重试。",
          500
        );
      }
      return result.data;
    }),
    timing.measure("database", "definition_resolution", async () => {
      const result = await loadReadingFullSet(createServiceSupabase(), ownedAttempt.fullSetId);
      if (!result) {
        throw new BootstrapFailure(
          "DEFINITION_FAILED",
          "definition_resolution",
          "这套阅读练习的数据已不可用。",
          409
        );
      }
      return result;
    })
  ]);
  const moduleAttempt = readingFullSetCurrentModuleAttempt(attempt);
  if (!moduleAttempt || moduleAttempt.moduleNumber !== 2 || moduleAttempt.status === "submitted") {
    throw new BootstrapFailure("M2_PREPARE_FAILED", "m2_prepare_rpc", "Module 2 状态无效。", 409);
  }
  const runner = buildReadingFullSetRunnerPayload(attempt, fullSet);
  const initialRunnerOccurrence = readingFullSetBootstrapOccurrence(runner.occurrences, moduleAttempt);
  const initialOccurrence = initialRunnerOccurrence
    ? fullSet.module2.occurrences.find(
      (occurrence) => occurrence.occurrenceId === initialRunnerOccurrence.occurrenceId
    )
    : null;
  if (!initialOccurrence || (moduleAttempt.status === "preparing" && initialOccurrence.taskType !== "ctw")) {
    throw new BootstrapFailure("CONTENT_FAILED", "first_occurrence_content", "Module 2 当前题目数据不可用。", 409);
  }

  const db = createServiceSupabase();
  const [firstOccurrence, reviewCompletedQuestionNumbers] = await Promise.all([
    loadReadingFullSetOccurrencePracticePayload({
      db,
      moduleAttempt,
      occurrence: initialOccurrence,
      timing,
      title: fullSet.title
    }),
    loadReadingFullSetReviewCompletedQuestionNumbers({
      db,
      moduleAttempt,
      occurrences: runner.occurrences
    })
  ]).catch((error) => {
    throw new BootstrapFailure(
      "CONTENT_FAILED",
      "first_occurrence_content",
      "Module 2 首题加载失败，请重试。",
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

class BootstrapFailure extends Error {
  constructor(
    readonly code: "OWNERSHIP_FAILED" | "M2_PREPARE_FAILED" | "DEFINITION_FAILED" | "CONTENT_FAILED",
    readonly phase: string,
    message: string,
    readonly status: number,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "BootstrapFailure";
  }
}

function classifiedBootstrapFailure(error: unknown) {
  if (error instanceof BootstrapFailure) return error;
  return new BootstrapFailure(
    "CONTENT_FAILED",
    "api_total",
    "Module 2 准备失败，请稍后重试。",
    500,
    { cause: error }
  );
}

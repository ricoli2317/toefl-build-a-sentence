import {
  isUuid,
  moduleNumber,
  readingFullSetAttemptError,
  readingFullSetAttemptJson,
  requireReadingFullSetStudent
} from "@/lib/reading/fullSetAttemptServer";
import { isReadingFullSetAttemptSummary } from "@/lib/reading/fullSetAttempts";
import { createStudentPerformanceTrace } from "@/lib/studentPerformance.server";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: { attemptId: string; moduleNumber: string } }
) {
  const moduleNo = moduleNumber(params.moduleNumber);
  const timing = createStudentPerformanceTrace(
    "/api/reading/full-set-attempts/[attemptId]/modules/[moduleNumber]/submit",
    {
      attemptId: params.attemptId,
      moduleNumber: moduleNo,
      traceId: request.headers.get("x-reading-full-set-trace-id")
    }
  );
  const respond = (response: ReturnType<typeof readingFullSetAttemptJson>) => {
    timing.finishHeaders(response.headers, response.ok).forEach((value, name) => {
      response.headers.set(name, value);
    });
    return response;
  };
  const auth = await requireReadingFullSetStudent(request, timing);
  if (auth.error) return respond(auth.error);
  if (!auth.client) return respond(readingFullSetAttemptJson({ code: "AUTH_FAILED", error: "请先登录。" }, { status: 401 }));
  if (!isUuid(params.attemptId) || !moduleNo) {
    return respond(readingFullSetAttemptJson({ error: "无效的 Module 提交请求。" }, { status: 400 }));
  }
  const body = await request.json().catch(() => ({})) as {
    expectedAnswerRevision?: unknown;
    timeoutOnly?: unknown;
  };
  const expectedAnswerRevision = Number(body.expectedAnswerRevision);
  if (
    body.timeoutOnly !== true
    && (!Number.isInteger(expectedAnswerRevision) || expectedAnswerRevision < 0)
  ) {
    return respond(readingFullSetAttemptJson({ error: "无效的 Module 提交状态。" }, { status: 400 }));
  }
  const rpcName = body.timeoutOnly === true
    ? "timeout_reading_full_set_module"
    : "submit_reading_full_set_module_v2";
  let submitResult = await timing.measure(
    "database",
    moduleNo === 1 ? "m1_submit_rpc" : "m2_submit_rpc",
    () => auth.client!.rpc(rpcName, {
      p_attempt_id: params.attemptId,
      p_module_number: moduleNo,
      ...(body.timeoutOnly === true
        ? {}
        : { p_expected_answer_revision: expectedAnswerRevision })
    })
  );
  if (body.timeoutOnly !== true && isMissingSubmitBarrierRpc(submitResult.error)) {
    submitResult = await timing.measure(
      "database",
      "submit_legacy_compatibility",
      () => auth.client!.rpc("submit_reading_full_set_module", {
        p_attempt_id: params.attemptId,
        p_module_number: moduleNo
      })
    );
  }
  const { data, error } = submitResult;
  if (error) return respond(readingFullSetAttemptError(error, "Module 提交失败，请稍后重试。"));
  if (isSubmitBarrierResult(data)) {
    return respond(timing.measureSync("processing", "serialization", () =>
      readingFullSetAttemptJson(data, { status: data.accepted ? 200 : 409 })
    ));
  }
  if (!isReadingFullSetAttemptSummary(data)) {
    return respond(readingFullSetAttemptJson({ error: "Module 提交状态返回了无效数据。" }, { status: 500 }));
  }
  return respond(timing.measureSync("processing", "serialization", () =>
    readingFullSetAttemptJson({ accepted: true, attempt: data })
  ));
}

function isSubmitBarrierResult(value: unknown): value is {
  accepted: boolean;
  answerRevision: number;
  attempt: import("@/lib/reading/fullSetAttempts").ReadingFullSetAttemptSummary;
  reason?: "stale_revision";
} {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return typeof result.accepted === "boolean"
    && Number.isInteger(result.answerRevision)
    && isReadingFullSetAttemptSummary(result.attempt);
}

function isMissingSubmitBarrierRpc(error: { code?: string; message?: string } | null) {
  return Boolean(error && (
    error.code === "PGRST202"
    || error.message?.includes("submit_reading_full_set_module_v2")
  ));
}

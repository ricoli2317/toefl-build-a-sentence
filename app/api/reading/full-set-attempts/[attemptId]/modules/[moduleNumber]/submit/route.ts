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
  const body = await request.json().catch(() => ({})) as { timeoutOnly?: unknown };
  const rpcName = body.timeoutOnly === true
    ? "timeout_reading_full_set_module"
    : "submit_reading_full_set_module";
  const { data, error } = await timing.measure(
    "database",
    moduleNo === 1 ? "m1_submit_rpc" : "m2_submit_rpc",
    () => auth.client!.rpc(rpcName, {
      p_attempt_id: params.attemptId,
      p_module_number: moduleNo
    })
  );
  if (error) return respond(readingFullSetAttemptError(error, "Module 提交失败，请稍后重试。"));
  if (!isReadingFullSetAttemptSummary(data)) {
    return respond(readingFullSetAttemptJson({ error: "Module 提交状态返回了无效数据。" }, { status: 500 }));
  }
  return respond(timing.measureSync("processing", "serialization", () =>
    readingFullSetAttemptJson({ attempt: data })
  ));
}

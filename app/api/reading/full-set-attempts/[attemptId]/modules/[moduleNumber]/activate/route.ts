import {
  isUuid,
  moduleNumber,
  readingFullSetAttemptError,
  readingFullSetAttemptJson,
  requireReadingFullSetStudent
} from "@/lib/reading/fullSetAttemptServer";
import { isReadingFullSetAttemptSummary } from "@/lib/reading/fullSetAttempts";
import {
  ReadingFullSetTimeoutError,
  withReadingFullSetTimeout
} from "@/lib/reading/fullSetTimeout";
import { createStudentPerformanceTrace } from "@/lib/studentPerformance.server";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: { attemptId: string; moduleNumber: string } }
) {
  const parsedModuleNumber = moduleNumber(params.moduleNumber);
  const timing = createStudentPerformanceTrace(
    "/api/reading/full-set-attempts/[attemptId]/modules/[moduleNumber]/activate",
    {
      attemptId: params.attemptId,
      moduleNumber: parsedModuleNumber,
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
  if (!isUuid(params.attemptId) || !parsedModuleNumber) {
    return respond(readingFullSetAttemptJson({ code: "ACTIVATION_FAILED", error: "无效的 Module 激活请求。" }, { status: 400 }));
  }
  let result: Awaited<ReturnType<typeof auth.client.rpc>>;
  try {
    result = await withReadingFullSetTimeout(
      timing.measure("database", "activation", () =>
        auth.client!.rpc("activate_reading_full_set_module", {
          p_attempt_id: params.attemptId,
          p_module_number: parsedModuleNumber
        })
      ),
      10_000,
      "ACTIVATION_FAILED"
    );
  } catch (error) {
    if (error instanceof ReadingFullSetTimeoutError) {
      console.error("Reading Full Set activation timeout", {
        attemptId: params.attemptId,
        moduleNumber: parsedModuleNumber,
        phase: "activation",
        traceId: timing.traceId
      });
    }
    return respond(readingFullSetAttemptJson(
      { code: "ACTIVATION_FAILED", error: "Module 计时启动失败，请重试。" },
      { status: error instanceof ReadingFullSetTimeoutError ? 504 : 500 }
    ));
  }
  const { data, error } = result;
  if (error) return respond(readingFullSetAttemptError(error, "Module 计时启动失败，请重试。"));
  if (!isReadingFullSetAttemptSummary(data)) {
    return respond(readingFullSetAttemptJson({ code: "ACTIVATION_FAILED", error: "Module 计时状态返回了无效数据。" }, { status: 500 }));
  }
  return respond(timing.measureSync("processing", "serialization", () =>
    readingFullSetAttemptJson({ attempt: data })
  ));
}

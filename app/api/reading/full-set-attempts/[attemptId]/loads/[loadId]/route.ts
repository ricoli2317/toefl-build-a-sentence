import {
  isUuid,
  readingFullSetAttemptError,
  readingFullSetAttemptJson,
  requireReadingFullSetStudent
} from "@/lib/reading/fullSetAttemptServer";
import { isReadingFullSetAttemptSummary } from "@/lib/reading/fullSetAttempts";

export const dynamic = "force-dynamic";

export async function PUT(
  request: Request,
  { params }: { params: { attemptId: string; loadId: string } }
) {
  const auth = await requireReadingFullSetStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client) return readingFullSetAttemptJson({ error: "请先登录。" }, { status: 401 });
  if (!isUuid(params.attemptId) || !isUuid(params.loadId)) {
    return readingFullSetAttemptJson({ error: "无效的题目加载请求。" }, { status: 400 });
  }
  const { data, error } = await auth.client.rpc("finish_reading_full_set_load_pause", {
    p_attempt_id: params.attemptId,
    p_load_id: params.loadId
  });
  if (error) return readingFullSetAttemptError(error, "题目加载计时同步失败，请重试。");
  if (!isFinishResult(data)) {
    return readingFullSetAttemptJson({ error: "题目加载计时状态返回了无效数据。" }, { status: 500 });
  }
  return readingFullSetAttemptJson(data);
}

function isFinishResult(value: unknown): value is {
  attempt: import("@/lib/reading/fullSetAttempts").ReadingFullSetAttemptSummary;
  finished: boolean;
} {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return typeof result.finished === "boolean" && isReadingFullSetAttemptSummary(result.attempt);
}

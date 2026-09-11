import {
  isUuid,
  readingFullSetAttemptError,
  readingFullSetAttemptJson,
  requireReadingFullSetStudent
} from "@/lib/reading/fullSetAttemptServer";
import { isReadingFullSetAttemptSummary } from "@/lib/reading/fullSetAttempts";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  const auth = await requireReadingFullSetStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client) return readingFullSetAttemptJson({ error: "请先登录。" }, { status: 401 });
  if (!isUuid(params.attemptId)) {
    return readingFullSetAttemptJson({ error: "无效的题目加载请求。" }, { status: 400 });
  }
  const body = await request.json().catch(() => ({})) as {
    loadId?: unknown;
    occurrenceId?: unknown;
  };
  const loadId = typeof body.loadId === "string" ? body.loadId : "";
  const occurrenceId = typeof body.occurrenceId === "string" && body.occurrenceId
    ? body.occurrenceId
    : null;
  if (!isUuid(loadId)) {
    return readingFullSetAttemptJson({ error: "无效的题目加载请求。" }, { status: 400 });
  }
  const { data, error } = await auth.client.rpc("begin_reading_full_set_load_pause", {
    p_attempt_id: params.attemptId,
    p_load_id: loadId,
    p_occurrence_id: occurrenceId
  });
  if (error) return readingFullSetAttemptError(error, "题目加载计时同步失败，请重试。");
  if (!isLoadPauseResult(data)) {
    return readingFullSetAttemptJson({ error: "题目加载计时状态返回了无效数据。" }, { status: 500 });
  }
  return readingFullSetAttemptJson(data);
}

function isLoadPauseResult(value: unknown): value is {
  attempt: import("@/lib/reading/fullSetAttempts").ReadingFullSetAttemptSummary;
  expiresAt?: string;
  loadId?: string;
  started: boolean;
} {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return typeof result.started === "boolean"
    && isReadingFullSetAttemptSummary(result.attempt)
    && (!result.started || (typeof result.loadId === "string" && typeof result.expiresAt === "string"));
}

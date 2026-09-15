import {
  isUuid,
  moduleNumber,
  readingFullSetAttemptError,
  readingFullSetAttemptJson,
  requireReadingFullSetStudent
} from "@/lib/reading/fullSetAttemptServer";
import { isReadingFullSetAttemptSummary } from "@/lib/reading/fullSetAttempts";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: { attemptId: string; moduleNumber: string } }
) {
  const moduleNo = moduleNumber(params.moduleNumber);
  const auth = await requireReadingFullSetStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client) return readingFullSetAttemptJson({ error: "请先登录。" }, { status: 401 });
  if (!isUuid(params.attemptId) || !moduleNo) {
    return readingFullSetAttemptJson({ error: "无效的 Module 暂停请求。" }, { status: 400 });
  }

  const body = await request.json().catch(() => ({})) as {
    expectedTimerRevision?: unknown;
    moduleAttemptId?: unknown;
    remainingSeconds?: unknown;
  };
  const expectedTimerRevision = Number(body.expectedTimerRevision);
  const remainingSeconds = Number(body.remainingSeconds);
  const moduleAttemptId = typeof body.moduleAttemptId === "string" ? body.moduleAttemptId : "";
  if (
    !isUuid(moduleAttemptId)
    || !Number.isInteger(expectedTimerRevision)
    || expectedTimerRevision < 0
    || !Number.isInteger(remainingSeconds)
    || remainingSeconds < 0
  ) {
    return readingFullSetAttemptJson({ error: "无效的 Module 暂停请求。" }, { status: 400 });
  }

  const { data, error } = await auth.client.rpc("pause_reading_full_set_module", {
    p_attempt_id: params.attemptId,
    p_expected_timer_revision: expectedTimerRevision,
    p_module_attempt_id: moduleAttemptId,
    p_module_number: moduleNo,
    p_remaining_seconds: remainingSeconds
  });
  if (error) return readingFullSetAttemptError(error, "Module 计时暂停失败，请重试。");
  if (!isPauseResult(data)) {
    return readingFullSetAttemptJson({ error: "Module 暂停状态返回了无效数据。" }, { status: 500 });
  }
  return readingFullSetAttemptJson(data, { status: data.accepted ? 200 : 409 });
}

function isPauseResult(value: unknown): value is {
  accepted: boolean;
  attempt: import("@/lib/reading/fullSetAttempts").ReadingFullSetAttemptSummary;
  reason?: "locked" | "stale_revision";
} {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return typeof result.accepted === "boolean"
    && isReadingFullSetAttemptSummary(result.attempt)
    && (result.accepted || result.reason === "locked" || result.reason === "stale_revision");
}

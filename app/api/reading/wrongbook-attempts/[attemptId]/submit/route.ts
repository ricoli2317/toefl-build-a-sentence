import type { ReadingSubmittedAnswer } from "@/lib/reading/attempts";
import {
  readingAttemptError,
  readingAttemptJson,
  requireReadingAttemptStudent
} from "@/lib/reading/attemptServer";
import { isReadingWrongbookAttemptSummary } from "@/lib/reading/wrongbook";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client) return readingAttemptJson({ error: "请先登录。" }, { status: 401 });
  if (!isUuid(params.attemptId)) {
    return readingAttemptJson({ error: "无效的错题订正提交。" }, { status: 400 });
  }
  const body = await request.json().catch(() => ({})) as {
    answers?: unknown;
    elapsedSeconds?: unknown;
    logicalItemId?: unknown;
  };
  const elapsedSeconds = Number(body.elapsedSeconds);
  if (
    typeof body.logicalItemId !== "string"
    || !Number.isInteger(elapsedSeconds)
    || elapsedSeconds < 0
    || elapsedSeconds > 604800
    || !Array.isArray(body.answers)
  ) {
    return readingAttemptJson({ error: "无效的错题订正提交。" }, { status: 400 });
  }

  const { data, error } = await auth.client.rpc("submit_reading_wrongbook_attempt", {
    p_answers: body.answers as ReadingSubmittedAnswer[],
    p_attempt_id: params.attemptId,
    p_elapsed_seconds: elapsedSeconds,
    p_logical_item_id: body.logicalItemId
  });
  if (error) return readingAttemptError(error, "错题订正提交失败，请稍后重试。");
  if (!isReadingWrongbookAttemptSummary(data) || data.status !== "submitted") {
    return readingAttemptJson({ error: "错题订正结果返回了无效数据。" }, { status: 500 });
  }
  return readingAttemptJson({ attempt: data });
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

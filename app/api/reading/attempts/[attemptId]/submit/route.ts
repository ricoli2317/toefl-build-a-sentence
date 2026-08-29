import { isReadingAttemptSummary, type ReadingSubmittedAnswer } from "@/lib/reading/attempts";
import {
  readingAttemptError,
  readingAttemptJson,
  requireReadingAttemptStudent
} from "@/lib/reading/attemptServer";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client) {
    return readingAttemptJson({ error: "请先登录后再提交阅读练习。" }, { status: 401 });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(params.attemptId)) {
    return readingAttemptJson({ error: "无效的阅读提交请求。" }, { status: 400 });
  }

  let body: {
    logicalItemId?: unknown;
    elapsedSeconds?: unknown;
    answers?: unknown;
  };
  try {
    body = await request.json();
  } catch {
    return readingAttemptJson({ error: "无效的阅读提交请求。" }, { status: 400 });
  }
  const logicalItemId = typeof body.logicalItemId === "string"
    ? body.logicalItemId.trim()
    : "";
  const elapsedSeconds = Number(body.elapsedSeconds);
  if (
    !/^reading-(ctw|rdl|rap)-[a-f0-9]{24}$/.test(logicalItemId)
    || !Number.isInteger(elapsedSeconds)
    || elapsedSeconds < 0
    || !Array.isArray(body.answers)
    || body.answers.some((answer) => {
      if (!answer || typeof answer !== "object") return true;
      const questionTimeSeconds = (answer as { questionTimeSeconds?: unknown }).questionTimeSeconds;
      return !Number.isInteger(questionTimeSeconds)
        || Number(questionTimeSeconds) < 0
        || Number(questionTimeSeconds) > 604800;
    })
  ) {
    return readingAttemptJson({ error: "无效的阅读提交请求。" }, { status: 400 });
  }

  // Only raw student answers cross this boundary. The database transaction loads
  // authoritative answer keys, validates stable IDs, scores, and persists.
  const { data, error } = await auth.client.rpc("submit_reading_attempt_with_times", {
    p_attempt_id: params.attemptId,
    p_logical_item_id: logicalItemId,
    p_elapsed_seconds: elapsedSeconds,
    p_answers: body.answers as ReadingSubmittedAnswer[]
  });
  if (error) {
    return readingAttemptError(error, "阅读答案提交失败，请稍后重试。");
  }
  if (!isReadingAttemptSummary(data) || data.status !== "submitted") {
    return readingAttemptJson({ error: "阅读提交结果返回了无效数据。" }, { status: 500 });
  }
  return readingAttemptJson({ attempt: data });
}

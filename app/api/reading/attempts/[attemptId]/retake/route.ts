import { isReadingAttemptSummary } from "@/lib/reading/attempts";
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
    return readingAttemptJson({ error: "请先登录后再重新练习。" }, { status: 401 });
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(params.attemptId)) {
    return readingAttemptJson({ error: "无效的重新练习请求。" }, { status: 400 });
  }

  const { data, error } = await auth.client.rpc("retake_reading_attempt", {
    p_submitted_attempt_id: params.attemptId
  });
  if (error) return readingAttemptError(error, "暂时无法开始重新练习，请稍后重试。");
  if (!isReadingAttemptSummary(data) || data.status !== "draft") {
    return readingAttemptJson({ error: "重新练习记录返回了无效数据。" }, { status: 500 });
  }
  return readingAttemptJson({ attempt: data }, { status: data.created ? 201 : 200 });
}

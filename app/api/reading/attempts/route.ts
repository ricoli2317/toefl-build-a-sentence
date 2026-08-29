import { isReadingAttemptSummary } from "@/lib/reading/attempts";
import {
  readingAttemptError,
  readingAttemptJson,
  requireReadingAttemptStudent
} from "@/lib/reading/attemptServer";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client) {
    return readingAttemptJson({ error: "请先登录后再开始阅读练习。" }, { status: 401 });
  }

  let body: { logicalItemId?: unknown };
  try {
    body = await request.json() as { logicalItemId?: unknown };
  } catch {
    return readingAttemptJson({ error: "无效的阅读练习请求。" }, { status: 400 });
  }
  const logicalItemId = typeof body.logicalItemId === "string"
    ? body.logicalItemId.trim()
    : "";
  if (!/^reading-(ctw|rdl|rap)-[a-f0-9]{24}$/.test(logicalItemId)) {
    return readingAttemptJson({ error: "无效的阅读练习请求。" }, { status: 400 });
  }

  const { data, error } = await auth.client.rpc("get_or_create_reading_attempt", {
    p_logical_item_id: logicalItemId
  });
  if (error) {
    return readingAttemptError(error, "暂时无法进入阅读练习，请稍后重试。");
  }
  if (!isReadingAttemptSummary(data) || data.logicalItemId !== logicalItemId) {
    return readingAttemptJson({ error: "阅读练习记录返回了无效数据。" }, { status: 500 });
  }
  return readingAttemptJson(
    { attempt: data },
    { status: data.created ? 201 : 200 }
  );
}

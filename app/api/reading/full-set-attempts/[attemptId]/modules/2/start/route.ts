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
    return readingFullSetAttemptJson({ error: "无效的套题练习请求。" }, { status: 400 });
  }
  const { data, error } = await auth.client.rpc("prepare_reading_full_set_module_2", {
    p_attempt_id: params.attemptId
  });
  if (error) return readingFullSetAttemptError(error, "暂时无法开始 Module 2，请稍后重试。");
  if (!isReadingFullSetAttemptSummary(data)) {
    return readingFullSetAttemptJson({ error: "Module 2 状态返回了无效数据。" }, { status: 500 });
  }
  return readingFullSetAttemptJson({ attempt: data });
}

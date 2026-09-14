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
  const auth = await requireReadingFullSetStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client) return readingFullSetAttemptJson({ error: "请先登录。" }, { status: 401 });
  const parsedModuleNumber = moduleNumber(params.moduleNumber);
  if (!isUuid(params.attemptId) || !parsedModuleNumber) {
    return readingFullSetAttemptJson({ error: "无效的 Module 激活请求。" }, { status: 400 });
  }
  const { data, error } = await auth.client.rpc("activate_reading_full_set_module", {
    p_attempt_id: params.attemptId,
    p_module_number: parsedModuleNumber
  });
  if (error) return readingFullSetAttemptError(error, "Module 计时启动失败，请重试。");
  if (!isReadingFullSetAttemptSummary(data)) {
    return readingFullSetAttemptJson({ error: "Module 计时状态返回了无效数据。" }, { status: 500 });
  }
  return readingFullSetAttemptJson({ attempt: data });
}

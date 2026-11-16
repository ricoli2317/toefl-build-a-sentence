import { bearerToken } from "@/lib/auth";
import { readingAttemptJson, readingAttemptError, requireReadingAttemptStudent } from "@/lib/reading/attemptServer";
import type { CategorySessionPayload } from "@/lib/reading/questionCategory";
import { createAnonSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Teacher-assigned RAP Question Category Start/Resume. The browser supplies
 * only the Assignment id and an idempotency key; the database RPC verifies
 * auth.uid(), membership, Assignment type/status and the frozen manifest. No
 * rap_category quota or ordinary unlock is written.
 */
export async function POST(
  request: Request,
  { params }: { params: { assignmentId: string } }
) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.userId) {
    return readingAttemptJson({ error: "请先登录。" }, { status: 401 });
  }
  const assignmentId = String(params.assignmentId ?? "").trim();
  if (!UUID_PATTERN.test(assignmentId)) {
    return readingAttemptJson({ error: "无效的题型分类作业。" }, { status: 400 });
  }
  const body = await request.json().catch(() => null);
  if (
    !body
    || Array.isArray(body)
    || typeof body.requestId !== "string"
    || !UUID_PATTERN.test(body.requestId.trim())
    || Object.keys(body).some((key) => key !== "requestId")
  ) {
    return readingAttemptJson({ error: "无效的练习启动请求。" }, { status: 400 });
  }
  const { data, error } = await createAnonSupabase(bearerToken(request) ?? "")
    .rpc("get_or_create_rap_category_assignment_session", {
    p_assignment_id: assignmentId,
    p_request_id: body.requestId.trim()
  });
  if (error) return readingAttemptError(error, "题型分类作业加载失败，请稍后重试。");
  const payload = data as (CategorySessionPayload & { created?: boolean }) | null;
  if (!payload?.session?.sessionId || !Array.isArray(payload.answers)) {
    return readingAttemptJson({ error: "题型分类作业加载结果无效。" }, { status: 500 });
  }
  return readingAttemptJson(payload, { status: payload.created === false ? 200 : 201 });
}

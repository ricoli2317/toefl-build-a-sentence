import { NextResponse } from "next/server";
import { bearerToken, requireAuthenticatedAccount } from "@/lib/auth";
import type { GrammarPracticeSessionPayload } from "@/lib/grammarPractice";
import { mapPracticeAccessError } from "@/lib/practiceEntitlements";
import { createAnonSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (data: unknown, init?: ResponseInit) =>
  NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });

/**
 * Teacher-assigned BAS Grammar Category Start/Resume.
 *
 * The browser supplies only the Assignment id and a request idempotency key.
 * The database RPC verifies auth.uid(), Assignment membership, type/status and
 * reads the frozen manifest. It never spends bas_category quota.
 */
export async function POST(
  request: Request,
  { params }: { params: { assignmentId: string } }
) {
  try {
    const token = bearerToken(request);
    const auth = await requireAuthenticatedAccount(token);
    if (auth.error || !auth.userId || !auth.role || !token) {
      return json({ error: "请先登录后再开始语法练习。" }, { status: 401 });
    }
    if (auth.role !== "student") {
      return json({ error: "仅学生可以开始教师分类作业。" }, { status: 403 });
    }
    const assignmentId = String(params.assignmentId ?? "").trim();
    if (!UUID_PATTERN.test(assignmentId)) {
      return json({ error: "无效的语法分类作业。" }, { status: 400 });
    }
    const body = (await request.json().catch(() => null)) as {
      requestId?: unknown;
    } | null;
    if (
      !body ||
      typeof body.requestId !== "string" ||
      !UUID_PATTERN.test(body.requestId.trim()) ||
      Object.keys(body).some((key) => key !== "requestId")
    ) {
      return json({ error: "无效的语法练习启动请求。" }, { status: 400 });
    }

    const { data, error } = await createAnonSupabase(token).rpc(
      "get_or_create_bas_category_assignment_session",
      {
        p_assignment_id: assignmentId,
        p_request_id: body.requestId.trim()
      }
    );
    if (error) {
      const failure = mapPracticeAccessError(
        error,
        "语法分类作业加载失败，请稍后重试。"
      );
      if (failure.status >= 500) {
        console.error("[grammar-category-assignment] start_failed", {
          code: error.code ?? null,
          message: error.message
        });
      }
      return json({ error: failure.message }, { status: failure.status });
    }
    const payload = data as (GrammarPracticeSessionPayload & { created?: boolean }) | null;
    if (!payload?.session?.sessionId) {
      return json({ error: "语法分类作业加载结果无效。" }, { status: 500 });
    }
    return json(payload, { status: payload.created === false ? 200 : 201 });
  } catch (error) {
    console.error("[grammar-category-assignment] request_failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return json({ error: "语法分类作业加载失败，请稍后重试。" }, { status: 500 });
  }
}

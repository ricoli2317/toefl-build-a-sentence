import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  assertWritingReviewTeacher,
  saveWritingReviewWorkspace,
  WritingReviewWorkspaceServerError
} from "@/lib/writingReviewWorkspaceServer";
import { canManageWritingAttempt } from "@/lib/accountAccess";

export const dynamic = "force-dynamic";

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}

export async function POST(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  try {
    const auth = await requireUserWithRole(bearerToken(request), "teacher");
    assertWritingReviewTeacher(auth);
    const supabase = createServiceSupabase();
    if (!await canManageWritingAttempt(supabase, { userId: auth.userId!, role: auth.role! }, params.attemptId)) {
      throw new WritingReviewWorkspaceServerError("ATTEMPT_NOT_FOUND", "未找到这条写作提交。", 404);
    }
    const review = await saveWritingReviewWorkspace(
      supabase,
      params.attemptId,
      await request.json(),
      { publish: true }
    );
    return json({ review });
  } catch (error) {
    if (error instanceof WritingReviewWorkspaceServerError) {
      return json(
        { code: error.code, message: error.message },
        { status: error.status }
      );
    }
    console.error("Unexpected writing review publish error", {
      attemptId: params.attemptId,
      error: error instanceof Error ? error.message : "Unknown error"
    });
    return json(
      { code: "INTERNAL_SERVER_ERROR", message: "发布失败，请稍后重试。" },
      { status: 500 }
    );
  }
}

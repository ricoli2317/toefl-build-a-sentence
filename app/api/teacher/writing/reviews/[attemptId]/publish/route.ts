import { NextResponse } from "next/server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  assertWritingReviewTeacher,
  loadAuthorizedWritingReviewSource,
  saveWritingReviewWorkspace,
  WritingReviewWorkspaceServerError
} from "@/lib/writingReviewWorkspaceServer";

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
    const auth = await requireTeacherOnly(bearerToken(request));
    assertWritingReviewTeacher(auth);
    const supabase = createServiceSupabase();
    const source = await loadAuthorizedWritingReviewSource(
      supabase,
      { userId: auth.userId!, role: auth.role! },
      params.attemptId
    );
    const review = await saveWritingReviewWorkspace(
      supabase,
      params.attemptId,
      await request.json(),
      { publish: true, source }
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

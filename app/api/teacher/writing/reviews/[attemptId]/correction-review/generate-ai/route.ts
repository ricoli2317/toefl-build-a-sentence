import { NextResponse } from "next/server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { assertWritingReviewTeacher } from "@/lib/writingReviewWorkspaceServer";
import { correctionId } from "@/lib/writingCorrection";
import {
  correctionReviewServerError,
  generateCorrectionReview
} from "@/lib/writingCorrectionReview.server";

export const dynamic = "force-dynamic";
// Keep the function alive beyond the C3 210s deadline so the route can still
// persist the correction review and its telemetry.
export const maxDuration = 240;

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
    const result = await generateCorrectionReview(
      supabase,
      { userId: auth.userId!, role: auth.role! },
      correctionId(params.attemptId)
    );
    return json({
      workspace: result.workspace,
      teacher_overrides_preserved: result.teacher_overrides_preserved,
      telemetry: result.telemetry
    });
  } catch (error) {
    const known = correctionReviewServerError(error);
    if (known) return json({ code: known.code, message: known.message }, { status: known.status });
    console.error("Unexpected correction AI error", {
      attemptId: params.attemptId,
      error: error instanceof Error ? error.message : "Unknown error"
    });
    return json(
      { code: "INTERNAL_SERVER_ERROR", message: "订正评价生成失败。" },
      { status: 500 }
    );
  }
}

import { NextResponse } from "next/server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { assertWritingReviewTeacher } from "@/lib/writingReviewWorkspaceServer";
import { correctionId } from "@/lib/writingCorrection";
import {
  correctionReviewServerError,
  loadCorrectionReviewWorkspace,
  saveCorrectionReview
} from "@/lib/writingCorrectionReview.server";

export const dynamic = "force-dynamic";

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}

export async function GET(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  try {
    const auth = await requireTeacherOnly(bearerToken(request));
    assertWritingReviewTeacher(auth);
    const supabase = createServiceSupabase();
    const workspace = await loadCorrectionReviewWorkspace(
      supabase,
      { userId: auth.userId!, role: auth.role! },
      correctionId(params.attemptId)
    );
    return json({ workspace });
  } catch (error) {
    const known = correctionReviewServerError(error);
    if (known) return json({ code: known.code, message: known.message }, { status: known.status });
    console.error("Unexpected correction review load error", {
      attemptId: params.attemptId,
      error: error instanceof Error ? error.message : "Unknown error"
    });
    return json(
      { code: "INTERNAL_SERVER_ERROR", message: "无法加载订正评价。" },
      { status: 500 }
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  try {
    const auth = await requireTeacherOnly(bearerToken(request));
    assertWritingReviewTeacher(auth);
    const body = (await request.json()) as { action?: unknown } & Record<string, unknown>;
    if (body?.action !== "save" && body?.action !== "publish") {
      return json(
        { code: "CORRECTION_REVIEW_INVALID", message: "不支持的订正评价操作。" },
        { status: 400 }
      );
    }
    const supabase = createServiceSupabase();
    const workspace = await saveCorrectionReview(
      supabase,
      { userId: auth.userId!, role: auth.role! },
      correctionId(params.attemptId),
      body,
      { publish: body.action === "publish" }
    );
    return json({ workspace });
  } catch (error) {
    const known = correctionReviewServerError(error);
    if (known) return json({ code: known.code, message: known.message }, { status: known.status });
    console.error("Unexpected correction review save error", {
      attemptId: params.attemptId,
      error: error instanceof Error ? error.message : "Unknown error"
    });
    return json(
      { code: "INTERNAL_SERVER_ERROR", message: "保存订正评价失败。" },
      { status: 500 }
    );
  }
}

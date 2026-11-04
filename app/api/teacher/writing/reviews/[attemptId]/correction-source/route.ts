import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import { writingJson } from "@/lib/writingServer";
import { frozenWritingCorrectionSource, WritingCorrectionError } from "@/lib/writingCorrection";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";
import { attachWritingCorrectionRevision } from "@/lib/writingCorrection.server";
import { assertWritingReviewTeacher, loadAuthorizedWritingReviewSource,
  WritingReviewWorkspaceServerError } from "@/lib/writingReviewWorkspaceServer";

export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: { attemptId: string } }) {
  try {
    const auth = await requireTeacherOnly(bearerToken(request));
    assertWritingReviewTeacher(auth);
    const db = createServiceSupabase();
    const source = await loadAuthorizedWritingReviewSource(db,
      { userId: auth.userId!, role: auth.role! }, params.attemptId, { allowCorrectionSource: true });
    if (source.attempt.attempt_kind !== "correction" || source.attempt.status !== "submitted") {
      return writingJson({ code: "ATTEMPT_NOT_FOUND", error: "未找到这条订正。" }, { status: 404 });
    }
    const profile = await db.from("profiles").select("id,email,full_name").eq("id", source.attempt.user_id).maybeSingle();
    if (profile.error) return writingJson({ error: "无法加载学生信息。" }, { status: 500 });
    const attempt = await attachWritingCorrectionRevision(db, source.attempt);
    return writingJson({ attempt,
      studentName: getPreferredUserDisplayName({ profileFullName: profile.data?.full_name, email: profile.data?.email }),
      frozen_source: frozenWritingCorrectionSource(source.attempt), review_supported: true });
  } catch (error) {
    if (error instanceof WritingReviewWorkspaceServerError || error instanceof WritingCorrectionError) {
      return writingJson({ code: error.code, error: error.message }, { status: error.status });
    }
    return writingJson({ error: "无法加载订正来源。" }, { status: 500 });
  }
}

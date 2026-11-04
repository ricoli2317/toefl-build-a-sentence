import { requireWritingStudent, writingJson } from "@/lib/writingServer";
import { createServiceSupabase } from "@/lib/supabase/server";
import { loadStudentCorrectionReview } from "@/lib/writingCorrectionPublished.server";
import { WritingCorrectionError } from "@/lib/writingCorrection";

export const dynamic = "force-dynamic";
export async function GET(request: Request, { params }: { params: { attemptId: string } }) {
  try {
    const auth = await requireWritingStudent(request);
    if (auth.error) return auth.error;
    if (!auth.userId) return writingJson({ error: "Unauthorized" }, { status: 401 });
    return writingJson(await loadStudentCorrectionReview(createServiceSupabase(), auth.userId, params.attemptId));
  } catch (error) {
    return writingJson({ error: error instanceof WritingCorrectionError ? error.message : "无法加载订正批改。" },
      { status: error instanceof WritingCorrectionError ? error.status : 500 });
  }
}

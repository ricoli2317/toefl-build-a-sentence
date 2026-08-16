import { createServiceSupabase } from "@/lib/supabase/server";
import {
  StudentPublishedReviewError,
  loadStudentPublishedWritingReview
} from "@/lib/writingPublishedReviewServer";
import { requireWritingStudent, writingJson } from "@/lib/writingServer";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  try {
    const auth = await requireWritingStudent(request);
    if (auth.error) return auth.error;
    if (!auth.userId) {
      return writingJson({ error: "Unauthorized" }, { status: 401 });
    }
    const payload = await loadStudentPublishedWritingReview(
      createServiceSupabase(),
      auth.userId,
      params.attemptId
    );
    return writingJson(payload);
  } catch (error) {
    if (error instanceof StudentPublishedReviewError) {
      return writingJson(
        { code: error.code, error: error.message },
        { status: error.status }
      );
    }
    return writingJson(
      { error: "暂时无法加载批改结果，请稍后重试。" },
      { status: 500 }
    );
  }
}

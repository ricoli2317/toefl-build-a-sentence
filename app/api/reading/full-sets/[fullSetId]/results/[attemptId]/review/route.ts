import {
  isFullSetId,
  isUuid,
  loadOwnedReadingFullSetAttempt,
  readingFullSetAttemptJson,
  requireReadingFullSetStudent
} from "@/lib/reading/fullSetAttemptServer";
import { loadReadingFullSetFinalSnapshot } from "@/lib/reading/fullSetReviewServer";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: { fullSetId: string; attemptId: string } }
) {
  const auth = await requireReadingFullSetStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client) return readingFullSetAttemptJson({ error: "请先登录。" }, { status: 401 });
  if (!isFullSetId(params.fullSetId) || !isUuid(params.attemptId)) {
    return readingFullSetAttemptJson({ error: "无效的套题作答请求。" }, { status: 400 });
  }
  const owned = await loadOwnedReadingFullSetAttempt(auth.client, params.attemptId);
  if (owned.error || !owned.attempt || owned.attempt.fullSetId !== params.fullSetId) {
    return readingFullSetAttemptJson({ error: "没有找到这次套题作答。" }, { status: 404 });
  }
  if (owned.attempt.status !== "completed" || !owned.attempt.completedAt) {
    return readingFullSetAttemptJson({ error: "这次套题练习尚未完成。" }, { status: 409 });
  }
  try {
    const db = createServiceSupabase();
    const snapshot = await loadReadingFullSetFinalSnapshot(db, {
      attempt_id: owned.attempt.attemptId,
      full_set_id: owned.attempt.fullSetId,
      status: owned.attempt.status,
      completed_at: owned.attempt.completedAt
    });
    return readingFullSetAttemptJson(snapshot.review);
  } catch (loadError) {
    console.error("Reading Full Set review load failed", {
      attemptId: params.attemptId,
      message: loadError instanceof Error ? loadError.message : "unknown"
    });
    return readingFullSetAttemptJson({ error: "套题作答加载失败，请稍后重试。" }, { status: 500 });
  }
}

import {
  buildReadingFullSetRunnerPayload,
  isUuid,
  loadOwnedReadingFullSetAttempt,
  readingFullSetAttemptError,
  readingFullSetAttemptJson,
  requireReadingFullSetStudent
} from "@/lib/reading/fullSetAttemptServer";
import { findValidReadingFullSet } from "@/lib/reading/fullSets";
import { loadReadingFullSets } from "@/lib/reading/fullSets.server";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  const auth = await requireReadingFullSetStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client) return readingFullSetAttemptJson({ error: "请先登录。" }, { status: 401 });
  if (!isUuid(params.attemptId)) {
    return readingFullSetAttemptJson({ error: "无效的套题练习请求。" }, { status: 400 });
  }
  const owned = await loadOwnedReadingFullSetAttempt(auth.client, params.attemptId);
  if (owned.error || !owned.attempt) {
    return readingFullSetAttemptError(owned.error, "套题练习加载失败，请稍后重试。");
  }
  try {
    const fullSet = findValidReadingFullSet(
      await loadReadingFullSets(createServiceSupabase()),
      owned.attempt.fullSetId
    );
    if (!fullSet) {
      return readingFullSetAttemptJson({ error: "这套阅读练习的数据已不可用。" }, { status: 409 });
    }
    return readingFullSetAttemptJson({
      runner: buildReadingFullSetRunnerPayload(owned.attempt, fullSet)
    });
  } catch (error) {
    console.error("Reading Full Set runner load failed", { error, attemptId: params.attemptId });
    return readingFullSetAttemptJson({ error: "套题练习加载失败，请稍后重试。" }, { status: 500 });
  }
}

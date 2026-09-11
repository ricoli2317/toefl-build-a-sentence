import {
  isFullSetId,
  loadOwnedReadingFullSetAttempt,
  readingFullSetAttemptError,
  readingFullSetAttemptJson,
  requireReadingFullSetStudent
} from "@/lib/reading/fullSetAttemptServer";
import { isReadingFullSetAttemptSummary } from "@/lib/reading/fullSetAttempts";
import { findValidReadingFullSet } from "@/lib/reading/fullSets";
import { buildReadingFullSetCatalogStates } from "@/lib/reading/fullSets";
import { loadReadingFullSets } from "@/lib/reading/fullSets.server";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireReadingFullSetStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client) return readingFullSetAttemptJson({ error: "请先登录。" }, { status: 401 });
  const fullSetId = new URL(request.url).searchParams.get("fullSetId")?.trim() ?? "";
  if (!isFullSetId(fullSetId)) {
    return readingFullSetAttemptJson({ error: "无效的套题练习请求。" }, { status: 400 });
  }
  const { data, error } = await createServiceSupabase().from("reading_full_set_attempts")
    .select("attempt_id,full_set_id,status,completed_at,created_at")
    .eq("student_id", auth.userId)
    .eq("full_set_id", fullSetId);
  if (error) return readingFullSetAttemptError(error, "套题练习状态加载失败，请稍后重试。");
  const state = buildReadingFullSetCatalogStates(data ?? []).get(fullSetId);
  const attemptId = state?.activeAttemptId ?? state?.latestCompletedAttemptId ?? null;
  if (!attemptId) return readingFullSetAttemptJson({ attempt: null });
  const owned = await loadOwnedReadingFullSetAttempt(auth.client, attemptId);
  if (owned.error) return readingFullSetAttemptError(owned.error, "套题练习状态加载失败，请稍后重试。");
  if (!owned.attempt || !isReadingFullSetAttemptSummary(owned.attempt) || owned.attempt.fullSetId !== fullSetId) {
    return readingFullSetAttemptJson({ error: "套题练习状态返回了无效数据。" }, { status: 500 });
  }
  return readingFullSetAttemptJson({ attempt: owned.attempt });
}

export async function POST(request: Request) {
  const auth = await requireReadingFullSetStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client) return readingFullSetAttemptJson({ error: "请先登录。" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { fullSetId?: unknown };
  const fullSetId = typeof body.fullSetId === "string" ? body.fullSetId.trim() : "";
  if (!isFullSetId(fullSetId)) {
    return readingFullSetAttemptJson({ error: "无效的套题练习请求。" }, { status: 400 });
  }
  try {
    const fullSet = findValidReadingFullSet(
      await loadReadingFullSets(createServiceSupabase()),
      fullSetId
    );
    if (!fullSet) {
      return readingFullSetAttemptJson({ error: "没有找到这个完整阅读套题。" }, { status: 404 });
    }
  } catch (error) {
    console.error("Reading Full Set start validation failed", { error, fullSetId });
    return readingFullSetAttemptJson({ error: "暂时无法开始套题练习，请稍后重试。" }, { status: 500 });
  }
  const { data, error } = await auth.client.rpc("get_or_create_reading_full_set_attempt", {
    p_full_set_id: fullSetId
  });
  if (error) return readingFullSetAttemptError(error, "暂时无法开始套题练习，请稍后重试。");
  if (!isReadingFullSetAttemptSummary(data) || data.fullSetId !== fullSetId) {
    return readingFullSetAttemptJson({ error: "套题练习记录返回了无效数据。" }, { status: 500 });
  }
  return readingFullSetAttemptJson({ attempt: data }, { status: data.created ? 201 : 200 });
}

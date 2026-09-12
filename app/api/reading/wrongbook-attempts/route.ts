import { isReadingModule } from "@/lib/reading/catalog";
import {
  readingAttemptError,
  readingAttemptJson,
  requireReadingAttemptStudent
} from "@/lib/reading/attemptServer";
import {
  isReadingWrongbookAttemptSummary,
  isReadingWrongbookScope
} from "@/lib/reading/wrongbook";
import {
  loadReadingWrongbookPreservedAnswers,
  loadReadingWrongbookQueue,
  toReadingWrongbookPreservedAnswers
} from "@/lib/reading/wrongbook.server";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.userId) return readingAttemptJson({ error: "请先登录。" }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const parsed = parseQueueRequest(params);
  if (!parsed) return readingAttemptJson({ error: "无效的错题订正请求。" }, { status: 400 });

  try {
    const items = await loadReadingWrongbookQueue({
      db: createServiceSupabase(),
      itemId: parsed.itemId,
      scope: parsed.scope,
      studentId: auth.userId,
      taskType: parsed.taskType,
      todayEnd: parsed.todayEnd,
      todayStart: parsed.todayStart
    });
    return readingAttemptJson({ items, scope: parsed.scope, taskType: parsed.taskType });
  } catch (error) {
    console.error("Reading wrongbook queue load failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return readingAttemptJson({ error: "错题订正加载失败，请稍后重试。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client || !auth.userId) {
    return readingAttemptJson({ error: "请先登录。" }, { status: 401 });
  }
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const params = new URLSearchParams();
  for (const key of ["itemId", "scope", "taskType", "todayEnd", "todayStart"] as const) {
    if (typeof body[key] === "string") params.set(key, body[key]);
  }
  const parsed = parseQueueRequest(params, true);
  if (!parsed?.itemId) {
    return readingAttemptJson({ error: "无效的错题订正请求。" }, { status: 400 });
  }

  try {
    const [item] = await loadReadingWrongbookQueue({
      db: createServiceSupabase(),
      itemId: parsed.itemId,
      scope: parsed.scope,
      studentId: auth.userId,
      taskType: parsed.taskType,
      todayEnd: parsed.todayEnd,
      todayStart: parsed.todayStart
    });
    if (!item) {
      return readingAttemptJson({ error: "这组错题已经订正完成。" }, { status: 409 });
    }
    const { data, error } = await auth.client.rpc("get_or_create_reading_wrongbook_attempt", {
      p_logical_item_id: item.logicalItemId,
      p_scope: parsed.scope,
      p_targets: item.targets
    });
    if (error) return readingAttemptError(error, "暂时无法进入错题订正，请稍后重试。");
    if (!isReadingWrongbookAttemptSummary(data) || data.logicalItemId !== item.logicalItemId) {
      return readingAttemptJson({ error: "错题订正记录返回了无效数据。" }, { status: 500 });
    }
    const preservedAnswers = data.taskType === "ctw"
      ? toReadingWrongbookPreservedAnswers(await loadReadingWrongbookPreservedAnswers({
          before: data.startedAt,
          db: createServiceSupabase(),
          logicalItemId: data.logicalItemId,
          studentId: auth.userId,
          targets: data.targets
        }))
      : [];
    return readingAttemptJson({ attempt: data, preservedAnswers }, { status: data.created ? 201 : 200 });
  } catch (error) {
    console.error("Reading wrongbook attempt creation failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return readingAttemptJson({ error: "暂时无法进入错题订正，请稍后重试。" }, { status: 500 });
  }
}

function parseQueueRequest(params: URLSearchParams, requireItem = false) {
  const scope = params.get("scope");
  const taskType = params.get("taskType");
  const itemId = params.get("itemId")?.trim() || null;
  const todayStart = Date.parse(params.get("todayStart") ?? "");
  const todayEnd = Date.parse(params.get("todayEnd") ?? "");
  if (
    !isReadingWrongbookScope(scope)
    || !isReadingModule(taskType)
    || (requireItem && !itemId)
    || (itemId && !/^reading-(ctw|rdl|rap)-[a-f0-9]{24}$/.test(itemId))
    || !Number.isFinite(todayStart)
    || !Number.isFinite(todayEnd)
    || todayEnd <= todayStart
    || todayEnd - todayStart > 26 * 60 * 60 * 1000
  ) return null;
  return { itemId, scope, taskType, todayEnd, todayStart };
}

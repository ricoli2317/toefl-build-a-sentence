import { isReadingModule } from "@/lib/reading/catalog";
import {
  readingAttemptError,
  readingAttemptJson,
  requireReadingAttemptStudent
} from "@/lib/reading/attemptServer";
import {
  isReadingFullSetWrongbookAttemptSummary,
  isReadingWrongbookAttemptSummary,
  isReadingWrongbookScope
} from "@/lib/reading/wrongbook";
import {
  loadReadingFullSetPreservedAnswers,
  loadReadingFullSetWrongbookQueue
} from "@/lib/reading/fullSetWrongbook.server";
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
    if (parsed.taskType === "full_set") {
      const items = await loadReadingFullSetWrongbookQueue({
        db: createServiceSupabase(),
        scope: parsed.scope,
        sourceAttemptId: parsed.sourceAttemptId,
        studentId: auth.userId,
        todayEnd: parsed.todayEnd,
        todayStart: parsed.todayStart
      });
      return readingAttemptJson({ items, scope: parsed.scope, taskType: "full_set" });
    }
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
  for (const key of ["itemId", "scope", "sourceAttemptId", "taskType", "todayEnd", "todayStart"] as const) {
    if (typeof body[key] === "string") params.set(key, body[key]);
  }
  const parsed = parseQueueRequest(params, true);
  if (!parsed || (parsed.taskType === "full_set" ? !parsed.sourceAttemptId : !parsed.itemId)) {
    return readingAttemptJson({ error: "无效的错题订正请求。" }, { status: 400 });
  }

  try {
    if (parsed.taskType === "full_set") {
      const [item] = await loadReadingFullSetWrongbookQueue({
        db: createServiceSupabase(),
        scope: parsed.scope,
        sourceAttemptId: parsed.sourceAttemptId,
        studentId: auth.userId,
        todayEnd: parsed.todayEnd,
        todayStart: parsed.todayStart
      });
      if (!item) return readingAttemptJson({ error: "这套错题已经订正完成。" }, { status: 409 });
      const { data, error } = await auth.client.rpc("get_or_create_reading_full_set_wrongbook_attempt", {
        p_full_set_id: item.fullSetId,
        p_scope: parsed.scope,
        p_source_attempt_id: item.sourceAttemptId,
        p_targets: item.targets
      });
      if (error) return readingAttemptError(error, "暂时无法进入错题订正，请稍后重试。");
      if (
        !isReadingFullSetWrongbookAttemptSummary(data)
        || data.sourceAttemptId !== item.sourceAttemptId
        || data.sourceFullSetId !== item.fullSetId
      ) return readingAttemptJson({ error: "错题订正记录返回了无效数据。" }, { status: 500 });
      const preservedAnswersByOccurrence = await loadReadingFullSetPreservedAnswers({
        before: data.startedAt,
        db: createServiceSupabase(),
        excludeAttemptId: data.attemptId,
        sourceAttemptId: item.sourceAttemptId,
        targets: item.targets
      });
      return readingAttemptJson(
        { attempt: data, item, preservedAnswersByOccurrence },
        { status: data.created ? 201 : 200 }
      );
    }
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
    return readingAttemptJson(
      { attempt: data, item, preservedAnswers },
      { status: data.created ? 201 : 200 }
    );
  } catch (error) {
    console.error("Reading wrongbook attempt creation failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return readingAttemptJson({ error: "暂时无法进入错题订正，请稍后重试。" }, { status: 500 });
  }
}

function parseQueueRequest(params: URLSearchParams, requireItem = false) {
  const scope = params.get("scope");
  const requestedTaskType = params.get("taskType");
  const taskType = requestedTaskType === "full_set"
    ? "full_set" as const
    : isReadingModule(requestedTaskType)
      ? requestedTaskType
      : null;
  const itemId = params.get("itemId")?.trim() || null;
  const sourceAttemptId = params.get("sourceAttemptId")?.trim() || null;
  const todayStart = Date.parse(params.get("todayStart") ?? "");
  const todayEnd = Date.parse(params.get("todayEnd") ?? "");
  if (
    !isReadingWrongbookScope(scope)
    || !taskType
    || (requireItem && taskType === "full_set" && !sourceAttemptId)
    || (requireItem && taskType !== "full_set" && !itemId)
    || (itemId && !/^reading-(ctw|rdl|rap)-[a-f0-9]{24}$/.test(itemId))
    || (sourceAttemptId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sourceAttemptId))
    || !Number.isFinite(todayStart)
    || !Number.isFinite(todayEnd)
    || todayEnd <= todayStart
    || todayEnd - todayStart > 26 * 60 * 60 * 1000
  ) return null;
  return { itemId, scope, sourceAttemptId, taskType, todayEnd, todayStart };
}

import {
  buildReadingFullSetRunnerPayload,
  isUuid,
  loadOwnedReadingFullSetAttempt,
  loadReadingFullSetOccurrencePracticePayload,
  requireReadingFullSetStudent
} from "@/lib/reading/fullSetAttemptServer";
import {
  readingFullSetBootstrapOccurrence,
  readingFullSetCurrentModuleAttempt
} from "@/lib/reading/fullSetAttempts";
import { loadReadingFullSet } from "@/lib/reading/fullSets.server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { createStudentPerformanceTrace } from "@/lib/studentPerformance.server";

export const dynamic = "force-dynamic";

const ROUTE = "/api/reading/full-set-attempts/[attemptId]";

export async function GET(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  const timing = createStudentPerformanceTrace(ROUTE, {
    attemptId: params.attemptId,
    traceId: request.headers.get("x-reading-full-set-trace-id")
  });
  const respond = (data: unknown, init: ResponseInit = {}) => {
    const body = timing.measureSync("processing", "serialization", () => JSON.stringify(data));
    const headers = timing.finishHeaders(init.headers, (init.status ?? 200) < 400);
    headers.set("Content-Type", "application/json");
    return new Response(body, { ...init, headers });
  };
  const auth = await requireReadingFullSetStudent(request, timing);
  if (auth.error || !auth.client) return respond({ error: "请先登录。" }, { status: 401 });
  if (!isUuid(params.attemptId)) {
    return respond({ error: "无效的套题练习请求。" }, { status: 400 });
  }
  const owned = await timing.measure("database", "ownership", () =>
    loadOwnedReadingFullSetAttempt(auth.client!, params.attemptId)
  );
  if (owned.error || !owned.attempt) {
    return respond({ error: "无权读取这次套题练习。" }, { status: 403 });
  }
  try {
    const db = createServiceSupabase();
    const fullSet = await timing.measure("database", "definition_resolution", () =>
      loadReadingFullSet(db, owned.attempt!.fullSetId)
    );
    if (!fullSet) {
      return respond({ error: "这套阅读练习的数据已不可用。" }, { status: 409 });
    }
    const runner = buildReadingFullSetRunnerPayload(owned.attempt, fullSet);
    const moduleAttempt = readingFullSetCurrentModuleAttempt(owned.attempt);
    const initialOccurrence = moduleAttempt
      ? readingFullSetBootstrapOccurrence(runner.occurrences, moduleAttempt)
      : null;
    if (!moduleAttempt || !initialOccurrence) return respond({ runner, traceId: timing.traceId });
    const definitionOccurrence = (moduleAttempt.moduleNumber === 1
      ? fullSet.module1.occurrences
      : fullSet.module2.occurrences
    ).find((occurrence) => occurrence.occurrenceId === initialOccurrence.occurrenceId);
    if (!definitionOccurrence) {
      return respond({ error: "当前题目数据已不可用。" }, { status: 409 });
    }
    const firstOccurrence = await loadReadingFullSetOccurrencePracticePayload({
      db,
      moduleAttempt,
      occurrence: definitionOccurrence,
      timing,
      title: fullSet.title
    });
    return respond({ firstOccurrence, runner, traceId: timing.traceId });
  } catch (error) {
    console.error("Reading Full Set runner load failed", { error, attemptId: params.attemptId });
    return respond({ error: "套题练习加载失败，请稍后重试。" }, { status: 500 });
  }
}

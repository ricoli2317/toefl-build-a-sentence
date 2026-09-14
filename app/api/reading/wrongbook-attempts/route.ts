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
  loadReadingFullSetWrongbookBootstrapQueue,
  loadReadingFullSetWrongbookQueue
} from "@/lib/reading/fullSetWrongbook.server";
import {
  loadStudentReadingPractice,
  StudentReadingLoadError,
  type StudentReadingPracticePayload
} from "@/lib/reading/studentPractice";
import {
  loadReadingWrongbookPreservedAnswers,
  loadReadingWrongbookQueue,
  toReadingWrongbookPreservedAnswers
} from "@/lib/reading/wrongbook.server";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  sameReadingFullSetWrongbookTarget,
  sameReadingFullSetWrongbookTargets,
  type ReadingFullSetWrongbookTarget
} from "@/lib/wrongQuestions";
import {
  appendSupabaseDebugMetrics,
  createServerDebugTrace,
  instrumentSupabaseClient,
  profileSupabaseQuery,
  synchronizeServerDebugOrigins,
  wantsSupabaseDebugMetrics,
  type ServerDebugMetric,
  type SupabaseQueryMetric
} from "@/lib/supabase/debugMetrics.server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.userId) return readingAttemptJson({ error: "请先登录。" }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const parsed = parseQueueRequest(params);
  if (!parsed) return readingAttemptJson({ error: "无效的错题订正请求。" }, { status: 400 });
  const debugMetrics: SupabaseQueryMetric[] = [];
  const debugEnabled = wantsSupabaseDebugMetrics(request);
  const service = () => {
    const client = createServiceSupabase();
    return debugEnabled ? instrumentSupabaseClient(client, debugMetrics) : client;
  };

  try {
    if (parsed.taskType === "full_set") {
      const items = await loadReadingFullSetWrongbookQueue({
        db: service(),
        scope: parsed.scope,
        sourceAttemptId: parsed.sourceAttemptId,
        studentId: auth.userId,
        todayEnd: parsed.todayEnd,
        todayStart: parsed.todayStart
      });
      const response = readingAttemptJson({ items, scope: parsed.scope, taskType: "full_set" });
      return debugEnabled ? appendSupabaseDebugMetrics(response, debugMetrics) : response;
    }
    const items = await loadReadingWrongbookQueue({
      db: service(),
      itemId: parsed.itemId,
      scope: parsed.scope,
      studentId: auth.userId,
      taskType: parsed.taskType,
      todayEnd: parsed.todayEnd,
      todayStart: parsed.todayStart
    });
    const response = readingAttemptJson({ items, scope: parsed.scope, taskType: parsed.taskType });
    return debugEnabled ? appendSupabaseDebugMetrics(response, debugMetrics) : response;
  } catch (error) {
    console.error("Reading wrongbook queue load failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return readingAttemptJson({ error: "错题订正加载失败，请稍后重试。" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const requestStartedAt = performance.now();
  const debugMetrics: SupabaseQueryMetric[] = [];
  const stageMetrics: ServerDebugMetric[] = [];
  synchronizeServerDebugOrigins(debugMetrics, stageMetrics);
  const debugEnabled = wantsSupabaseDebugMetrics(request);
  const profile = createServerDebugTrace(stageMetrics, debugEnabled);
  const auth = await profile.measure(
    "correction auth",
    [],
    () => requireReadingAttemptStudent(request)
  );
  if (auth.error) return auth.error;
  if (!auth.client || !auth.userId) {
    return readingAttemptJson({ error: "请先登录。" }, { status: 401 });
  }
  const userId = auth.userId;
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const params = new URLSearchParams();
  for (const key of ["itemId", "scope", "sourceAttemptId", "taskType", "todayEnd", "todayStart"] as const) {
    if (typeof body[key] === "string") params.set(key, body[key]);
  }
  const parsed = parseQueueRequest(params, true);
  if (!parsed || (parsed.taskType === "full_set" ? !parsed.sourceAttemptId : !parsed.itemId)) {
    return readingAttemptJson({ error: "无效的错题订正请求。" }, { status: 400 });
  }
  const service = () => {
    const client = createServiceSupabase();
    return debugEnabled ? instrumentSupabaseClient(client, debugMetrics) : client;
  };
  const mutationClient = debugEnabled
    ? instrumentSupabaseClient(auth.client, debugMetrics)
    : auth.client;

  try {
    if (parsed.taskType === "full_set") {
      const sourceAttemptId = parsed.sourceAttemptId!;
      const firstPracticeLoad: {
        promise?: Promise<
          | { error: unknown; practice?: never }
          | { error?: never; practice: StudentReadingPracticePayload }
        >;
        target?: ReadingFullSetWrongbookTarget;
      } = {};
      const [item] = await profile.measure(
        "Full Set historical/correction lookup",
        ["correction auth"],
        () => loadReadingFullSetWrongbookBootstrapQueue({
          db: service(),
          onFirstTarget: (target) => {
            firstPracticeLoad.target = target;
            profile.record(
              "Full Set first target known",
              0,
              ["Full Set first target selection"],
              1
            );
            profile.record(
              "Full Set first practice start",
              0,
              ["Full Set first target known"],
              1
            );
            firstPracticeLoad.promise = profile.measure(
              "Full Set first practice load",
              ["Full Set first practice start"],
              () => loadStudentReadingPractice(
                service(),
                target.logicalItemId,
                undefined,
                {},
                profile
              ),
              (value) => value.questions.length
            ).then(
              (practice) => ({ practice }),
              (error: unknown) => ({ error })
            );
          },
          profile,
          scope: parsed.scope,
          sourceAttemptId,
          studentId: userId,
          todayEnd: parsed.todayEnd,
          todayStart: parsed.todayStart
        }),
        (value) => value.length
      );
      if (!item) return readingAttemptJson({ error: "这套错题已经订正完成。" }, { status: 409 });
      profile.record(
        "Full Set full queue finish",
        0,
        ["Full Set bootstrap queue calculation"],
        item.targets.length
      );
      const firstTarget = firstPracticeLoad.target;
      const firstPracticePromise = firstPracticeLoad.promise;
      if (
        !firstTarget
        || !firstPracticePromise
        || !sameReadingFullSetWrongbookTarget(firstTarget, item.targets[0])
      ) {
        await firstPracticePromise;
        throw new Error("READING_FULL_SET_FIRST_TARGET_MISMATCH");
      }
      profile.record(
        "current occurrence identity",
        0,
        ["Full Set bootstrap queue calculation"],
        item.targets.length
      );
      const { data, error } = await profile.measure(
        "wrongbook attempt creation/reuse",
        ["current occurrence identity"],
        () => profileSupabaseQuery(
          { query: "full_set_get_or_create_attempt", dependsOn: ["current occurrence identity"] },
          () => mutationClient.rpc("get_or_create_reading_full_set_wrongbook_attempt", {
            p_full_set_id: item.fullSetId,
            p_scope: parsed.scope,
            p_source_attempt_id: item.sourceAttemptId,
            p_targets: item.targets
          })
        )
      );
      if (error) return readingAttemptError(error, "暂时无法进入错题订正，请稍后重试。");
      if (
        !isReadingFullSetWrongbookAttemptSummary(data)
        || data.sourceAttemptId !== item.sourceAttemptId
        || data.sourceFullSetId !== item.fullSetId
        || !sameReadingFullSetWrongbookTargets(data.targets, item.targets)
      ) return readingAttemptJson({ error: "错题订正记录返回了无效数据。" }, { status: 500 });
      const preservedAnswersPromise = profile.measure(
        "Full Set preserved/historical answer lookup",
        ["wrongbook attempt creation/reuse"],
        () => profileSupabaseQuery(
          {
            query: "full_set_preserved_answers",
            dependsOn: ["full_set_get_or_create_attempt"]
          },
          () => loadReadingFullSetPreservedAnswers({
            before: data.startedAt,
            db: service(),
            excludeAttemptId: data.attemptId,
            sourceAttemptId: item.sourceAttemptId,
            targets: item.targets
          })
        ),
        (value) => Object.values(value).reduce((sum, rows) => sum + rows.length, 0)
      );
      const [preservedAnswersByOccurrence, firstPracticeResult] = await Promise.all([
        preservedAnswersPromise,
        firstPracticePromise
      ]);
      if ("error" in firstPracticeResult) throw firstPracticeResult.error;
      const payload = {
        attempt: data,
        firstPractice: firstPracticeResult.practice,
        firstTarget,
        item,
        preservedAnswersByOccurrence
      };
      const response = profile.measureSync(
        "Full Set bootstrap serialization",
        ["Full Set preserved/historical answer lookup", "Full Set first practice load"],
        () => readingAttemptJson(
          payload,
          { status: data.created ? 201 : 200 }
        ),
        () => new TextEncoder().encode(JSON.stringify(payload)).length
      );
      profile.record(
        "Full Set bootstrap total",
        performance.now() - requestStartedAt,
        ["Full Set bootstrap serialization"],
        item.targets.length
      );
      return debugEnabled
        ? appendSupabaseDebugMetrics(response, debugMetrics, stageMetrics)
        : response;
    }
    const taskType = parsed.taskType;
    const [item] = await profile.measure(
      "historical/correction lookup",
      ["correction auth"],
      () => loadReadingWrongbookQueue({
        db: service(),
        itemId: parsed.itemId,
        profile,
        scope: parsed.scope,
        studentId: userId,
        taskType,
        todayEnd: parsed.todayEnd,
        todayStart: parsed.todayStart
      }),
      (value) => value.length
    );
    if (!item) {
      return readingAttemptJson({ error: "这组错题已经订正完成。" }, { status: 409 });
    }
    const { data, error } = await profile.measure(
      "wrongbook attempt creation/reuse",
      ["correction queue calculation"],
      () => profileSupabaseQuery(
        { query: "reading_get_or_create_attempt", dependsOn: ["correction queue calculation"] },
        () => mutationClient.rpc("get_or_create_reading_wrongbook_attempt", {
          p_logical_item_id: item.logicalItemId,
          p_scope: parsed.scope,
          p_targets: item.targets
        })
      )
    );
    if (error) return readingAttemptError(error, "暂时无法进入错题订正，请稍后重试。");
    if (!isReadingWrongbookAttemptSummary(data) || data.logicalItemId !== item.logicalItemId) {
      return readingAttemptJson({ error: "错题订正记录返回了无效数据。" }, { status: 500 });
    }
    const preservedAnswers = data.taskType === "ctw"
      ? toReadingWrongbookPreservedAnswers(await profile.measure(
          "historical/correction answer lookup",
          ["wrongbook attempt creation/reuse"],
          () => profileSupabaseQuery(
            { query: "reading_preserved_answers", dependsOn: ["reading_get_or_create_attempt"] },
            () => loadReadingWrongbookPreservedAnswers({
              before: data.startedAt,
              db: service(),
              logicalItemId: data.logicalItemId,
              studentId: userId,
              targets: data.targets
            })
          ),
          (value) => value.length
        ))
      : [];
    if (data.taskType !== "ctw") {
      profile.record(
        "historical/correction answer lookup (not required)",
        0,
        ["wrongbook attempt creation/reuse"],
        0
      );
    }
    const response = profile.measureSync(
      "correction response creation",
      [data.taskType === "ctw" ? "historical/correction answer lookup" : "wrongbook attempt creation/reuse"],
      () => readingAttemptJson(
        { attempt: data, item, preservedAnswers },
        { status: data.created ? 201 : 200 }
      )
    );
    return debugEnabled
      ? appendSupabaseDebugMetrics(response, debugMetrics, stageMetrics)
      : response;
  } catch (error) {
    console.error("Reading wrongbook attempt creation failed", {
      message: error instanceof Error ? error.message : String(error)
    });
    return readingAttemptJson(
      {
        error: error instanceof StudentReadingLoadError
          ? `首题内容加载失败：${error.publicMessage}`
          : "暂时无法进入错题订正，请稍后重试。"
      },
      { status: error instanceof StudentReadingLoadError ? error.status : 500 }
    );
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

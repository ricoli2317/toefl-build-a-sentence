import type { SupabaseClient } from "@supabase/supabase-js";
import { isReadingModule } from "@/lib/reading/catalog";
import {
  readingAttemptError,
  readingAttemptJson,
  requireReadingAttemptStudent
} from "@/lib/reading/attemptServer";
import {
  isReadingFullSetWrongbookAttemptSummary,
  isReadingWrongbookAttemptSummary,
  isReadingWrongbookScope,
  type ReadingWrongbookPracticeItem
} from "@/lib/reading/wrongbook";
import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { loadWrongQuestionPracticeSession } from "@/lib/wrongQuestionBank.server";
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
import { loadFullSetWrongbookRdlAssets } from "@/lib/reading/fullSetWrongbookRdlAssets.server";
import {
  loadReadingCtwContextAnswers,
  loadReadingWrongbookPreservedAnswers,
  loadReadingWrongbookQueue,
  loadReadingWrongbookTitles,
  toReadingWrongbookPreservedAnswers
} from "@/lib/reading/wrongbook.server";
import type { ReadingModule } from "@/lib/reading/types";
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
  const bankRequest = parseBankRequest(body);
  const params = new URLSearchParams();
  for (const key of ["itemId", "scope", "sourceAttemptId", "taskType", "todayEnd", "todayStart"] as const) {
    if (typeof body[key] === "string") params.set(key, body[key]);
  }
  const parsed = bankRequest ? null : parseQueueRequest(params, true);
  if (!bankRequest && (!parsed || (parsed.taskType === "full_set" ? !parsed.sourceAttemptId : !parsed.itemId))) {
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
    if (bankRequest) {
      const resolved = await resolveBankCorrectionTargets(service(), userId, bankRequest);
      if (!resolved) {
        return readingAttemptJson({ error: "本次练习没有需要订正的错题。" }, { status: 409 });
      }
      const { item, scope } = resolved;
      const { data, error } = await profileSupabaseQuery(
        { query: "reading_get_or_create_attempt", dependsOn: ["correction auth"] },
        () => mutationClient.rpc("get_or_create_reading_wrongbook_attempt", {
          p_logical_item_id: item.logicalItemId,
          p_scope: scope,
          p_targets: item.targets
        })
      );
      if (error) return readingAttemptError(error, "暂时无法进入错题订正，请稍后重试。");
      if (!isReadingWrongbookAttemptSummary(data) || data.logicalItemId !== item.logicalItemId) {
        return readingAttemptJson({ error: "错题订正记录返回了无效数据。" }, { status: 500 });
      }
      const preservedAnswers = data.taskType === "ctw"
        ? toReadingWrongbookPreservedAnswers(await loadReadingWrongbookPreservedAnswers({
            before: data.startedAt,
            db: service(),
            logicalItemId: data.logicalItemId,
            studentId: userId,
            targets: data.targets
          }))
        : [];
      // CTW renders the whole paragraph. Only the history *session* practice
      // draws a partial slot set, so only it shows the material's correct word
      // as read-only context for untargeted slots (never a target answer).
      // Today practice and every entry correction keep their original
      // presentation. A context lookup failure must not block the practice.
      const contextAnswers = data.taskType === "ctw"
        && bankRequest.kind === "session"
        && data.scope === "history"
        ? await loadCtwContextAnswersSafe(service(), data.logicalItemId, data.targets)
        : [];
      return readingAttemptJson(
        { attempt: data, item, preservedAnswers, contextAnswers },
        { status: data.created ? 201 : 200 }
      );
    }
    if (!parsed) {
      return readingAttemptJson({ error: "无效的错题订正请求。" }, { status: 400 });
    }
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
                { rdlAssetLoader: loadFullSetWrongbookRdlAssets },
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

type BankCorrectionRequest =
  | { itemId: string; kind: "session"; sessionId: string }
  | { kind: "entry"; sourceAttemptId: string; taskType: ReadingModule };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const READING_ITEM_PATTERN = /^reading-(ctw|rdl|rap)-[a-f0-9]{24}$/;

/**
 * The bank-driven correction flows (today / history practice sessions and
 * formal-result entry corrections) derive their targets server-side from the
 * frozen session manifest or the source attempt. Client-supplied targets are
 * never trusted for these flows.
 */
function parseBankRequest(body: Record<string, unknown>): BankCorrectionRequest | null {
  const sessionId = typeof body.sessionId === "string" ? body.sessionId.trim() : "";
  if (sessionId) {
    const itemId = typeof body.itemId === "string" ? body.itemId.trim() : "";
    if (!UUID_PATTERN.test(sessionId) || !READING_ITEM_PATTERN.test(itemId)) return null;
    return { itemId, kind: "session", sessionId };
  }
  if (body.mode === "entry") {
    const sourceAttemptId = typeof body.sourceAttemptId === "string"
      ? body.sourceAttemptId.trim()
      : "";
    const taskType = typeof body.taskType === "string" && isReadingModule(body.taskType)
      ? body.taskType
      : null;
    if (!UUID_PATTERN.test(sourceAttemptId) || !taskType) return null;
    return { kind: "entry", sourceAttemptId, taskType };
  }
  return null;
}

async function resolveBankCorrectionTargets(
  db: SupabaseClient,
  userId: string,
  request: BankCorrectionRequest
): Promise<{ item: ReadingWrongbookPracticeItem; scope: "history" | "today" } | null> {
  if (request.kind === "session") {
    const session = await loadWrongQuestionPracticeSession(db, userId, request.sessionId);
    if (!session || session.taskType === "bas" || !session.groups) return null;
    const group = session.groups.find((candidate) => candidate.logicalItemId === request.itemId);
    if (!group || group.targets.length === 0) return null;
    return {
      item: {
        logicalItemId: group.logicalItemId,
        targets: group.targets.map((target) => ({
          questionId: target.questionId,
          slotId: target.slotId
        })),
        taskType: session.taskType,
        title: group.title
      },
      scope: session.mode === "history" ? "history" : "today"
    };
  }
  return resolveEntryCorrectionTargets(db, userId, request);
}

/**
 * Entry-level correction for one submitted attempt. A formal attempt clears
 * pending state (scope "today"); a history-practice attempt never touches
 * pending state (scope "history").
 */
async function resolveEntryCorrectionTargets(
  db: SupabaseClient,
  userId: string,
  request: { sourceAttemptId: string; taskType: ReadingModule }
): Promise<{ item: ReadingWrongbookPracticeItem; scope: "history" | "today" } | null> {
  const formalResult = await db
    .from("reading_attempts")
    .select("attempt_id,logical_item_id,task_type,status")
    .eq("attempt_id", request.sourceAttemptId)
    .eq("student_id", userId)
    .maybeSingle();
  if (formalResult.error) throw new Error(formalResult.error.message);
  if (
    formalResult.data
    && formalResult.data.status === "submitted"
    && formalResult.data.task_type === request.taskType
  ) {
    const logicalItemId = String(formalResult.data.logical_item_id);
    const targets = await readWrongAnswerTargets(db, "reading_attempt_answers", request.sourceAttemptId);
    if (targets.length === 0) return null;
    return {
      item: {
        logicalItemId,
        targets,
        taskType: request.taskType,
        title: await loadReadingItemTitle(db, logicalItemId, request.taskType)
      },
      scope: "today"
    };
  }

  const correctionResult = await db
    .from("reading_wrongbook_attempts")
    .select("attempt_id,logical_item_id,task_type,scope,status")
    .eq("attempt_id", request.sourceAttemptId)
    .eq("student_id", userId)
    .neq("task_type", "full_set")
    .maybeSingle();
  if (correctionResult.error) throw new Error(correctionResult.error.message);
  if (
    !correctionResult.data
    || correctionResult.data.status !== "submitted"
    || !correctionResult.data.logical_item_id
    || correctionResult.data.task_type !== request.taskType
  ) {
    return null;
  }
  const logicalItemId = String(correctionResult.data.logical_item_id);
  const targets = await readWrongAnswerTargets(
    db,
    "reading_wrongbook_attempt_answers",
    request.sourceAttemptId
  );
  if (targets.length === 0) return null;
  return {
    item: {
      logicalItemId,
      targets,
      taskType: request.taskType,
      title: await loadReadingItemTitle(db, logicalItemId, request.taskType)
    },
    scope: correctionResult.data.scope === "history" ? "history" : "today"
  };
}

async function readWrongAnswerTargets(
  db: SupabaseClient,
  table: "reading_attempt_answers" | "reading_wrongbook_attempt_answers",
  attemptId: string
) {
  const result = await readAllSupabaseRows<{ is_correct: boolean | null; question_id: string; slot_id: string | null }>(
    (from, to) => db.from(table)
      .select("is_correct,question_id,slot_id")
      .eq("attempt_id", attemptId)
      .order("question_id", { ascending: true })
      .order("slot_id", { ascending: true })
      .range(from, to)
  );
  if (result.error) throw new Error(result.error.message);
  const seen = new Set<string>();
  const targets: Array<{ questionId: string; slotId: string | null }> = [];
  for (const row of result.data ?? []) {
    // Wrong or unanswered (is_correct not explicitly true) both stay targets.
    if (row.is_correct === true) continue;
    const questionId = String(row.question_id);
    const slotId = row.slot_id ? String(row.slot_id) : null;
    const key = `${questionId}:${slotId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ questionId, slotId });
  }
  return targets;
}

async function loadReadingItemTitle(
  db: SupabaseClient,
  logicalItemId: string,
  taskType: ReadingModule
) {
  const titles = await loadReadingWrongbookTitles(db, [logicalItemId]);
  return titles.get(logicalItemId)?.trim() || logicalItemId || taskType;
}

/**
 * Context answers are a rendering aid for the whole CTW paragraph; a failed
 * lookup degrades to the old (blank) context instead of blocking the practice.
 */
async function loadCtwContextAnswersSafe(
  db: SupabaseClient,
  logicalItemId: string,
  targets: Array<{ questionId: string; slotId: string | null }>
) {
  try {
    return await loadReadingCtwContextAnswers({ db, logicalItemId, targets });
  } catch (error) {
    console.error("Reading CTW context answers load failed", {
      logicalItemId,
      message: error instanceof Error ? error.message : String(error)
    });
    return [];
  }
}

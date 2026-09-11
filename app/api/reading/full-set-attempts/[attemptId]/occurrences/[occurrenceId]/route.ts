import {
  isUuid,
  loadOwnedReadingFullSetAttempt,
  readingFullSetAttemptError,
  readingFullSetAttemptJson,
  requireReadingFullSetStudent
} from "@/lib/reading/fullSetAttemptServer";
import {
  isReadingFullSetAttemptSummary,
  readingFullSetAttemptPhase
} from "@/lib/reading/fullSetAttempts";
import { findValidReadingFullSet, type ReadingFullSetOccurrence } from "@/lib/reading/fullSets";
import { loadReadingFullSets } from "@/lib/reading/fullSets.server";
import { buildSubmittedReadingAnswerState, type SubmittedReadingAnswerRow } from "@/lib/reading/review";
import { loadStudentReadingPractice, StudentReadingLoadError } from "@/lib/reading/studentPractice";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: { attemptId: string; occurrenceId: string } }
) {
  const auth = await requireReadingFullSetStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client) return readingFullSetAttemptJson({ error: "请先登录。" }, { status: 401 });
  if (!isUuid(params.attemptId) || !params.occurrenceId) {
    return readingFullSetAttemptJson({ error: "无效的套题题目请求。" }, { status: 400 });
  }
  const owned = await loadOwnedReadingFullSetAttempt(auth.client, params.attemptId);
  if (owned.error || !owned.attempt) {
    return readingFullSetAttemptError(owned.error, "套题题目加载失败，请稍后重试。");
  }
  const active = activeModule(owned.attempt);
  if (!active) {
    return readingFullSetAttemptJson({ error: "当前 Module 已结束。" }, { status: 409 });
  }
  try {
    const fullSet = findValidReadingFullSet(
      await loadReadingFullSets(createServiceSupabase()),
      owned.attempt.fullSetId
    );
    const occurrence = fullSet
      ? moduleOccurrences(fullSet, active.moduleNumber)
        .find((candidate) => candidate.occurrenceId === params.occurrenceId)
      : null;
    if (!fullSet || !occurrence) {
      return readingFullSetAttemptJson({ error: "这个题目不属于当前 Module。" }, { status: 404 });
    }
    const db = createServiceSupabase();
    const practice = await loadStudentReadingPractice(db, occurrence.logicalItemId);
    const answerResult = await db
      .from("reading_full_set_answers")
      .select("question_id,slot_id,answer_kind,student_answer,question_time_seconds")
      .eq("module_attempt_id", active.moduleAttemptId)
      .eq("occurrence_id", occurrence.occurrenceId);
    if (answerResult.error) {
      return readingFullSetAttemptError(answerResult.error, "套题答案加载失败，请稍后重试。");
    }
    const rows = (answerResult.data ?? []) as SubmittedReadingAnswerRow[];
    const answers = rows.length ? buildSubmittedReadingAnswerState(practice, rows) : {};
    const questionTimes = Object.fromEntries(Array.from(new Set(rows.map((row) => row.question_id))).flatMap((questionId) => {
      const values = rows
        .filter((row) => row.question_id === questionId && row.question_time_seconds !== null)
        .map((row) => Number(row.question_time_seconds));
      return values.length ? [[questionId, Math.max(...values)]] : [];
    }));
    return readingFullSetAttemptJson({
      answerRevision: active.answerRevision,
      answers,
      occurrence: publicOccurrence(occurrence),
      practice,
      questionTimes
    });
  } catch (error) {
    if (error instanceof StudentReadingLoadError) {
      console.error("Reading Full Set occurrence content failed", {
        attemptId: params.attemptId,
        detail: error.message,
        occurrenceId: params.occurrenceId
      });
      return readingFullSetAttemptJson({ error: error.publicMessage }, { status: error.status });
    }
    console.error("Reading Full Set occurrence load failed", {
      error,
      attemptId: params.attemptId,
      occurrenceId: params.occurrenceId
    });
    return readingFullSetAttemptJson({ error: "套题题目加载失败，请稍后重试。" }, { status: 500 });
  }
}

export async function PUT(
  request: Request,
  { params }: { params: { attemptId: string; occurrenceId: string } }
) {
  const auth = await requireReadingFullSetStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client) return readingFullSetAttemptJson({ error: "请先登录。" }, { status: 401 });
  if (!isUuid(params.attemptId) || !params.occurrenceId) {
    return readingFullSetAttemptJson({ error: "无效的套题答案请求。" }, { status: 400 });
  }
  const body = await request.json().catch(() => ({})) as {
    answers?: unknown;
    expectedRevision?: unknown;
    moduleNumber?: unknown;
  };
  const moduleNo = Number(body.moduleNumber);
  const expectedRevision = Number(body.expectedRevision);
  if (
    (moduleNo !== 1 && moduleNo !== 2)
    || !Number.isInteger(expectedRevision)
    || expectedRevision < 0
    || !Array.isArray(body.answers)
  ) {
    return readingFullSetAttemptJson({ error: "无效的套题答案请求。" }, { status: 400 });
  }
  const { data, error } = await auth.client.rpc("save_reading_full_set_occurrence_answers", {
    p_answers: body.answers,
    p_attempt_id: params.attemptId,
    p_expected_revision: expectedRevision,
    p_module_number: moduleNo,
    p_occurrence_id: params.occurrenceId
  });
  if (error) return readingFullSetAttemptError(error, "套题答案保存失败，请稍后重试。");
  if (!isSaveResult(data)) {
    return readingFullSetAttemptJson({ error: "套题答案保存状态返回了无效数据。" }, { status: 500 });
  }
  return readingFullSetAttemptJson(data, { status: data.accepted ? 200 : 409 });
}

function activeModule(attempt: Parameters<typeof readingFullSetAttemptPhase>[0]) {
  const phase = readingFullSetAttemptPhase(attempt);
  if (phase === "module_1_active") return attempt.module1;
  if (phase === "module_2_active") return attempt.module2;
  return null;
}

function moduleOccurrences(
  fullSet: NonNullable<ReturnType<typeof findValidReadingFullSet>>,
  moduleNumber: 1 | 2
) {
  return moduleNumber === 1 ? fullSet.module1.occurrences : fullSet.module2.occurrences;
}

function publicOccurrence(occurrence: ReadingFullSetOccurrence) {
  return {
    occurrenceId: occurrence.occurrenceId,
    logicalItemId: occurrence.logicalItemId,
    taskType: occurrence.taskType,
    sourceQuestionStart: occurrence.sourceQuestionStart,
    sourceQuestionEnd: occurrence.sourceQuestionEnd
  };
}

function isSaveResult(value: unknown): value is {
  accepted: boolean;
  answerRevision?: number;
  attempt: import("@/lib/reading/fullSetAttempts").ReadingFullSetAttemptSummary;
  reason?: "locked" | "timed_out" | "stale_revision";
} {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return typeof result.accepted === "boolean"
    && isReadingFullSetAttemptSummary(result.attempt)
    && (result.accepted ? Number.isInteger(result.answerRevision) : typeof result.reason === "string");
}

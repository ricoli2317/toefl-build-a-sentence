import {
  isUuid,
  loadReadingFullSetOccurrencePracticePayload,
  loadOwnedReadingFullSetAttempt,
  readingFullSetAttemptError,
  readingFullSetAttemptJson,
  requireReadingFullSetStudent
} from "@/lib/reading/fullSetAttemptServer";
import {
  isReadingFullSetAttemptSummary,
  readingFullSetCurrentModuleAttempt,
  type ReadingFullSetAttemptSummary
} from "@/lib/reading/fullSetAttempts";
import { loadReadingFullSet } from "@/lib/reading/fullSets.server";
import { StudentReadingLoadError } from "@/lib/reading/studentPractice";
import { createServiceSupabase } from "@/lib/supabase/server";
import { createStudentPerformanceTrace } from "@/lib/studentPerformance.server";
import { sameReadingFullSetAnswers } from "@/lib/reading/fullSetSaveIdempotency.server";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: { attemptId: string; occurrenceId: string } }
) {
  const timing = createStudentPerformanceTrace(
    "/api/reading/full-set-attempts/[attemptId]/occurrences/[occurrenceId]",
    {
      attemptId: params.attemptId,
      traceId: request.headers.get("x-reading-full-set-trace-id")
    }
  );
  const respond = (response: ReturnType<typeof readingFullSetAttemptJson>) => {
    timing.finishHeaders(response.headers, response.ok).forEach((value, name) => {
      response.headers.set(name, value);
    });
    return response;
  };
  const auth = await requireReadingFullSetStudent(request, timing);
  if (auth.error) return respond(auth.error);
  if (!auth.client) return respond(readingFullSetAttemptJson({ error: "请先登录。" }, { status: 401 }));
  if (!isUuid(params.attemptId) || !params.occurrenceId) {
    return respond(readingFullSetAttemptJson({ error: "无效的套题题目请求。" }, { status: 400 }));
  }
  const owned = await timing.measure(
    "database",
    "ownership",
    () => loadOwnedReadingFullSetAttempt(auth.client!, params.attemptId)
  );
  if (owned.error || !owned.attempt) {
    return respond(readingFullSetAttemptError(owned.error, "套题题目加载失败，请稍后重试。"));
  }
  const active = activeModule(owned.attempt);
  if (!active) {
    return respond(readingFullSetAttemptJson({ error: "当前 Module 已结束。" }, { status: 409 }));
  }
  try {
    const fullSet = await timing.measure(
      "database",
      "definition_resolution",
      () => loadReadingFullSet(createServiceSupabase(), owned.attempt!.fullSetId)
    );
    const occurrence = fullSet
      ? moduleOccurrences(fullSet, active.moduleNumber)
        .find((candidate) => candidate.occurrenceId === params.occurrenceId)
      : null;
    if (!fullSet || !occurrence) {
      return respond(readingFullSetAttemptJson({ error: "这个题目不属于当前 Module。" }, { status: 404 }));
    }
    const payload = await loadReadingFullSetOccurrencePracticePayload({
      contentPhase: "occurrence_content",
      db: createServiceSupabase(),
      moduleAttempt: active,
      occurrence,
      timing,
      title: fullSet.title
    });
    return respond(timing.measureSync("processing", "serialization", () =>
      readingFullSetAttemptJson(payload)
    ));
  } catch (error) {
    if (error instanceof StudentReadingLoadError) {
      console.error("Reading Full Set occurrence content failed", {
        attemptId: params.attemptId,
        detail: error.message,
        occurrenceId: params.occurrenceId
      });
      return respond(readingFullSetAttemptJson({ error: error.publicMessage }, { status: error.status }));
    }
    console.error("Reading Full Set occurrence load failed", {
      error,
      attemptId: params.attemptId,
      occurrenceId: params.occurrenceId
    });
    return respond(readingFullSetAttemptJson({ error: "套题题目加载失败，请稍后重试。" }, { status: 500 }));
  }
}

export async function PUT(
  request: Request,
  { params }: { params: { attemptId: string; occurrenceId: string } }
) {
  const timing = createStudentPerformanceTrace(
    "/api/reading/full-set-attempts/[attemptId]/occurrences/[occurrenceId]",
    {
      attemptId: params.attemptId,
      traceId: request.headers.get("x-reading-full-set-trace-id")
    }
  );
  const respond = (response: ReturnType<typeof readingFullSetAttemptJson>) => {
    timing.finishHeaders(response.headers, response.ok).forEach((value, name) => {
      response.headers.set(name, value);
    });
    return response;
  };
  const auth = await requireReadingFullSetStudent(request, timing);
  if (auth.error) return respond(auth.error);
  if (!auth.client) return respond(readingFullSetAttemptJson({ code: "AUTH_FAILED", error: "请先登录。" }, { status: 401 }));
  if (!isUuid(params.attemptId) || !params.occurrenceId) {
    return respond(readingFullSetAttemptJson({ error: "无效的套题答案请求。" }, { status: 400 }));
  }
  const body = await request.json().catch(() => ({})) as {
    answers?: unknown;
    expectedOccurrenceRevision?: unknown;
    expectedRevision?: unknown;
    moduleNumber?: unknown;
  };
  const moduleNo = Number(body.moduleNumber);
  const expectedRevision = Number(body.expectedRevision);
  const expectedOccurrenceRevision = Number(
    body.expectedOccurrenceRevision ?? body.expectedRevision
  );
  if (
    (moduleNo !== 1 && moduleNo !== 2)
    || !Number.isInteger(expectedRevision)
    || expectedRevision < 0
    || !Number.isInteger(expectedOccurrenceRevision)
    || expectedOccurrenceRevision < 0
    || !Array.isArray(body.answers)
  ) {
    return respond(readingFullSetAttemptJson({ error: "无效的套题答案请求。" }, { status: 400 }));
  }
  let saveResult = await timing.measure(
    "database",
    moduleNo === 1 ? "m1_final_flush" : "answer_save",
    () => auth.client!.rpc("save_reading_full_set_occurrence_answers_v2", {
      p_answers: body.answers,
      p_attempt_id: params.attemptId,
      p_expected_occurrence_revision: expectedOccurrenceRevision,
      p_module_number: moduleNo,
      p_occurrence_id: params.occurrenceId
    })
  );
  if (isMissingAnswerConsistencyRpc(saveResult.error)) {
    saveResult = await timing.measure(
      "database",
      "answer_save_legacy_compatibility",
      () => auth.client!.rpc("save_reading_full_set_occurrence_answers", {
        p_answers: body.answers,
        p_attempt_id: params.attemptId,
        p_expected_revision: expectedRevision,
        p_module_number: moduleNo,
        p_occurrence_id: params.occurrenceId
      })
    );
  }
  const { data, error } = saveResult;
  if (error) return respond(readingFullSetAttemptError(error, "套题答案保存失败，请稍后重试。"));
  if (!isSaveResult(data)) {
    return respond(readingFullSetAttemptJson({ error: "套题答案保存状态返回了无效数据。" }, { status: 500 }));
  }
  if (!data.accepted && data.reason === "stale_revision") {
    const moduleAttempt = moduleNo === 1 ? data.attempt.module1 : data.attempt.module2;
    if (moduleAttempt) {
      const saved = await timing.measure(
        "database",
        "answer_save_idempotency",
        () => auth.client!
          .from("reading_full_set_answers")
          .select("question_id,slot_id,answer_kind,student_answer,question_time_seconds")
          .eq("module_attempt_id", moduleAttempt.moduleAttemptId)
          .eq("occurrence_id", params.occurrenceId)
      );
      if (!saved.error && sameReadingFullSetAnswers(body.answers, saved.data)) {
        return respond(timing.measureSync("processing", "serialization", () =>
          readingFullSetAttemptJson({
            accepted: true,
            answerRevision: moduleAttempt.answerRevision,
            occurrenceRevision: Number(data.occurrenceRevision ?? moduleAttempt.answerRevision),
            attempt: data.attempt
          })
        ));
      }
      if (!saved.error) {
        return respond(timing.measureSync("processing", "serialization", () =>
          readingFullSetAttemptJson({
            ...data,
            answerRevision: moduleAttempt.answerRevision,
            occurrenceRevision: Number(data.occurrenceRevision ?? moduleAttempt.answerRevision),
            serverAnswers: submittedAnswers(saved.data)
          }, { status: 409 })
        ));
      }
    }
  }
  return respond(timing.measureSync("processing", "serialization", () =>
    readingFullSetAttemptJson(data, { status: data.accepted ? 200 : 409 })
  ));
}

function activeModule(attempt: ReadingFullSetAttemptSummary) {
  return readingFullSetCurrentModuleAttempt(attempt);
}

function moduleOccurrences(
  fullSet: NonNullable<Awaited<ReturnType<typeof loadReadingFullSet>>>,
  moduleNumber: 1 | 2
) {
  return moduleNumber === 1 ? fullSet.module1.occurrences : fullSet.module2.occurrences;
}

function isSaveResult(value: unknown): value is {
  accepted: boolean;
  answerRevision?: number;
  occurrenceRevision?: number;
  attempt: import("@/lib/reading/fullSetAttempts").ReadingFullSetAttemptSummary;
  reason?: "locked" | "timed_out" | "stale_revision";
} {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return typeof result.accepted === "boolean"
    && isReadingFullSetAttemptSummary(result.attempt)
    && (result.accepted ? Number.isInteger(result.answerRevision) : typeof result.reason === "string");
}

function submittedAnswers(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const answer = row as Record<string, unknown>;
    return {
      kind: answer.answer_kind,
      questionId: answer.question_id,
      questionTimeSeconds: Number(answer.question_time_seconds ?? 0),
      ...(typeof answer.slot_id === "string" ? { slotId: answer.slot_id } : {}),
      studentAnswer: typeof answer.student_answer === "string" ? answer.student_answer : null
    };
  });
}

function isMissingAnswerConsistencyRpc(error: { code?: string; message?: string } | null) {
  return Boolean(error && (
    error.code === "PGRST202"
    || error.message?.includes("save_reading_full_set_occurrence_answers_v2")
  ));
}

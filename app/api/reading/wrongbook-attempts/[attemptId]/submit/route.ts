import type { ReadingSubmittedAnswer } from "@/lib/reading/attempts";
import {
  readingAttemptError,
  readingAttemptJson,
  requireReadingAttemptStudent
} from "@/lib/reading/attemptServer";
import { isReadingWrongbookAttemptSummary } from "@/lib/reading/wrongbook";
import { isReadingFullSetWrongbookAttemptSummary } from "@/lib/reading/wrongbook";
import { applyReadingCorrectionAttemptEvents } from "@/lib/reading/wrongQuestionEvents.server";
import { createServiceSupabase } from "@/lib/supabase/server";
import { wrongQuestionBusinessDate } from "@/lib/wrongQuestionBusinessDate";
import { recordWrongQuestionSessionGroupProgress } from "@/lib/wrongQuestionBank.server";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client) return readingAttemptJson({ error: "请先登录。" }, { status: 401 });
  if (!isUuid(params.attemptId)) {
    return readingAttemptJson({ error: "无效的错题订正提交。" }, { status: 400 });
  }
  const body = await request.json().catch(() => ({})) as {
    answers?: unknown;
    elapsedSeconds?: unknown;
    logicalItemId?: unknown;
    sessionId?: unknown;
    sourceAttemptId?: unknown;
    sourceFullSetId?: unknown;
    taskType?: unknown;
  };
  const elapsedSeconds = Number(body.elapsedSeconds);
  if (
    !Number.isInteger(elapsedSeconds)
    || elapsedSeconds < 0
    || elapsedSeconds > 604800
    || !Array.isArray(body.answers)
  ) {
    return readingAttemptJson({ error: "无效的错题订正提交。" }, { status: 400 });
  }

  if (body.taskType === "full_set") {
    if (typeof body.sourceAttemptId !== "string" || typeof body.sourceFullSetId !== "string") {
      return readingAttemptJson({ error: "无效的错题订正提交。" }, { status: 400 });
    }
    const { data, error } = await auth.client.rpc("submit_reading_full_set_wrongbook_attempt", {
      p_answers: body.answers,
      p_attempt_id: params.attemptId,
      p_elapsed_seconds: elapsedSeconds,
      p_full_set_id: body.sourceFullSetId,
      p_source_attempt_id: body.sourceAttemptId
    });
    if (error) return readingAttemptError(error, "错题订正提交失败，请稍后重试。");
    if (!isReadingFullSetWrongbookAttemptSummary(data) || data.status !== "submitted") {
      return readingAttemptJson({ error: "错题订正结果返回了无效数据。" }, { status: 500 });
    }
    // Full Set corrections resolve pending state for their canonical Reading
    // questions (occurrence ignored), so both scopes clear.
    await applyCorrectionEvents(params.attemptId, auth.userId, true);    return readingAttemptJson({ attempt: data });
  }
  if (typeof body.logicalItemId !== "string") {
    return readingAttemptJson({ error: "无效的错题订正提交。" }, { status: 400 });
  }

  const { data, error } = await auth.client.rpc("submit_reading_wrongbook_attempt", {
    p_answers: body.answers as ReadingSubmittedAnswer[],
    p_attempt_id: params.attemptId,
    p_elapsed_seconds: elapsedSeconds,
    p_logical_item_id: body.logicalItemId
  });
  if (error) return readingAttemptError(error, "错题订正提交失败，请稍后重试。");
  if (!isReadingWrongbookAttemptSummary(data) || data.status !== "submitted") {
    return readingAttemptJson({ error: "错题订正结果返回了无效数据。" }, { status: 500 });
  }
  // Today practice clears pending; history practice never changes pending.
  await applyCorrectionEvents(params.attemptId, auth.userId, data.scope === "today");
  if (typeof body.sessionId === "string" && body.sessionId.trim() && auth.userId) {
    try {
      await recordWrongQuestionSessionGroupProgress({
        db: createServiceSupabase(),
        group: {
          logicalItemId: data.logicalItemId,
          targets: data.targets.map((target) => ({
            questionId: target.questionId,
            slotId: target.slotId
          })),
          title: ""
        },
        progress: {
          attemptId: data.attemptId,
          correctPoints: data.correctPoints,
          submittedAt: data.submittedAt ?? new Date().toISOString(),
          totalPoints: data.totalPoints
        },
        sessionId: body.sessionId.trim(),
        studentId: auth.userId
      });
    } catch (progressError) {
      console.error("Wrong-question session progress update failed", {
        attemptId: params.attemptId,
        message: progressError instanceof Error ? progressError.message : String(progressError)
      });
    }
  }
  return readingAttemptJson({ attempt: data });
}

async function applyCorrectionEvents(
  attemptId: string,
  userId: string | null,
  appliesToPending: boolean
) {
  if (!userId) return;
  try {
    await applyReadingCorrectionAttemptEvents(createServiceSupabase(), {
      appliesToPending,
      attemptId,
      practiceDate: wrongQuestionBusinessDate(),
      studentId: userId
    });
  } catch (bankError) {
    console.error("Reading wrong-question correction update failed", {
      attemptId,
      message: bankError instanceof Error ? bankError.message : String(bankError)
    });
  }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

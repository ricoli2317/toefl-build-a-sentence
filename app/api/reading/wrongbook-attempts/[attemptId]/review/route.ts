import { readingAttemptJson, requireReadingAttemptStudent } from "@/lib/reading/attemptServer";
import {
  buildReadingCorrectionAnswerPresentations,
  type ReadingCorrectionAnchorRow,
  type ReadingCorrectionCtwSlotRow,
  type ReadingCorrectionOptionRow,
  type ReadingCorrectionQuestionRow,
  type ReadingCorrectionSentenceRow
} from "@/lib/reading/correctionResult";
import type { ReadingAnswerRow } from "@/lib/reading/history";
import {
  buildSubmittedReadingAnswerState,
  buildSubmittedReadingReviewItems,
  type SubmittedReadingAnswerRow
} from "@/lib/reading/review";
import { selectReadingWrongbookPractice } from "@/lib/reading/wrongbook";
import { loadReadingWrongbookPreservedAnswers } from "@/lib/reading/wrongbook.server";
import { loadStudentReadingPractice, StudentReadingLoadError } from "@/lib/reading/studentPractice";
import type { ReadingWrongbookTarget } from "@/lib/wrongQuestions";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type ReviewRow = SubmittedReadingAnswerRow & {
  attempt_answer_id: string;
  is_correct: boolean;
};

export async function GET(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client || !auth.userId) {
    return readingAttemptJson({ error: "请先登录后再查看订正作答。" }, { status: 401 });
  }
  if (!isUuid(params.attemptId)) {
    return readingAttemptJson({ error: "无效的订正作答请求。" }, { status: 400 });
  }

  const { data: attempt, error: attemptError } = await auth.client
    .from("reading_wrongbook_attempts")
    .select("attempt_id,logical_item_id,task_type,status,scope,targets,elapsed_seconds,started_at,submitted_at,total_points,correct_points")
    .eq("attempt_id", params.attemptId)
    .maybeSingle();
  if (attemptError) return serverError("owned correction attempt", attemptError);
  if (!attempt) return readingAttemptJson({ error: "没有找到这次错题订正作答。" }, { status: 404 });
  if (attempt.status !== "submitted" || !attempt.submitted_at) {
    return readingAttemptJson({ error: "这次错题订正尚未提交。" }, { status: 409 });
  }

  const db = createServiceSupabase();
  let fullPractice: Awaited<ReturnType<typeof loadStudentReadingPractice>>;
  try {
    fullPractice = await loadStudentReadingPractice(db, attempt.logical_item_id);
  } catch (error) {
    if (error instanceof StudentReadingLoadError) {
      console.error("Reading correction review content load failed", {
        attemptId: params.attemptId,
        detail: error.message
      });
    }
    return readingAttemptJson({ error: "订正作答内容暂时无法显示。" }, { status: 500 });
  }

  const targets = attempt.targets as ReadingWrongbookTarget[];
  let answerData;
  try {
    answerData = await Promise.all([
      db.from("reading_wrongbook_attempt_answers")
        .select("attempt_answer_id,question_id,slot_id,answer_kind,student_answer,is_correct,question_time_seconds")
        .eq("attempt_id", attempt.attempt_id),
      attempt.task_type === "ctw"
        ? loadReadingWrongbookPreservedAnswers({
            before: attempt.started_at,
            db,
            logicalItemId: attempt.logical_item_id,
            studentId: auth.userId,
            targets
          })
        : Promise.resolve([])
    ]);
  } catch (error) {
    return serverError("correction preserved answers", asError(error));
  }
  const [answerResult, preservedAnswers] = answerData;
  if (answerResult.error) return serverError("correction answers", answerResult.error);

  const practice = selectReadingWrongbookPractice(fullPractice, targets);
  const rows = [...(answerResult.data ?? []), ...preservedAnswers] as ReviewRow[];
  try {
    const reviewItems = buildSubmittedReadingReviewItems(practice, rows);
    return readingAttemptJson({
      answers: buildSubmittedReadingAnswerState(practice, rows),
      attempt: {
        attemptId: attempt.attempt_id,
        logicalItemId: attempt.logical_item_id,
        taskType: attempt.task_type,
        status: "submitted",
        elapsedSeconds: attempt.elapsed_seconds,
        startedAt: attempt.started_at,
        submittedAt: attempt.submitted_at,
        totalPoints: attempt.total_points,
        correctPoints: attempt.correct_points,
        incorrectPoints: rows.filter((row) => isTargetRow(row, targets) && answered(row) && !row.is_correct).length,
        unansweredPoints: rows.filter((row) => isTargetRow(row, targets) && !answered(row)).length
      },
      disclosures: await loadDisclosures(db, rows),
      practice,
      reviewItems
    });
  } catch (error) {
    console.error("Reading correction review mapping failed", {
      attemptId: params.attemptId,
      message: error instanceof Error ? error.message : "unknown"
    });
    return readingAttemptJson({ error: "订正作答数据暂时无法显示。" }, { status: 500 });
  }
}

async function loadDisclosures(db: ReturnType<typeof createServiceSupabase>, rows: ReviewRow[]) {
  const questionIds = Array.from(new Set(rows.map((row) => row.question_id)));
  const [questionResult, slotResult, optionResult, anchorResult] = await Promise.all([
    db.from("reading_questions")
      .select("question_id,question_type,correct_option_id,correct_anchor_id,correct_sentence_id")
      .in("question_id", questionIds),
    db.from("reading_ctw_slots").select("question_id,slot_id,prefix,answer,display_text,missing_text").in("question_id", questionIds),
    db.from("reading_question_options").select("question_id,option_id,option_order,option_text").in("question_id", questionIds),
    db.from("reading_rap_insertion_anchors").select("question_id,anchor_id,anchor_order").in("question_id", questionIds)
  ]);
  const baseError = questionResult.error || slotResult.error || optionResult.error || anchorResult.error;
  if (baseError) throw new Error(baseError.message);
  const questions = (questionResult.data ?? []) as ReadingCorrectionQuestionRow[];
  const sentenceIds = Array.from(new Set([
    ...questions.map((question) => question.correct_sentence_id),
    ...rows
      .filter((row) => row.answer_kind === "sentence_selection")
      .map((row) => row.student_answer)
  ].filter((value): value is string => Boolean(value))));
  const sentenceResult = sentenceIds.length
    ? await db.from("reading_passage_sentences").select("sentence_id,sentence_order,sentence_text").in("sentence_id", sentenceIds)
    : { data: [], error: null };
  if (sentenceResult.error) throw new Error(sentenceResult.error.message);

  const presentations = buildReadingCorrectionAnswerPresentations({
    anchors: (anchorResult.data ?? []) as ReadingCorrectionAnchorRow[],
    correctionRows: rows as ReadingAnswerRow[],
    ctwSlots: (slotResult.data ?? []) as ReadingCorrectionCtwSlotRow[],
    options: (optionResult.data ?? []) as ReadingCorrectionOptionRow[],
    questions,
    sentences: (sentenceResult.data ?? []) as ReadingCorrectionSentenceRow[]
  });
  return presentations;
}

function isTargetRow(row: ReviewRow, targets: ReadingWrongbookTarget[]) {
  return targets.some((target) =>
    target.questionId === row.question_id && target.slotId === row.slot_id
  );
}

function answered(row: ReviewRow) {
  return Boolean(row.student_answer?.trim());
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function serverError(scope: string, error: { message?: string } | null) {
  console.error("Reading correction review load failed", { scope, message: error?.message });
  return readingAttemptJson({ error: "订正作答加载失败，请稍后重试。" }, { status: 500 });
}

function asError(error: unknown) {
  return error instanceof Error ? error : null;
}

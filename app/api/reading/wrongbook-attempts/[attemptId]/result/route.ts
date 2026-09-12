import {
  buildReadingResultPayload,
  type ReadingAnswerRow,
  type ReadingAttemptRow,
  type ReadingCtwParagraphResultRow,
  type ReadingCtwSegmentResultRow,
  type ReadingItemRow,
  type ReadingSlotResultRow
} from "@/lib/reading/history";
import {
  buildReadingCorrectionResultAnswers,
  type ReadingCorrectionAnchorRow,
  type ReadingCorrectionCtwSlotRow,
  type ReadingCorrectionOptionRow,
  type ReadingCorrectionQuestionRow,
  type ReadingCorrectionSentenceRow
} from "@/lib/reading/correctionResult";
import { readingAttemptJson, requireReadingAttemptStudent } from "@/lib/reading/attemptServer";
import { loadReadingWrongbookPreservedAnswers } from "@/lib/reading/wrongbook.server";
import type { ReadingWrongbookTarget } from "@/lib/wrongQuestions";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client || !auth.userId) {
    return readingAttemptJson({ error: "请先登录后再查看订正结果。" }, { status: 401 });
  }
  if (!isUuid(params.attemptId)) {
    return readingAttemptJson({ error: "无效的订正结果请求。" }, { status: 400 });
  }

  const { data: attempt, error: attemptError } = await auth.client
    .from("reading_wrongbook_attempts")
    .select("attempt_id,logical_item_id,task_type,status,scope,targets,elapsed_seconds,started_at,submitted_at,total_points,correct_points")
    .eq("attempt_id", params.attemptId)
    .maybeSingle();
  if (attemptError) return serverError("owned correction attempt", attemptError);
  if (!attempt) return readingAttemptJson({ error: "没有找到这次错题订正结果。" }, { status: 404 });
  if (attempt.status !== "submitted" || !attempt.submitted_at) {
    return readingAttemptJson({ error: "这次错题订正尚未提交。" }, { status: 409 });
  }

  const db = createServiceSupabase();
  let base;
  try {
    base = await Promise.all([
      db.from("reading_logical_items")
        .select("logical_item_id,module,title")
        .eq("logical_item_id", attempt.logical_item_id)
        .single(),
      db.from("reading_wrongbook_attempt_answers")
        .select("attempt_answer_id,question_id,slot_id,answer_kind,student_answer,is_correct,question_time_seconds")
        .eq("attempt_id", attempt.attempt_id),
      attempt.task_type === "ctw"
        ? loadReadingWrongbookPreservedAnswers({
            before: attempt.started_at,
            db,
            logicalItemId: attempt.logical_item_id,
            studentId: auth.userId,
            targets: attempt.targets as ReadingWrongbookTarget[]
          })
        : Promise.resolve([])
    ]);
  } catch (error) {
    return serverError("correction result preserved answers", asError(error));
  }
  const [itemResult, correctionAnswerResult, preservedAnswers] = base;
  if (itemResult.error || correctionAnswerResult.error || !itemResult.data) {
    return serverError("correction result base", itemResult.error ?? correctionAnswerResult.error);
  }

  const answers = [
    ...(correctionAnswerResult.data ?? []),
    ...preservedAnswers
  ] as ReadingAnswerRow[];
  const questionIds = Array.from(new Set(answers.map((answer) => answer.question_id)));
  if (questionIds.length === 0) return serverError("correction result answers", null);
  const questionResult = await db.from("reading_questions")
    .select("question_id,question_order,question_type,correct_option_id,correct_anchor_id,correct_sentence_id")
    .eq("logical_item_id", attempt.logical_item_id)
    .in("question_id", questionIds);
  if (questionResult.error) return serverError("correction result questions", questionResult.error);

  const questions = (questionResult.data ?? []) as ReadingCorrectionQuestionRow[];
  const sentenceIds = Array.from(new Set([
    ...questions.map((question) => question.correct_sentence_id),
    ...(correctionAnswerResult.data ?? [])
      .filter((answer) => answer.answer_kind === "sentence_selection")
      .map((answer) => answer.student_answer)
  ].filter((value): value is string => Boolean(value))));
  const [optionResult, anchorResult, sentenceResult] = await Promise.all([
    db.from("reading_question_options")
      .select("question_id,option_id,option_order,option_text")
      .in("question_id", questionIds)
      .order("option_order", { ascending: true }),
    db.from("reading_rap_insertion_anchors")
      .select("question_id,anchor_id,anchor_order")
      .in("question_id", questionIds)
      .order("anchor_order", { ascending: true }),
    sentenceIds.length
      ? db.from("reading_passage_sentences")
          .select("sentence_id,sentence_order,sentence_text")
          .in("sentence_id", sentenceIds)
      : Promise.resolve({ data: [], error: null })
  ]);
  const answerDetailError = optionResult.error || anchorResult.error || sentenceResult.error;
  if (answerDetailError) return serverError("correction result answer details", answerDetailError);

  let ctwParagraphs: ReadingCtwParagraphResultRow[] = [];
  let ctwSegments: ReadingCtwSegmentResultRow[] = [];
  let slots: ReadingSlotResultRow[] = [];
  let correctionCtwSlots: ReadingCorrectionCtwSlotRow[] = [];
  if (attempt.task_type === "ctw") {
    const [paragraphResult, segmentResult, slotResult] = await Promise.all([
      db.from("reading_ctw_paragraphs")
        .select("question_id,paragraph_id,paragraph_order")
        .in("question_id", questionIds)
        .order("paragraph_order", { ascending: true }),
      db.from("reading_ctw_segments")
        .select("question_id,paragraph_id,segment_order,segment_type,text_content,slot_id")
        .in("question_id", questionIds)
        .order("segment_order", { ascending: true }),
      db.from("reading_ctw_slots")
        .select("question_id,slot_id,slot_order,prefix,answer,display_text,missing_text")
        .in("question_id", questionIds)
        .order("slot_order", { ascending: true })
    ]);
    const detailError = paragraphResult.error || segmentResult.error || slotResult.error;
    if (detailError) return serverError("CTW correction result details", detailError);
    ctwParagraphs = (paragraphResult.data ?? []) as ReadingCtwParagraphResultRow[];
    ctwSegments = (segmentResult.data ?? []) as ReadingCtwSegmentResultRow[];
    slots = (slotResult.data ?? []) as ReadingSlotResultRow[];
    correctionCtwSlots = (slotResult.data ?? []) as ReadingCorrectionCtwSlotRow[];
  }

  try {
    const payload = buildReadingResultPayload({
      allowDisplayAnswerCountMismatch: attempt.task_type === "ctw",
      answers,
      attempt: attempt as ReadingAttemptRow & { submitted_at: string },
      ctwParagraphs,
      ctwSegments,
      item: itemResult.data as ReadingItemRow,
      questions,
      slots
    });
    return readingAttemptJson({
      ...payload,
      answers: buildReadingCorrectionResultAnswers({
        allResultAnswers: payload.answers,
        anchors: (anchorResult.data ?? []) as ReadingCorrectionAnchorRow[],
        correctionRows: (correctionAnswerResult.data ?? []) as ReadingAnswerRow[],
        ctwSlots: correctionCtwSlots,
        options: (optionResult.data ?? []) as ReadingCorrectionOptionRow[],
        questions,
        sentences: (sentenceResult.data ?? []) as ReadingCorrectionSentenceRow[]
      })
    });
  } catch (error) {
    console.error("Reading correction result mapping failed", {
      attemptId: params.attemptId,
      message: error instanceof Error ? error.message : "unknown"
    });
    return readingAttemptJson({ error: "订正结果数据暂时无法显示。" }, { status: 500 });
  }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function serverError(scope: string, error: { message?: string } | null) {
  console.error("Reading correction result load failed", { scope, message: error?.message });
  return readingAttemptJson({ error: "订正结果加载失败，请稍后重试。" }, { status: 500 });
}

function asError(error: unknown) {
  return error instanceof Error ? error : null;
}

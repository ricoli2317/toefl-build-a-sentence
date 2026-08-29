import {
  buildReadingResultPayload,
  type ReadingAnswerRow,
  type ReadingAttemptRow,
  type ReadingCtwParagraphResultRow,
  type ReadingCtwSegmentResultRow,
  type ReadingItemRow,
  type ReadingQuestionResultRow,
  type ReadingSlotResultRow
} from "@/lib/reading/history";
import { readingAttemptJson, requireReadingAttemptStudent } from "@/lib/reading/attemptServer";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  const auth = await requireReadingAttemptStudent(request);
  if (auth.error) return auth.error;
  if (!auth.client) {
    return readingAttemptJson({ error: "请先登录后再查看阅读结果。" }, { status: 401 });
  }
  if (!isUuid(params.attemptId)) {
    return readingAttemptJson({ error: "无效的阅读结果请求。" }, { status: 400 });
  }

  // Verify ownership and submission before the service-role detail query.
  const { data: ownedAttempt, error: attemptError } = await auth.client
    .from("reading_attempts")
    .select("attempt_id,logical_item_id,task_type,status,elapsed_seconds,submitted_at,total_points,correct_points")
    .eq("attempt_id", params.attemptId)
    .maybeSingle();
  if (attemptError) return serverError("owned attempt", attemptError);
  if (!ownedAttempt) {
    return readingAttemptJson({ error: "没有找到这次阅读练习结果。" }, { status: 404 });
  }
  if (ownedAttempt.status !== "submitted" || !ownedAttempt.submitted_at) {
    return readingAttemptJson({ error: "这次阅读练习尚未提交。" }, { status: 409 });
  }

  const db = createServiceSupabase();
  const [itemResult, answerResult] = await Promise.all([
    db
      .from("reading_logical_items")
      .select("logical_item_id,module,title")
      .eq("logical_item_id", ownedAttempt.logical_item_id)
      .single(),
    db
      .from("reading_attempt_answers")
      .select("attempt_answer_id,question_id,slot_id,answer_kind,student_answer,is_correct,question_time_seconds")
      .eq("attempt_id", ownedAttempt.attempt_id)
  ]);
  if (itemResult.error || answerResult.error || !itemResult.data) {
    return serverError("result base", itemResult.error ?? answerResult.error);
  }

  const answers = (answerResult.data ?? []) as ReadingAnswerRow[];
  const questionIds = Array.from(new Set(answers.map((answer) => answer.question_id)));
  if (questionIds.length === 0) return serverError("result answers", null);

  const questionResult = await db
    .from("reading_questions")
    .select("question_id,question_order,question_type")
    .eq("logical_item_id", ownedAttempt.logical_item_id)
    .in("question_id", questionIds);
  if (questionResult.error) return serverError("result questions", questionResult.error);

  let ctwParagraphs: ReadingCtwParagraphResultRow[] = [];
  let ctwSegments: ReadingCtwSegmentResultRow[] = [];
  let slots: ReadingSlotResultRow[] = [];
  if (ownedAttempt.task_type === "ctw") {
    const [paragraphResult, segmentResult, slotResult] = await Promise.all([
      db
        .from("reading_ctw_paragraphs")
        .select("question_id,paragraph_id,paragraph_order")
        .in("question_id", questionIds)
        .order("paragraph_order", { ascending: true }),
      db
        .from("reading_ctw_segments")
        .select("question_id,paragraph_id,segment_order,segment_type,text_content,slot_id")
        .in("question_id", questionIds)
        .order("segment_order", { ascending: true }),
      db
        .from("reading_ctw_slots")
        .select("question_id,slot_id,slot_order,prefix")
        .in("question_id", questionIds)
        .order("slot_order", { ascending: true })
    ]);
    const detailError = paragraphResult.error || segmentResult.error || slotResult.error;
    if (detailError) return serverError("CTW result details", detailError);
    ctwParagraphs = (paragraphResult.data ?? []) as ReadingCtwParagraphResultRow[];
    ctwSegments = (segmentResult.data ?? []) as ReadingCtwSegmentResultRow[];
    slots = (slotResult.data ?? []) as ReadingSlotResultRow[];
  }

  try {
    return readingAttemptJson(buildReadingResultPayload({
      attempt: ownedAttempt as ReadingAttemptRow & { submitted_at: string },
      item: itemResult.data as ReadingItemRow,
      answers,
      questions: (questionResult.data ?? []) as ReadingQuestionResultRow[],
      ctwParagraphs,
      ctwSegments,
      slots
    }));
  } catch (error) {
    console.error("Reading result mapping failed", {
      attemptId: params.attemptId,
      message: error instanceof Error ? error.message : "unknown"
    });
    return readingAttemptJson({ error: "阅读结果数据暂时无法显示。" }, { status: 500 });
  }
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function serverError(scope: string, error: { message?: string } | null) {
  console.error("Reading result load failed", { scope, message: error?.message });
  return readingAttemptJson({ error: "阅读结果加载失败，请稍后重试。" }, { status: 500 });
}

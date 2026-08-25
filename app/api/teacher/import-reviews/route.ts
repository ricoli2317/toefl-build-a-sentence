import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { validateLogicalWritingTitle } from "@/lib/practiceImporter/logicalTitle";
import { createServiceSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type ReviewRow = {
  review_id: string;
  task_type: "build_sentence" | "email" | "academic_discussion";
  source_set_id: string | null;
  source_question_id: string | null;
  candidate_item_id: string | null;
  candidate_item_ids: unknown;
  similarity_summary: unknown;
  occurrences: unknown;
  created_at: string;
};

type ItemRow = {
  item_id: string;
  task_type: string;
  display_number: string;
  display_title: string | null;
};

type SourceRow = {
  item_id: string;
  source_question_id: string | null;
};

type WritingQuestionRow = Record<string, unknown> & {
  question_id: string;
  set_id: string;
  set_title: string | null;
};

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}

function errorMessage(error: unknown) {
  if (error && typeof error === "object" && "message" in error) {
    return String(error.message);
  }
  return error instanceof Error ? error.message : "待确认记录处理失败。";
}

async function authorize(request: Request) {
  return requireUserWithRole(bearerToken(request), "teacher");
}

export async function GET(request: Request) {
  try {
    const auth = await authorize(request);
    if (auth.error) return json({ message: auth.error }, { status: 401 });

    const supabase = createServiceSupabase();
    const { data, error } = await supabase
      .from("practice_import_review_queue")
      .select(
        "review_id,task_type,source_set_id,source_question_id,candidate_item_id,candidate_item_ids,similarity_summary,occurrences,created_at"
      )
      .eq("status", "pending")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;

    const reviews = (data ?? []) as ReviewRow[];
    const candidateIds = unique(
      reviews.flatMap((review) => candidateItemIds(review))
    );
    const writingQuestionIds = unique(
      reviews.flatMap((review) =>
        review.source_question_id && review.task_type !== "build_sentence"
          ? [review.source_question_id]
          : []
      )
    );

    const [items, sources] = await Promise.all([
      loadRows<ItemRow>(supabase, "practice_items", "item_id,task_type,display_number,display_title", "item_id", candidateIds),
      loadRows<SourceRow>(supabase, "practice_item_sources", "item_id,source_question_id", "item_id", candidateIds, { is_canonical: true })
    ]);
    const canonicalQuestionIds = unique(
      sources.flatMap((source) => source.source_question_id ? [source.source_question_id] : [])
    );
    const allQuestionIds = unique([...writingQuestionIds, ...canonicalQuestionIds]);
    const [emailQuestions, academicQuestions] = await Promise.all([
      loadRows<WritingQuestionRow>(
        supabase,
        "email_questions",
        "question_id,set_id,set_title,scenario,task_instruction,requirement_1,requirement_2,requirement_3,recipient,subject",
        "question_id",
        allQuestionIds.filter((id) => id.startsWith("EMAIL-"))
      ),
      loadRows<WritingQuestionRow>(
        supabase,
        "academic_discussion_questions",
        "question_id,set_id,set_title,professor_prompt,student_1_response,student_2_response",
        "question_id",
        allQuestionIds.filter((id) => id.startsWith("AD-"))
      )
    ]);

    const itemById = new Map(items.map((item) => [item.item_id, item]));
    const canonicalQuestionByItem = new Map(
      sources.flatMap((source) =>
        source.source_question_id ? [[source.item_id, source.source_question_id] as const] : []
      )
    );
    const questionById = new Map(
      [...emailQuestions, ...academicQuestions].map((question) => [question.question_id, question])
    );

    return json({
      reviews: reviews.map((review) => {
        const summary = asObject(review.similarity_summary);
        const incoming = review.source_question_id
          ? questionById.get(review.source_question_id) ?? null
          : null;
        return {
          reviewId: review.review_id,
          taskType: review.task_type,
          createdAt: review.created_at,
          sourceSetId: review.source_set_id,
          sourceQuestionId: review.source_question_id,
          proposedDisplayTitle:
            typeof summary.proposedDisplayTitle === "string"
              ? summary.proposedDisplayTitle
              : "",
          similarity: summary,
          occurrences: Array.isArray(review.occurrences) ? review.occurrences : [],
          incoming: incoming ? writingPreview(review.task_type, incoming) : null,
          candidates: candidateItemIds(review).flatMap((itemId) => {
            const item = itemById.get(itemId);
            if (!item) return [];
            const questionId = canonicalQuestionByItem.get(itemId);
            const question = questionId ? questionById.get(questionId) : null;
            return [{
              itemId,
              displayNumber: item.display_number,
              displayTitle: item.display_title,
              canonical: question ? writingPreview(review.task_type, question) : null
            }];
          }),
          canResolve: review.task_type === "email" || review.task_type === "academic_discussion"
        };
      })
    });
  } catch (error) {
    console.error("[teacher-import-reviews] load_failed", error);
    return json({ message: errorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const auth = await authorize(request);
    if (auth.error) return json({ message: auth.error }, { status: 401 });

    const body = await request.json() as {
      reviewId?: unknown;
      resolution?: unknown;
      candidateItemId?: unknown;
      displayTitle?: unknown;
    };
    const reviewId = String(body.reviewId ?? "").trim();
    const resolution = String(body.resolution ?? "").trim();
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(reviewId)) {
      return json({ message: "无效的待确认记录 ID。" }, { status: 400 });
    }
    if (resolution !== "merge" && resolution !== "new") {
      return json({ message: "处理方式必须是合并或作为新题。" }, { status: 400 });
    }

    let displayTitle: string | null = null;
    if (resolution === "new") {
      try {
        displayTitle = validateLogicalWritingTitle(body.displayTitle);
      } catch (error) {
        return json({ message: errorMessage(error) }, { status: 400 });
      }
    }

    const candidateItemId = resolution === "merge"
      ? String(body.candidateItemId ?? "").trim() || null
      : null;
    const { data, error } = await createServiceSupabase().rpc(
      "resolve_practice_import_review_v2",
      {
        p_review_id: reviewId,
        p_resolution: resolution,
        p_candidate_item_id: candidateItemId,
        p_display_title: displayTitle
      }
    );
    if (error) throw error;
    return json({ result: data });
  } catch (error) {
    console.error("[teacher-import-reviews] resolve_failed", error);
    const message = errorMessage(error);
    const migrationMissing = /resolve_practice_import_review_v2|schema cache/i.test(message);
    return json(
      {
        message: migrationMissing
          ? "待确认处理 SQL 尚未部署，请先执行 practice_import_review_resolution.sql。"
          : message
      },
      { status: migrationMissing ? 503 : 500 }
    );
  }
}

function candidateItemIds(review: ReviewRow) {
  const ids = Array.isArray(review.candidate_item_ids)
    ? review.candidate_item_ids.filter((value): value is string => typeof value === "string")
    : [];
  return unique(review.candidate_item_id ? [review.candidate_item_id, ...ids] : ids);
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

async function loadRows<T>(
  supabase: ReturnType<typeof createServiceSupabase>,
  table: string,
  columns: string,
  identityColumn: string,
  ids: string[],
  equals: Record<string, string | boolean> = {}
) {
  if (ids.length === 0) return [] as T[];
  let query = supabase.from(table).select(columns).in(identityColumn, ids);
  for (const [column, value] of Object.entries(equals)) query = query.eq(column, value);
  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as T[];
}

function writingPreview(taskType: ReviewRow["task_type"], row: WritingQuestionRow) {
  const common = {
    questionId: String(row.question_id),
    setId: String(row.set_id),
    setTitle: String(row.set_title ?? "")
  };
  if (taskType === "email") {
    return {
      ...common,
      fields: [
        { label: "情境", value: String(row.scenario ?? "") },
        { label: "任务", value: String(row.task_instruction ?? "") },
        {
          label: "要求",
          value: [row.requirement_1, row.requirement_2, row.requirement_3]
            .map((value) => String(value ?? ""))
            .filter(Boolean)
            .join(" / ")
        },
        { label: "收件人", value: String(row.recipient ?? "") }
      ]
    };
  }
  return {
    ...common,
    fields: [
      { label: "讨论题", value: String(row.professor_prompt ?? "") },
      {
        label: "学生观点",
        value: [row.student_1_response, row.student_2_response]
          .map((value) => String(value ?? ""))
          .filter(Boolean)
          .join(" / ")
      }
    ]
  };
}

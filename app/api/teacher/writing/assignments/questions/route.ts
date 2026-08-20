import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { isWritingTaskType, WRITING_TASK_CONFIG, type WritingQuestion } from "@/lib/writing";
import {
  buildLogicalWritingQuestionSearchResults,
  matchedLogicalWritingItemIds,
  type WritingSearchPracticeItem,
  type WritingSearchPracticeSource
} from "@/lib/writingAssignmentLogicalSearch";
import {
  chunkValues,
  parsePositiveInteger,
  requireWritingAssignmentTeacher,
  safeWritingAssignmentSearchTerm,
  WRITING_ASSIGNMENT_QUERY_FIELDS,
  WRITING_ASSIGNMENT_SEARCH_FIELDS,
  writingAssignmentJson
} from "@/lib/writingAssignmentsServer";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const auth = await requireWritingAssignmentTeacher(request);
    if (auth.error) return auth.error;
    if (!auth.supabase) return writingAssignmentJson({ message: "无权访问教师端作业数据。" }, { status: 401 });

    const params = new URL(request.url).searchParams;
    const taskType = params.get("taskType");
    if (!isWritingTaskType(taskType)) {
      return writingAssignmentJson(
        { code: "INVALID_TASK_TYPE", message: "请选择有效的写作题型。" },
        { status: 400 }
      );
    }
    const query = safeWritingAssignmentSearchTerm(params.get("query") ?? "");
    const page = parsePositiveInteger(params.get("page"), 1, 100000);
    const pageSize = parsePositiveInteger(params.get("pageSize"), 12, 40);

    const [rawMatchesResult, itemsResult, sourcesResult] = await Promise.all([
      readAllSupabaseRows<Record<string, unknown>>((from, to) => {
        let builder = auth.supabase!
          .from(WRITING_TASK_CONFIG[taskType].questionTable)
          .select(WRITING_ASSIGNMENT_QUERY_FIELDS[taskType]);
        if (query) {
          builder = builder.or(
            WRITING_ASSIGNMENT_SEARCH_FIELDS[taskType]
              .map((field) => `${field}.ilike.%${query}%`)
              .join(",")
          );
        }
        return builder.order("question_id", { ascending: true }).range(from, to) as unknown as PromiseLike<{
          data: Record<string, unknown>[] | null;
          error: { message: string } | null;
        }>;
      }),
      readAllSupabaseRows<WritingSearchPracticeItem>((from, to) =>
        auth.supabase!
          .from("practice_items")
          .select("item_id,task_type,display_number,display_title,first_seen_date,is_active")
          .eq("task_type", taskType)
          .eq("is_active", true)
          .order("item_id", { ascending: true })
          .range(from, to)
      ),
      readAllSupabaseRows<WritingSearchPracticeSource>((from, to) =>
        auth.supabase!
          .from("practice_item_sources")
          .select("item_id,task_type,source_question_id,is_canonical")
          .eq("task_type", taskType)
          .not("source_question_id", "is", null)
          .order("item_id", { ascending: true })
          .order("source_question_id", { ascending: true })
          .range(from, to)
      )
    ]);
    const lookupError = rawMatchesResult.error ?? itemsResult.error ?? sourcesResult.error;
    if (lookupError) throw lookupError;

    const rawMatches = rawMatchesResult.data ?? [];
    const sources = sourcesResult.data ?? [];
    const matchedItemIds = matchedLogicalWritingItemIds({
      matchedRawQuestionIds: rawMatches.map((row) => String(row.question_id)),
      sources,
      taskType
    });
    const canonicalIds = Array.from(new Set(
      sources.flatMap((source) =>
        source.is_canonical && matchedItemIds.has(source.item_id) && source.source_question_id
          ? [source.source_question_id]
          : []
      )
    ));
    const canonicalQuestions: WritingQuestion[] = [];
    for (const batch of chunkValues(canonicalIds)) {
      const result = await readAllSupabaseRows<Record<string, unknown>>((from, to) =>
        auth.supabase!
          .from(WRITING_TASK_CONFIG[taskType].questionTable)
          .select(WRITING_ASSIGNMENT_QUERY_FIELDS[taskType])
          .in("question_id", batch)
          .order("question_id", { ascending: true })
          .range(from, to) as unknown as PromiseLike<{
            data: Record<string, unknown>[] | null;
            error: { message: string } | null;
          }>
      );
      if (result.error) throw result.error;
      canonicalQuestions.push(...(result.data ?? []) as unknown as WritingQuestion[]);
    }

    const allResults = buildLogicalWritingQuestionSearchResults({
      canonicalQuestions,
      items: itemsResult.data ?? [],
      matchedItemIds,
      sources,
      taskType
    });
    const from = (page - 1) * pageSize;
    return writingAssignmentJson({
      questions: allResults.slice(from, from + pageSize),
      page,
      pageSize,
      total: allResults.length
    });
  } catch (error) {
    console.error("[writing-assignments] logical_question_search_failed", error);
    return writingAssignmentJson(
      { code: "QUESTION_SEARCH_FAILED", message: "题库搜索失败，请稍后重试。" },
      { status: 500 }
    );
  }
}

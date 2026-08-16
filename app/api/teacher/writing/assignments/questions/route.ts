import { isWritingTaskType, WRITING_TASK_CONFIG, type WritingQuestion } from "@/lib/writing";
import {
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
    const from = (page - 1) * pageSize;

    let builder = auth.supabase
      .from(WRITING_TASK_CONFIG[taskType].questionTable)
      .select(WRITING_ASSIGNMENT_QUERY_FIELDS[taskType], { count: "exact" });
    if (query) {
      builder = builder.or(
        WRITING_ASSIGNMENT_SEARCH_FIELDS[taskType]
          .map((field) => `${field}.ilike.%${query}%`)
          .join(",")
      );
    }
    const { data, error, count } = await builder
      .order("year_month", { ascending: false })
      .order("set_title", { ascending: true })
      .order("question_id", { ascending: true })
      .range(from, from + pageSize - 1);

    if (error) throw error;
    return writingAssignmentJson({
      questions: (data ?? []) as unknown as WritingQuestion[],
      page,
      pageSize,
      total: count ?? 0
    });
  } catch (error) {
    console.error("[writing-assignments] question_search_failed", error);
    return writingAssignmentJson(
      { code: "QUESTION_SEARCH_FAILED", message: "题库搜索失败，请稍后重试。" },
      { status: 500 }
    );
  }
}

import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  isWritingTaskType,
  WRITING_TASK_CONFIG,
  type WritingQuestion,
  type WritingTaskType
} from "@/lib/writing";
import {
  buildCustomWritingQuestionSnapshot,
  isWritingAssignmentQuestionSource,
  isWritingQuestionSnapshot,
  type WritingAssignmentQuestionSource
} from "@/lib/writingAssignments";

export const WRITING_ASSIGNMENT_QUERY_FIELDS = {
  email:
    "question_id,set_id,set_title,year_month,source_labels,scenario,task_instruction,requirement_1,requirement_2,requirement_3,closing_instruction,recipient,subject",
  academic_discussion:
    "question_id,set_id,set_title,year_month,source_labels,professor_name,professor_prompt,student_1_name,student_1_response,student_2_name,student_2_response"
} satisfies Record<WritingTaskType, string>;

export const WRITING_ASSIGNMENT_SEARCH_FIELDS = {
  email: [
    "set_title",
    "scenario",
    "requirement_1",
    "requirement_2",
    "requirement_3",
    "recipient",
    "subject"
  ],
  academic_discussion: [
    "set_title",
    "professor_name",
    "professor_prompt",
    "student_1_name",
    "student_1_response",
    "student_2_name",
    "student_2_response"
  ]
} satisfies Record<WritingTaskType, string[]>;

export function writingAssignmentJson(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}

export async function requireWritingAssignmentTeacher(request: Request) {
  const auth = await requireUserWithRole(bearerToken(request), "teacher");
  if (auth.error || !auth.userId) {
    return {
      error: writingAssignmentJson(
        { code: "UNAUTHORIZED", message: "无权访问教师端作业数据。" },
        { status: auth.error === "Unauthorized" ? 403 : 401 }
      ),
      supabase: null,
      teacherId: null
    };
  }
  return {
    error: null,
    supabase: createServiceSupabase(),
    teacherId: auth.userId
  };
}

export function safeWritingAssignmentSearchTerm(value: string) {
  return value
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9\u00c0-\u024f\u3400-\u9fff\s-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}

export function parsePositiveInteger(value: string | null, fallback: number, max: number) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

export function uniqueStrings(values: unknown) {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values.filter((value): value is string => typeof value === "string" && Boolean(value.trim())).map((value) => value.trim())));
}

export function validOptionalDueAt(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error("截止时间格式无效。");
  }
  return new Date(value).toISOString();
}

export function chunkValues<T>(values: T[], size = 100) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

export async function prepareWritingAssignmentMutation(
  supabase: ReturnType<typeof createServiceSupabase>,
  body: Record<string, unknown>,
  options: { canonicalizeQuestionBank?: boolean } = {}
) {
  if (!isWritingTaskType(body.taskType)) throw new Error("请选择有效的写作题型。");
  if (!isWritingAssignmentQuestionSource(body.questionSource)) {
    throw new Error("请选择有效的题目来源。");
  }
  const { dueAt, studentIds } = await prepareWritingAssignmentMembership(supabase, body);
  const taskType = body.taskType;
  const questionSource = body.questionSource;
  let questionId: string | null = null;
  let questionSnapshot: WritingQuestion;

  if (questionSource === "question_bank") {
    questionId = typeof body.questionId === "string" ? body.questionId.trim() : "";
    if (!questionId) throw new Error("请选择一道题库题目。");
    if (options.canonicalizeQuestionBank) {
      questionId = await resolveCanonicalWritingAssignmentQuestionId(
        supabase,
        taskType,
        questionId
      );
    }
    const { data, error } = await supabase
      .from(WRITING_TASK_CONFIG[taskType].questionTable)
      .select(WRITING_ASSIGNMENT_QUERY_FIELDS[taskType])
      .eq("question_id", questionId)
      .maybeSingle();
    if (error) throw error;
    if (!data || !isWritingQuestionSnapshot(taskType, data)) {
      throw new Error("所选题目不存在，或与当前题型不匹配。");
    }
    questionSnapshot = data;
  } else {
    questionSnapshot = buildCustomWritingQuestionSnapshot({
      taskType,
      fields: isRecord(body.customQuestion) ? body.customQuestion : {},
      id: crypto.randomUUID()
    });
  }

  return {
    dueAt,
    questionId,
    questionSnapshot,
    questionSource: questionSource satisfies WritingAssignmentQuestionSource,
    studentIds,
    taskType
  };
}

async function resolveCanonicalWritingAssignmentQuestionId(
  supabase: ReturnType<typeof createServiceSupabase>,
  taskType: WritingTaskType,
  selectedQuestionId: string
) {
  const selectedSource = await supabase
    .from("practice_item_sources")
    .select("item_id")
    .eq("task_type", taskType)
    .eq("source_question_id", selectedQuestionId)
    .maybeSingle();
  if (selectedSource.error) throw selectedSource.error;
  if (!selectedSource.data) throw new Error("所选题目不属于当前练习题库。");

  const canonicalSource = await supabase
    .from("practice_item_sources")
    .select("source_question_id")
    .eq("item_id", selectedSource.data.item_id)
    .eq("task_type", taskType)
    .eq("is_canonical", true)
    .maybeSingle();
  if (canonicalSource.error) throw canonicalSource.error;
  const canonicalQuestionId = canonicalSource.data?.source_question_id?.trim();
  if (!canonicalQuestionId) throw new Error("所选题目的当前版本不可用。");
  return canonicalQuestionId;
}

export async function prepareWritingAssignmentMembership(
  supabase: ReturnType<typeof createServiceSupabase>,
  body: Record<string, unknown>
) {
  const studentIds = uniqueStrings(body.studentIds);
  if (studentIds.length === 0) throw new Error("请至少选择一名学生。");
  const dueAt = validOptionalDueAt(body.dueAt);
  await assertWritingAssignmentStudentIds(supabase, studentIds);
  return { dueAt, studentIds };
}

async function assertWritingAssignmentStudentIds(
  supabase: ReturnType<typeof createServiceSupabase>,
  studentIds: string[]
) {
  let count = 0;
  for (const batch of chunkValues(studentIds)) {
    const { data, error } = await supabase
      .from("profiles")
      .select("id")
      .eq("role", "student")
      .in("id", batch);
    if (error) throw error;
    count += data?.length ?? 0;
  }
  if (count !== studentIds.length) throw new Error("所选学生中包含无效账号。");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

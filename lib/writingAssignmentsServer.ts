import { NextResponse } from "next/server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  assignmentItemSubject,
  isAssignmentItemType,
  type AssignmentItemType,
  type AssignmentSubject
} from "@/lib/assignmentCatalog";
import { isWritingTaskType } from "@/lib/writing";
import { loadAssignmentCatalogEntryMap } from "@/lib/assignmentCatalog.server";
import {
  chunkValues,
  prepareWritingAssignmentGroupEditMutation,
  prepareWritingAssignmentMembership,
  prepareWritingAssignmentQuestion,
  resolveAssignmentGroupSubject,
  uniqueStrings,
  validOptionalDueAt,
  WRITING_ASSIGNMENT_QUERY_FIELDS,
  WRITING_ASSIGNMENT_SEARCH_FIELDS
} from "@/lib/writingAssignmentMutation.server";
import type { AccountActor } from "@/lib/accountAccess";
import { buildCustomWritingQuestionSnapshot } from "@/lib/writingAssignments";

// The 题库 / withdrawn-edit world lives in its own module (kept free of
// route-only imports); it is re-exported here so the existing API imports stay
// stable.
export {
  chunkValues,
  prepareWritingAssignmentGroupEditMutation,
  prepareWritingAssignmentMembership,
  prepareWritingAssignmentQuestion,
  uniqueStrings,
  validOptionalDueAt,
  WRITING_ASSIGNMENT_QUERY_FIELDS,
  WRITING_ASSIGNMENT_SEARCH_FIELDS
};

export function writingAssignmentJson(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}

export async function requireWritingAssignmentTeacher(request: Request) {
  const auth = await requireTeacherOnly(bearerToken(request));
  if (auth.error || !auth.userId || !auth.role) {
    return {
      error: writingAssignmentJson(
        { code: "UNAUTHORIZED", message: "无权访问教师端作业数据。" },
        { status: auth.error === "Forbidden" ? 403 : 401 }
      ),
      supabase: null,
      teacherId: null,
      actor: null
    };
  }
  return {
    error: null,
    supabase: createServiceSupabase(),
    teacherId: auth.userId,
    actor: { userId: auth.userId, role: auth.role } satisfies AccountActor
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

export async function prepareWritingAssignmentMutation(
  supabase: ReturnType<typeof createServiceSupabase>,
  body: Record<string, unknown>,
  options: {
    canonicalizeQuestionBank?: boolean;
    actor?: AccountActor;
    subject?: AssignmentSubject;
  } = {}
) {
  const question = await prepareWritingAssignmentQuestion(supabase, body, options);
  const subject = options.subject ?? assignmentItemSubject(question.taskType);
  const membership = await prepareWritingAssignmentMembership(supabase, body, {
    actor: options.actor,
    subject
  });
  return { ...membership, ...question, subject };
}

export async function prepareWritingAssignmentGroupMutation(
  supabase: ReturnType<typeof createServiceSupabase>,
  body: Record<string, unknown>,
  options: {
    canonicalizeQuestionBank?: boolean;
    actor?: AccountActor;
    subject?: AssignmentSubject;
  } = {}
) {
  if (!Array.isArray(body.assignments) || body.assignments.length === 0) {
    throw new Error("请至少添加一道题目。");
  }
  if (body.assignments.length > 50) throw new Error("一次最多布置 50 道题目。");
  const itemValues = body.assignments.filter(isRecord);
  const subject = resolveAssignmentGroupSubject(itemValues, options.subject);
  const catalogEntries = await loadAssignmentCatalogEntryMap(
    supabase,
    itemValues.flatMap((value) => {
      const itemType = readAssignmentItemType(value);
      return itemType && !isWritingTaskType(itemType) ? [itemType] : [];
    })
  );
  const membership = await prepareWritingAssignmentMembership(supabase, body, {
    actor: options.actor,
    subject
  });
  const assignments = [];
  for (const value of body.assignments) {
    if (!isRecord(value)) throw new Error("请完整填写每道题目。");
    assignments.push(await prepareWritingAssignmentQuestion(supabase, value, {
      ...options,
      catalogEntries
    }));
  }
  return { assignments, studentIds: membership.studentIds, subject };
}

/**
 * Class mode for assignment creation: recipients are resolved by the RPC from
 * the class members at creation time, so the client only supplies the prepared
 * questions and the class id.
 */
export async function prepareClassWritingAssignmentGroupMutation(
  supabase: ReturnType<typeof createServiceSupabase>,
  body: Record<string, unknown>,
  options: {
    canonicalizeQuestionBank?: boolean;
    actor?: AccountActor;
    subject?: AssignmentSubject;
  } = {}
) {
  if (!Array.isArray(body.assignments) || body.assignments.length === 0) {
    throw new Error("请至少添加一道题目。");
  }
  if (body.assignments.length > 50) throw new Error("一次最多布置 50 道题目。");
  const itemValues = body.assignments.filter(isRecord);
  const subject = resolveAssignmentGroupSubject(itemValues, options.subject);
  const catalogEntries = await loadAssignmentCatalogEntryMap(
    supabase,
    itemValues.flatMap((value) => {
      const itemType = readAssignmentItemType(value);
      return itemType && !isWritingTaskType(itemType) ? [itemType] : [];
    })
  );
  const assignments = [];
  for (const value of body.assignments) {
    if (!isRecord(value)) throw new Error("请完整填写每道题目。");
    assignments.push(await prepareWritingAssignmentQuestion(supabase, value, {
      ...options,
      catalogEntries
    }));
  }
  return { assignments, subject };
}

/**
 * The withdrawn-edit lock: once an item has a submitted attempt its question
 * content is frozen. Shared by the single edit route and the group edit route.
 * Catalog items (BAS / Reading) are frozen by their stable item identity.
 */
export function assertLockedWritingAssignmentQuestionInput(
  body: Record<string, unknown>,
  assignment: {
    task_type: AssignmentItemType;
    question_source: "question_bank" | "custom";
    question_id: string | null;
    question_snapshot: Record<string, unknown>;
  }
) {
  const bodyItemType = readAssignmentItemType(body);
  if (bodyItemType !== assignment.task_type || body.questionSource !== assignment.question_source) {
    throw new Error("QUESTION_LOCKED_AFTER_SUBMISSION");
  }
  if (!isWritingTaskType(assignment.task_type)) {
    if (body.questionId !== assignment.question_id) throw new Error("QUESTION_LOCKED_AFTER_SUBMISSION");
    return;
  }
  if (assignment.question_source === "question_bank") {
    if (body.questionId !== assignment.question_id) throw new Error("QUESTION_LOCKED_AFTER_SUBMISSION");
    return;
  }
  try {
    const candidate = buildCustomWritingQuestionSnapshot({
      taskType: assignment.task_type,
      fields: isRecord(body.customQuestion) ? body.customQuestion : {},
      id: "locked-comparison"
    });
    const fields = assignment.task_type === "email"
      ? ["set_title", "scenario", "task_instruction", "requirement_1", "requirement_2", "requirement_3", "closing_instruction", "recipient", "subject"]
      : [
          "set_title", "professor_name", "professor_prompt", "student_1_name",
          "student_1_response", "student_2_name", "student_2_response",
          ...["professor_avatar_type", "student_1_avatar_type", "student_2_avatar_type"]
            .filter((field) => assignment.question_snapshot[field] !== undefined)
        ];
    if (fields.some((field) => candidate[field as keyof typeof candidate] !== assignment.question_snapshot[field])) {
      throw new Error("QUESTION_LOCKED_AFTER_SUBMISSION");
    }
  } catch {
    throw new Error("QUESTION_LOCKED_AFTER_SUBMISSION");
  }
}

function readAssignmentItemType(value: Record<string, unknown>): AssignmentItemType | null {
  const raw = value.itemType ?? value.taskType;
  return isAssignmentItemType(raw) ? raw : null;
}

/** One shared class-mode error mapping for create and withdrawn edit. */
export function writingAssignmentClassErrorMessage(message: string) {
  if (message.includes("CLASS_NOT_WRITING_CLASS")) return "该班级不包含写作科目。";
  if (message.includes("CLASS_NOT_READING_CLASS")) return "该班级不包含阅读科目。";
  if (message.includes("CLASS_HAS_NO_MEMBERS")) return "该班级还没有学生，请先添加学生。";
  return "所选班级不存在或无权布置作业。";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

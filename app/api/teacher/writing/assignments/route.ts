import { readAllSupabaseRows } from "@/lib/supabasePagination";
import {
  earliestWritingAssignmentSubmission,
  isLaterWritingAssignmentSubmission,
  type WritingAssignmentSummary
} from "@/lib/writingAssignments";
import type { WritingQuestion } from "@/lib/writing";
import {
  chunkValues,
  prepareWritingAssignmentGroupMutation,
  requireWritingAssignmentTeacher,
  writingAssignmentJson
} from "@/lib/writingAssignmentsServer";
import { loadWritingAssignmentDisplayNames } from "@/lib/historicalPracticeDisplay";

export const dynamic = "force-dynamic";

type AssignmentRow = Omit<
  WritingAssignmentSummary,
  | "assigned_count"
  | "completed_count"
  | "published_count"
  | "has_attempts"
  | "single_student_latest_submitted_attempt_id"
  | "single_student_latest_review_status"
  | "has_overdue_students"
  | "question_snapshot"
> & {
  teacher_id: string;
  updated_at: string;
  set_title: string | null;
};
type AssignmentStudentRow = { assignment_id: string; student_id: string; assigned_at: string };
type AssignmentAttemptRow = { assignment_id: string; attempt_id: string; user_id: string; status: string; submitted_at: string | null };
type AssignmentReviewRow = { attempt_id: string; status: string; published_at: string | null };

export async function GET(request: Request) {
  try {
    const auth = await requireWritingAssignmentTeacher(request);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.teacherId) return writingAssignmentJson({ message: "无权访问教师端作业数据。" }, { status: 401 });
    const studentId = new URL(request.url).searchParams.get("studentId")?.trim() ?? "";
    const assignmentsResult = await readAllSupabaseRows<AssignmentRow>((from, to) =>
      auth.supabase!
        .from("writing_assignments")
        .select("assignment_id,group_id,group_position,teacher_id,task_type,question_source,question_id,set_title:question_snapshot->>set_title,due_at,status,created_at,updated_at")
        .eq("teacher_id", auth.teacherId!)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .order("assignment_id", { ascending: false })
        .range(from, to)
    );
    if (assignmentsResult.error) throw assignmentsResult.error;
    let assignments = assignmentsResult.data ?? [];
    if (studentId) {
      const membershipResult = await readAllSupabaseRows<{ assignment_id: string }>((from, to) =>
        auth.supabase!
          .from("writing_assignment_students")
          .select("assignment_id")
          .eq("student_id", studentId)
          .order("assignment_id", { ascending: true })
          .range(from, to)
      );
      if (membershipResult.error) throw membershipResult.error;
      const studentAssignmentIds = new Set(
        (membershipResult.data ?? []).map((row) => String(row.assignment_id))
      );
      assignments = assignments.filter((assignment) =>
        studentAssignmentIds.has(assignment.assignment_id)
      );
    }
    if (assignments.length === 0) return writingAssignmentJson({ assignments: [] });

    const assignmentIds = assignments.map((assignment) => assignment.assignment_id);
    // Members, attempts, review statuses and display names are all keyed by the
    // assignment ids, so the whole detail set loads in one parallel wave.
    const [members, attempts, reviewStatuses, displayNames] = await Promise.all([
      readAssignmentRows<AssignmentStudentRow>(auth.supabase, "writing_assignment_students", "assignment_id,student_id,assigned_at", assignmentIds),
      readAssignmentRows<AssignmentAttemptRow>(auth.supabase, "writing_attempts", "assignment_id,attempt_id,user_id,status,submitted_at", assignmentIds),
      readAssignmentReviewStatuses(auth.supabase, assignmentIds),
      loadWritingAssignmentDisplayNames(
        auth.supabase,
        assignments.map((assignment) => ({
          assignmentId: assignment.assignment_id,
          taskType: assignment.task_type,
          questionSource: assignment.question_source,
          questionId: assignment.question_id,
          fallbackDisplayName: assignmentSnapshotTitle(assignment)
        }))
      )
    ]);
    const assignedByAssignment = new Map<string, Set<string>>();
    for (const member of members) {
      const values = assignedByAssignment.get(member.assignment_id) ?? new Set<string>();
      values.add(member.student_id);
      assignedByAssignment.set(member.assignment_id, values);
    }
    const submissions = new Map<string, string[]>();
    const latestSubmission = new Map<string, AssignmentAttemptRow>();
    const assignmentsWithAttempts = new Set<string>();
    for (const attempt of attempts) {
      assignmentsWithAttempts.add(attempt.assignment_id);
      if (attempt.status !== "submitted" || !attempt.submitted_at) continue;
      const key = `${attempt.assignment_id}:${attempt.user_id}`;
      submissions.set(key, [...(submissions.get(key) ?? []), attempt.submitted_at]);
      const current = latestSubmission.get(key);
      if (!current || isLaterWritingAssignmentSubmission(attempt, current)) {
        latestSubmission.set(key, attempt);
      }
    }
    const now = Date.now();
    const enrichedAssignments = assignments.map((assignment) => {
        const students = assignedByAssignment.get(assignment.assignment_id) ?? new Set();
        let completedCount = 0;
        let publishedCount = 0;
        for (const studentId of Array.from(students)) {
          const key = `${assignment.assignment_id}:${studentId}`;
          if (earliestWritingAssignmentSubmission(submissions.get(key) ?? [])) {
            completedCount += 1;
          }
          const latest = latestSubmission.get(key);
          if (latest && reviewStatuses.get(latest.attempt_id) === "published") {
            publishedCount += 1;
          }
        }
        const singleStudentId = students.size === 1 ? Array.from(students)[0] : null;
        const singleStudentSubmission = singleStudentId
          ? latestSubmission.get(`${assignment.assignment_id}:${singleStudentId}`)
          : undefined;
        const snapshotTitle = assignmentSnapshotTitle(assignment);
        return {
          assignment_id: assignment.assignment_id,
          group_id: assignment.group_id,
          group_position: assignment.group_position,
          task_type: assignment.task_type,
          question_source: assignment.question_source,
          question_id: assignment.question_id,
          question_snapshot: { set_title: assignment.set_title ?? "" } as WritingQuestion,
          display_name: displayNames.get(assignment.assignment_id) ?? snapshotTitle,
          status: assignment.status,
          due_at: assignment.due_at,
          created_at: assignment.created_at,
          assigned_count: students.size,
          completed_count: completedCount,
          published_count: publishedCount,
          has_attempts: assignmentsWithAttempts.has(assignment.assignment_id),
          single_student_latest_submitted_attempt_id:
            singleStudentSubmission?.attempt_id ?? null,
          single_student_latest_review_status: singleStudentSubmission
            ? reviewStatuses.get(singleStudentSubmission.attempt_id) ?? null
            : null,
          has_overdue_students: Boolean(
            assignment.due_at && Date.parse(assignment.due_at) < now && completedCount < students.size
          )
        } satisfies WritingAssignmentSummary;
    });
    return writingAssignmentJson({ assignments: enrichedAssignments });
  } catch (error) {
    console.error("[writing-assignments] list_load_failed", error);
    return writingAssignmentJson(
      { code: "ASSIGNMENTS_LOAD_FAILED", message: "作业列表加载失败，请稍后重试。" },
      { status: 500 }
    );
  }
}

async function readAssignmentReviewStatuses(
  supabase: NonNullable<Awaited<ReturnType<typeof requireWritingAssignmentTeacher>>["supabase"]>,
  assignmentIds: string[]
) {
  const statuses = new Map<string, "reviewing" | "published">();
  for (const batch of chunkValues(assignmentIds)) {
    if (batch.length === 0) continue;
    const result = await readAllSupabaseRows<AssignmentReviewRow>((from, to) =>
      supabase
        .from("writing_reviews")
        .select("attempt_id,status,published_at,attempt:writing_attempts!inner(assignment_id)")
        .in("attempt.assignment_id", batch)
        .order("attempt_id", { ascending: true })
        .range(from, to)
    );
    if (result.error) throw result.error;
    for (const review of result.data ?? []) {
      statuses.set(
        review.attempt_id,
        review.status === "published" && review.published_at
          ? "published"
          : "reviewing"
      );
    }
  }
  return statuses;
}

export async function POST(request: Request) {
  try {
    const auth = await requireWritingAssignmentTeacher(request);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.teacherId) return writingAssignmentJson({ message: "无权访问教师端作业数据。" }, { status: 401 });
    const body = await request.json() as Record<string, unknown>;
    const groupBody = Array.isArray(body.assignments)
      ? body
      : { assignments: [body], studentIds: body.studentIds };
    const prepared = await prepareWritingAssignmentGroupMutation(auth.supabase, groupBody, {
      canonicalizeQuestionBank: true,
      actor: auth.actor ?? undefined
    });
    const { data, error } = await auth.supabase.rpc("create_writing_assignment_group", {
      p_teacher_id: auth.teacherId,
      p_assignments: prepared.assignments.map((assignment) => ({
        due_at: assignment.dueAt,
        question_id: assignment.questionId,
        question_snapshot: assignment.questionSnapshot,
        question_source: assignment.questionSource,
        task_type: assignment.taskType
      })),
      p_student_ids: prepared.studentIds
    });
    if (error) {
      logWritingAssignmentCreateFailure(error, {
        teacherId: auth.teacherId,
        studentCount: prepared.studentIds.length,
        assignmentCount: prepared.assignments.length
      });
      const inputMessage = writingAssignmentRpcInputErrorMessage(error.message);
      if (inputMessage) return invalid(inputMessage);
      throw error;
    }
    const assignmentIds = isRecord(data) && Array.isArray(data.assignment_ids)
      ? data.assignment_ids.map(String)
      : [];
    if (assignmentIds.length !== prepared.assignments.length) {
      throw new Error("Assignment group RPC returned an incomplete result");
    }
    return writingAssignmentJson({
      assignmentId: assignmentIds[0],
      assignmentIds
    }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && isAssignmentInputError(error.message)) return invalid(error.message);
    console.error("[writing-assignments] create_failed", error);
    return writingAssignmentJson(
      { code: "ASSIGNMENT_CREATE_FAILED", message: "作业创建失败，请稍后重试。" },
      { status: 500 }
    );
  }
}

async function readAssignmentRows<T>(
  supabase: NonNullable<Awaited<ReturnType<typeof requireWritingAssignmentTeacher>>["supabase"]>,
  table: string,
  fields: string,
  assignmentIds: string[]
) {
  const rows: T[] = [];
  for (const batch of chunkValues(assignmentIds)) {
    const result = await readAllSupabaseRows<T>((from, to) => {
      return supabase.from(table).select(fields).in("assignment_id", batch)
        .order("assignment_id", { ascending: true }).range(from, to) as unknown as PromiseLike<{
        data: T[] | null;
        error: { message: string } | null;
      }>;
    });
    if (result.error) throw result.error;
    rows.push(...(result.data ?? []));
  }
  return rows;
}

function assignmentSnapshotTitle(assignment: {
  set_title: string | null;
}) {
  return assignment.set_title?.trim() || "自定义题目";
}

function invalid(message: string) {
  return writingAssignmentJson({ code: "INVALID_ASSIGNMENT", message }, { status: 400 });
}

function isAssignmentInputError(message: string) {
  return /^(请选择|请至少|请完整|请填写|请输入|所选|截止|一次最多)/.test(message);
}

/**
 * The RPC raises English validation errors before any insert. They stay 400
 * responses; unknown Supabase failures stay 500. Database internals are only
 * ever logged server-side, never returned to the client.
 */
const WRITING_ASSIGNMENT_RPC_INPUT_ERROR_MESSAGES: Record<string, string> = {
  "Assignments must contain between 1 and 50 items": "请至少添加一道题目，且一次最多布置 50 道题目。",
  "At least one student is required": "请至少选择一名学生。",
  "One or more students are invalid": "所选学生中包含无效账号。",
  "Invalid writing task type": "请选择有效的写作题型。",
  "Invalid question source": "请选择有效的题目来源。",
  "Question snapshot must be an object": "请完整填写每道题目。",
  "Question bank assignment requires question_id": "请选择一道题库题目。",
  "Custom assignment cannot include question_id": "请完整填写每道题目。"
};

function writingAssignmentRpcInputErrorMessage(message: string) {
  return WRITING_ASSIGNMENT_RPC_INPUT_ERROR_MESSAGES[message] ?? null;
}

function logWritingAssignmentCreateFailure(
  error: unknown,
  context: { teacherId: string; studentCount: number; assignmentCount: number }
) {
  const rpcError = isRecord(error) ? error : {};
  console.error("[writing-assignments] rpc_create_failed", {
    code: typeof rpcError.code === "string" ? rpcError.code : null,
    message: error instanceof Error ? error.message : String(rpcError.message ?? error),
    details: rpcError.details ?? null,
    hint: rpcError.hint ?? null,
    teacherId: context.teacherId,
    studentCount: context.studentCount,
    assignmentCount: context.assignmentCount
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

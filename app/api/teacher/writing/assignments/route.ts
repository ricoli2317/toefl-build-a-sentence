import { readAllSupabaseRows } from "@/lib/supabasePagination";
import {
  earliestWritingAssignmentSubmission,
  isLaterWritingAssignmentSubmission,
  type WritingAssignmentSummary
} from "@/lib/writingAssignments";
import {
  chunkValues,
  prepareWritingAssignmentMutation,
  requireWritingAssignmentTeacher,
  writingAssignmentJson
} from "@/lib/writingAssignmentsServer";
import {
  loadHistoricalPracticeDisplayResolver,
  logHistoricalPracticeDisplayWarnings,
  type HistoricalPracticeDisplay
} from "@/lib/historicalPracticeDisplay";

export const dynamic = "force-dynamic";

type AssignmentRow = Omit<WritingAssignmentSummary, "assigned_count" | "completed_count" | "published_count" | "has_attempts" | "single_student_latest_submitted_attempt_id" | "single_student_latest_review_status" | "has_overdue_students"> & {
  teacher_id: string;
  updated_at: string;
};
type AssignmentStudentRow = { assignment_id: string; student_id: string; assigned_at: string };
type AssignmentAttemptRow = { assignment_id: string; attempt_id: string; user_id: string; status: string; submitted_at: string | null };

export async function GET(request: Request) {
  try {
    const auth = await requireWritingAssignmentTeacher(request);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.teacherId) return writingAssignmentJson({ message: "无权访问教师端作业数据。" }, { status: 401 });
    const assignmentsResult = await readAllSupabaseRows<AssignmentRow>((from, to) =>
      auth.supabase!
        .from("writing_assignments")
        .select("assignment_id,teacher_id,task_type,question_source,question_id,question_snapshot,due_at,status,created_at,updated_at")
        .eq("teacher_id", auth.teacherId!)
        .is("deleted_at", null)
        .order("created_at", { ascending: false })
        .order("assignment_id", { ascending: false })
        .range(from, to)
    );
    if (assignmentsResult.error) throw assignmentsResult.error;
    const assignments = assignmentsResult.data ?? [];
    if (assignments.length === 0) return writingAssignmentJson({ assignments: [] });

    const assignmentIds = assignments.map((assignment) => assignment.assignment_id);
    const [members, attempts, historicalDisplayResolver] = await Promise.all([
      readAssignmentRows<AssignmentStudentRow>(auth.supabase, "writing_assignment_students", "assignment_id,student_id,assigned_at", assignmentIds),
      readAssignmentRows<AssignmentAttemptRow>(auth.supabase, "writing_attempts", "assignment_id,attempt_id,user_id,status,submitted_at", assignmentIds),
      loadHistoricalPracticeDisplayResolver(auth.supabase)
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
    const reviewStatusByAttemptId = await readReviewStatuses(
      auth.supabase,
      Array.from(latestSubmission.values(), (attempt) => attempt.attempt_id)
    );
    const now = Date.now();
    const resolvedDisplays: HistoricalPracticeDisplay[] = [];
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
          if (latest && reviewStatusByAttemptId.get(latest.attempt_id) === "published") {
            publishedCount += 1;
          }
        }
        const singleStudentId = students.size === 1 ? Array.from(students)[0] : null;
        const singleStudentSubmission = singleStudentId
          ? latestSubmission.get(`${assignment.assignment_id}:${singleStudentId}`)
          : undefined;
        const snapshotTitle = assignment.question_snapshot.set_title?.trim() || "自定义题目";
        const display = assignment.question_source === "question_bank" && assignment.question_id
          ? historicalDisplayResolver.resolveWritingAttempt({
              assignmentId: null,
              fallbackDisplayName: snapshotTitle,
              rawQuestionId: assignment.question_id,
              taskType: assignment.task_type
            })
          : null;
        if (display) resolvedDisplays.push(display);
        return {
          assignment_id: assignment.assignment_id,
          task_type: assignment.task_type,
          question_source: assignment.question_source,
          question_id: assignment.question_id,
          question_snapshot: assignment.question_snapshot,
          display_name: display?.displayName ?? snapshotTitle,
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
            ? reviewStatusByAttemptId.get(singleStudentSubmission.attempt_id) ?? null
            : null,
          has_overdue_students: Boolean(
            assignment.due_at && Date.parse(assignment.due_at) < now && completedCount < students.size
          )
        } satisfies WritingAssignmentSummary;
    });
    logHistoricalPracticeDisplayWarnings(resolvedDisplays);
    return writingAssignmentJson({ assignments: enrichedAssignments });
  } catch (error) {
    console.error("[writing-assignments] list_load_failed", error);
    return writingAssignmentJson(
      { code: "ASSIGNMENTS_LOAD_FAILED", message: "作业列表加载失败，请稍后重试。" },
      { status: 500 }
    );
  }
}

async function readReviewStatuses(
  supabase: NonNullable<Awaited<ReturnType<typeof requireWritingAssignmentTeacher>>["supabase"]>,
  attemptIds: string[]
) {
  const statuses = new Map<string, "reviewing" | "published">();
  for (const batch of chunkValues(attemptIds)) {
    if (batch.length === 0) continue;
    const result = await readAllSupabaseRows<{
      attempt_id: string;
      status: string;
      published_at: string | null;
    }>((from, to) =>
      supabase
        .from("writing_reviews")
        .select("attempt_id,status,published_at")
        .in("attempt_id", batch)
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
    const prepared = await prepareWritingAssignmentMutation(auth.supabase, body, {
      canonicalizeQuestionBank: true
    });
    const { data, error } = await auth.supabase.rpc("create_writing_assignment", {
      p_teacher_id: auth.teacherId,
      p_task_type: prepared.taskType,
      p_question_source: prepared.questionSource,
      p_question_id: prepared.questionId,
      p_question_snapshot: prepared.questionSnapshot,
      p_due_at: prepared.dueAt,
      p_student_ids: prepared.studentIds
    });
    if (error) throw error;
    return writingAssignmentJson({ assignmentId: String(data) }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && isAssignmentInputError(error.message)) return invalid(error.message);
    console.error("[writing-assignments] create_failed", error);
    return writingAssignmentJson(
      { code: "ASSIGNMENT_CREATE_FAILED", message: "作业创建失败，请确认数据库 SQL 已执行后重试。" },
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

function invalid(message: string) {
  return writingAssignmentJson({ code: "INVALID_ASSIGNMENT", message }, { status: 400 });
}

function isAssignmentInputError(message: string) {
  return /^(请选择|请至少|请填写|请输入|所选|截止)/.test(message);
}

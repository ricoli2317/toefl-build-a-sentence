import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";
import { loadWritingAssignmentDisplayNames } from "@/lib/historicalPracticeDisplay";
import { loadWritingAssignmentGroupTitles } from "@/lib/writingAssignmentsGroupTitles.server";
import type { WritingQuestion, WritingTaskType } from "@/lib/writing";
import {
  calculateWritingAssignmentStudentStatus,
  earliestWritingAssignmentSubmission,
  isLaterWritingAssignmentSubmission,
  writingAssignmentTitle,
  type WritingAssignmentCollectionDetail,
  type WritingAssignmentLifecycleStatus,
  type WritingAssignmentQuestionSource,
  type WritingAssignmentStudentDetail
} from "@/lib/writingAssignments";
import {
  assertLockedWritingAssignmentQuestionInput,
  chunkValues,
  prepareWritingAssignmentGroupEditMutation,
  requireWritingAssignmentTeacher,
  writingAssignmentJson
} from "@/lib/writingAssignmentsServer";

export const dynamic = "force-dynamic";

type AssignmentRow = {
  assignment_id: string;
  group_id: string;
  group_position: number;
  task_type: WritingTaskType;
  question_source: WritingAssignmentQuestionSource;
  question_id: string | null;
  question_snapshot: WritingQuestion;
  status: WritingAssignmentLifecycleStatus;
  due_at: string | null;
  created_at: string;
  updated_at: string;
};
type MemberRow = { assignment_id: string; student_id: string; assigned_at: string };
type ProfileRow = { id: string; email: string | null; full_name: string | null };
type AttemptRow = {
  assignment_id: string;
  attempt_id: string;
  user_id: string;
  status: string;
  submitted_at: string | null;
};
type ReviewRow = { attempt_id: string; status: string; published_at: string | null };

export async function GET(
  request: Request,
  { params }: { params: { batchId: string } }
) {
  try {
    const auth = await requireWritingAssignmentTeacher(request);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.teacherId) return unauthorized();

    const assignmentsResult = await readAllSupabaseRows<AssignmentRow>((from, to) =>
      auth.supabase!
        .from("writing_assignments")
        .select("assignment_id,group_id,group_position,task_type,question_source,question_id,question_snapshot,status,due_at,created_at,updated_at")
        .eq("group_id", params.batchId)
        .eq("teacher_id", auth.teacherId!)
        .is("deleted_at", null)
        .order("group_position", { ascending: true })
        .range(from, to)
    );
    if (assignmentsResult.error) throw assignmentsResult.error;
    const assignments = assignmentsResult.data ?? [];
    if (assignments.length < 2) return notFound();
    const assignmentIds = assignments.map((assignment) => assignment.assignment_id);

    const [membersResult, attemptsResult, displayNames, groupTitles] = await Promise.all([
      readAllSupabaseRows<MemberRow>((from, to) =>
        auth.supabase!
          .from("writing_assignment_students")
          .select("assignment_id,student_id,assigned_at,sort_order")
          .in("assignment_id", assignmentIds)
          .order("sort_order", { ascending: true, nullsFirst: false })
          .order("assigned_at", { ascending: true })
          .order("student_id", { ascending: true })
          .order("assignment_id", { ascending: true })
          .range(from, to)
      ),
      readAllSupabaseRows<AttemptRow>((from, to) =>
        auth.supabase!
          .from("writing_attempts")
          .select("assignment_id,attempt_id,user_id,status,submitted_at")
          .in("assignment_id", assignmentIds)
          .order("submitted_at", { ascending: true, nullsFirst: false })
          .order("attempt_id", { ascending: true })
          .range(from, to)
      ),
      loadWritingAssignmentDisplayNames(
        auth.supabase,
        assignments.map((assignment) => ({
          assignmentId: assignment.assignment_id,
          fallbackDisplayName: writingAssignmentTitle(assignment.question_snapshot),
          questionId: assignment.question_id,
          questionSource: assignment.question_source,
          taskType: assignment.task_type
        }))
      ),
      loadWritingAssignmentGroupTitles(auth.supabase, [params.batchId])
    ]);
    if (membersResult.error || attemptsResult.error) {
      throw membersResult.error ?? attemptsResult.error;
    }
    const members = membersResult.data ?? [];
    const profiles = await readProfiles(
      auth.supabase,
      Array.from(new Set(members.map((member) => member.student_id)))
    );
    const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
    const membersByAssignment = new Map<string, MemberRow[]>();
    for (const member of members) {
      membersByAssignment.set(member.assignment_id, [
        ...(membersByAssignment.get(member.assignment_id) ?? []),
        member
      ]);
    }

    const attemptStudents = new Set<string>();
    const submissions = new Map<string, string[]>();
    const latestSubmission = new Map<string, AttemptRow>();
    for (const attempt of attemptsResult.data ?? []) {
      const key = assignmentStudentKey(attempt.assignment_id, attempt.user_id);
      attemptStudents.add(key);
      if (attempt.status !== "submitted" || !attempt.submitted_at) continue;
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

    let completedCount = 0;
    let publishedCount = 0;
    const details = assignments.map((assignment) => {
      const assignmentMembers = membersByAssignment.get(assignment.assignment_id) ?? [];
      const students: WritingAssignmentStudentDetail[] = assignmentMembers.map((member) => {
        const key = assignmentStudentKey(assignment.assignment_id, member.student_id);
        const firstSubmittedAt = earliestWritingAssignmentSubmission(submissions.get(key) ?? []);
        const latest = latestSubmission.get(key);
        const latestReviewStatus = latest
          ? reviewStatusByAttemptId.get(latest.attempt_id) ?? null
          : null;
        if (firstSubmittedAt) completedCount += 1;
        if (latestReviewStatus === "published") publishedCount += 1;
        const profile = profileById.get(member.student_id);
        return {
          student_id: member.student_id,
          student_name: getPreferredUserDisplayName({
            email: profile?.email,
            profileFullName: profile?.full_name
          }),
          student_email: profile?.email ?? "",
          assigned_at: member.assigned_at,
          first_submitted_at: firstSubmittedAt,
          has_attempt: attemptStudents.has(key),
          latest_submitted_attempt_id: latest?.attempt_id ?? null,
          latest_review_status: latestReviewStatus,
          status: calculateWritingAssignmentStudentStatus({
            dueAt: assignment.due_at,
            firstSubmittedAt
          })
        };
      });
      const assignmentCompletedCount = students.filter(
        (student) => student.first_submitted_at
      ).length;
      const assignmentPublishedCount = students.filter(
        (student) => student.latest_review_status === "published"
      ).length;
      return {
        assignment_id: assignment.assignment_id,
        group_id: assignment.group_id,
        group_position: assignment.group_position,
        task_type: assignment.task_type,
        question_source: assignment.question_source,
        question_id: assignment.question_id,
        question_snapshot: assignment.question_snapshot,
        display_name:
          displayNames.get(assignment.assignment_id)
          ?? writingAssignmentTitle(assignment.question_snapshot),
        status: assignment.status,
        due_at: assignment.due_at,
        created_at: assignment.created_at,
        updated_at: assignment.updated_at,
        assigned_count: students.length,
        completed_count: assignmentCompletedCount,
        published_count: assignmentPublishedCount,
        has_attempts: students.some((student) => student.has_attempt),
        has_submitted_attempts: students.some((student) => student.first_submitted_at),
        students
      };
    });
    const assignedCount = Math.max(0, ...details.map((detail) => detail.assigned_count));
    const collection: WritingAssignmentCollectionDetail = {
      collection_id: params.batchId,
      title: groupTitles.get(params.batchId) ?? "",
      assignments: details,
      assigned_count: assignedCount,
      completed_count: completedCount,
      created_at: details[0].created_at,
      pending_review_count: Math.max(0, completedCount - publishedCount),
      published_count: publishedCount,
      total_count: details.reduce((count, detail) => count + detail.assigned_count, 0)
    };
    return writingAssignmentJson({ collection });
  } catch (error) {
    console.error("[writing-assignments] collection_load_failed", error);
    return writingAssignmentJson(
      { code: "ASSIGNMENT_LOAD_FAILED", message: "作业详情加载失败，请稍后重试。" },
      { status: 500 }
    );
  }
}

function assignmentStudentKey(assignmentId: string, studentId: string) {
  return `${assignmentId}:${studentId}`;
}

async function readReviewStatuses(
  supabase: NonNullable<Awaited<ReturnType<typeof requireWritingAssignmentTeacher>>["supabase"]>,
  attemptIds: string[]
) {
  const statuses = new Map<string, "reviewing" | "published">();
  for (const batch of chunkValues(attemptIds)) {
    if (!batch.length) continue;
    const result = await readAllSupabaseRows<ReviewRow>((from, to) =>
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
        review.status === "published" && review.published_at ? "published" : "reviewing"
      );
    }
  }
  return statuses;
}

async function readProfiles(
  supabase: NonNullable<Awaited<ReturnType<typeof requireWritingAssignmentTeacher>>["supabase"]>,
  studentIds: string[]
) {
  const rows: ProfileRow[] = [];
  for (const batch of chunkValues(studentIds)) {
    if (!batch.length) continue;
    const result = await readAllSupabaseRows<ProfileRow>((from, to) =>
      supabase
        .from("profiles")
        .select("id,email,full_name")
        .in("id", batch)
        .order("id", { ascending: true })
        .range(from, to)
    );
    if (result.error) throw result.error;
    rows.push(...(result.data ?? []));
  }
  return rows;
}

type GroupEditAssignmentRow = {
  assignment_id: string;
  task_type: WritingTaskType;
  question_source: WritingAssignmentQuestionSource;
  question_id: string | null;
  question_snapshot: WritingQuestion;
  status: WritingAssignmentLifecycleStatus;
};

/**
 * Whole-group edit for a withdrawn Assignment Group. The payload carries every
 * item (no add/remove) and the RPC applies items, recipients and the lifecycle
 * status in one transaction, so an Email + AD group can never be half edited or
 * split into separate reassignments.
 */
export async function PATCH(
  request: Request,
  { params }: { params: { batchId: string } }
) {
  try {
    const auth = await requireWritingAssignmentTeacher(request);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.teacherId) return unauthorized();
    const body = await request.json() as Record<string, unknown>;
    if (body.action !== "edit") {
      return writingAssignmentJson(
        { code: "INVALID_ACTION", message: "无效的作业操作。" },
        { status: 400 }
      );
    }
    const { data: groupAssignments, error: groupError } = await auth.supabase
      .from("writing_assignments")
      .select("assignment_id,task_type,question_source,question_id,question_snapshot,status")
      .eq("group_id", params.batchId)
      .eq("teacher_id", auth.teacherId)
      .is("deleted_at", null)
      .order("group_position", { ascending: true })
      .order("assignment_id", { ascending: true });
    if (groupError) throw groupError;
    const currentItems = (groupAssignments ?? []) as GroupEditAssignmentRow[];
    if (currentItems.length < 2) return notFound();
    if (currentItems.some((item) => item.status !== "withdrawn")) {
      return invalidState("只有已撤回的作业可以编辑。");
    }

    const prepared = await prepareWritingAssignmentGroupEditMutation(auth.supabase, body, {
      actor: auth.actor ?? undefined
    });
    const submittedAssignmentIds = await readSubmittedAttemptAssignmentIds(
      auth.supabase,
      currentItems.map((item) => item.assignment_id)
    );
    const currentById = new Map(currentItems.map((item) => [item.assignment_id, item]));
    const rawItems = Array.isArray(body.items)
      ? body.items.filter(isRecord)
      : [];
    const rawById = new Map(
      rawItems.map((item) => [String(item.assignmentId ?? ""), item])
    );
    const rpcItems = prepared.items.map((preparedItem) => {
      const current = currentById.get(preparedItem.assignmentId);
      if (!current) throw new Error("INVALID_GROUP_ITEMS");
      if (!submittedAssignmentIds.has(preparedItem.assignmentId)) return preparedItem;
      // Same frozen-question rule as the single edit route: the submitted item
      // must keep exactly its stored question.
      assertLockedWritingAssignmentQuestionInput(
        rawById.get(preparedItem.assignmentId) ?? {},
        current
      );
      return {
        ...preparedItem,
        taskType: current.task_type,
        questionSource: current.question_source,
        questionId: current.question_id,
        questionSnapshot: current.question_snapshot
      };
    });

    const { error: updateError } = await auth.supabase.rpc(
      "update_withdrawn_writing_assignment_group",
      {
        p_group_id: params.batchId,
        p_teacher_id: auth.teacherId,
        p_items: rpcItems.map((item) => ({
          assignment_id: item.assignmentId,
          task_type: item.taskType,
          question_source: item.questionSource,
          question_id: item.questionId,
          question_snapshot: item.questionSnapshot
        })),
        p_student_ids: prepared.studentIds,
        p_due_at: prepared.dueAt,
        p_reactivate: body.reactivate === true
      }
    );
    if (updateError) {
      const message = errorMessage(updateError);
      if (message.includes("QUESTION_LOCKED_AFTER_SUBMISSION")) {
        return invalidState("已有学生提交，题型和题目内容不能修改。");
      }
      if (message.includes("STUDENT_HAS_ATTEMPT")) {
        return invalidState("已有草稿或提交记录的学生不能移除。");
      }
      if (message.includes("ASSIGNMENT_GROUP_NOT_WITHDRAWN")) {
        return invalidState("只有已撤回的作业可以编辑或重新布置。");
      }
      if (message.includes("ASSIGNMENT_GROUP_NOT_FOUND")) return notFound();
      if (/^(请选择|请至少|请填写|请输入|所选|截止)/.test(message)) {
        return writingAssignmentJson({ code: "INVALID_ASSIGNMENT", message }, { status: 400 });
      }
      throw updateError;
    }
    return writingAssignmentJson({
      groupId: params.batchId,
      status: body.reactivate === true ? "active" : "withdrawn",
      assignmentIds: rpcItems.map((item) => item.assignmentId)
    });
  } catch (error) {
    const message = errorMessage(error);
    if (message.includes("QUESTION_LOCKED_AFTER_SUBMISSION")) {
      return invalidState("已有学生提交，题型和题目内容不能修改。");
    }
    if (message.includes("STUDENT_HAS_ATTEMPT")) {
      return invalidState("已有草稿或提交记录的学生不能移除。");
    }
    if (/^(请选择|请至少|请填写|请输入|所选|截止|一次最多)/.test(message)) {
      return writingAssignmentJson({ code: "INVALID_ASSIGNMENT", message }, { status: 400 });
    }
    console.error("[writing-assignments] group_edit_failed", error);
    return writingAssignmentJson(
      { code: "ASSIGNMENT_UPDATE_FAILED", message: "作业更新失败，请稍后重试。" },
      { status: 500 }
    );
  }
}

async function readSubmittedAttemptAssignmentIds(
  supabase: NonNullable<Awaited<ReturnType<typeof requireWritingAssignmentTeacher>>["supabase"]>,
  assignmentIds: string[]
) {
  const ids = new Set<string>();
  for (const batch of chunkValues(assignmentIds)) {
    if (!batch.length) continue;
    const { data, error } = await supabase
      .from("writing_attempts")
      .select("assignment_id")
      .in("assignment_id", batch)
      .eq("status", "submitted");
    if (error) throw error;
    for (const row of data ?? []) {
      if (row.assignment_id) ids.add(String(row.assignment_id));
    }
  }
  return ids;
}

function invalidState(message: string) {
  return writingAssignmentJson({ code: "INVALID_ASSIGNMENT_STATE", message }, { status: 409 });
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") return error.message;
  return String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unauthorized() {
  return writingAssignmentJson({ message: "无权访问教师端作业数据。" }, { status: 401 });
}

function notFound() {
  return writingAssignmentJson(
    { code: "ASSIGNMENT_NOT_FOUND", message: "未找到这项作业。" },
    { status: 404 }
  );
}

import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";
import type { WritingQuestion, WritingTaskType } from "@/lib/writing";
import {
  calculateWritingAssignmentStudentStatus,
  earliestWritingAssignmentSubmission,
  isLaterWritingAssignmentSubmission,
  type WritingAssignmentCollectionDetail,
  type WritingAssignmentLifecycleStatus,
  type WritingAssignmentQuestionSource,
  type WritingAssignmentStudentDetail
} from "@/lib/writingAssignments";
import {
  chunkValues,
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

    const [membersResult, attemptsResult] = await Promise.all([
      readAllSupabaseRows<MemberRow>((from, to) =>
        auth.supabase!
          .from("writing_assignment_students")
          .select("assignment_id,student_id,assigned_at")
          .in("assignment_id", assignmentIds)
          .order("assignment_id", { ascending: true })
          .order("student_id", { ascending: true })
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
      )
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

function unauthorized() {
  return writingAssignmentJson({ message: "无权访问教师端作业数据。" }, { status: 401 });
}

function notFound() {
  return writingAssignmentJson(
    { code: "ASSIGNMENT_NOT_FOUND", message: "未找到这项作业。" },
    { status: 404 }
  );
}

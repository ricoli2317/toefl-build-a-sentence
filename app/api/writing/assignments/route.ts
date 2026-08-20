import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { createServiceSupabase } from "@/lib/supabase/server";
import type { WritingAttempt, WritingMode, WritingQuestion, WritingTaskType } from "@/lib/writing";
import {
  calculateWritingAssignmentStudentStatus,
  compareStudentWritingAssignments,
  earliestWritingAssignmentSubmission,
  isWritingQuestionSnapshot,
  type StudentWritingAssignmentSummary,
  type WritingAssignmentLifecycleStatus,
  type WritingAssignmentQuestionSource
} from "@/lib/writingAssignments";
import { requireWritingStudent, writingJson } from "@/lib/writingServer";

export const dynamic = "force-dynamic";

type MembershipRow = {
  assignment_id: string;
  assigned_at: string;
};

type AssignmentRow = {
  assignment_id: string;
  group_id: string | null;
  group_position: number | null;
  task_type: WritingTaskType;
  question_source: WritingAssignmentQuestionSource;
  question_snapshot: WritingQuestion;
  due_at: string | null;
  status: WritingAssignmentLifecycleStatus;
  created_at: string;
};

type AttemptRow = Pick<
  WritingAttempt,
  | "assignment_id"
  | "attempt_id"
  | "created_at"
  | "status"
  | "submitted_at"
  | "updated_at"
  | "writing_mode"
>;

export async function GET(request: Request) {
  try {
    const auth = await requireWritingStudent(request);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.userId) {
      return writingJson({ error: "Unauthorized" }, { status: 401 });
    }

    const membershipResult = await readAllSupabaseRows<MembershipRow>((from, to) =>
      auth.supabase!
        .from("writing_assignment_students")
        .select("assignment_id,assigned_at")
        .eq("student_id", auth.userId!)
        .order("assigned_at", { ascending: false })
        .range(from, to)
    );
    if (membershipResult.error) {
      return writingJson({ error: "暂时无法加载我的作业。" }, { status: 500 });
    }
    const memberships = membershipResult.data ?? [];
    if (memberships.length === 0) return writingJson({ assignments: [] });

    const assignmentIds = memberships.map((membership) => membership.assignment_id);
    const [assignmentResult, attemptResult] = await Promise.all([
      readAllSupabaseRows<AssignmentRow>((from, to) =>
        auth.supabase!
          .from("writing_assignments")
          .select("assignment_id,group_id,group_position,task_type,question_source,question_snapshot,due_at,status,created_at")
          .in("assignment_id", assignmentIds)
          .eq("status", "active")
          .is("deleted_at", null)
          .order("created_at", { ascending: false })
          .range(from, to)
      ),
      readAllSupabaseRows<AttemptRow>((from, to) =>
        auth.supabase!
          .from("writing_attempts")
          .select("assignment_id,attempt_id,status,writing_mode,submitted_at,created_at,updated_at")
          .eq("user_id", auth.userId!)
          .in("assignment_id", assignmentIds)
          .order("updated_at", { ascending: false })
          .range(from, to)
      )
    ]);
    if (assignmentResult.error || attemptResult.error) {
      return writingJson({ error: "暂时无法加载我的作业。" }, { status: 500 });
    }

    const attemptsByAssignment = new Map<string, AttemptRow[]>();
    for (const attempt of attemptResult.data ?? []) {
      if (!attempt.assignment_id) continue;
      attemptsByAssignment.set(attempt.assignment_id, [
        ...(attemptsByAssignment.get(attempt.assignment_id) ?? []),
        attempt
      ]);
    }
    const submittedAttemptIds = (attemptResult.data ?? [])
      .filter((attempt) => attempt.status === "submitted")
      .map((attempt) => attempt.attempt_id);
    const publishedAttemptIds = new Set<string>();
    if (submittedAttemptIds.length > 0) {
      const service = createServiceSupabase();
      const publishedResult = await readAllSupabaseRows<{ attempt_id: string }>((from, to) =>
        service
          .from("writing_reviews")
          .select("attempt_id")
          .eq("status", "published")
          .not("published_at", "is", null)
          .in("attempt_id", submittedAttemptIds)
          .range(from, to)
      );
      if (publishedResult.error) {
        return writingJson({ error: "暂时无法加载作业批改状态。" }, { status: 500 });
      }
      for (const review of publishedResult.data ?? []) {
        publishedAttemptIds.add(review.attempt_id);
      }
    }

    const membershipByAssignment = new Map(
      memberships.map((membership) => [membership.assignment_id, membership])
    );
    const assignments: StudentWritingAssignmentSummary[] = [];
    for (const assignment of assignmentResult.data ?? []) {
      if (!isWritingQuestionSnapshot(assignment.task_type, assignment.question_snapshot)) {
        continue;
      }
      const attempts = attemptsByAssignment.get(assignment.assignment_id) ?? [];
      const draft = attempts.find((attempt) => attempt.status === "draft") ?? null;
      const submitted = attempts
        .filter((attempt) => attempt.status === "submitted")
        .sort(compareSubmittedAttempts);
      const firstSubmittedAt = earliestWritingAssignmentSubmission(
        submitted.map((attempt) => attempt.submitted_at)
      );
      const published = submitted.find((attempt) => publishedAttemptIds.has(attempt.attempt_id));
      const membership = membershipByAssignment.get(assignment.assignment_id);
      assignments.push({
        assignment_id: assignment.assignment_id,
        group_id: assignment.group_id,
        group_position: assignment.group_position,
        assigned_at: membership?.assigned_at ?? assignment.created_at,
        created_at: assignment.created_at,
        draft_attempt_id: draft?.attempt_id ?? null,
        draft_writing_mode: normalizeWritingMode(draft?.writing_mode),
        due_at: assignment.due_at,
        first_submitted_at: firstSubmittedAt,
        latest_submitted_attempt_id: submitted[0]?.attempt_id ?? null,
        published_review_attempt_id: published?.attempt_id ?? null,
        question_id: assignment.question_snapshot.question_id,
        question_snapshot: assignment.question_snapshot,
        question_source: assignment.question_source,
        status: assignment.status,
        student_status: calculateWritingAssignmentStudentStatus({
          dueAt: assignment.due_at,
          firstSubmittedAt
        }),
        submitted_attempt_count: submitted.length,
        task_type: assignment.task_type
      });
    }

    assignments.sort(compareStudentWritingAssignments);
    return writingJson({ assignments });
  } catch {
    return writingJson({ error: "暂时无法加载我的作业。" }, { status: 500 });
  }
}

function compareSubmittedAttempts(left: AttemptRow, right: AttemptRow) {
  return (
    Date.parse(right.submitted_at ?? "") - Date.parse(left.submitted_at ?? "") ||
    right.attempt_id.localeCompare(left.attempt_id)
  );
}

function normalizeWritingMode(value: WritingMode | null | undefined) {
  return value === "exam" || value === "practice" ? value : null;
}

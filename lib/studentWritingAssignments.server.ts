import { createAnonSupabase, createServiceSupabase } from "@/lib/supabase/server";
import type { WritingAttempt, WritingMode, WritingTaskType } from "@/lib/writing";
import {
  calculateWritingAssignmentStudentStatus,
  compareStudentWritingAssignments,
  earliestWritingAssignmentSubmission,
  type StudentWritingAssignmentSummary,
  type WritingAssignmentLifecycleStatus,
  type WritingAssignmentQuestionSource
} from "@/lib/writingAssignments";

export const STUDENT_ASSIGNMENT_DETAIL_SELECT = `
  assignment_id,
  assigned_at,
  writing_assignments!inner(
    assignment_id,
    group_id,
    group_position,
    task_type,
    question_source,
    question_id:question_snapshot->>question_id,
    title:question_snapshot->>set_title,
    due_at,
    status,
    created_at
  )
`;

type EmbeddedAssignmentRow = {
  assignment_id: string;
  group_id: string | null;
  group_position: number | null;
  task_type: WritingTaskType;
  question_source: WritingAssignmentQuestionSource;
  question_id: string;
  title: string;
  due_at: string | null;
  status: WritingAssignmentLifecycleStatus;
  created_at: string;
};

export type StudentAssignmentMembershipDetailRow = {
  assignment_id: string;
  assigned_at: string;
  writing_assignments: EmbeddedAssignmentRow | EmbeddedAssignmentRow[] | null;
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

export async function loadStudentAssignmentDetails(input: {
  memberships: StudentAssignmentMembershipDetailRow[];
  supabase: ReturnType<typeof createAnonSupabase>;
  userId: string;
}) {
  const rows = input.memberships.flatMap((membership) => {
    const assignment = embeddedAssignment(membership.writing_assignments);
    return assignment ? [{ assignment, membership }] : [];
  });
  if (rows.length === 0) return { assignments: [] as StudentWritingAssignmentSummary[] };

  const assignmentIds = rows.map(({ assignment }) => assignment.assignment_id);
  const attemptResult = await input.supabase
    .from("writing_attempts")
    .select("assignment_id,attempt_id,status,writing_mode,submitted_at,created_at,updated_at")
    .eq("user_id", input.userId)
    .in("assignment_id", assignmentIds)
    .order("updated_at", { ascending: false })
    .limit(5000);
  if (attemptResult.error) return { assignments: null, error: attemptResult.error };

  const attempts = (attemptResult.data ?? []) as AttemptRow[];
  const attemptsByAssignment = new Map<string, AttemptRow[]>();
  for (const attempt of attempts) {
    if (!attempt.assignment_id) continue;
    const existing = attemptsByAssignment.get(attempt.assignment_id) ?? [];
    existing.push(attempt);
    attemptsByAssignment.set(attempt.assignment_id, existing);
  }

  const submittedAttemptIds = attempts
    .filter((attempt) => attempt.status === "submitted")
    .map((attempt) => attempt.attempt_id);
  const publishedAttemptIds = new Set<string>();
  if (submittedAttemptIds.length > 0) {
    const publishedResult = await createServiceSupabase()
      .from("writing_reviews")
      .select("attempt_id")
      .eq("status", "published")
      .not("published_at", "is", null)
      .in("attempt_id", submittedAttemptIds)
      .limit(5000);
    if (publishedResult.error) {
      return { assignments: null, error: publishedResult.error };
    }
    for (const review of publishedResult.data ?? []) {
      publishedAttemptIds.add(review.attempt_id);
    }
  }

  const assignments = rows.map(({ assignment, membership }) => {
    const assignmentAttempts = attemptsByAssignment.get(assignment.assignment_id) ?? [];
    const draft = assignmentAttempts.find((attempt) => attempt.status === "draft") ?? null;
    const submitted = assignmentAttempts
      .filter((attempt) => attempt.status === "submitted")
      .sort(compareSubmittedAttempts);
    const firstSubmittedAt = earliestWritingAssignmentSubmission(
      submitted.map((attempt) => attempt.submitted_at)
    );
    const published = submitted.find((attempt) => publishedAttemptIds.has(attempt.attempt_id));
    return {
      assignment_id: assignment.assignment_id,
      group_id: assignment.group_id,
      group_position: assignment.group_position,
      assigned_at: membership.assigned_at,
      created_at: assignment.created_at,
      draft_attempt_id: draft?.attempt_id ?? null,
      draft_writing_mode: normalizeWritingMode(draft?.writing_mode),
      due_at: assignment.due_at,
      display_name: assignment.title,
      title: assignment.title,
      first_submitted_at: firstSubmittedAt,
      latest_submitted_attempt_id: submitted[0]?.attempt_id ?? null,
      published_review_attempt_id: published?.attempt_id ?? null,
      question_id: assignment.question_id,
      question_source: assignment.question_source,
      status: assignment.status,
      student_status: calculateWritingAssignmentStudentStatus({
        dueAt: assignment.due_at,
        firstSubmittedAt
      }),
      submitted_attempt_count: submitted.length,
      task_type: assignment.task_type
    } satisfies StudentWritingAssignmentSummary;
  });
  assignments.sort(compareStudentWritingAssignments);
  return { assignments };
}

export function embeddedAssignment<T>(value: T | T[] | null) {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function compareSubmittedAttempts(left: AttemptRow, right: AttemptRow) {
  return (
    Date.parse(right.submitted_at ?? "") - Date.parse(left.submitted_at ?? "")
    || right.attempt_id.localeCompare(left.attempt_id)
  );
}

function normalizeWritingMode(value: WritingMode | null | undefined) {
  return value === "exam" || value === "practice" ? value : null;
}

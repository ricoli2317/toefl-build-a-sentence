import { createServiceSupabase } from "@/lib/supabase/server";
import { loadWritingAssignmentDisplayNames } from "@/lib/historicalPracticeDisplay";
import { loadWritingAssignmentGroupTitles } from "@/lib/writingAssignmentsGroupTitles.server";
import type { StudentPerformanceTrace } from "@/lib/studentPerformance.server";
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
> & {
  writing_reviews:
    | { published_at: string | null; status: string }
    | Array<{ published_at: string | null; status: string }>
    | null;
};

export async function loadStudentAssignmentDetails(input: {
  memberships: StudentAssignmentMembershipDetailRow[];
  timing?: StudentPerformanceTrace;
  userId: string;
}) {
  const rows = input.memberships.flatMap((membership) => {
    const assignment = embeddedAssignment(membership.writing_assignments);
    return assignment ? [{ assignment, membership }] : [];
  });
  if (rows.length === 0) return { assignments: [] as StudentWritingAssignmentSummary[] };

  const assignmentIds = rows.map(({ assignment }) => assignment.assignment_id);
  const [attemptResult, displayNames, groupTitles] = await Promise.all([
    measureDatabase(input.timing, "assignment_day_attempts_and_reviews", () =>
      createServiceSupabase()
        .from("writing_attempts")
        .select(`
          assignment_id,
          attempt_id,
          status,
          writing_mode,
          submitted_at,
          created_at,
          updated_at,
          writing_reviews(status,published_at)
        `)
        .eq("user_id", input.userId)
        .in("assignment_id", assignmentIds)
        .order("updated_at", { ascending: false })
        .limit(5000)
    ),
    loadWritingAssignmentDisplayNames(
      createServiceSupabase(),
      rows.map(({ assignment }) => ({
        assignmentId: assignment.assignment_id,
        fallbackDisplayName: assignment.title?.trim() || "未命名作业",
        questionId: assignment.question_id,
        questionSource: assignment.question_source,
        taskType: assignment.task_type
      })),
      input.timing
    ),
    loadWritingAssignmentGroupTitles(
      createServiceSupabase(),
      rows.map(({ assignment }) => assignment.group_id)
    )
  ]);
  if (attemptResult.error) return { assignments: null, error: attemptResult.error };

  const attempts = (attemptResult.data ?? []) as AttemptRow[];
  const attemptsByAssignment = new Map<string, AttemptRow[]>();
  for (const attempt of attempts) {
    if (!attempt.assignment_id) continue;
    const existing = attemptsByAssignment.get(attempt.assignment_id) ?? [];
    existing.push(attempt);
    attemptsByAssignment.set(attempt.assignment_id, existing);
  }

  const publishedAttemptIds = new Set(
    attempts
      .filter((attempt) =>
        attempt.status === "submitted"
        && embeddedReviews(attempt.writing_reviews).some(
          (review) => review.status === "published" && Boolean(review.published_at)
        )
      )
      .map((attempt) => attempt.attempt_id)
  );

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
      group_title: assignment.group_id
        ? groupTitles.get(assignment.group_id) ?? null
        : null,
      assigned_at: membership.assigned_at,
      created_at: assignment.created_at,
      draft_attempt_id: draft?.attempt_id ?? null,
      draft_writing_mode: normalizeWritingMode(draft?.writing_mode),
      due_at: assignment.due_at,
      display_name: displayNames.get(assignment.assignment_id) ?? assignment.title,
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

function embeddedReviews<T>(value: T | T[] | null) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function measureDatabase<T>(
  timing: StudentPerformanceTrace | undefined,
  name: string,
  operation: () => PromiseLike<T>
): Promise<T> {
  return timing ? timing.measure("database", name, operation) : Promise.resolve(operation());
}

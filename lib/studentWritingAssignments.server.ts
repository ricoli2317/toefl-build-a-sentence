import { createServiceSupabase } from "@/lib/supabase/server";
import { loadWritingAssignmentDisplayNames } from "@/lib/historicalPracticeDisplay";
import { loadWritingAssignmentGroupTitles } from "@/lib/writingAssignmentsGroupTitles.server";
import type { StudentPerformanceTrace } from "@/lib/studentPerformance.server";
import type { WritingAttempt, WritingMode } from "@/lib/writing";
import type { AssignmentItemType } from "@/lib/assignmentCatalog";
import {
  assignmentStudentResult,
  loadAssignmentStudentResults,
  type AssignmentResultLookupItem,
  type AssignmentStudentResultMap
} from "@/lib/assignmentResults.server";
import {
  calculateWritingAssignmentStudentStatus,
  compareStudentWritingAssignments,
  earliestWritingAssignmentSubmission,
  isAssignmentDisplayNameType,
  isWritingReviewItemType,
  type StudentWritingAssignmentSummary,
  type WritingAssignmentLifecycleStatus,
  type WritingAssignmentQuestionSource
} from "@/lib/writingAssignments";

/**
 * The student Assignment detail index.
 *
 * It stays one database-bounded query for the memberships plus batched
 * hydration: writing attempts only for WE / AD, and one batched result lookup
 * for every read-only item (BAS / CTW / RDL / RAP / Full Set). No question
 * bodies, no per-item queries and no full attempt history are read here.
 */
export const STUDENT_ASSIGNMENT_DETAIL_SELECT = `
  assignment_id,
  assigned_at,
  writing_assignments!inner(
    assignment_id,
    group_id,
    group_position,
    task_type,
    question_source,
    question_id,
    snapshot_question_id:question_snapshot->>question_id,
    snapshot_item_id:question_snapshot->>item_id,
    snapshot_source_set_id:question_snapshot->>source_set_id,
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
  task_type: AssignmentItemType;
  question_source: WritingAssignmentQuestionSource;
  question_id: string | null;
  snapshot_question_id: string | null;
  snapshot_item_id: string | null;
  snapshot_source_set_id: string | null;
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
  // The read-only item lookup is one batched query per table for the whole
  // visible list; nothing is fetched per item. Every item carries the
  // membership's own assigned_at, so only attempts completed after this
  // Assignment became effective can ever satisfy it.
  const resultItems: AssignmentResultLookupItem[] = rows.flatMap(({ assignment, membership }) => {
    if (isWritingReviewItemType(assignment.task_type)) return [];
    const itemId = resolvedAssignmentItemId(assignment);
    return itemId
      ? [{
          assignmentId: assignment.assignment_id,
          // Safe fallback only: a legacy membership without assigned_at must
          // never fall back to "no boundary" (the old pollution bug). The
          // item's own created_at is a conservative lower bound.
          boundaryAt: membership.assigned_at ?? assignment.created_at,
          itemId,
          itemType: assignment.task_type,
          sourceSetId: assignment.snapshot_source_set_id,
          studentId: input.userId
        }]
      : [];
  });
  const reviewRows = rows.filter(({ assignment }) =>
    isWritingReviewItemType(assignment.task_type)
  );
  // Every item type with a logical Writing title (WE / AD banks + BAS sets)
  // resolves its Assignment display name from the current question / item;
  // reading / full-set rows keep their own persisted catalog titles.
  const displayRows = rows.filter(({ assignment }) =>
    isAssignmentDisplayNameType(assignment.task_type)
  );
  const db = createServiceSupabase();
  const [attemptResult, displayNames, groupTitles, studentResultMap] = await Promise.all([
    reviewRows.length > 0
      ? measureDatabase(input.timing, "assignment_day_attempts_and_reviews", () =>
          db
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
        )
      : Promise.resolve({ data: [] as AttemptRow[], error: null }),
    loadWritingAssignmentDisplayNames(
      db,
      displayRows.map(({ assignment }) => ({
        assignmentId: assignment.assignment_id,
        fallbackDisplayName: assignment.title?.trim() || "未命名作业",
        rawQuestionId: resolvedAssignmentItemId(assignment),
        questionSource: assignment.question_source,
        sourceSetId: assignment.snapshot_source_set_id,
        taskType: assignment.task_type as "email" | "academic_discussion" | "build_sentence"
      })),
      input.timing
    ),
    loadWritingAssignmentGroupTitles(
      db,
      rows.map(({ assignment }) => assignment.group_id)
    ),
    resultItems.length > 0
      ? measureDatabase(input.timing, "assignment_item_results", () =>
          loadAssignmentStudentResults({
            db,
            items: resultItems,
            studentIds: [input.userId]
          })
        )
      : Promise.resolve<AssignmentStudentResultMap>(new Map())
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
    const reviewType = isWritingReviewItemType(assignment.task_type);
    const itemResult = reviewType
      ? null
      : assignmentStudentResult(studentResultMap, assignment.assignment_id, input.userId);
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
      latest_result_attempt_id: itemResult?.available_result
        ? assignment.task_type === "build_sentence"
          ? itemResult.available_result.attempt_id ?? null
          : itemResult.available_result.id
        : null,
      has_started_result: Boolean(itemResult?.started),
      question_id: resolvedAssignmentItemId(assignment),
      source_set_id: assignment.snapshot_source_set_id?.trim() || null,
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

/**
 * One identity resolution for every Assignment item type. Historical Writing
 * rows keep the persisted snapshot question id (custom items included); the
 * read-only item types store their stable item id on the row itself.
 */
export function resolvedAssignmentItemId(assignment: {
  question_id: string | null;
  snapshot_question_id?: string | null;
  snapshot_item_id?: string | null;
}) {
  return assignment.question_id?.trim()
    || assignment.snapshot_question_id?.trim()
    || assignment.snapshot_item_id?.trim()
    || "";
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

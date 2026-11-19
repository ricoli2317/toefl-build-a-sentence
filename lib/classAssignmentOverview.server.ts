import type { SupabaseClient } from "@supabase/supabase-js";
import {
  assignmentItemSubject,
  type AssignmentItemType
} from "./assignmentCatalog.ts";
import {
  buildAssignmentOverview,
  type AssignmentOverview,
  type AssignmentOverviewItem,
  type AssignmentOverviewStudent
} from "./assignmentOverview.ts";
import {
  assignmentStudentResult,
  loadAssignmentStudentResults,
  type AssignmentItemGrade
} from "./assignmentResults.server.ts";
import {
  isLaterWritingAssignmentSubmission,
  isTeacherAssignmentStudentCompleted,
  isWritingReviewItemType
} from "./writingAssignments.ts";
import { loadWritingReviewSummaries } from "./writingReviewSummaries.server.ts";
import { loadStudentLatestPracticeAt } from "./assignmentOverview.server.ts";
import { readAllSupabaseRows } from "./supabasePagination.ts";
import type { StudentBindingDomain } from "./studentBindings.ts";

/**
 * Class-wide Assignment overview.
 *
 * Scope (correctness):
 *
 *   - only Assignment Groups permanently attached to THIS class and owned by
 *     the ACTING teacher;
 *   - only effective items (not deleted, not withdrawn);
 *   - only recipients that are still class members AND that the acting
 *     teacher is currently bound to for the item's subject (reading/writing);
 *   - the membership's own `assigned_at` is the time boundary, exactly like
 *     the batch detail, so an autonomous practice before the Assignment never
 *     completes it.
 *
 * Performance:
 *
 *   Groups, items, recipients, bindings, writing attempts and reviews are all
 *   read in batched ID queries. The read-only result locator then loads
 *   reading/BAS/category results in its own existing batches. No per-student,
 *   per-type or per-Assignment query is issued, and no prompt, essay or review
 *   JSON is loaded for the summary.
 */

const QUERY_BATCH_SIZE = 100;

type ClassAssignmentRow = {
  assignment_id: string;
  task_type: AssignmentItemType;
  question_id: string | null;
  source_set_id: string | null;
  created_at: string;
};

type MembershipRow = {
  assignment_id: string;
  student_id: string;
  assigned_at: string | null;
};

type WritingAttemptRow = {
  assignment_id: string;
  attempt_id: string;
  user_id: string;
  submitted_at: string | null;
};

type BindingRow = {
  student_id: string;
  domain: string;
};

export type ClassOverviewMember = {
  studentId: string;
  /** Optional so the caller can start the overview before profile names load. */
  studentName?: string;
};

export type LoadClassAssignmentOverviewInput = {
  db: SupabaseClient;
  teacherId: string;
  classId: string;
  members: ReadonlyArray<ClassOverviewMember>;
};

/** A fixed type order keeps columns stable as the class history grows. */
const CLASS_OVERVIEW_TYPE_ORDER: AssignmentItemType[] = [
  "build_sentence",
  "bas_category",
  "ctw",
  "rdl",
  "rap",
  "rap_category",
  "email",
  "academic_discussion",
  "full_set"
];

export async function loadClassAssignmentOverview(
  input: LoadClassAssignmentOverviewInput
): Promise<AssignmentOverview> {
  if (input.members.length === 0) {
    return buildAssignmentOverview(
      { assignments: [], items: [], students: [] },
      { includeSummary: false }
    );
  }
  const memberIds = input.members.map((member) => member.studentId);
  const [memberDomains, latestPracticeAtByStudent, groupIds] = await Promise.all([
    loadClassMemberBindingDomains(input.db, input.teacherId, memberIds),
    loadStudentLatestPracticeAt(input.db, memberIds),
    readClassGroupIds(input.db, input.teacherId, input.classId)
  ]);
  const members: AssignmentOverviewStudent[] = input.members.map((member) => ({
    studentId: member.studentId,
    studentName: member.studentName ?? "",
    // Latest practice is the shared, domain-agnostic summary. It is only
    // exposed when the teacher actually holds a binding to this member.
    latestPracticeAt: memberDomains.get(member.studentId)?.size
      ? latestPracticeAtByStudent.get(member.studentId) ?? null
      : null
  }));
  if (groupIds.length === 0) {
    return emptyOverview(members);
  }

  const assignments = await readEffectiveAssignments(
    input.db,
    input.teacherId,
    groupIds
  );
  if (assignments.length === 0) {
    return emptyOverview(members);
  }
  const assignmentById = new Map(
    assignments.map((assignment) => [assignment.assignment_id, assignment])
  );

  const memberships = await readAssignmentMemberships(
    input.db,
    assignments.map((assignment) => assignment.assignment_id),
    memberIds
  );
  const eligibleMemberships = memberships.filter((membership) => {
    const assignment = assignmentById.get(membership.assignment_id);
    if (!assignment) return false;
    return memberHasDomain(
      memberDomains,
      membership.student_id,
      assignmentItemSubject(assignment.task_type)
    );
  });
  if (eligibleMemberships.length === 0) {
    return emptyOverview(members);
  }

  const overviewItems = await buildOverviewItems({
    assignments,
    db: input.db,
    eligibleMemberships
  });

  // Only types that actually have an eligible recipient produce a column.
  // This avoids exposing empty columns for a subject the current teacher is
  // not bound to any member for.
  const visibleAssignmentIds = new Set(
    overviewItems.map((item) => item.assignmentId)
  );
  const visibleAssignments = assignments
    .filter((assignment) => visibleAssignmentIds.has(assignment.assignment_id))
    .sort((left, right) =>
      classOverviewTypeRank(left.task_type) - classOverviewTypeRank(right.task_type)
      || left.created_at.localeCompare(right.created_at)
      || left.assignment_id.localeCompare(right.assignment_id)
    )
    .map((assignment) => ({
      assignmentId: assignment.assignment_id,
      taskType: assignment.task_type
    }));

  return buildAssignmentOverview(
    {
      assignments: visibleAssignments,
      items: overviewItems,
      students: members
    },
    { includeSummary: true }
  );
}

function emptyOverview(members: ReadonlyArray<AssignmentOverviewStudent>) {
  return buildAssignmentOverview(
    { assignments: [], items: [], students: members },
    { includeSummary: false }
  );
}

async function buildOverviewItems(input: {
  db: SupabaseClient;
  assignments: ReadonlyArray<ClassAssignmentRow>;
  eligibleMemberships: ReadonlyArray<MembershipRow>;
}): Promise<AssignmentOverviewItem[]> {
  const assignmentById = new Map(
    input.assignments.map((assignment) => [assignment.assignment_id, assignment])
  );
  const writingKeys = new Set<string>();
  const writingAssignments: ClassAssignmentRow[] = [];
  for (const assignment of input.assignments) {
    if (!isWritingReviewItemType(assignment.task_type)) continue;
    writingAssignments.push(assignment);
    for (const membership of input.eligibleMemberships) {
      if (membership.assignment_id === assignment.assignment_id) {
        writingKeys.add(overviewKey(assignment.assignment_id, membership.student_id));
      }
    }
  }

  const writingItems = await loadWritingOverviewItems({
    assignments: writingAssignments,
    db: input.db,
    eligibleMemberships: input.eligibleMemberships,
    writingKeys
  });

  const readOnlyMemberships = input.eligibleMemberships.filter((membership) => {
    const assignment = assignmentById.get(membership.assignment_id);
    if (!assignment) return false;
    return !isWritingReviewItemType(assignment.task_type);
  });
  const readOnlyItems = await loadReadOnlyOverviewItems({
    assignments: input.assignments,
    db: input.db,
    memberships: readOnlyMemberships
  });

  return [...writingItems, ...readOnlyItems].sort((left, right) =>
    left.assignmentId.localeCompare(right.assignmentId)
    || left.studentId.localeCompare(right.studentId)
  );
}

async function loadWritingOverviewItems(input: {
  db: SupabaseClient;
  assignments: ReadonlyArray<ClassAssignmentRow>;
  eligibleMemberships: ReadonlyArray<MembershipRow>;
  writingKeys: ReadonlySet<string>;
}): Promise<AssignmentOverviewItem[]> {
  if (input.writingKeys.size === 0) return [];
  const membershipByKey = new Map(
    input.eligibleMemberships.map((membership) => [
      overviewKey(membership.assignment_id, membership.student_id),
      membership
    ])
  );
  const assignmentById = new Map(
    input.assignments.map((assignment) => [assignment.assignment_id, assignment])
  );
  const attempts = await readWritingAttempts(
    input.db,
    input.assignments.map((assignment) => assignment.assignment_id),
    Array.from(new Set(input.eligibleMemberships.map((membership) => membership.student_id)))
  );

  const latestByKey = new Map<string, WritingAttemptRow>();
  for (const attempt of attempts) {
    const key = overviewKey(attempt.assignment_id, attempt.user_id);
    if (!input.writingKeys.has(key)) continue;
    const current = latestByKey.get(key);
    if (!current || isLaterWritingAssignmentSubmission(attempt, current)) {
      latestByKey.set(key, attempt);
    }
  }

  const reviews = await loadWritingReviewSummaries(
    input.db,
    Array.from(latestByKey.values(), (attempt) => attempt.attempt_id)
  );

  const items: AssignmentOverviewItem[] = [];
  for (const [key, membership] of Array.from(membershipByKey)) {
    const assignment = assignmentById.get(membership.assignment_id);
    if (!assignment || !isWritingReviewItemType(assignment.task_type)) continue;
    const latest = latestByKey.get(key);
    const review = latest ? reviews.get(latest.attempt_id) ?? null : null;
    const publishedReview = review?.status === "published";
    items.push({
      assignmentId: assignment.assignment_id,
      completed: isTeacherAssignmentStudentCompleted({
        hasResult: false,
        itemType: assignment.task_type,
        publishedReview
      }),
      grade: null,
      studentId: membership.student_id,
      taskType: assignment.task_type,
      writingScore: publishedReview ? review?.score ?? null : null
    });
  }
  return items;
}

async function loadReadOnlyOverviewItems(input: {
  db: SupabaseClient;
  assignments: ReadonlyArray<ClassAssignmentRow>;
  memberships: ReadonlyArray<MembershipRow>;
}): Promise<AssignmentOverviewItem[]> {
  if (input.memberships.length === 0) return [];
  const assignmentById = new Map(
    input.assignments.map((assignment) => [assignment.assignment_id, assignment])
  );
  const lookupItems = input.memberships.flatMap((membership) => {
    const assignment = assignmentById.get(membership.assignment_id);
    if (!assignment || !assignment.question_id) return [];
    return [{
      assignmentId: assignment.assignment_id,
      boundaryAt: membership.assigned_at ?? assignment.created_at,
      itemId: assignment.question_id,
      itemType: assignment.task_type,
      sourceSetId: assignment.source_set_id,
      studentId: membership.student_id
    }];
  });
  const grades = new Map<string, AssignmentItemGrade>();
  const results = lookupItems.length
    ? await loadAssignmentStudentResults({
        db: input.db,
        grades,
        items: lookupItems,
        studentIds: Array.from(
          new Set(input.memberships.map((membership) => membership.student_id))
        )
      })
    : new Map();

  return input.memberships.map((membership) => {
    const assignment = assignmentById.get(membership.assignment_id);
    const taskType = assignment?.task_type ?? "ctw";
    const result = assignmentStudentResult(
      results,
      membership.assignment_id,
      membership.student_id
    );
    return {
      assignmentId: membership.assignment_id,
      completed: isTeacherAssignmentStudentCompleted({
        hasResult: Boolean(result.available_result),
        itemType: taskType,
        publishedReview: false
      }),
      grade: grades.get(overviewKey(membership.assignment_id, membership.student_id)) ?? null,
      studentId: membership.student_id,
      taskType,
      writingScore: null
    };
  });
}

async function readClassGroupIds(db: SupabaseClient, teacherId: string, classId: string) {
  const result = await readAllSupabaseRows<{ group_id: string }>((from, to) =>
    db
      .from("writing_assignment_groups")
      .select("group_id")
      .eq("class_id", classId)
      .eq("teacher_id", teacherId)
      .order("group_id", { ascending: true })
      .range(from, to)
  );
  if (result.error) throw result.error;
  return (result.data ?? []).map((row) => String(row.group_id));
}

async function readEffectiveAssignments(
  db: SupabaseClient,
  teacherId: string,
  groupIds: ReadonlyArray<string>
) {
  const assignments: ClassAssignmentRow[] = [];
  for (const batch of chunkValues(groupIds)) {
    const result = await readAllSupabaseRows<ClassAssignmentRow>((from, to) =>
      db
        .from("writing_assignments")
        .select(
          "assignment_id,task_type,question_id,source_set_id:question_snapshot->>source_set_id,created_at"
        )
        .in("group_id", batch)
        .eq("teacher_id", teacherId)
        .is("deleted_at", null)
        .neq("status", "withdrawn")
        .order("assignment_id", { ascending: true })
        .range(from, to)
    );
    if (result.error) throw result.error;
    assignments.push(...(result.data ?? []));
  }
  return assignments;
}

async function readAssignmentMemberships(
  db: SupabaseClient,
  assignmentIds: ReadonlyArray<string>,
  studentIds: ReadonlyArray<string>
) {
  const rows: MembershipRow[] = [];
  for (const assignmentBatch of chunkValues(assignmentIds)) {
    for (const studentBatch of chunkValues(studentIds)) {
      const result = await readAllSupabaseRows<MembershipRow>((from, to) =>
        db
          .from("writing_assignment_students")
          .select("assignment_id,student_id,assigned_at")
          .in("assignment_id", assignmentBatch)
          .in("student_id", studentBatch)
          .order("assignment_id", { ascending: true })
          .order("student_id", { ascending: true })
          .range(from, to)
      );
      if (result.error) throw result.error;
      rows.push(...(result.data ?? []));
    }
  }
  return rows;
}

async function readWritingAttempts(
  db: SupabaseClient,
  assignmentIds: ReadonlyArray<string>,
  studentIds: ReadonlyArray<string>
) {
  const rows: WritingAttemptRow[] = [];
  for (const assignmentBatch of chunkValues(assignmentIds)) {
    for (const studentBatch of chunkValues(studentIds)) {
      const result = await readAllSupabaseRows<WritingAttemptRow>((from, to) =>
        db
          .from("writing_attempts")
          .select("assignment_id,attempt_id,user_id,submitted_at")
          .eq("attempt_kind", "original")
          .eq("status", "submitted")
          .in("assignment_id", assignmentBatch)
          .in("user_id", studentBatch)
          .order("assignment_id", { ascending: true })
          .order("user_id", { ascending: true })
          .order("submitted_at", { ascending: true })
          .order("attempt_id", { ascending: true })
          .range(from, to)
      );
      if (result.error) throw result.error;
      rows.push(...(result.data ?? []));
    }
  }
  return rows;
}

/**
 * The current teacher's own per-student teaching domains. These are the same
 * `teacher_student_bindings` rows the teacher's student scope uses; a class
 * membership alone never grants access to another subject's learning data.
 */
export async function loadClassMemberBindingDomains(
  db: SupabaseClient,
  teacherId: string,
  studentIds: ReadonlyArray<string>
) {
  const domains = new Map<string, Set<StudentBindingDomain>>();
  for (const batch of chunkValues(studentIds)) {
    const rows: BindingRow[] = [];
    const result = await readAllSupabaseRows<BindingRow>((from, to) =>
      db
        .from("teacher_student_bindings")
        .select("student_id,domain")
        .eq("teacher_id", teacherId)
        .in("student_id", batch)
        .order("student_id", { ascending: true })
        .order("domain", { ascending: true })
        .range(from, to)
    );
    if (result.error) throw result.error;
    rows.push(...(result.data ?? []));
    for (const row of rows) {
      const studentId = String(row.student_id);
      const domain = String(row.domain);
      if (domain !== "reading" && domain !== "writing") continue;
      const set = domains.get(studentId) ?? new Set<StudentBindingDomain>();
      set.add(domain);
      domains.set(studentId, set);
    }
  }
  return domains;
}

function memberHasDomain(
  domains: ReadonlyMap<string, ReadonlySet<StudentBindingDomain>>,
  studentId: string,
  subject: StudentBindingDomain
) {
  return domains.get(studentId)?.has(subject) ?? false;
}

function classOverviewTypeRank(taskType: AssignmentItemType) {
  const index = CLASS_OVERVIEW_TYPE_ORDER.indexOf(taskType);
  return index === -1 ? CLASS_OVERVIEW_TYPE_ORDER.length : index;
}

function overviewKey(assignmentId: string, studentId: string) {
  return `${assignmentId}:${studentId}`;
}

function chunkValues<T>(values: ReadonlyArray<T>, size = QUERY_BATCH_SIZE) {
  const chunks: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

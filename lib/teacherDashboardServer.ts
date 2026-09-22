import type { SupabaseClient } from "@supabase/supabase-js";
import { isReadingModule } from "./reading/catalog.ts";
import { safeReadingItemTitle } from "./reading/history.ts";
import type { ReadingModule } from "./reading/types.ts";
import {
  aggregateTeacherDashboardReminders,
  buildTeacherDashboardActivity,
  TEACHER_DASHBOARD_ACTIVITY_LIMIT,
  TEACHER_DASHBOARD_INACTIVE_LIMIT,
  type TeacherDashboardActivity,
  type TeacherDashboardAssignmentReminderStatus,
  type TeacherDashboardInactiveStudent,
  type TeacherDashboardReadingActivityInput,
  type TeacherDashboardStudentReminder,
  type TeacherDashboardWritingActivityInput
} from "./teacherDashboard.ts";
import { loadBuildSentenceHistoricalPracticeDisplayResolver } from "./historicalPracticeDisplay.ts";
import { loadInactiveStudentsWithLastActivity } from "./teacherStudentActivity.server.ts";
import { getPreferredUserDisplayName } from "./userDisplayName.ts";

const RECENT_ACTIVITY_QUERY_LIMIT = 8;
const REMINDER_HORIZON_MS = 24 * 60 * 60 * 1000;
const REMINDER_ASSIGNMENT_SCAN_LIMIT = 30;
const DATABASE_BATCH_SIZE = 100;

type PageError = { message: string };

type ProfileRow = {
  id: string;
  email: string | null;
  full_name: string | null;
};

type WritingAttemptRow = {
  attempt_id: string;
  student_id: string;
  set_id: string;
  set_title: string | null;
  submitted_at: string | null;
};

type ReadingAttemptRow = {
  attempt_id: string;
  student_id: string;
  logical_item_id: string;
  task_type: string;
  submitted_at: string | null;
};

type ReadingItemRow = {
  logical_item_id: string;
  module: string;
  title: string | null;
};

type ReminderAssignmentRow = {
  assignment_id: string;
  due_at: string;
};

function batchesOf(values: string[]) {
  const batches: string[][] = [];
  for (let index = 0; index < values.length; index += DATABASE_BATCH_SIZE) {
    batches.push(values.slice(index, index + DATABASE_BATCH_SIZE));
  }
  return batches;
}

function unique(values: string[]) {
  return Array.from(new Set(values));
}

async function countRows(
  build: () => PromiseLike<{ count: number | null; error: PageError | null }>
) {
  const { count, error } = await build();
  if (error) throw new Error(error.message);
  return count ?? 0;
}

/**
 * Pending review count matches the Writing review list model exactly: submitted
 * attempts that are visible to the teacher and have no published review yet
 * (no review, AI draft, or teacher-saved-but-unpublished all count).
 * Every number comes from a database `count`, never from loaded attempt rows.
 */
export async function loadPendingReviewCount(
  db: SupabaseClient,
  teacherId: string,
  writingStudentIds: string[]
) {
  const ownAssignmentIds = await listOwnAssignmentIds(db, teacherId);
  const [selfSubmitted, selfPublished, assignmentSubmitted, assignmentPublished] =
    await Promise.all([
      countVisibleSubmittedAttempts(db, { studentIds: writingStudentIds }),
      countVisibleSubmittedAttempts(db, { studentIds: writingStudentIds, publishedOnly: true }),
      countVisibleSubmittedAttempts(db, { assignmentIds: ownAssignmentIds }),
      countVisibleSubmittedAttempts(db, { assignmentIds: ownAssignmentIds, publishedOnly: true })
    ]);
  return Math.max(
    0,
    selfSubmitted + assignmentSubmitted - selfPublished - assignmentPublished
  );
}

async function countVisibleSubmittedAttempts(
  db: SupabaseClient,
  scope: { assignmentIds?: string[]; publishedOnly?: boolean; studentIds?: string[] }
) {
  const ids = scope.studentIds ?? scope.assignmentIds ?? [];
  let total = 0;
  for (const batch of batchesOf(ids)) {
    total += await countRows(() => {
      let query = db
        .from("writing_attempts")
        .select(
          scope.publishedOnly
            ? "attempt_id,writing_reviews!inner(attempt_id)"
            : "attempt_id",
          { count: "exact", head: true }
        )
        .eq("status", "submitted");
      if (scope.studentIds) {
        query = query.is("assignment_id", null).in("user_id", batch);
      } else {
        query = query.in("assignment_id", batch);
      }
      if (scope.publishedOnly) {
        query = query.eq("writing_reviews.status", "published");
      }
      return query;
    });
  }
  return total;
}

async function listOwnAssignmentIds(db: SupabaseClient, teacherId: string) {
  const ids: string[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await db
      .from("writing_assignments")
      .select("assignment_id")
      .eq("teacher_id", teacherId)
      .order("assignment_id", { ascending: true })
      .range(from, from + 499);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    ids.push(...rows.map((row) => String(row.assignment_id)));
    if (rows.length < 500) break;
  }
  return ids;
}

/**
 * Assignment reminders only read what the reminder itself needs: the teacher's
 * active assignments with a deadline in the past or the next 24 hours, their
 * recipients, and the submitted/completed state of those recipients. The result
 * is aggregated to student-level reminders before it leaves the server.
 */
export async function loadTeacherAssignmentReminders(
  db: SupabaseClient,
  teacherId: string,
  now: Date,
  studentNames?: Map<string, string>
): Promise<TeacherDashboardStudentReminder[]> {
  const nowIso = now.toISOString();
  const horizonIso = new Date(now.getTime() + REMINDER_HORIZON_MS).toISOString();
  const baseQuery = () =>
    db
      .from("writing_assignments")
      .select("assignment_id,due_at")
      .eq("teacher_id", teacherId)
      .eq("status", "active")
      .is("deleted_at", null)
      .not("due_at", "is", null);

  const [overdueResult, upcomingResult] = await Promise.all([
    baseQuery().lt("due_at", nowIso).order("due_at", { ascending: false })
      .limit(REMINDER_ASSIGNMENT_SCAN_LIMIT),
    baseQuery().gte("due_at", nowIso).lte("due_at", horizonIso)
      .order("due_at", { ascending: true })
      .limit(REMINDER_ASSIGNMENT_SCAN_LIMIT)
  ]);
  if (overdueResult.error) throw new Error(overdueResult.error.message);
  if (upcomingResult.error) throw new Error(upcomingResult.error.message);

  const statusByAssignment = new Map<string, TeacherDashboardAssignmentReminderStatus>();
  const dueAtByAssignment = new Map<string, string>();
  for (const row of (overdueResult.data ?? []) as ReminderAssignmentRow[]) {
    statusByAssignment.set(String(row.assignment_id), "overdue");
    dueAtByAssignment.set(String(row.assignment_id), String(row.due_at));
  }
  for (const row of (upcomingResult.data ?? []) as ReminderAssignmentRow[]) {
    statusByAssignment.set(String(row.assignment_id), "due_soon");
    dueAtByAssignment.set(String(row.assignment_id), String(row.due_at));
  }
  const assignmentIds = Array.from(statusByAssignment.keys());
  if (assignmentIds.length === 0) return [];

  const members: Array<{ assignmentId: string; studentId: string }> = [];
  const completedKeys = new Set<string>();
  for (const batch of batchesOf(assignmentIds)) {
    const [memberResult, attemptResult] = await Promise.all([
      db
        .from("writing_assignment_students")
        .select("assignment_id,student_id")
        .in("assignment_id", batch),
      db
        .from("writing_attempts")
        .select("assignment_id,user_id")
        .eq("status", "submitted")
        .in("assignment_id", batch)
    ]);
    if (memberResult.error) throw new Error(memberResult.error.message);
    if (attemptResult.error) throw new Error(attemptResult.error.message);
    for (const row of memberResult.data ?? []) {
      members.push({
        assignmentId: String(row.assignment_id),
        studentId: String(row.student_id)
      });
    }
    for (const row of attemptResult.data ?? []) {
      completedKeys.add(`${String(row.assignment_id)}:${String(row.user_id)}`);
    }
  }

  const incomplete = members.filter(
    (member) => !completedKeys.has(`${member.assignmentId}:${member.studentId}`)
  );
  if (incomplete.length === 0) return [];
  const names = studentNames
    ?? await loadStudentNames(db, unique(incomplete.map((member) => member.studentId)));

  return aggregateTeacherDashboardReminders(
    incomplete.map((member) => ({
      assignmentId: member.assignmentId,
      studentId: member.studentId,
      dueAt: dueAtByAssignment.get(member.assignmentId) ?? "",
      status: statusByAssignment.get(member.assignmentId) ?? "due_soon"
    })),
    names
  );
}

export async function loadTeacherInactiveStudents(
  db: SupabaseClient,
  visibleStudentIds: string[],
  now: Date,
  studentNames?: Map<string, string>
): Promise<TeacherDashboardInactiveStudent[]> {
  const { inactiveStudentIds, lastActivityByStudent } =
    await loadInactiveStudentsWithLastActivity(db, visibleStudentIds, now);
  const ranked = [...inactiveStudentIds].sort((left, right) => {
    const leftActivity = lastActivityByStudent.get(left);
    const rightActivity = lastActivityByStudent.get(right);
    if (leftActivity === rightActivity) return left.localeCompare(right);
    if (!leftActivity) return -1;
    if (!rightActivity) return 1;
    return Date.parse(leftActivity) - Date.parse(rightActivity);
  });
  const selected = ranked.slice(0, TEACHER_DASHBOARD_INACTIVE_LIMIT);
  const names = studentNames ?? await loadStudentNames(db, selected);
  return selected.map((studentId) => ({
    studentId,
    studentName: names.get(studentId) ?? "学生"
  }));
}

export async function loadRecentActivity(
  db: SupabaseClient,
  scope: {
    hasReadingDomain: boolean;
    hasWritingDomain: boolean;
    readingStudentIds: string[];
    writingStudentIds: string[];
  },
  studentNames?: Map<string, string>
): Promise<TeacherDashboardActivity[]> {
  const [writingRows, readingRows] = await Promise.all([
    scope.hasWritingDomain && scope.writingStudentIds.length > 0
      ? loadRecentRows<WritingAttemptRow>(scope.writingStudentIds, (batch) =>
          db
            .from("attempts")
            .select("attempt_id,student_id,set_id,set_title,submitted_at")
            .in("student_id", batch)
            .not("submitted_at", "is", null)
            .order("submitted_at", { ascending: false })
            .order("attempt_id", { ascending: false })
            .limit(RECENT_ACTIVITY_QUERY_LIMIT) as unknown as PromiseLike<{
            data: unknown[] | null;
            error: PageError | null;
          }>
        )
      : Promise.resolve([]),
    scope.hasReadingDomain && scope.readingStudentIds.length > 0
      ? loadRecentRows<ReadingAttemptRow>(scope.readingStudentIds, (batch) =>
          db
            .from("reading_attempts")
            .select("attempt_id,student_id,logical_item_id,task_type,submitted_at")
            .eq("status", "submitted")
            .in("student_id", batch)
            .not("submitted_at", "is", null)
            .order("submitted_at", { ascending: false })
            .order("attempt_id", { ascending: false })
            .limit(RECENT_ACTIVITY_QUERY_LIMIT) as unknown as PromiseLike<{
            data: unknown[] | null;
            error: PageError | null;
          }>
        )
      : Promise.resolve([])
  ]);

  const [writing, reading] = await Promise.all([
    resolveWritingActivity(db, writingRows),
    resolveReadingActivity(db, readingRows)
  ]);
  const activity = buildTeacherDashboardActivity({
    reading,
    studentNames: new Map(),
    writing,
    limit: TEACHER_DASHBOARD_ACTIVITY_LIMIT
  });
  const names = studentNames
    ?? await loadStudentNames(db, unique(activity.map((entry) => entry.studentId)));
  return activity.map((entry) => ({
    ...entry,
    studentName: names.get(entry.studentId) ?? "学生"
  }));
}

async function loadRecentRows<T>(
  studentIds: string[],
  build: (
    batch: string[]
  ) => PromiseLike<{ data: unknown[] | null; error: PageError | null }>
) {
  const rows: T[] = [];
  for (const batch of batchesOf(studentIds)) {
    const { data, error } = await build(batch);
    if (error) throw new Error(error.message);
    rows.push(...((data ?? []) as T[]));
  }
  return rows;
}

async function resolveWritingActivity(
  db: SupabaseClient,
  rows: WritingAttemptRow[]
): Promise<TeacherDashboardWritingActivityInput[]> {
  const setIds = unique(rows.map((row) => String(row.set_id)));
  const resolver = await loadBuildSentenceHistoricalPracticeDisplayResolver(db, setIds);
  return rows
    .filter((row): row is WritingAttemptRow & { submitted_at: string } => Boolean(row.submitted_at))
    .map((row) => ({
      attemptId: String(row.attempt_id),
      studentId: String(row.student_id),
      title: resolver.resolveBuildSentence({
        fallbackDisplayName: row.set_title?.trim() || String(row.set_id),
        rawSetId: String(row.set_id)
      }).displayName,
      submittedAt: row.submitted_at
    }));
}

async function resolveReadingActivity(
  db: SupabaseClient,
  rows: ReadingAttemptRow[]
): Promise<TeacherDashboardReadingActivityInput[]> {
  const itemIds = unique(rows.map((row) => String(row.logical_item_id)));
  const itemById = new Map<string, ReadingItemRow>();
  if (itemIds.length > 0) {
    for (const batch of batchesOf(itemIds)) {
      const { data, error } = await db
        .from("reading_logical_items")
        .select("logical_item_id,module,title")
        .in("logical_item_id", batch);
      if (error) throw new Error(error.message);
      for (const item of (data ?? []) as ReadingItemRow[]) {
        itemById.set(String(item.logical_item_id), item);
      }
    }
  }

  const activities: TeacherDashboardReadingActivityInput[] = [];
  for (const row of rows) {
    if (!row.submitted_at || !isReadingModule(row.task_type)) continue;
    const taskType = row.task_type as ReadingModule;
    const item = itemById.get(String(row.logical_item_id));
    activities.push({
      attemptId: String(row.attempt_id),
      studentId: String(row.student_id),
      taskType,
      itemTitle: safeReadingItemTitle(taskType, item?.title),
      submittedAt: row.submitted_at
    });
  }
  return activities;
}

export async function loadStudentNames(db: SupabaseClient, studentIds: string[]) {
  const names = new Map<string, string>();
  for (const batch of batchesOf(studentIds)) {
    const { data, error } = await db
      .from("profiles")
      .select("id,email,full_name")
      .in("id", batch);
    if (error) throw new Error(error.message);
    for (const profile of (data ?? []) as ProfileRow[]) {
      names.set(
        String(profile.id),
        getPreferredUserDisplayName({
          email: profile.email,
          profileFullName: profile.full_name
        })
      );
    }
  }
  return names;
}

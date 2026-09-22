import type { ReadingModule } from "./reading/types.ts";
import type { StudentBindingDomain } from "./studentBindings.ts";

export type TeacherDashboardAssignmentReminderStatus = "overdue" | "due_soon";

/**
 * Student-level reminder shown on the teacher home. The homepage is never an
 * assignment list: each student gets at most one overdue reminder (their most
 * recently missed deadline) and at most one upcoming reminder (their nearest
 * deadline inside the 24h horizon). No assignment, question, or count is
 * exposed.
 */
export type TeacherDashboardStudentReminder = {
  studentId: string;
  studentName: string;
  dueAt: string;
  status: TeacherDashboardAssignmentReminderStatus;
};

/** Assignment-level row used only while aggregating student reminders. */
export type TeacherDashboardAssignmentReminder = {
  assignmentId: string;
  studentId: string;
  dueAt: string;
  status: TeacherDashboardAssignmentReminderStatus;
};

export type TeacherDashboardInactiveStudent = {
  studentId: string;
  studentName: string;
};

export type TeacherDashboardActivity = {
  activityId: string;
  domain: StudentBindingDomain;
  domainLabel: "Reading" | "Writing";
  taskLabel: string;
  title: string;
  studentId: string;
  studentName: string;
  submittedAt: string;
};

export type TeacherDashboardPayload = {
  teacherDomains: StudentBindingDomain[];
  studentCount: number;
  pendingReviewCount: number;
  assignmentReminders: TeacherDashboardStudentReminder[];
  inactiveStudents: TeacherDashboardInactiveStudent[];
  recentActivity: TeacherDashboardActivity[];
};

export type TeacherDashboardWritingActivityInput = {
  attemptId: string;
  studentId: string;
  title: string;
  submittedAt: string;
};

export type TeacherDashboardReadingActivityInput = {
  attemptId: string;
  studentId: string;
  taskType: ReadingModule;
  itemTitle: string;
  submittedAt: string;
};

export const TEACHER_DASHBOARD_ACTIVITY_LIMIT = 6;
export const TEACHER_DASHBOARD_REMINDER_LIMIT = 6;
export const TEACHER_DASHBOARD_INACTIVE_LIMIT = 10;

const READING_TASK_LABELS: Record<ReadingModule, string> = {
  ctw: "CTW",
  rdl: "RDL",
  rap: "RAP"
};

/**
 * Merges Reading and Writing activity into one newest-first list. Each entry
 * keeps its domain label so the homepage never mixes the two teaching domains.
 */
export function buildTeacherDashboardActivity(input: {
  writing: TeacherDashboardWritingActivityInput[];
  reading: TeacherDashboardReadingActivityInput[];
  studentNames: Map<string, string>;
  limit?: number;
}) {
  const limited = input.limit ?? TEACHER_DASHBOARD_ACTIVITY_LIMIT;
  const writing = input.writing.map((attempt): TeacherDashboardActivity => ({
    activityId: attempt.attemptId,
    domain: "writing",
    domainLabel: "Writing",
    taskLabel: "BAS",
    title: attempt.title,
    studentId: attempt.studentId,
    studentName: input.studentNames.get(attempt.studentId) ?? "学生",
    submittedAt: attempt.submittedAt
  }));
  const reading = input.reading.map((attempt): TeacherDashboardActivity => ({
    activityId: attempt.attemptId,
    domain: "reading",
    domainLabel: "Reading",
    taskLabel: READING_TASK_LABELS[attempt.taskType],
    title: attempt.itemTitle,
    studentId: attempt.studentId,
    studentName: input.studentNames.get(attempt.studentId) ?? "学生",
    submittedAt: attempt.submittedAt
  }));

  return [...writing, ...reading]
    .sort((left, right) =>
      activityTimestamp(right.submittedAt) - activityTimestamp(left.submittedAt)
      || left.activityId.localeCompare(right.activityId)
    )
    .slice(0, Math.max(0, limited));
}

/**
 * Homepage reminder priority: overdue work first (most recently missed first),
 * then work due within the next 24 hours (soonest first).
 *
 * The homepage is student-level, so the same student can never produce two
 * reminders with the same status: overdue keeps the student's most recent
 * missed deadline, due_soon keeps their nearest deadline inside the horizon.
 * The list is capped so reminders can never stretch the homepage without limit.
 */
export function sortTeacherDashboardReminders(
  reminders: TeacherDashboardAssignmentReminder[],
  limit = TEACHER_DASHBOARD_REMINDER_LIMIT
) {
  const selected = new Map<string, TeacherDashboardAssignmentReminder>();
  for (const reminder of reminders) {
    const key = `${reminder.studentId}:${reminder.status}`;
    const current = selected.get(key);
    if (!current || isMoreRelevantReminder(reminder, current)) {
      selected.set(key, reminder);
    }
  }

  return Array.from(selected.values())
    .sort((left, right) => {
      if (left.status !== right.status) return left.status === "overdue" ? -1 : 1;
      const leftDue = activityTimestamp(left.dueAt);
      const rightDue = activityTimestamp(right.dueAt);
      return left.status === "overdue" ? rightDue - leftDue : leftDue - rightDue
        || left.assignmentId.localeCompare(right.assignmentId)
        || left.studentId.localeCompare(right.studentId);
    })
    .slice(0, Math.max(0, limit));
}

/**
 * Student-level reminders for the homepage payload. Assignment identity is
 * deliberately dropped here; the client only renders the student, the chosen
 * deadline, and the status.
 */
export function aggregateTeacherDashboardReminders(
  reminders: TeacherDashboardAssignmentReminder[],
  studentNames: Map<string, string>,
  limit = TEACHER_DASHBOARD_REMINDER_LIMIT
): TeacherDashboardStudentReminder[] {
  return sortTeacherDashboardReminders(reminders, limit).map((reminder) => ({
    studentId: reminder.studentId,
    studentName: studentNames.get(reminder.studentId) ?? "学生",
    dueAt: reminder.dueAt,
    status: reminder.status
  }));
}

function isMoreRelevantReminder(
  candidate: TeacherDashboardAssignmentReminder,
  current: TeacherDashboardAssignmentReminder
) {
  const candidateDue = activityTimestamp(candidate.dueAt);
  const currentDue = activityTimestamp(current.dueAt);
  if (candidateDue !== currentDue) {
    return candidate.status === "overdue"
      ? candidateDue > currentDue
      : candidateDue < currentDue;
  }
  return candidate.assignmentId.localeCompare(current.assignmentId) < 0;
}

function activityTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

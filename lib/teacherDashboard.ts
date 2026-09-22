import type { ReadingModule } from "./reading/types.ts";
import type { StudentBindingDomain } from "./studentBindings.ts";

export type TeacherDashboardWritingOverview = {
  setCount: number;
  questionCount: number;
  todayAttemptCount: number;
};

export type TeacherDashboardReadingOverview = {
  completedAttemptCount: number;
  todayAttemptCount: number;
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
  writing: TeacherDashboardWritingOverview | null;
  reading: TeacherDashboardReadingOverview | null;
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
  const limited = input.limit ?? 4;
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

function activityTimestamp(value: string) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

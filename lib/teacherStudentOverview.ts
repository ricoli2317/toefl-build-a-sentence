import { STUDENT_BINDING_DOMAINS, type StudentBindingDomain } from "./studentBindings.ts";

/**
 * Student-level practice summary that is shared across every teacher who can
 * see the student. The summary is deliberately domain-agnostic: a Reading
 * teacher and a Writing teacher of the same student receive identical aggregate
 * numbers, while never receiving attempt, task, or review details.
 */
export type TeacherStudentOverviewEntry = {
  studentId: string;
  studentDisplayName: string;
  studentEmail: string;
  domains: StudentBindingDomain[];
  totalPracticeSeconds: number;
  latestPracticeAt: string | null;
  /**
   * The student's single pending forgot-password request, when one exists and
   * the viewing teacher is bound to the student. Null/undefined hides the
   * approval prompt entirely.
   */
  passwordResetRequestId?: string | null;
};

export type TeacherStudentOverviewCandidate = {
  studentId: string;
  studentDisplayName: string;
  studentEmail: string;
  domains: StudentBindingDomain[];
};

export type TeacherStudentPracticeSummary = {
  totalPracticeSeconds: number;
  latestPracticeAt: string | null;
};

export type TeacherStudentPracticeSource =
  | "reading"
  | "reading-wrongbook"
  | "reading-full-set"
  | "build-sentence"
  | "writing";

/**
 * One row per real practice record. `durationSeconds` must come from a stored
 * duration column; timestamps are never subtracted to estimate time. Full Set
 * attempts have no persisted duration and only contribute their canonical
 * completion timestamp.
 */
export type TeacherStudentPracticeRow = {
  studentId: string;
  source: TeacherStudentPracticeSource;
  durationSeconds: number | null;
  completedAt: string | null;
};

/**
 * One persisted `student_practice_summary` row. The teacher student list reads
 * these directly instead of scanning practice history.
 */
export type TeacherStudentPracticeSummaryRow = {
  studentId: string;
  totalPracticeSeconds: number | null;
  latestPracticeAt: string | null;
};

export function buildTeacherStudentOverview(input: {
  students: TeacherStudentOverviewCandidate[];
  practiceRows: TeacherStudentPracticeRow[];
}): TeacherStudentOverviewEntry[] {
  const summaries = aggregateTeacherStudentPracticeSummaries(input.practiceRows);
  return input.students.map((student) => toOverviewEntry(student, summaries.get(student.studentId)));
}

export function buildTeacherStudentOverviewFromSummaries(input: {
  students: TeacherStudentOverviewCandidate[];
  summaries: TeacherStudentPracticeSummaryRow[];
}): TeacherStudentOverviewEntry[] {
  const summaryByStudentId = new Map<string, TeacherStudentPracticeSummary>();
  for (const row of input.summaries) {
    const studentId = typeof row.studentId === "string" ? row.studentId.trim() : "";
    if (!studentId) continue;
    summaryByStudentId.set(studentId, {
      totalPracticeSeconds: practiceDurationSeconds(row.totalPracticeSeconds),
      latestPracticeAt: canonicalCompletedAt(row.latestPracticeAt)
    });
  }
  return input.students.map((student) =>
    toOverviewEntry(student, summaryByStudentId.get(student.studentId))
  );
}

function toOverviewEntry(
  student: TeacherStudentOverviewCandidate,
  summary: TeacherStudentPracticeSummary | undefined
): TeacherStudentOverviewEntry {
  return {
    studentId: student.studentId,
    studentDisplayName: student.studentDisplayName,
    studentEmail: student.studentEmail,
    domains: STUDENT_BINDING_DOMAINS.filter((domain) => student.domains.includes(domain)),
    totalPracticeSeconds: summary?.totalPracticeSeconds ?? 0,
    latestPracticeAt: summary?.latestPracticeAt ?? null
  };
}

export function aggregateTeacherStudentPracticeSummaries(
  rows: TeacherStudentPracticeRow[]
): Map<string, TeacherStudentPracticeSummary> {
  const summaries = new Map<string, TeacherStudentPracticeSummary>();
  for (const row of rows) {
    const studentId = typeof row.studentId === "string" ? row.studentId.trim() : "";
    if (!studentId) continue;
    const summary = summaries.get(studentId) ?? {
      latestPracticeAt: null,
      totalPracticeSeconds: 0
    };
    summary.totalPracticeSeconds += practiceDurationSeconds(row.durationSeconds);
    const completedAt = canonicalCompletedAt(row.completedAt);
    if (
      completedAt
      && (summary.latestPracticeAt === null
        || Date.parse(completedAt) > Date.parse(summary.latestPracticeAt))
    ) {
      summary.latestPracticeAt = completedAt;
    }
    summaries.set(studentId, summary);
  }
  return summaries;
}

/**
 * UI formatter for the shared practice total: no record shows a dash, real
 * practice under a minute shows "<1分钟", and bare seconds are never shown.
 */
export function formatPracticeDuration(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "—";
  const seconds = Math.max(0, Math.round(value));
  if (seconds < 60) return "<1分钟";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder > 0 ? `${hours}小时${remainder}分钟` : `${hours}小时`;
}

/**
 * UI formatter for the shared latest-practice timestamp: no record shows a
 * dash and no task type, title, or score is ever appended.
 */
export function formatLatestPracticeAt(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  const now = new Date();
  const dateLabel = date.getFullYear() === now.getFullYear()
    ? `${date.getMonth() + 1}月${date.getDate()}日`
    : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
  const timeLabel = date.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    hour12: false,
    minute: "2-digit"
  });
  return `${dateLabel} ${timeLabel}`;
}

function practiceDurationSeconds(value: number | null): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.round(value));
}

function canonicalCompletedAt(value: string | null): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

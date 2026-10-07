import type {
  TeacherBasTaskSummary,
  TeacherReadingTaskSummary,
  TeacherWritingScoreTaskSummary
} from "./teacherStudentPractice.ts";
import type { ReadingModule } from "./reading/types.ts";
import type { CategoryHistoryRow } from "./reading/questionCategory.ts";

/**
 * Lightweight range statistics for the teacher student detail page.
 *
 * It reuses the single-day statistics rules (the seven cards) but only carries
 * the numbers needed to render them: no practice records, titles, answers or
 * Full Set content ever travel through this payload. Per-day counters feed the
 * ten-category date list.
 */

export const TEACHER_PRACTICE_RANGE_DAY_COUNT_KEYS = [
  "ctw",
  "rdl",
  "rap",
  "build_sentence",
  "email",
  "academic_discussion",
  "full_set",
  "wrongbook_entry",
  "wrongbook_today",
  "wrongbook_history"
] as const;

export type TeacherPracticeRangeDayCountKey =
  (typeof TEACHER_PRACTICE_RANGE_DAY_COUNT_KEYS)[number];

export type TeacherPracticeRangeDayCounts = Record<TeacherPracticeRangeDayCountKey, number>;

export const TEACHER_PRACTICE_RANGE_DAY_COUNT_LABELS: Record<
  TeacherPracticeRangeDayCountKey,
  string
> = {
  ctw: "CTW",
  rdl: "RDL",
  rap: "RAP",
  build_sentence: "BAS",
  email: "WE",
  academic_discussion: "AD",
  full_set: "Full Set",
  wrongbook_entry: "Entry 订正",
  wrongbook_today: "今日错题",
  wrongbook_history: "历史错题"
};

export type TeacherPracticeRangeDay = {
  /** Calendar date in the requested timezone (YYYY-MM-DD). */
  date: string;
  counts: TeacherPracticeRangeDayCounts;
};

export type TeacherStudentPracticeRangeReading = {
  tasks: Record<ReadingModule, TeacherReadingTaskSummary>;
  fullSet: TeacherReadingTaskSummary;
};

export type TeacherStudentPracticeRangeWriting = {
  tasks: {
    build_sentence: TeacherBasTaskSummary;
    email: TeacherWritingScoreTaskSummary;
    academic_discussion: TeacherWritingScoreTaskSummary;
  };
};

export type TeacherStudentPracticeRangeStats = {
  reading: TeacherStudentPracticeRangeReading | null;
  writing: TeacherStudentPracticeRangeWriting | null;
  days: TeacherPracticeRangeDay[];
};

/** One API response: student/range context plus the two statistics blocks. */
export type TeacherStudentPracticeRangePayload = TeacherStudentPracticeRangeStats & {
  student: {
    studentId: string;
    displayName: string;
    account: string;
    domains: Array<"reading" | "writing">;
  };
  range: {
    startAt: string;
    endAt: string;
    timeZone: string;
  };
};

export type TeacherRangeReadingAttemptRow = {
  task_type: ReadingModule;
  status?: string | null;
  correct_points: number | null;
  total_points: number | null;
  submitted_at: string | null;
};

export type TeacherRangeWrongbookAttemptRow = {
  attempt_id: string;
  task_type?: string | null;
  scope?: string | null;
  status?: string | null;
  submitted_at: string | null;
};

export type TeacherRangeWrongbookSessionRow = {
  session_id: string;
  task_type?: string | null;
  mode: "history" | "today" | string;
  status?: string | null;
  completed_at: string | null;
  progress: Record<string, { attemptId?: string | null } | null> | null;
};

export type TeacherRangeFullSetAttemptRow = {
  attempt_id: string;
  completed_at: string | null;
};

export type TeacherRangeFullSetModuleRow = {
  attempt_id: string;
  module_attempt_id: string;
  correct_points: number | null;
  total_points: number | null;
};

export type TeacherRangeBasAttemptRow = {
  set_id: string;
  set_title: string | null;
  correct_count: number | null;
  total_questions: number | null;
  submitted_at: string | null;
};

export type TeacherRangeWritingAttemptRow = {
  attempt_id: string;
  task_type: "email" | "academic_discussion";
  submitted_at: string | null;
};

export type TeacherPracticeRangeReadingInput = {
  categorySessions?: CategoryHistoryRow[];
  attempts: TeacherRangeReadingAttemptRow[];
  wrongbookAttempts: TeacherRangeWrongbookAttemptRow[];
  sessions: TeacherRangeWrongbookSessionRow[];
  fullSetAttempts: TeacherRangeFullSetAttemptRow[];
  fullSetModules: TeacherRangeFullSetModuleRow[];
};

export type TeacherPracticeRangeWritingInput = {
  basAttempts: TeacherRangeBasAttemptRow[];
  writingAttempts: TeacherRangeWritingAttemptRow[];
  reviewScores?: Map<string, number>;
};

const DEFAULT_TIME_ZONE = "Asia/Shanghai";
const validTimeZoneCache = new Map<string, boolean>();

export function normalizePracticeTimeZone(value: string | null | undefined) {
  const candidate = (value ?? "").trim();
  if (!candidate) return DEFAULT_TIME_ZONE;
  return isSupportedTimeZone(candidate) ? candidate : DEFAULT_TIME_ZONE;
}

function isSupportedTimeZone(timeZone: string) {
  const cached = validTimeZoneCache.get(timeZone);
  if (cached !== undefined) return cached;
  let valid = true;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone }).format(new Date(0));
  } catch {
    valid = false;
  }
  validTimeZoneCache.set(timeZone, valid);
  return valid;
}

/**
 * Calendar day of one instant in the requested timezone. The client sends the
 * same browser timezone it used to build the range boundaries, so per-day
 * buckets always agree with the selected day range.
 */
export function practiceRangeDateKey(
  value: string | Date | null | undefined,
  timeZone: string
) {
  if (value === null || value === undefined) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const zone = normalizePracticeTimeZone(timeZone);
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    month: "2-digit",
    timeZone: zone,
    year: "numeric"
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  const key = `${part("year")}-${part("month")}-${part("day")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : "";
}

export function buildTeacherStudentPracticeRange(input: {
  reading?: TeacherPracticeRangeReadingInput | null;
  writing?: TeacherPracticeRangeWritingInput | null;
  timeZone: string;
  /** Defaults to true; the student practice history passes false so Entry /
   *  今日错题 / 历史错题 counters never enter its per-day list. */
  includeWrongbook?: boolean;
  /** Defaults to true; the student practice history passes false so
   *  `wrongbook-*` / legacy `grammar-*` BAS rows are not counted at all. */
  includeVirtualBas?: boolean;
  /** Range boundaries (exclusive end); sessions completed outside it are only
   * used for attempt ownership, never counted as a range day. */
  startAt?: string;
  endAt?: string;
}): TeacherStudentPracticeRangeStats {
  const dayCounts = new Map<string, TeacherPracticeRangeDayCounts>();
  const addCount = (
    submittedAt: string,
    key: TeacherPracticeRangeDayCountKey,
    amount = 1
  ) => {
    const date = practiceRangeDateKey(submittedAt, input.timeZone);
    if (!date) return;
    const counts = dayCounts.get(date) ?? emptyDayCounts();
    counts[key] += amount;
    dayCounts.set(date, counts);
  };

  const reading = input.reading
    ? buildReadingRange(
        input.reading,
        addCount,
        {
          endAt: input.endAt ? Date.parse(input.endAt) : null,
          startAt: input.startAt ? Date.parse(input.startAt) : null
        },
        input.includeWrongbook !== false
      )
    : null;
  const writing = input.writing
    ? buildWritingRange(input.writing, addCount, input.includeVirtualBas !== false)
    : null;

  const days = Array.from(dayCounts.entries())
    .filter(([, counts]) =>
      TEACHER_PRACTICE_RANGE_DAY_COUNT_KEYS.some((key) => counts[key] > 0))
    .map(([date, counts]) => ({ date, counts }))
    .sort((left, right) => right.date.localeCompare(left.date));

  return { reading, writing, days };
}

function buildReadingRange(
  reading: TeacherPracticeRangeReadingInput,
  addCount: (submittedAt: string, key: TeacherPracticeRangeDayCountKey, amount?: number) => void,
  bounds: { startAt: number | null; endAt: number | null },
  includeWrongbook: boolean
): TeacherStudentPracticeRangeReading {
  const tasks: Record<ReadingModule, TeacherReadingTaskSummary> = {
    ctw: emptyReadingTask(),
    rdl: emptyReadingTask(),
    rap: emptyReadingTask()
  };
  const fullSet = emptyReadingTask();

  for (const attempt of reading.attempts) {
    const submittedAt = validSubmittedAt(attempt.submitted_at);
    if (attempt.status !== "submitted" || !submittedAt) continue;
    const totalPoints = nonNegativeInteger(attempt.total_points);
    const correctPoints = Math.min(totalPoints, nonNegativeInteger(attempt.correct_points));
    accumulateReadingTask(tasks[attempt.task_type], correctPoints, totalPoints);
    addCount(submittedAt, attempt.task_type);
  }

  for (const session of reading.categorySessions ?? []) {
    const completedAt = validSubmittedAt(session.completed_at);
    if (session.status !== "completed" || !completedAt) continue;
    const completed = Date.parse(completedAt);
    if (bounds.startAt !== null && completed < bounds.startAt || bounds.endAt !== null && completed >= bounds.endAt) continue;
    const total = nonNegativeInteger(session.total_points);
    accumulateReadingTask(tasks.rap, Math.min(total, nonNegativeInteger(session.correct_points)), total);
    addCount(completedAt, "rap");
  }

  if (includeWrongbook) {
    // Any session (active or completed) owns its attempts: those attempts never
    // double count as independent Entry corrections.
    const sessionAttemptIds = new Set<string>();
    for (const session of reading.sessions) {
      for (const entry of Object.values(session.progress ?? {})) {
        const attemptId = entry?.attemptId ? String(entry.attemptId) : "";
        if (attemptId) sessionAttemptIds.add(attemptId);
      }
    }
    for (const attempt of reading.wrongbookAttempts) {
      const submittedAt = validSubmittedAt(attempt.submitted_at);
      if (attempt.status !== "submitted" || !submittedAt) continue;
      if (sessionAttemptIds.has(String(attempt.attempt_id))) continue;
      addCount(submittedAt, "wrongbook_entry");
    }
    // A frozen session counts once, at the moment it completed. Sessions
    // outside the requested range stay in the list above only to own their
    // attempts.
    for (const session of reading.sessions) {
      if (session.status !== "completed") continue;
      const completedAt = validSubmittedAt(session.completed_at);
      if (!completedAt) continue;
      const completedAtMs = Date.parse(completedAt);
      if (bounds.startAt !== null && completedAtMs < bounds.startAt) continue;
      if (bounds.endAt !== null && completedAtMs >= bounds.endAt) continue;
      addCount(
        completedAt,
        session.mode === "today" ? "wrongbook_today" : "wrongbook_history"
      );
    }
  }

  const modulesByAttempt = groupBy(
    reading.fullSetModules,
    (module) => String(module.attempt_id)
  );
  for (const attempt of reading.fullSetAttempts) {
    const completedAt = validSubmittedAt(attempt.completed_at);
    if (!completedAt) continue;
    const modules = modulesByAttempt.get(String(attempt.attempt_id)) ?? [];
    // Same completion definition as the single-day card: exactly two submitted
    // modules. The stored module points are the Full Set's own grading result.
    if (modules.length !== 2) continue;
    let correctPoints = 0;
    let totalPoints = 0;
    for (const moduleRow of modules) {
      const total = nonNegativeInteger(moduleRow.total_points);
      correctPoints += Math.min(total, nonNegativeInteger(moduleRow.correct_points));
      totalPoints += total;
    }
    fullSet.attempts += 1;
    fullSet.correctPoints += correctPoints;
    fullSet.totalPoints += totalPoints;
    fullSet.accuracy = ratio(fullSet.correctPoints, fullSet.totalPoints);
    addCount(completedAt, "full_set");
  }

  return { tasks, fullSet };
}

function buildWritingRange(
  writing: TeacherPracticeRangeWritingInput,
  addCount: (submittedAt: string, key: TeacherPracticeRangeDayCountKey, amount?: number) => void,
  includeVirtualBas: boolean
): TeacherStudentPracticeRangeWriting {
  const tasks: TeacherStudentPracticeRangeWriting["tasks"] = {
    build_sentence: { attempts: 0, correctCount: 0, totalQuestions: 0, accuracy: 0 },
    email: { attempts: 0, scoredAttempts: 0, averageScore: null },
    academic_discussion: { attempts: 0, scoredAttempts: 0, averageScore: null }
  };
  let emailScoreTotal = 0;
  let discussionScoreTotal = 0;

  for (const attempt of writing.basAttempts) {
    const submittedAt = validSubmittedAt(attempt.submitted_at);
    if (!submittedAt) continue;
    const category = basAttemptCategory(attempt.set_id, attempt.set_title);
    if (category !== "practice") {
      if (includeVirtualBas) {
        addCount(
          submittedAt,
          category === "today"
            ? "wrongbook_today"
            : category === "history"
              ? "wrongbook_history"
              : "wrongbook_entry"
        );
      }
      continue;
    }
    const totalQuestions = nonNegativeInteger(attempt.total_questions);
    const correctCount = Math.min(totalQuestions, nonNegativeInteger(attempt.correct_count));
    tasks.build_sentence.attempts += 1;
    tasks.build_sentence.correctCount += correctCount;
    tasks.build_sentence.totalQuestions += totalQuestions;
    addCount(submittedAt, "build_sentence");
  }

  for (const attempt of writing.writingAttempts) {
    const submittedAt = validSubmittedAt(attempt.submitted_at);
    if (!submittedAt) continue;
    const taskType = attempt.task_type;
    const score = writing.reviewScores?.get(String(attempt.attempt_id));
    const hasScore = Number.isFinite(score) && (score as number) >= 0 && (score as number) <= 5;
    tasks[taskType].attempts += 1;
    if (hasScore) {
      tasks[taskType].scoredAttempts += 1;
      if (taskType === "email") emailScoreTotal += score as number;
      else discussionScoreTotal += score as number;
    }
    addCount(submittedAt, taskType);
  }

  tasks.build_sentence.accuracy = ratio(
    tasks.build_sentence.correctCount,
    tasks.build_sentence.totalQuestions
  );
  tasks.email.averageScore = tasks.email.scoredAttempts
    ? emailScoreTotal / tasks.email.scoredAttempts
    : null;
  tasks.academic_discussion.averageScore = tasks.academic_discussion.scoredAttempts
    ? discussionScoreTotal / tasks.academic_discussion.scoredAttempts
    : null;

  return { tasks };
}

/**
 * BAS wrong-question attempts reuse one virtual `wrongbook-` id space for both
 * session practice and entry corrections, so the stored display title is the
 * reliable discriminator: session practice stores 今日错题订正 / 历史错题练习,
 * entry corrections store 错题订正 / 历史错题订正. Rows without a recognized
 * title (legacy data) keep the existing teacher-side classification by id.
 */
export function basAttemptCategory(
  setId: string,
  setTitle: string | null
): "practice" | "entry" | "today" | "history" {
  const normalizedId = setId.trim().toLocaleLowerCase();
  if (!normalizedId.startsWith("wrongbook-")) return "practice";
  const title = (setTitle ?? "").trim();
  if (title === "今日错题订正") return "today";
  if (title === "历史错题练习") return "history";
  if (title === "错题订正" || title === "历史错题订正") return "entry";
  if (normalizedId.startsWith("wrongbook-today-")) return "today";
  if (normalizedId.startsWith("wrongbook-all-") || normalizedId.startsWith("wrongbook-random-")) {
    return "history";
  }
  return "entry";
}

export function emptyPracticeRangeDayCounts(): TeacherPracticeRangeDayCounts {
  return {
    ctw: 0,
    rdl: 0,
    rap: 0,
    build_sentence: 0,
    email: 0,
    academic_discussion: 0,
    full_set: 0,
    wrongbook_entry: 0,
    wrongbook_today: 0,
    wrongbook_history: 0
  };
}

function emptyDayCounts() {
  return emptyPracticeRangeDayCounts();
}

function emptyReadingTask(): TeacherReadingTaskSummary {
  return { attempts: 0, correctPoints: 0, totalPoints: 0, accuracy: 0 };
}

function accumulateReadingTask(
  task: TeacherReadingTaskSummary,
  correctPoints: number,
  totalPoints: number
) {
  task.attempts += 1;
  task.correctPoints += correctPoints;
  task.totalPoints += totalPoints;
  task.accuracy = ratio(task.correctPoints, task.totalPoints);
}

function groupBy<T>(items: T[], getKey: (item: T) => string) {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = getKey(item);
    groups.set(key, [...(groups.get(key) ?? []), item]);
  }
  return groups;
}

function validSubmittedAt(value: string | null | undefined) {
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}

function nonNegativeInteger(value: number | null | undefined) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value as number)) : 0;
}

function ratio(correct: number, total: number) {
  return total > 0 ? correct / total : 0;
}

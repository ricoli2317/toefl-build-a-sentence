import type { HistoricalPracticeDisplayResolver } from "./historicalPracticeDisplay.ts";
import type { ReadingCorrectionAnswerPresentation } from "./reading/correctionResult.ts";
import type { ReadingAnswerState } from "./reading/practiceState.ts";
import type { SubmittedReadingReviewItem } from "./reading/review.ts";
import type { StudentReadingPracticePayload } from "./reading/studentPractice.ts";
import type { ReadingModule } from "./reading/types.ts";

export const TEACHER_PRACTICE_TASK_TYPES = [
  "ctw",
  "rdl",
  "rap",
  "build_sentence",
  "email",
  "academic_discussion"
] as const;

export type TeacherPracticeTaskType = (typeof TEACHER_PRACTICE_TASK_TYPES)[number];

export const TEACHER_PRACTICE_READING_TASKS: ReadingModule[] = ["ctw", "rdl", "rap"];

export const TEACHER_PRACTICE_TASK_SHORT_LABELS: Record<TeacherPracticeTaskType, string> = {
  ctw: "CTW",
  rdl: "RDL",
  rap: "RAP",
  build_sentence: "BAS",
  email: "WE",
  academic_discussion: "AD"
};

export const TEACHER_PRACTICE_TASK_LABELS: Record<TeacherPracticeTaskType, string> = {
  ctw: "Complete the Words",
  rdl: "Read in Daily Life",
  rap: "Read an Academic Passage",
  build_sentence: "Build a Sentence",
  email: "Write an Email",
  academic_discussion: "Academic Discussion"
};

export type TeacherReadingTaskSummary = {
  attempts: number;
  correctPoints: number;
  totalPoints: number;
  accuracy: number;
};

export type TeacherBasTaskSummary = {
  attempts: number;
  correctCount: number;
  totalQuestions: number;
  accuracy: number;
};

export type TeacherWritingScoreTaskSummary = {
  attempts: number;
  scoredAttempts: number;
  averageScore: number | null;
};

export type TeacherPracticeRecordMetric =
  | { kind: "objective"; correct: number; total: number; accuracy: number }
  | { kind: "writing"; hasScore: boolean; score: number | null; wordCount: number };

export type TeacherPracticeRecordKind = "practice" | "wrongbook" | "full_set";

export type TeacherPracticeRecord = {
  recordId: string;
  attemptId: string;
  domain: "reading" | "writing";
  taskType: TeacherPracticeTaskType;
  kind: TeacherPracticeRecordKind;
  title: string;
  submittedAt: string;
  durationSeconds: number;
  metric: TeacherPracticeRecordMetric;
  scope: "today" | "history" | null;
  href: string | null;
};

export type TeacherStudentReadingPractice = {
  tasks: Record<ReadingModule, TeacherReadingTaskSummary>;
  records: TeacherPracticeRecord[];
};

/**
 * On-demand teacher payload for one submitted Reading attempt. It is only
 * requested after a teacher opens a record; the student detail list never
 * includes practice content, answers, or scoring detail.
 */
export type TeacherReadingAttemptReviewPayload = {
  attempt: {
    attemptId: string;
    logicalItemId: string;
    taskType: ReadingModule;
    submittedAt: string;
  };
  answers: ReadingAnswerState;
  disclosures: Record<string, ReadingCorrectionAnswerPresentation>;
  practice: StudentReadingPracticePayload;
  reviewItems: SubmittedReadingReviewItem[];
};

/**
 * Teacher detail routes are keyed by the attempt id alone so repeated practices
 * of one item always open the exact attempt the teacher clicked.
 */
export function teacherReadingAttemptHref(input: {
  studentId?: string;
  kind: TeacherPracticeRecordKind;
  attemptId: string;
}) {
  if (!input.studentId) return null;
  const base = `/teacher/students/${encodeURIComponent(input.studentId)}/reading`;
  if (input.kind === "full_set") {
    return `${base}/full-set-attempts/${encodeURIComponent(input.attemptId)}`;
  }
  if (input.kind === "wrongbook") {
    return `${base}/wrongbook-attempts/${encodeURIComponent(input.attemptId)}`;
  }
  return `${base}/attempts/${encodeURIComponent(input.attemptId)}`;
}

export type TeacherStudentWritingPractice = {
  tasks: {
    build_sentence: TeacherBasTaskSummary;
    email: TeacherWritingScoreTaskSummary;
    academic_discussion: TeacherWritingScoreTaskSummary;
  };
  records: TeacherPracticeRecord[];
};

export type TeacherStudentPracticePayload = {
  student: {
    studentId: string;
    displayName: string;
    account: string;
    domains: Array<"reading" | "writing">;
  };
  range: {
    startAt: string;
    endAt: string;
  };
  reading: TeacherStudentReadingPractice | null;
  writing: TeacherStudentWritingPractice | null;
};

export type TeacherReadingAttemptRow = {
  attempt_id: string;
  student_id?: string;
  logical_item_id: string;
  task_type: ReadingModule;
  status: "draft" | "submitted";
  elapsed_seconds: number;
  total_points: number;
  correct_points: number;
  submitted_at: string | null;
};

export type TeacherReadingWrongbookAttemptRow = TeacherReadingAttemptRow & {
  scope: "today" | "history";
};

export type TeacherFullSetAttemptRow = {
  attempt_id: string;
  full_set_id: string;
  completed_at: string | null;
};

export type TeacherFullSetModuleRow = {
  attempt_id: string;
  module_attempt_id: string;
  module_number: number;
  started_at: string;
  submitted_at: string | null;
  time_limit_seconds: number;
};

export type TeacherFullSetAnswerRow = {
  module_attempt_id: string;
  occurrence_id: string;
  logical_item_id: string;
  is_correct: boolean | null;
};

export type TeacherReadingItemMeta = {
  logical_item_id: string;
  module: ReadingModule;
  displayName: string;
  scoringPointCount: number;
};

export type TeacherBasAttemptRow = {
  attempt_id: string;
  set_id: string;
  set_title: string | null;
  correct_count: number | null;
  total_questions: number | null;
  time_spent_seconds: number | null;
  submitted_at: string | null;
};

export type TeacherWritingAttemptRow = {
  attempt_id: string;
  assignment_id: string | null;
  task_type: "email" | "academic_discussion";
  question_id: string;
  word_count: number | null;
  elapsed_seconds: number | null;
  submitted_at: string | null;
};

export type TeacherWritingReviewScoreRow = {
  attempt_id: string;
  score: number | null;
};

export const WRONGBOOK_TODAY_GROUP_ID = "wrongbook-today";
export const WRONGBOOK_HISTORY_GROUP_ID = "wrongbook-history";

export function isBasWrongbookSetId(setId: string) {
  const normalized = setId.trim().toLocaleLowerCase();
  return normalized.startsWith("wrongbook-");
}

export function basAttemptGroupId(setId: string) {
  const normalized = setId.trim().toLocaleLowerCase();
  if (normalized.startsWith("wrongbook-today")) return WRONGBOOK_TODAY_GROUP_ID;
  if (normalized.startsWith("wrongbook-all-") || normalized.startsWith("wrongbook-random-")) {
    return WRONGBOOK_HISTORY_GROUP_ID;
  }
  return setId;
}

export function normalizeBasGroupId(setId: string) {
  return basAttemptGroupId(setId);
}

export function buildTeacherStudentReadingPractice(input: {
  attempts: TeacherReadingAttemptRow[];
  wrongbookAttempts?: TeacherReadingWrongbookAttemptRow[];
  fullSetAttempts?: TeacherFullSetAttemptRow[];
  fullSetModules?: TeacherFullSetModuleRow[];
  fullSetAnswers?: TeacherFullSetAnswerRow[];
  itemMeta: Map<string, TeacherReadingItemMeta>;
  studentId?: string;
}): TeacherStudentReadingPractice {
  const tasks: Record<ReadingModule, TeacherReadingTaskSummary> = {
    ctw: emptyReadingTask(),
    rdl: emptyReadingTask(),
    rap: emptyReadingTask()
  };
  const records: TeacherPracticeRecord[] = [];

  for (const attempt of input.attempts) {
    const submittedAt = validSubmittedAt(attempt.submitted_at);
    if (attempt.status !== "submitted" || !submittedAt) continue;
    const totalPoints = nonNegativeInteger(attempt.total_points);
    const correctPoints = Math.min(totalPoints, nonNegativeInteger(attempt.correct_points));
    const accuracy = ratio(correctPoints, totalPoints);
    accumulateReadingTask(tasks[attempt.task_type], correctPoints, totalPoints);
    records.push({
      recordId: `${attempt.task_type}:${attempt.attempt_id}`,
      attemptId: String(attempt.attempt_id),
      domain: "reading",
      taskType: attempt.task_type,
      kind: "practice",
      title: readingRecordTitle(input.itemMeta, attempt.logical_item_id, attempt.task_type),
      submittedAt,
      durationSeconds: nonNegativeInteger(attempt.elapsed_seconds),
      metric: { kind: "objective", correct: correctPoints, total: totalPoints, accuracy },
      scope: null,
      href: teacherReadingAttemptHref({
        studentId: input.studentId,
        kind: "practice",
        attemptId: String(attempt.attempt_id)
      })
    });
  }

  for (const attempt of input.wrongbookAttempts ?? []) {
    const submittedAt = validSubmittedAt(attempt.submitted_at);
    if (attempt.status !== "submitted" || !submittedAt) continue;
    const totalPoints = nonNegativeInteger(attempt.total_points);
    const correctPoints = Math.min(totalPoints, nonNegativeInteger(attempt.correct_points));
    records.push({
      recordId: `${attempt.task_type}:${attempt.attempt_id}`,
      attemptId: String(attempt.attempt_id),
      domain: "reading",
      taskType: attempt.task_type,
      kind: "wrongbook",
      title: readingRecordTitle(input.itemMeta, attempt.logical_item_id, attempt.task_type),
      submittedAt,
      durationSeconds: nonNegativeInteger(attempt.elapsed_seconds),
      metric: {
        kind: "objective",
        correct: correctPoints,
        total: totalPoints,
        accuracy: ratio(correctPoints, totalPoints)
      },
      scope: attempt.scope,
      href: isReadingModuleValue(attempt.task_type)
        ? teacherReadingAttemptHref({
            studentId: input.studentId,
            kind: "wrongbook",
            attemptId: String(attempt.attempt_id)
          })
        : null
    });
  }

  const fullSet = buildFullSetReadingPractice(input);
  for (const taskType of TEACHER_PRACTICE_READING_TASKS) {
    const summary = fullSet.tasks[taskType];
    tasks[taskType].attempts += summary.attempts;
    tasks[taskType].correctPoints += summary.correctPoints;
    tasks[taskType].totalPoints += summary.totalPoints;
    tasks[taskType].accuracy = ratio(tasks[taskType].correctPoints, tasks[taskType].totalPoints);
  }
  records.push(...fullSet.records);

  return { tasks, records: sortPracticeRecords(records) };
}

export function buildTeacherStudentWritingPractice(input: {
  basAttempts: TeacherBasAttemptRow[];
  basTitles?: Map<string, string>;
  studentId: string;
  writingAttempts: TeacherWritingAttemptRow[];
  writingDisplayNames: Map<string, string>;
  reviewScores?: Map<string, number>;
}): TeacherStudentWritingPractice {
  const tasks: TeacherStudentWritingPractice["tasks"] = {
    build_sentence: { attempts: 0, correctCount: 0, totalQuestions: 0, accuracy: 0 },
    email: { attempts: 0, scoredAttempts: 0, averageScore: null },
    academic_discussion: { attempts: 0, scoredAttempts: 0, averageScore: null }
  };
  const records: TeacherPracticeRecord[] = [];
  let basScoreTotal = 0;
  let emailScoreTotal = 0;
  let discussionScoreTotal = 0;

  for (const attempt of input.basAttempts) {
    const submittedAt = validSubmittedAt(attempt.submitted_at);
    if (!submittedAt) continue;
    const setId = String(attempt.set_id);
    const totalQuestions = nonNegativeInteger(attempt.total_questions);
    const correctCount = Math.min(totalQuestions, nonNegativeInteger(attempt.correct_count));
    const isWrongbook = isBasWrongbookSetId(setId);
    if (!isWrongbook) {
      tasks.build_sentence.attempts += 1;
      tasks.build_sentence.correctCount += correctCount;
      tasks.build_sentence.totalQuestions += totalQuestions;
    }
    const groupId = basAttemptGroupId(setId);
    records.push({
      recordId: `build_sentence:${attempt.attempt_id}`,
      attemptId: String(attempt.attempt_id),
      domain: "writing",
      taskType: "build_sentence",
      kind: isWrongbook ? "wrongbook" : "practice",
      title: isWrongbook
        ? groupId === WRONGBOOK_TODAY_GROUP_ID
          ? "今日错题"
          : "历史错题"
        : input.basTitles?.get(setId)?.trim() || attempt.set_title?.trim() || setId,
      submittedAt,
      durationSeconds: nonNegativeInteger(attempt.time_spent_seconds),
      metric: {
        kind: "objective",
        correct: correctCount,
        total: totalQuestions,
        accuracy: ratio(correctCount, totalQuestions)
      },
      scope: isWrongbook
        ? groupId === WRONGBOOK_TODAY_GROUP_ID
          ? "today"
          : "history"
        : null,
      href: `/teacher/students/${encodeURIComponent(input.studentId)}/details/${encodeURIComponent(groupId)}`
    });
  }

  for (const attempt of input.writingAttempts) {
    const submittedAt = validSubmittedAt(attempt.submitted_at);
    if (!submittedAt) continue;
    const taskType = attempt.task_type;
    const score = input.reviewScores?.get(String(attempt.attempt_id));
    const hasScore = Number.isFinite(score) && (score as number) >= 0 && (score as number) <= 5;
    tasks[taskType].attempts += 1;
    if (hasScore) {
      tasks[taskType].scoredAttempts += 1;
      if (taskType === "email") emailScoreTotal += score as number;
      else discussionScoreTotal += score as number;
    }
    records.push({
      recordId: `${taskType}:${attempt.attempt_id}`,
      attemptId: String(attempt.attempt_id),
      domain: "writing",
      taskType,
      kind: "practice",
      title:
        input.writingDisplayNames.get(String(attempt.attempt_id))?.trim()
        || TEACHER_PRACTICE_TASK_LABELS[taskType],
      submittedAt,
      durationSeconds: nonNegativeInteger(attempt.elapsed_seconds),
      metric: {
        kind: "writing",
        hasScore,
        score: hasScore ? (score as number) : null,
        wordCount: nonNegativeInteger(attempt.word_count)
      },
      scope: null,
      href: `/teacher/writing/reviews/${encodeURIComponent(String(attempt.attempt_id))}`
    });
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

  return { tasks, records: sortPracticeRecords(records) };
}

export function resolveTeacherWritingAttemptDisplayName(input: {
  assignmentId: string | null;
  assignmentTitle: string | null;
  assignmentQuestionSource: "custom" | "question_bank" | null;
  fallbackTitle: string;
  questionId: string;
  resolver: HistoricalPracticeDisplayResolver;
  taskType: "email" | "academic_discussion";
}) {
  const display = input.resolver.resolveWritingAttempt({
    assignmentId: input.assignmentId,
    assignmentDisplayName: input.assignmentTitle,
    fallbackDisplayName: input.fallbackTitle,
    questionSource: input.assignmentQuestionSource,
    rawQuestionId: input.questionId,
    taskType: input.taskType
  });
  return display.displayName;
}

export function sortPracticeRecords(records: TeacherPracticeRecord[]) {
  return [...records].sort((left, right) =>
    Date.parse(right.submittedAt) - Date.parse(left.submittedAt)
    || left.recordId.localeCompare(right.recordId)
  );
}

function buildFullSetReadingPractice(input: {
  fullSetAttempts?: TeacherFullSetAttemptRow[];
  fullSetModules?: TeacherFullSetModuleRow[];
  fullSetAnswers?: TeacherFullSetAnswerRow[];
  itemMeta: Map<string, TeacherReadingItemMeta>;
  studentId?: string;
}): {
  tasks: Record<ReadingModule, TeacherReadingTaskSummary>;
  records: TeacherPracticeRecord[];
} {
  const tasks: Record<ReadingModule, TeacherReadingTaskSummary> = {
    ctw: emptyReadingTask(),
    rdl: emptyReadingTask(),
    rap: emptyReadingTask()
  };
  const records: TeacherPracticeRecord[] = [];
  const modulesByAttempt = groupBy(input.fullSetModules ?? [], (moduleRow) => String(moduleRow.attempt_id));
  const answersByModule = groupBy(input.fullSetAnswers ?? [], (answer) => String(answer.module_attempt_id));

  for (const attempt of input.fullSetAttempts ?? []) {
    const completedAt = validSubmittedAt(attempt.completed_at);
    if (!completedAt) continue;
    const attemptModules = (modulesByAttempt.get(String(attempt.attempt_id)) ?? [])
      .filter((module) => module.submitted_at);
    if (attemptModules.length !== 2) continue;

    const durationSeconds = attemptModules.reduce((sum, module) => {
      const started = Date.parse(module.started_at);
      const submitted = Date.parse(module.submitted_at ?? "");
      if (!Number.isFinite(started) || !Number.isFinite(submitted)) return sum;
      const elapsed = Math.max(0, Math.round((submitted - started) / 1000));
      const timeLimit = nonNegativeInteger(module.time_limit_seconds);
      return sum + (timeLimit > 0 ? Math.min(elapsed, timeLimit) : elapsed);
    }, 0);

    const occurrences = new Map<string, { correct: number; total: number; taskType: ReadingModule }>();
    for (const fullSetModule of attemptModules) {
      for (const answer of answersByModule.get(String(fullSetModule.module_attempt_id)) ?? []) {
        const occurrenceId = String(answer.occurrence_id);
        const meta = input.itemMeta.get(String(answer.logical_item_id));
        const existing = occurrences.get(occurrenceId);
        if (!existing) {
          occurrences.set(occurrenceId, {
            correct: answer.is_correct === true ? 1 : 0,
            total: meta ? Math.max(0, nonNegativeInteger(meta.scoringPointCount)) : 1,
            taskType: meta?.module ?? "ctw"
          });
          continue;
        }
        if (answer.is_correct === true) existing.correct += 1;
        if (!meta) existing.total += 1;
      }
    }

    const byTask = new Map<ReadingModule, { correct: number; total: number; attempts: number }>();
    for (const occurrence of Array.from(occurrences.values())) {
      const summary = byTask.get(occurrence.taskType) ?? { correct: 0, total: 0, attempts: 0 };
      summary.correct += occurrence.correct;
      summary.total += occurrence.total;
      summary.attempts += 1;
      byTask.set(occurrence.taskType, summary);
    }

    for (const taskType of TEACHER_PRACTICE_READING_TASKS) {
      const summary = byTask.get(taskType);
      if (!summary) continue;
      tasks[taskType].attempts += summary.attempts;
      tasks[taskType].correctPoints += summary.correct;
      tasks[taskType].totalPoints += summary.total;
      tasks[taskType].accuracy = ratio(tasks[taskType].correctPoints, tasks[taskType].totalPoints);
      records.push({
        recordId: `full_set:${attempt.attempt_id}:${taskType}`,
        attemptId: String(attempt.attempt_id),
        domain: "reading",
        taskType,
        kind: "full_set",
        title: `Full Set ${attempt.full_set_id}`,
        submittedAt: completedAt,
        durationSeconds,
        metric: {
          kind: "objective",
          correct: summary.correct,
          total: summary.total,
          accuracy: ratio(summary.correct, summary.total)
        },
        scope: null,
        href: teacherReadingAttemptHref({
          studentId: input.studentId,
          kind: "full_set",
          attemptId: String(attempt.attempt_id)
        })
      });
    }
  }

  return { tasks, records };
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

function emptyReadingTask(): TeacherReadingTaskSummary {
  return { attempts: 0, correctPoints: 0, totalPoints: 0, accuracy: 0 };
}

function readingRecordTitle(
  itemMeta: Map<string, TeacherReadingItemMeta>,
  logicalItemId: string,
  taskType: ReadingModule
) {
  return itemMeta.get(String(logicalItemId))?.displayName?.trim()
    || TEACHER_PRACTICE_TASK_LABELS[taskType];
}

function isReadingModuleValue(value: string) {
  return value === "ctw" || value === "rdl" || value === "rap";
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

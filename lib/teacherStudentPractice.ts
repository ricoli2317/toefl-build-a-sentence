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
  "full_set",
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
  full_set: "FS",
  build_sentence: "BAS",
  email: "WE",
  academic_discussion: "AD"
};

export const TEACHER_PRACTICE_TASK_LABELS: Record<TeacherPracticeTaskType, string> = {
  ctw: "Complete the Words",
  rdl: "Read in Daily Life",
  rap: "Read an Academic Passage",
  full_set: "Full Set",
  build_sentence: "Build a Sentence",
  email: "Write an Email",
  academic_discussion: "Academic Discussion"
};

export function allTeacherPracticeTasksSelected(): Record<TeacherPracticeTaskType, boolean> {
  return Object.fromEntries(
    TEACHER_PRACTICE_TASK_TYPES.map((taskType) => [taskType, true])
  ) as Record<TeacherPracticeTaskType, boolean>;
}

/**
 * Parses the `tasks` search param of the student detail page. A missing value
 * keeps the default (all selected); `none` is an explicit empty selection;
 * unknown-only values fall back to the default so a stale link never hides
 * every record.
 */
export function parseTeacherPracticeTaskSelection(
  value: string | null | undefined
): Record<TeacherPracticeTaskType, boolean> {
  const selected = Object.fromEntries(
    TEACHER_PRACTICE_TASK_TYPES.map((taskType) => [taskType, false])
  ) as Record<TeacherPracticeTaskType, boolean>;
  const raw = (value ?? "").trim();
  if (!raw) return allTeacherPracticeTasksSelected();
  if (raw === "none") return selected;
  const wanted = new Set(raw.split(",").map((part) => part.trim()).filter(Boolean));
  for (const taskType of TEACHER_PRACTICE_TASK_TYPES) {
    selected[taskType] = wanted.has(taskType);
  }
  return TEACHER_PRACTICE_TASK_TYPES.some((taskType) => selected[taskType])
    ? selected
    : allTeacherPracticeTasksSelected();
}

/** Serializes the filter for the URL; "" means the default all-selected state. */
export function formatTeacherPracticeTaskSelection(
  selected: Record<TeacherPracticeTaskType, boolean>
) {
  const checked = TEACHER_PRACTICE_TASK_TYPES.filter((taskType) => selected[taskType]);
  if (checked.length === TEACHER_PRACTICE_TASK_TYPES.length) return "";
  if (checked.length === 0) return "none";
  return checked.join(",");
}

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
  /**
   * Completed Full Set practices. One completed Full Set is one practice (both
   * modules, one run) and its accuracy is weighted by all of its scoring
   * points. Full Set work never enters the CTW / RDL / RAP cards.
   */
  fullSet: TeacherReadingTaskSummary;
  records: TeacherPracticeRecord[];
};

/**
 * On-demand teacher payload for one submitted Reading attempt. It is only
 * requested after a teacher opens a record; the student detail list never
 * includes practice content, answers, or scoring detail.
 *
 * The attempt carries the same result numbers the student's result page shows
 * (`correctPoints` / `totalPoints` / `elapsedSeconds`) so the teacher drill-down
 * can open the student-shaped result view before any read-only question page.
 */
export type TeacherReadingAttemptReviewPayload = {
  attempt: {
    attemptId: string;
    logicalItemId: string;
    taskType: ReadingModule;
    submittedAt: string;
    correctPoints: number;
    totalPoints: number;
    elapsedSeconds: number;
  };
  answers: ReadingAnswerState;
  disclosures: Record<string, ReadingCorrectionAnswerPresentation>;
  practice: StudentReadingPracticePayload;
  reviewItems: SubmittedReadingReviewItem[];
};

/**
 * The teacher result view header data for one reading record (practice,
 * correction, session or Full Set). It mirrors the student result summary of
 * the same attempt.
 */
export type TeacherReadingResultSummary = {
  correctPoints: number;
  elapsedSeconds: number | null;
  /** Official Full Set score display (student result page score card). */
  scoreDisplay?: string;
  submittedAt: string;
  title: string;
  totalPoints: number;
};

/**
 * Teacher drill-down data for a wrong-question session / Full Set: the
 * student-shaped result summary plus the multi-source read-only review the
 * question pages render.
 */
export type TeacherReadingMultiSourceDetail<Review> = {
  review: Review;
  summary: TeacherReadingResultSummary;
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

/**
 * One frozen wrong-question practice session. Its `progress` maps each
 * material's logical item id to the correction attempt that submitted it, so
 * the teacher list can fold a session's per-material attempts into the single
 * record the student actually practised.
 *
 * Only completed sessions produce a record: an unfinished session has no
 * student result to open (the student page sends the student back to keep
 * practising) and would otherwise appear as a partial, material-sized record.
 */
export type TeacherReadingWrongbookSessionRow = {
  mode: "history" | "today";
  progress: Record<string, { attemptId?: string | null } | null> | null;
  session_id: string;
  status?: string | null;
  task_type: string;
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
  wrongbookSessions?: TeacherReadingWrongbookSessionRow[];
  fullSetAttempts?: TeacherFullSetAttemptRow[];
  fullSetModules?: TeacherFullSetModuleRow[];
  fullSetAnswers?: TeacherFullSetAnswerRow[];
  fullSetTitles?: Map<string, string>;
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

  // A today / history wrong-question practice is one frozen session covering
  // several materials; the teacher list shows it as ONE record per session, not
  // one record per screened material. Corrections that are not part of a
  // session (formal-result entry corrections, Full Set corrections) stay
  // individual records.
  const sessionByAttemptId = new Map<string, TeacherReadingWrongbookSessionRow>();
  for (const session of input.wrongbookSessions ?? []) {
    for (const entry of Object.values(session.progress ?? {})) {
      const attemptId = entry?.attemptId ? String(entry.attemptId) : "";
      if (attemptId) sessionByAttemptId.set(attemptId, session);
    }
  }
  const sessionAttemptGroups = new Map<string, {
    attempts: TeacherReadingWrongbookAttemptRow[];
    session: TeacherReadingWrongbookSessionRow;
  }>();
  const standaloneWrongbookAttempts: TeacherReadingWrongbookAttemptRow[] = [];
  for (const attempt of input.wrongbookAttempts ?? []) {
    const submittedAt = validSubmittedAt(attempt.submitted_at);
    if (attempt.status !== "submitted" || !submittedAt) continue;
    const session = sessionByAttemptId.get(String(attempt.attempt_id));
    if (session) {
      const sessionId = String(session.session_id);
      const group = sessionAttemptGroups.get(sessionId) ?? { attempts: [], session };
      group.attempts.push(attempt);
      sessionAttemptGroups.set(sessionId, group);
    } else {
      standaloneWrongbookAttempts.push(attempt);
    }
  }

  for (const attempt of standaloneWrongbookAttempts) {
    const submittedAt = validSubmittedAt(attempt.submitted_at)!;
    const totalPoints = nonNegativeInteger(attempt.total_points);
    const correctPoints = Math.min(totalPoints, nonNegativeInteger(attempt.correct_points));
    // An entry correction is one attempt on one material: it reads as the
    // unified record name plus the material the student corrected
    // (`错题订正·材料名`). Sessions keep their own 历史错题 / 今日错题 titles.
    records.push({
      recordId: `${attempt.task_type}:${attempt.attempt_id}`,
      attemptId: String(attempt.attempt_id),
      domain: "reading",
      taskType: attempt.task_type,
      kind: "wrongbook",
      title: isReadingModuleValue(attempt.task_type)
        ? `错题订正·${readingRecordTitle(input.itemMeta, attempt.logical_item_id, attempt.task_type)}`
        : readingRecordTitle(input.itemMeta, attempt.logical_item_id, attempt.task_type),
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

  for (const { attempts, session } of Array.from(sessionAttemptGroups.values())) {
    // Only a finished practice has a result the teacher can open. An unfinished
    // session would show up as a partial one-material record, exactly the
    // per-material list the session record replaces.
    if (session.status !== "completed") continue;
    // Earliest submitted material first: its attempt backs the drill-down link
    // (the teacher detail page opens one correction attempt at a time).
    const orderedAttempts = [...attempts].sort((left, right) =>
      Date.parse(String(left.submitted_at)) - Date.parse(String(right.submitted_at))
      || String(left.attempt_id).localeCompare(String(right.attempt_id))
    );
    const firstAttempt = orderedAttempts[0];
    const totalPoints = orderedAttempts.reduce(
      (sum, attempt) => sum + nonNegativeInteger(attempt.total_points), 0);
    const correctPoints = orderedAttempts.reduce(
      (sum, attempt) => sum + Math.min(
        nonNegativeInteger(attempt.total_points),
        nonNegativeInteger(attempt.correct_points)
      ), 0);
    // The record sits at the session's completion moment (its latest material).
    const submittedAt = validSubmittedAt(
      orderedAttempts[orderedAttempts.length - 1].submitted_at
    )!;
    records.push({
      recordId: `wrongbook-session:${session.session_id}`,
      attemptId: String(firstAttempt.attempt_id),
      domain: "reading",
      taskType: isReadingModuleValue(session.task_type)
        ? session.task_type
        : firstAttempt.task_type,
      kind: "wrongbook",
      // One record per session, named like the Writing wrongbook records.
      title: session.mode === "today" ? "今日错题" : "历史错题",
      submittedAt,
      durationSeconds: orderedAttempts.reduce(
        (sum, attempt) => sum + nonNegativeInteger(attempt.elapsed_seconds), 0),
      metric: {
        kind: "objective",
        correct: correctPoints,
        total: totalPoints,
        accuracy: ratio(correctPoints, totalPoints)
      },
      scope: session.mode,
      href: teacherReadingAttemptHref({
        studentId: input.studentId,
        kind: "wrongbook",
        attemptId: String(firstAttempt.attempt_id)
      })
    });
  }

  // Full Set work stays out of the CTW / RDL / RAP cards: those count only the
  // student's own single-task practices. The dedicated Full Set card counts a
  // completed Full Set as one whole practice (see buildFullSetReadingPractice).
  const fullSet = buildFullSetReadingPractice(input);
  records.push(...fullSet.records);

  return { tasks, fullSet: fullSet.fullSet, records: sortPracticeRecords(records) };
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
        : input.basTitles?.get(setId)?.trim() || setId,
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
      // A BAS record opens the attempt's own result page, never the set-wide
      // list of every attempt of that set.
      href: `/teacher/students/${encodeURIComponent(input.studentId)}/attempts/${encodeURIComponent(String(attempt.attempt_id))}`
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
  fullSetTitles?: Map<string, string>;
  itemMeta: Map<string, TeacherReadingItemMeta>;
  studentId?: string;
}): {
  fullSet: TeacherReadingTaskSummary;
  records: TeacherPracticeRecord[];
} {
  const fullSet = emptyReadingTask();
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

    const occurrences = new Map<string, { correct: number; total: number }>();
    for (const fullSetModule of attemptModules) {
      for (const answer of answersByModule.get(String(fullSetModule.module_attempt_id)) ?? []) {
        const occurrenceId = String(answer.occurrence_id);
        const meta = input.itemMeta.get(String(answer.logical_item_id));
        const existing = occurrences.get(occurrenceId);
        if (!existing) {
          occurrences.set(occurrenceId, {
            correct: answer.is_correct === true ? 1 : 0,
            total: meta ? Math.max(0, nonNegativeInteger(meta.scoringPointCount)) : 1
          });
          continue;
        }
        if (answer.is_correct === true) existing.correct += 1;
        if (!meta) existing.total += 1;
      }
    }

    // The card and the record list both show the whole Full Set as ONE run:
    // both modules, one summed score, the same title the student's Full Set
    // result shows. The card's accuracy is the accumulated correct ÷ total
    // scoring points of completed Full Sets, never a per-module count.
    let correctPoints = 0;
    let totalPoints = 0;
    for (const occurrence of Array.from(occurrences.values())) {
      correctPoints += occurrence.correct;
      totalPoints += occurrence.total;
    }
    fullSet.attempts += 1;
    fullSet.correctPoints += correctPoints;
    fullSet.totalPoints += totalPoints;
    fullSet.accuracy = ratio(fullSet.correctPoints, fullSet.totalPoints);

    records.push({
      recordId: `full_set:${attempt.attempt_id}`,
      attemptId: String(attempt.attempt_id),
      domain: "reading",
      taskType: "full_set",
      kind: "full_set",
      title: input.fullSetTitles?.get(String(attempt.full_set_id))?.trim()
        || `Full Set ${attempt.full_set_id}`,
      submittedAt: completedAt,
      durationSeconds,
      metric: {
        kind: "objective",
        correct: correctPoints,
        total: totalPoints,
        accuracy: ratio(correctPoints, totalPoints)
      },
      scope: null,
      href: teacherReadingAttemptHref({
        studentId: input.studentId,
        kind: "full_set",
        attemptId: String(attempt.attempt_id)
      })
    });
  }

  return { fullSet, records };
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

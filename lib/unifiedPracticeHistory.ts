import { WRITING_TASK_CONFIG, type WritingTaskType } from "./writing.ts";
import { writingReviewResultHref } from "./studentNavigation.ts";

export const UNIFIED_HISTORY_TASK_TYPES = [
  "build_sentence",
  "email",
  "academic_discussion",
  "ctw",
  "rdl",
  "rap"
] as const;

export type UnifiedHistoryTaskType = (typeof UNIFIED_HISTORY_TASK_TYPES)[number];
export type UnifiedHistoryCategory = "all" | "writing" | "reading";

export const UNIFIED_HISTORY_TASK_LABELS: Record<UnifiedHistoryTaskType, string> = {
  build_sentence: "Build a Sentence",
  email: "Write an Email",
  academic_discussion: "Academic Discussion",
  ctw: "Complete the Words",
  rdl: "Read in Daily Life",
  rap: "Read an Academic Passage"
};

export type UnifiedHistoryObjectiveMetrics = {
  kind: "objective";
  accuracy: number;
  correct: number;
  total: number;
};

export type UnifiedHistoryWritingMetrics = {
  kind: "writing";
  hasPublishedReview: boolean;
  reviewScore: number | null;
  wordCount: number;
};

export type UnifiedHistoryTarget = {
  href: string;
  label: string;
  method: "GET" | "POST";
};

export type UnifiedHistoryRecord = {
  attemptId: string;
  category: Exclude<UnifiedHistoryCategory, "all">;
  durationSeconds: number;
  metrics: UnifiedHistoryObjectiveMetrics | UnifiedHistoryWritingMetrics;
  resultTarget: UnifiedHistoryTarget;
  retakeTarget: UnifiedHistoryTarget;
  submittedAt: string;
  taskLabel: string;
  taskType: UnifiedHistoryTaskType;
  title: string;
};

export type UnifiedHistoryOverview = {
  allCompleted: number;
  allDurationSeconds: number;
  todayCompleted: number;
  todayDurationSeconds: number;
};

export type UnifiedHistoryPayload = {
  filters: {
    category: UnifiedHistoryCategory;
    taskType: UnifiedHistoryTaskType | "all";
  };
  overview: UnifiedHistoryOverview;
  pagination: {
    limit: number;
    nextOffset: number | null;
    offset: number;
    total: number;
  };
  records: UnifiedHistoryRecord[];
};

export type UnifiedBasAttemptRow = {
  attempt_id: string;
  correct_count: number | null;
  set_id: string;
  set_title: string | null;
  submitted_at: string | null;
  time_spent_seconds: number | null;
  total_questions: number | null;
};

export type UnifiedWritingAttemptRow = {
  assignment_id: string | null;
  attempt_id: string;
  elapsed_seconds: number | null;
  question_id: string;
  status: "draft" | "submitted";
  submitted_at: string | null;
  task_type: WritingTaskType;
  word_count: number | null;
};

export type UnifiedReadingAttemptRow = {
  attempt_id: string;
  correct_points: number | null;
  elapsed_seconds: number | null;
  logical_item_id: string;
  status: "draft" | "submitted";
  submitted_at: string | null;
  task_type: "ctw" | "rdl" | "rap";
  total_points: number | null;
};

export type UnifiedWritingReviewSummary = {
  officialScore: number;
};

export type UnifiedWritingAssignmentSummary = {
  questionSource: "custom" | "question_bank";
  title: string | null;
};

export function buildUnifiedPracticeHistory(input: {
  basAttempts: UnifiedBasAttemptRow[];
  category?: UnifiedHistoryCategory;
  limit?: number;
  offset?: number;
  readingAttempts: UnifiedReadingAttemptRow[];
  readingTitles?: Map<string, string>;
  taskType?: UnifiedHistoryTaskType | "all";
  todayEnd: number;
  todayStart: number;
  writingAssignments?: Map<string, UnifiedWritingAssignmentSummary>;
  writingAttempts: UnifiedWritingAttemptRow[];
  writingReviews?: Map<string, UnifiedWritingReviewSummary>;
  writingTitles?: Map<string, string>;
  basTitles?: Map<string, string>;
}): UnifiedHistoryPayload {
  const category = input.category ?? "all";
  const taskType = input.taskType ?? "all";
  const limit = clampInteger(input.limit, 1, 50, 20);
  const offset = clampInteger(input.offset, 0, Number.MAX_SAFE_INTEGER, 0);
  const records = [
    ...buildBasRecords(input.basAttempts, input.basTitles),
    ...buildWritingRecords(
      input.writingAttempts,
      input.writingTitles,
      input.writingAssignments,
      input.writingReviews
    ),
    ...buildReadingRecords(input.readingAttempts, input.readingTitles)
  ].sort(compareUnifiedHistoryRecords);
  const overview = buildUnifiedHistoryOverview(records, input.todayStart, input.todayEnd);
  const filtered = records.filter((record) =>
    (category === "all" || record.category === category)
    && (taskType === "all" || record.taskType === taskType)
  );

  return {
    filters: { category, taskType },
    overview,
    pagination: {
      limit,
      nextOffset: offset + limit < filtered.length ? offset + limit : null,
      offset,
      total: filtered.length
    },
    records: filtered.slice(offset, offset + limit)
  };
}

export function buildUnifiedHistoryOverview(
  records: UnifiedHistoryRecord[],
  todayStart: number,
  todayEnd: number
): UnifiedHistoryOverview {
  const today = records.filter((record) => {
    const submitted = Date.parse(record.submittedAt);
    return Number.isFinite(submitted) && submitted >= todayStart && submitted < todayEnd;
  });
  return {
    allCompleted: records.length,
    allDurationSeconds: sumDurations(records),
    todayCompleted: today.length,
    todayDurationSeconds: sumDurations(today)
  };
}

export function compareUnifiedHistoryRecords(
  left: Pick<UnifiedHistoryRecord, "attemptId" | "submittedAt">,
  right: Pick<UnifiedHistoryRecord, "attemptId" | "submittedAt">
) {
  return dateTime(right.submittedAt) - dateTime(left.submittedAt)
    || right.attemptId.localeCompare(left.attemptId);
}

export function isUnifiedHistoryCategory(value: unknown): value is UnifiedHistoryCategory {
  return value === "all" || value === "writing" || value === "reading";
}

export function isUnifiedHistoryTaskType(value: unknown): value is UnifiedHistoryTaskType {
  return UNIFIED_HISTORY_TASK_TYPES.includes(value as UnifiedHistoryTaskType);
}

function buildBasRecords(
  attempts: UnifiedBasAttemptRow[],
  titles = new Map<string, string>()
): UnifiedHistoryRecord[] {
  return attempts.flatMap((attempt) => {
    const submittedAt = validSubmittedAt(attempt.submitted_at);
    const setId = String(attempt.set_id).trim();
    if (!submittedAt || !setId || isVirtualBasSet(setId)) return [];
    const total = nonNegativeInteger(attempt.total_questions);
    const correct = Math.min(total, nonNegativeInteger(attempt.correct_count));
    return [{
      attemptId: String(attempt.attempt_id),
      category: "writing" as const,
      durationSeconds: duration(attempt.time_spent_seconds),
      metrics: objectiveMetrics(correct, total),
      resultTarget: {
        href: `/student/results/${encodeURIComponent(String(attempt.attempt_id))}?source=practice-history`,
        label: "查看结果",
        method: "GET" as const
      },
      retakeTarget: {
        href: `/student/practice/${encodeURIComponent(setId)}`,
        label: "重新练习",
        method: "GET" as const
      },
      submittedAt,
      taskLabel: UNIFIED_HISTORY_TASK_LABELS.build_sentence,
      taskType: "build_sentence" as const,
      title: titles.get(setId)?.trim() || attempt.set_title?.trim() || setId
    }];
  });
}

function buildWritingRecords(
  attempts: UnifiedWritingAttemptRow[],
  titles = new Map<string, string>(),
  assignments = new Map<string, UnifiedWritingAssignmentSummary>(),
  reviews = new Map<string, UnifiedWritingReviewSummary>()
): UnifiedHistoryRecord[] {
  return attempts.flatMap((attempt) => {
    const submittedAt = validSubmittedAt(attempt.submitted_at);
    if (attempt.status !== "submitted" || !submittedAt) return [];
    const attemptId = String(attempt.attempt_id);
    const taskType = attempt.task_type;
    const config = WRITING_TASK_CONFIG[taskType];
    const questionId = String(attempt.question_id);
    const assignmentId = attempt.assignment_id ? String(attempt.assignment_id) : null;
    const review = reviews.get(attemptId);
    const assignment = assignmentId ? assignments.get(assignmentId) : null;
    const resultTarget = review
      ? {
          href: writingReviewResultHref(attemptId, "/student/practice-history"),
          label: "查看批改",
          method: "GET" as const
        }
      : {
          href: `${config.submissionHref}/${encodeURIComponent(attemptId)}`,
          label: "查看提交",
          method: "GET" as const
        };
    return [{
      attemptId,
      category: "writing" as const,
      durationSeconds: duration(attempt.elapsed_seconds),
      metrics: {
        kind: "writing" as const,
        hasPublishedReview: Boolean(review),
        reviewScore: review?.officialScore ?? null,
        wordCount: nonNegativeInteger(attempt.word_count)
      },
      resultTarget,
      retakeTarget: {
        href: assignmentId
          ? `/student/assignments/${encodeURIComponent(assignmentId)}?new=1`
          : `${config.practiceHref}/${encodeURIComponent(questionId)}?new=1`,
        label: "重新练习",
        method: "GET" as const
      },
      submittedAt,
      taskLabel: UNIFIED_HISTORY_TASK_LABELS[taskType],
      taskType,
      title:
        (assignment?.questionSource === "custom" ? assignment.title?.trim() : "")
        || titles.get(`${taskType}:${questionId}`)?.trim()
        || assignment?.title?.trim()
        || config.label
    }];
  });
}

function buildReadingRecords(
  attempts: UnifiedReadingAttemptRow[],
  titles = new Map<string, string>()
): UnifiedHistoryRecord[] {
  return attempts.flatMap((attempt) => {
    const submittedAt = validSubmittedAt(attempt.submitted_at);
    if (attempt.status !== "submitted" || !submittedAt) return [];
    const attemptId = String(attempt.attempt_id);
    const logicalItemId = String(attempt.logical_item_id);
    const total = nonNegativeInteger(attempt.total_points);
    const correct = Math.min(total, nonNegativeInteger(attempt.correct_points));
    return [{
      attemptId,
      category: "reading" as const,
      durationSeconds: duration(attempt.elapsed_seconds),
      metrics: objectiveMetrics(correct, total),
      resultTarget: {
        href: `/student/reading/results/${encodeURIComponent(attemptId)}`,
        label: "查看结果",
        method: "GET" as const
      },
      retakeTarget: {
        href: `/api/reading/attempts/${encodeURIComponent(attemptId)}/retake`,
        label: "重新练习",
        method: "POST" as const
      },
      submittedAt,
      taskLabel: UNIFIED_HISTORY_TASK_LABELS[attempt.task_type],
      taskType: attempt.task_type,
      title: titles.get(logicalItemId)?.trim() || UNIFIED_HISTORY_TASK_LABELS[attempt.task_type]
    }];
  });
}

function objectiveMetrics(correct: number, total: number): UnifiedHistoryObjectiveMetrics {
  return {
    kind: "objective",
    accuracy: total > 0 ? correct / total : 0,
    correct,
    total
  };
}

function sumDurations(records: UnifiedHistoryRecord[]) {
  return records.reduce((sum, record) => sum + duration(record.durationSeconds), 0);
}

function duration(value: number | null | undefined) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value as number)) : 0;
}

function nonNegativeInteger(value: number | null | undefined) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value as number)) : 0;
}

function validSubmittedAt(value: string | null | undefined) {
  return value && Number.isFinite(Date.parse(value)) ? value : null;
}

function dateTime(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

function isVirtualBasSet(setId: string) {
  const normalized = setId.toLocaleLowerCase();
  return normalized.startsWith("wrongbook-") || normalized.startsWith("grammar-");
}

function clampInteger(value: number | undefined, minimum: number, maximum: number, fallback: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value as number)));
}

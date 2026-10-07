import { WRITING_TASK_CONFIG } from "./writing.ts";
import { categoryResultHref, categoryPracticeHref } from "./reading/questionCategory.ts";
import { nextWrongQuestionHistoryAmount } from "./wrongQuestionBank.ts";
import {
  STUDENT_ROUTES,
  readingFullSetResultHref,
  readingResultHref,
  withStudentReturnTo,
  writingReviewResultHref,
  writingSubmissionResultHref
} from "./studentNavigation.ts";
import {
  formatTeacherPracticeTaskSelection,
  parseTeacherPracticeTaskSelection,
  type TeacherPracticeRecord,
  type TeacherPracticeTaskType,
  type TeacherStudentReadingPractice,
  type TeacherStudentWritingPractice
} from "./teacherStudentPractice.ts";
import type {
  TeacherPracticeRangeDay,
  TeacherPracticeRangeDayCountKey,
  TeacherStudentPracticeRangeReading,
  TeacherStudentPracticeRangeWriting
} from "./teacherStudentPracticeRange.ts";

/**
 * Student practice history is the same teacher practice read, scoped to the
 * authenticated student and to the seven public task types: CTW / RDL / RAP /
 * Full Set / BAS / WE / AD. Wrong-question work stays in the wrong-question
 * bank, so no Entry / 今日错题 / 历史错题 record ever enters this page.
 */

export type StudentPracticeHistoryDayPayload = {
  range: { startAt: string; endAt: string };
  reading: TeacherStudentReadingPractice | null;
  writing: TeacherStudentWritingPractice | null;
};

export type StudentPracticeHistoryRangePayload = {
  range: { startAt: string; endAt: string; timeZone: string };
  reading: TeacherStudentPracticeRangeReading | null;
  writing: TeacherStudentPracticeRangeWriting | null;
  days: TeacherPracticeRangeDay[];
};

/** The per-day counter columns the student range view renders. */
export const STUDENT_RANGE_DAY_COUNT_KEYS: TeacherPracticeRangeDayCountKey[] = [
  "ctw",
  "rdl",
  "rap",
  "full_set",
  "build_sentence",
  "email",
  "academic_discussion"
];

export type StudentPracticeHistoryView =
  | { kind: "day" }
  | { kind: "range"; start: string; end: string }
  | { kind: "rangeDay"; start: string; end: string; date: string };

export type StudentPracticeHistoryUrlState = {
  /** Calendar day (YYYY-MM-DD) the single-day view shows. */
  selectedDay: string;
  tasks: Record<TeacherPracticeTaskType, boolean>;
  view: StudentPracticeHistoryView;
};

export function isPracticeDateKey(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

export function firstSearchParamValue(value: string | string[] | undefined) {
  if (Array.isArray(value)) return value[0]?.trim() ?? "";
  return value?.trim() ?? "";
}

/**
 * Restores the whole page state from the URL params. `date` + `tasks` always
 * describe the single-day view; `start` + `end` keep the range that a
 * range-day detail belongs to, and `view=range` marks the range statistics
 * view itself so a refresh never falls back to a day.
 */
export function parseStudentPracticeHistoryUrl(input: {
  date?: string | null;
  tasks?: string | null;
  start?: string | null;
  end?: string | null;
  view?: string | null;
  today: string;
}): StudentPracticeHistoryUrlState {
  const tasks = parseTeacherPracticeTaskSelection(input.tasks);
  const date = isPracticeDateKey(input.date) ? input.date : "";
  const start = isPracticeDateKey(input.start) ? input.start : "";
  const end = isPracticeDateKey(input.end) ? input.end : "";
  if (start && end && start < end) {
    const inRange = (value: string) => start <= value && value <= end;
    if (input.view === "range") {
      return {
        selectedDay: date && inRange(date) ? date : start,
        tasks,
        view: { kind: "range", start, end }
      };
    }
    if (date && inRange(date)) {
      return {
        selectedDay: date,
        tasks,
        view: { kind: "rangeDay", start, end, date }
      };
    }
    return { selectedDay: start, tasks, view: { kind: "range", start, end } };
  }
  return { selectedDay: date || input.today, tasks, view: { kind: "day" } };
}

/**
 * Serializes the page state into the URL params. Missing `date` already means
 * today, so the untouched default day never rewrites the address bar.
 */
export function formatStudentPracticeHistoryParams(state: {
  selectedDay: string;
  tasks: Record<TeacherPracticeTaskType, boolean>;
  view: StudentPracticeHistoryView;
  today: string;
}) {
  const activeRange = state.view.kind === "range" || state.view.kind === "rangeDay"
    ? { start: state.view.start, end: state.view.end }
    : null;
  return {
    date: state.view.kind === "day" && state.selectedDay === state.today
      ? null
      : state.selectedDay,
    tasks: formatTeacherPracticeTaskSelection(state.tasks) || null,
    start: activeRange ? activeRange.start : null,
    end: activeRange ? activeRange.end : null,
    view: state.view.kind === "range" ? "range" as const : null
  };
}

/** Canonical in-app href for the current state; used as the result drill-down
 *  `returnTo` so every result page returns to the exact date / range / filter. */
export function studentPracticeHistoryHref(state: {
  selectedDay: string;
  tasks: Record<TeacherPracticeTaskType, boolean>;
  view: StudentPracticeHistoryView;
  today: string;
}) {
  const params = formatStudentPracticeHistoryParams(state);
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value) search.set(key, value);
  }
  const query = search.toString();
  return query ? `${STUDENT_ROUTES.practiceHistory}?${query}` : STUDENT_ROUTES.practiceHistory;
}

/**
 * In-place update of the current URL (path + query + hash, same origin). Only
 * the practice history params are touched, so any unrelated param survives.
 */
export function studentPracticeHistoryQueryUrl(
  updates: Record<string, string | null | undefined>
) {
  if (typeof window === "undefined") return "";
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(updates)) {
    if (value === null || value === undefined || value === "") {
      url.searchParams.delete(key);
    } else {
      url.searchParams.set(key, value);
    }
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export type StudentPracticeResultTarget = {
  href: string;
  label: string;
};

export type StudentPracticeRetakeTarget =
  | { kind: "reading"; attemptId: string }
  | { kind: "full_set"; fullSetId: string }
  | { kind: "link"; href: string; label: string }
  | null;

/**
 * The student result page for one record. Wrong-question records are never
 * rendered here (the loaders exclude them), so they have no target.
 */
export function studentPracticeRecordResultTarget(
  record: TeacherPracticeRecord,
  returnTo?: string | null
): StudentPracticeResultTarget | null {
  if (record.kind === "wrongbook") return null;
  const attemptId = record.attemptId;
  if (record.kind === "question_category") return {
    href: withStudentReturnTo(categoryResultHref(attemptId), returnTo || STUDENT_ROUTES.practiceHistory), label: "查看结果"
  };
  if (record.taskType === "full_set") {
    const fullSetId = record.source?.fullSetId;
    if (!fullSetId) return null;
    return {
      href: withStudentReturnTo(
        readingFullSetResultHref(fullSetId, attemptId, "practice-history"),
        returnTo
      ),
      label: "查看结果"
    };
  }
  if (record.taskType === "build_sentence") {
    return {
      href: withStudentReturnTo(
        `/student/results/${encodeURIComponent(attemptId)}?source=practice-history`,
        returnTo
      ),
      label: "查看结果"
    };
  }
  if (record.taskType === "email" || record.taskType === "academic_discussion") {
    const fallbackReturnTo = returnTo || STUDENT_ROUTES.practiceHistory;
    if (
      record.metric.kind === "writing"
      && record.metric.hasScore
      && record.metric.score !== null
    ) {
      return {
        href: writingReviewResultHref(attemptId, fallbackReturnTo),
        label: "查看批改"
      };
    }
    return {
      href: writingSubmissionResultHref(record.taskType, attemptId, fallbackReturnTo),
      label: "查看提交"
    };
  }
  return {
    href: withStudentReturnTo(readingResultHref(attemptId, "practice-history"), returnTo),
    label: "查看结果"
  };
}

/**
 * The existing student retake entry for one record: Reading keeps its POST
 * retake button, Full Set its runner component, and BAS / WE / AD their
 * original practice links.
 */
export function studentPracticeRecordRetakeTarget(
  record: TeacherPracticeRecord
): StudentPracticeRetakeTarget {
  if (record.kind === "wrongbook") return null;
  if (record.kind === "question_category") return record.source?.questionCategory && record.source.categoryAmount
    ? { kind: "link", href: categoryPracticeHref(record.source.questionCategory, nextWrongQuestionHistoryAmount(record.source.categoryAmount)), label: "重新练习" }
    : null;
  if (record.taskType === "full_set") {
    const fullSetId = record.source?.fullSetId;
    return fullSetId ? { kind: "full_set", fullSetId } : null;
  }
  if (record.taskType === "build_sentence") {
    const setId = record.source?.basSetId;
    return setId
      ? { kind: "link", href: `/student/practice/${encodeURIComponent(setId)}`, label: "重新练习" }
      : null;
  }
  if (record.taskType === "email" || record.taskType === "academic_discussion") {
    const assignmentId = record.source?.writingAssignmentId;
    if (assignmentId) {
      return {
        kind: "link",
        href: `/student/assignments/${encodeURIComponent(assignmentId)}?new=1`,
        label: "重新练习"
      };
    }
    const questionId = record.source?.writingQuestionId;
    if (!questionId) return null;
    return {
      kind: "link",
      href: `${WRITING_TASK_CONFIG[record.taskType].practiceHref}/${encodeURIComponent(questionId)}?new=1`,
      label: "重新练习"
    };
  }
  return { kind: "reading", attemptId: record.attemptId };
}

import type { AssignmentItemType } from "./assignmentCatalog.ts";
import { isWritingReviewItemType } from "./writingAssignments.ts";

/**
 * Teacher Assignment Detail overview.
 *
 * The overview is a pure projection of the exact rows the detail page already
 * renders: one item per (Assignment, student) pair, with `completed` produced by
 * the shared `isTeacherAssignmentStudentCompleted` rule. It therefore can never
 * disagree with the per-item statuses below it.
 *
 * Grades are display-only summaries:
 *
 *   WE / AD            -> average of published teacher scores (0-5)
 *   BAS / Reading      -> stored correct / total counts (weighted, never an
 *                         average of student percentages)
 *   Full Set           -> no stored grading, always `—`
 *
 * Only completed items with a valid grade contribute. Unfinished items are
 * never counted as zero, and a single item is never counted twice.
 */

export type AssignmentOverviewGrade = {
  correct: number;
  total: number;
};

export type AssignmentOverviewItem = {
  assignmentId: string;
  studentId: string;
  taskType: AssignmentItemType;
  /** The shared Assignment completion rule's result for this item. */
  completed: boolean;
  /** Stored grading counts of the latest valid result, when one exists. */
  grade: AssignmentOverviewGrade | null;
  /** Published teacher score (0-5) of the latest valid WE / AD submission. */
  writingScore: number | null;
};

export type AssignmentOverviewStudent = {
  studentId: string;
  studentName: string;
  /** Platform-wide latest valid practice time (student_practice_summary). */
  latestPracticeAt: string | null;
};

export type AssignmentOverviewGradeKind = "accuracy" | "score";

export type AssignmentOverviewColumn = {
  taskType: AssignmentItemType;
  label: string;
  gradeKind: AssignmentOverviewGradeKind;
};

export type AssignmentOverviewCell = {
  taskType: AssignmentItemType;
  assignedCount: number;
  completedCount: number;
  /** 0-100, from raw correct / total counts of completed items. */
  accuracyPercent: number | null;
  /** 0-5, one decimal, from published teacher scores of completed items. */
  averageScore: number | null;
};

export type AssignmentOverviewRow = {
  studentId: string;
  studentName: string;
  latestPracticeAt: string | null;
  assignedCount: number;
  completedCount: number;
  completionPercent: number;
  cells: AssignmentOverviewCell[];
};

export type AssignmentOverview = {
  columns: AssignmentOverviewColumn[];
  rows: AssignmentOverviewRow[];
  /** 全班汇总; null when the caller omits it (e.g. one-to-one batch). */
  summary: AssignmentOverviewRow | null;
};

export const ASSIGNMENT_OVERVIEW_SUMMARY_NAME = "全班汇总";

/**
 * Type columns use the same short names teachers already use in the
 * assignment UI. Category item types keep their existing tab labels so a
 * category column can never be mistaken for a normal item column.
 */
const ASSIGNMENT_OVERVIEW_COLUMN_LABELS: Record<AssignmentItemType, string> = {
  academic_discussion: "AD",
  bas_category: "BAS 分类",
  build_sentence: "BAS",
  ctw: "CTW",
  email: "WE",
  full_set: "FS",
  rap: "RAP",
  rap_category: "RAP 分类",
  rdl: "RDL"
};

export function assignmentOverviewColumnLabel(taskType: AssignmentItemType) {
  return ASSIGNMENT_OVERVIEW_COLUMN_LABELS[taskType];
}

export function assignmentOverviewGradeKind(
  taskType: AssignmentItemType
): AssignmentOverviewGradeKind {
  return isWritingReviewItemType(taskType) ? "score" : "accuracy";
}

export function buildAssignmentOverview(
  input: {
    students: ReadonlyArray<AssignmentOverviewStudent>;
    assignments: ReadonlyArray<{
      assignmentId: string;
      taskType: AssignmentItemType;
    }>;
    items: ReadonlyArray<AssignmentOverviewItem>;
  },
  options?: {
    /**
     * Batch pages omit the summary for a one-to-one assignment; a class page
     * always shows 全班汇总 even when the class currently has one member.
     */
    includeSummary?: boolean;
  }
): AssignmentOverview {
  const columns: AssignmentOverviewColumn[] = [];
  const seenTypes = new Set<AssignmentItemType>();
  for (const assignment of input.assignments) {
    if (seenTypes.has(assignment.taskType)) continue;
    seenTypes.add(assignment.taskType);
    columns.push({
      taskType: assignment.taskType,
      label: assignmentOverviewColumnLabel(assignment.taskType),
      gradeKind: assignmentOverviewGradeKind(assignment.taskType)
    });
  }

  const itemsByStudent = new Map<string, AssignmentOverviewItem[]>();
  for (const item of input.items) {
    itemsByStudent.set(item.studentId, [
      ...(itemsByStudent.get(item.studentId) ?? []),
      item
    ]);
  }

  const rows = input.students.map((student) =>
    buildOverviewRow({
      studentId: student.studentId,
      studentName: student.studentName,
      latestPracticeAt: student.latestPracticeAt,
      columns,
      items: itemsByStudent.get(student.studentId) ?? []
    })
  );

  const includeSummary = options?.includeSummary ?? input.students.length > 1;
  const summary = includeSummary
    ? buildOverviewRow({
        studentId: "summary",
        studentName: ASSIGNMENT_OVERVIEW_SUMMARY_NAME,
        latestPracticeAt: null,
        columns,
        items: input.students.flatMap(
          (student) => itemsByStudent.get(student.studentId) ?? []
        )
      })
    : null;

  return { columns, rows, summary };
}

function buildOverviewRow(input: {
  studentId: string;
  studentName: string;
  latestPracticeAt: string | null;
  columns: ReadonlyArray<AssignmentOverviewColumn>;
  items: ReadonlyArray<AssignmentOverviewItem>;
}): AssignmentOverviewRow {
  const completed = input.items.filter((item) => item.completed);
  return {
    studentId: input.studentId,
    studentName: input.studentName,
    latestPracticeAt: input.latestPracticeAt,
    assignedCount: input.items.length,
    completedCount: completed.length,
    completionPercent: percentage(completed.length, input.items.length),
    cells: input.columns.map((column) => {
      const scoped = input.items.filter(
        (item) => item.taskType === column.taskType
      );
      const completedScoped = scoped.filter((item) => item.completed);
      return {
        taskType: column.taskType,
        assignedCount: scoped.length,
        completedCount: completedScoped.length,
        accuracyPercent: column.gradeKind === "accuracy"
          ? weightedAccuracyPercent(completedScoped)
          : null,
        averageScore: column.gradeKind === "score"
          ? averageWritingScore(completedScoped)
          : null
      };
    })
  };
}

function weightedAccuracyPercent(items: ReadonlyArray<AssignmentOverviewItem>) {
  let correct = 0;
  let total = 0;
  for (const item of items) {
    if (!item.grade) continue;
    if (!Number.isFinite(item.grade.correct) || !Number.isFinite(item.grade.total)) continue;
    if (item.grade.total <= 0 || item.grade.correct < 0) continue;
    correct += Math.min(item.grade.correct, item.grade.total);
    total += item.grade.total;
  }
  return total > 0 ? percentage(correct, total) : null;
}

function averageWritingScore(items: ReadonlyArray<AssignmentOverviewItem>) {
  const scores = items.flatMap((item) => {
    const score = item.writingScore;
    return typeof score === "number" && Number.isFinite(score) && score >= 0 && score <= 5
      ? [score]
      : [];
  });
  if (scores.length === 0) return null;
  const average = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  return Math.round(average * 10) / 10;
}

function percentage(value: number, total: number) {
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, Math.round((value / total) * 100)));
}

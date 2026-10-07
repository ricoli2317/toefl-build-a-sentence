import { isWritingTaskType, type WritingTaskType } from "./writing.ts";
import type { WritingAssignmentRecipient } from "./writingAssignments.ts";

/**
 * Shared model of the teacher Writing Review list (client + server safe).
 *
 * The list order is authoritative on the server (`submitted_at DESC`, then the
 * unique attempt id); this module only derives the filter views, so the 学生
 * and 班级 tabs apply exactly the same 学生/班级 ∩ 状态 ∩ 题型 rules without
 * conflicting sorts.
 */

export type WritingReviewListStatus =
  | "pending"
  | "reviewing"
  | "published"
  | "ignored";
export type WritingReviewStatusFilter = "all" | WritingReviewListStatus;
export type WritingReviewTaskTypeFilter = "all" | WritingTaskType;

export const WRITING_REVIEW_LIST_STATUSES: readonly WritingReviewListStatus[] = [
  "pending",
  "reviewing",
  "published",
  "ignored"
];

export function isWritingReviewListStatus(value: unknown): value is WritingReviewListStatus {
  return (
    value === "pending" ||
    value === "reviewing" ||
    value === "published" ||
    value === "ignored"
  );
}

export function isWritingReviewStatusFilter(
  value: unknown
): value is WritingReviewStatusFilter {
  return value === "all" || isWritingReviewListStatus(value);
}

export function isWritingReviewTaskTypeFilter(
  value: unknown
): value is WritingReviewTaskTypeFilter {
  return value === "all" || isWritingTaskType(value);
}

/** The minimal fields every review list row needs for filtering. */
export type WritingReviewListEntry = {
  studentId: string;
  studentName: string;
  taskType: WritingTaskType;
  reviewStatus: WritingReviewListStatus;
};

/**
 * 学生/班级 ∩ 批改状态 ∩ 题型. Every supplied filter is optional so the tabs
 * can reuse the same predicate; an empty student/class id means 全部.
 *
 * 全部 is the working list and never includes 已忽略 rows: an ignored review
 * only reappears through the explicit 忽略 filter, so every count derived from
 * the visible list (badges, totals, pagination) stays consistent with what the
 * teacher actually sees.
 */
export function filterWritingReviewListEntries<T extends WritingReviewListEntry>(
  entries: readonly T[],
  filters: {
    studentId?: string;
    status?: WritingReviewStatusFilter;
    taskType?: WritingReviewTaskTypeFilter;
  }
): T[] {
  const studentId = filters.studentId?.trim() ?? "";
  const status = filters.status ?? "all";
  const taskType = filters.taskType ?? "all";
  return entries.filter(
    (entry) =>
      (studentId === "" || entry.studentId === studentId) &&
      (taskType === "all" || entry.taskType === taskType) &&
      matchesWritingReviewStatusFilter(entry.reviewStatus, status)
  );
}

export function matchesWritingReviewStatusFilter(
  reviewStatus: WritingReviewListStatus,
  status: WritingReviewStatusFilter
) {
  if (status === "all") return reviewStatus !== "ignored";
  return reviewStatus === status;
}

/**
 * Distinct students of the loaded (already teacher-scoped) review list, sorted
 * for the shared student filter. Reusing the loaded rows means the picker
 * never asks the server for anything and can only offer viewable students.
 */
export function collectWritingReviewStudentOptions<T extends WritingReviewListEntry>(
  entries: readonly T[]
): WritingAssignmentRecipient[] {
  const byId = new Map<string, string>();
  for (const entry of entries) {
    const studentId = entry.studentId?.trim();
    if (!studentId || byId.has(studentId)) continue;
    byId.set(studentId, entry.studentName?.trim() ?? "");
  }
  const collator = new Intl.Collator("zh-Hans-CN");
  return Array.from(byId, ([student_id, student_name]) => ({
    student_id,
    student_name
  })).sort(
    (left, right) =>
      collator.compare(left.student_name, right.student_name) ||
      left.student_id.localeCompare(right.student_id)
  );
}

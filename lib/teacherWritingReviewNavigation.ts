import { safeTeacherReturnTo, firstSearchParamValue } from "./teacherNavigation.ts";
import { isWritingReviewListStatus, type WritingReviewStatusFilter, type WritingReviewTaskTypeFilter } from "./teacherWritingReviewList.ts";
import { isWritingTaskType } from "./writing.ts";

export const DEFAULT_TEACHER_WRITING_REVIEW_RETURN_TO = "/teacher/writing/reviews";
export const TEACHER_WRITING_REVIEWS_HREF = "/teacher/writing/reviews";

export type TeacherWritingReviewListTab = "students" | "class";

/**
 * The review workspace accepts every known teacher drill-down source (student
 * detail pages, class-filtered lists, assignment detail pages, the class
 * review list, the AI log list), so a refresh or a shared URL keeps the back
 * link usable. Anything else falls back to the review list.
 */
export function safeWritingReviewReturnTo(value: unknown) {
  return safeTeacherReturnTo(value, DEFAULT_TEACHER_WRITING_REVIEW_RETURN_TO);
}

export function teacherWritingReviewWorkspaceHref(
  attemptId: string,
  returnTo: unknown = DEFAULT_TEACHER_WRITING_REVIEW_RETURN_TO
) {
  return `/teacher/writing/reviews/${encodeURIComponent(attemptId)}?returnTo=${encodeURIComponent(
    safeWritingReviewReturnTo(returnTo)
  )}`;
}

/**
 * Reliable URL of the review list state. The 学生 tab is the default and omits
 * `tab`; the 班级 tab always writes it, and only the active tab's own filter
 * is written so the URL always equals the visible list context. `status` and
 * `taskType` are shared by both tabs.
 */
export function teacherWritingReviewsListHref(input: {
  tab: TeacherWritingReviewListTab;
  studentId?: string;
  classId?: string;
  status?: WritingReviewStatusFilter;
  taskType?: WritingReviewTaskTypeFilter;
}) {
  const params = new URLSearchParams();
  if (input.tab === "class") {
    params.set("tab", "class");
    const classId = input.classId?.trim() ?? "";
    if (classId) params.set("classId", classId);
  } else {
    const studentId = input.studentId?.trim() ?? "";
    if (studentId) params.set("studentId", studentId);
  }
  const status = input.status && input.status !== "all" ? input.status : "";
  if (status) params.set("status", status);
  const taskType = input.taskType && input.taskType !== "all" ? input.taskType : "";
  if (taskType) params.set("taskType", taskType);
  const query = params.toString();
  return query ? `${TEACHER_WRITING_REVIEWS_HREF}?${query}` : TEACHER_WRITING_REVIEWS_HREF;
}

export type TeacherWritingReviewListInitialState = {
  tab: TeacherWritingReviewListTab;
  classId: string;
  studentId: string;
  status: WritingReviewStatusFilter;
  taskType: WritingReviewTaskTypeFilter;
};

/**
 * Parses the review list search params with safe fallbacks: an unknown tab
 * becomes 学生, and an unknown status / taskType is ignored (the list then
 * shows 全部 and the canonicalization on mount drops the invalid value).
 */
export function parseTeacherWritingReviewListSearchParams(
  searchParams?: Record<string, string | string[] | undefined>
): TeacherWritingReviewListInitialState {
  const rawStatus = firstSearchParamValue(searchParams?.status);
  const rawTaskType = firstSearchParamValue(searchParams?.taskType);
  return {
    tab: firstSearchParamValue(searchParams?.tab) === "class" ? "class" : "students",
    classId: firstSearchParamValue(searchParams?.classId),
    studentId: firstSearchParamValue(searchParams?.studentId),
    status: isWritingReviewListStatus(rawStatus) ? rawStatus : "all",
    taskType: isWritingTaskType(rawTaskType) ? rawTaskType : "all"
  };
}

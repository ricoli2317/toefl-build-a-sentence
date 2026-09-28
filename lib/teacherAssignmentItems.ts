import {
  assignmentItemTypeLabel,
  type AssignmentItemType
} from "./assignmentCatalog.ts";
import { teacherReturnToHref } from "./teacherNavigation.ts";
import { teacherWritingReviewWorkspaceHref } from "./teacherWritingReviewNavigation.ts";
import { teacherReadingAttemptHref } from "./teacherStudentPractice.ts";
import {
  getWritingAssignmentReviewAction,
  type TeacherAssignmentItemResult,
  type WritingAssignmentStudentDetail
} from "./writingAssignments.ts";

/**
 * One shared teacher-side action rule for every Assignment item row.
 *
 * WE / AD keep the existing Writing Review chain (批改). Every other item type
 * (BAS / CTW / RDL / RAP / Full Set) is graded by its own student practice
 * flow, so the teacher side only ever 查看 the existing read-only result page —
 * never a Writing Review, never a new result page.
 */
export type TeacherAssignmentItemAction = {
  href: string;
  kind: "review" | "view";
  label: string;
};

export function teacherAssignmentItemAction(input: {
  itemType: AssignmentItemType;
  student: Pick<
    WritingAssignmentStudentDetail,
    "available_result" | "latest_review_status" | "latest_submitted_attempt_id"
  >;
  studentId: string;
  returnTo?: string;
}): TeacherAssignmentItemAction | null {
  if (input.itemType === "email" || input.itemType === "academic_discussion") {
    const review = getWritingAssignmentReviewAction({
      latestReviewStatus: input.student.latest_review_status,
      latestSubmittedAttemptId: input.student.latest_submitted_attempt_id
    });
    if (!review) return null;
    return {
      href: teacherWritingReviewWorkspaceHref(review.attemptId, input.returnTo),
      kind: "review",
      label: review.label
    };
  }
  const result = input.student.available_result;
  if (!result) return null;
  const href = teacherAssignmentItemResultHref({
    itemType: input.itemType,
    result,
    studentId: input.studentId
  });
  if (!href) return null;
  return {
    href: input.returnTo ? teacherReturnToHref(href, input.returnTo) : href,
    kind: "view",
    label: "查看"
  };
}

/**
 * Maps a located student result to the existing teacher read-only route. No new
 * Assignment result page is introduced: BAS reuses 套题记录, Reading reuses the
 * Reading attempt review, Full Set reuses the Full Set review.
 */
export function teacherAssignmentItemResultHref(input: {
  itemType: AssignmentItemType;
  result: TeacherAssignmentItemResult;
  studentId: string;
}) {
  if (input.result.kind === "bas_set") {
    return `/teacher/students/${encodeURIComponent(input.studentId)}/details/${encodeURIComponent(input.result.id)}`;
  }
  if (input.result.kind === "reading_full_set") {
    return teacherReadingAttemptHref({
      attemptId: input.result.id,
      kind: "full_set",
      studentId: input.studentId
    });
  }
  return teacherReadingAttemptHref({
    attemptId: input.result.id,
    kind: "practice",
    studentId: input.studentId
  });
}

/** The item title used in Assignment rows; the snapshot is authoritative. */
export function teacherAssignmentItemLabel(
  itemType: AssignmentItemType,
  fallbackTitle: string
) {
  return fallbackTitle.trim() || assignmentItemTypeLabel(itemType);
}

export function teacherAssignmentItemWithReturnTo(
  href: string,
  returnTo?: string | null
) {
  return teacherReturnToHref(href, returnTo);
}

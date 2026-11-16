import type { AssignmentItemType } from "./assignmentCatalog.ts";
import { STUDENT_ROUTES, withStudentReturnTo } from "./studentNavigation.ts";
import { WRITING_TASK_CONFIG } from "./writing.ts";

/**
 * One shared student-side Assignment item dispatcher (client + server safe).
 *
 * Assignment is only an entrance: every item maps to the exact same canonical
 * student practice route the normal catalog uses, so the practice component,
 * question fetch and submit handler are never duplicated for Assignments.
 *
 * WE / AD keep the existing Assignment entry (`/student/assignments/{id}`),
 * which carries `assignmentId` into WritingPractice so the attempt stays
 * linked to its Assignment. BAS / CTW / RDL / RAP / Full Set enter their own
 * existing practice routes directly.
 */
export type StudentAssignmentPracticeItem = {
  assignmentId?: string | null;
  /**
   * The stable Assignment item `question_id` contract: the raw question id
   * for WE / AD, `practice_items.item_id` for BAS,
   * `reading_logical_items.logical_item_id` for CTW / RDL / RAP and the
   * full set id for Full Set.
   */
  itemId?: string | null;
  taskType: AssignmentItemType;
  /** BAS only: the raw question set the existing practice session route uses. */
  sourceSetId?: string | null;
};

/**
 * BAS and Reading practice routes are not Assignment-id routes, but their
 * start RPC still needs the Assignment hint so the server can validate the
 * real membership/item/status before granting a free unlock. The hint is never
 * trusted by itself.
 */
function withAssignmentHint(href: string, assignmentId?: string | null) {
  const id = assignmentId?.trim() ?? "";
  if (!id) return href;
  const separator = href.includes("?") ? "&" : "?";
  return `${href}${separator}assignmentId=${encodeURIComponent(id)}`;
}

export function studentAssignmentPracticeHref(
  item: StudentAssignmentPracticeItem,
  returnTo?: string | string[] | null
): string | null {
  const itemId = item.itemId?.trim() ?? "";
  const withReturnTo = (href: string) => withStudentReturnTo(href, returnTo);
  switch (item.taskType) {
    case "email":
    case "academic_discussion": {
      const assignmentId = item.assignmentId?.trim() ?? "";
      if (assignmentId) {
        return withReturnTo(`${STUDENT_ROUTES.assignments}/${encodeURIComponent(assignmentId)}`);
      }
      return itemId
        ? withReturnTo(`${WRITING_TASK_CONFIG[item.taskType].practiceHref}/${encodeURIComponent(itemId)}`)
        : null;
    }
    case "build_sentence": {
      const sourceSetId = item.sourceSetId?.trim() ?? "";
      const href = sourceSetId
        ? `${STUDENT_ROUTES.buildASentencePractice}/${encodeURIComponent(sourceSetId)}`
        : "";
      return href
        ? withReturnTo(withAssignmentHint(href, item.assignmentId))
        : null;
    }
    case "ctw":
    case "rdl":
    case "rap": {
      const href = itemId
        ? `/student/reading/practice/${encodeURIComponent(itemId)}`
        : "";
      return href
        ? withReturnTo(withAssignmentHint(href, item.assignmentId))
        : null;
    }
    case "full_set": {
      const href = itemId
        ? `${STUDENT_ROUTES.readingFullSets}/${encodeURIComponent(itemId)}`
        : "";
      return href
        ? withReturnTo(withAssignmentHint(href, item.assignmentId))
        : null;
    }
    case "bas_category": {
      const assignmentId = item.assignmentId?.trim() ?? "";
      return assignmentId
        ? withReturnTo(`/student/grammar-practice/assignment/${encodeURIComponent(assignmentId)}`)
        : null;
    }
    case "rap_category": {
      const assignmentId = item.assignmentId?.trim() ?? "";
      return assignmentId
        ? withReturnTo(`/student/question-category-practice/assignment/${encodeURIComponent(assignmentId)}`)
        : null;
    }
  }
}

/**
 * The existing student result route of a completed read-only item. WE / AD
 * return null here on purpose: their result chain stays exactly the historical
 * submission / published-review navigation.
 */
export function studentAssignmentResultHref(input: {
  attemptId?: string | null;
  itemId?: string | null;
  taskType: AssignmentItemType;
}, returnTo?: string | string[] | null): string | null {
  const attemptId = input.attemptId?.trim() ?? "";
  if (!attemptId) return null;
  switch (input.taskType) {
    case "build_sentence":
    case "bas_category":
      return withStudentReturnTo(`/student/results/${encodeURIComponent(attemptId)}`, returnTo);
    case "ctw":
    case "rdl":
    case "rap":
      return withStudentReturnTo(`/student/reading/results/${encodeURIComponent(attemptId)}`, returnTo);
    case "rap_category":
      return withStudentReturnTo(
        `/student/question-category-practice/sessions/${encodeURIComponent(attemptId)}`,
        returnTo
      );
    case "full_set": {
      const itemId = input.itemId?.trim() ?? "";
      return itemId
        ? withStudentReturnTo(`${STUDENT_ROUTES.readingFullSets}/${encodeURIComponent(itemId)}/result/${encodeURIComponent(attemptId)}`, returnTo)
        : null;
    }
    default:
      return null;
  }
}

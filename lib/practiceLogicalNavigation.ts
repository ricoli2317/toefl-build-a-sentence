import type {
  LogicalPracticeAttemptAction,
  LogicalPracticeSourceAction
} from "./practiceLogicalState.ts";
import type { PracticeTaskType } from "./practiceImporter/types.ts";

export type LogicalPracticeActionName = "start" | "resume" | "view_result" | "retake";

export const LOGICAL_PRACTICE_ROOTS: Record<PracticeTaskType, string> = {
  build_sentence: "/student/practice-sets",
  email: "/student/write-email",
  academic_discussion: "/student/academic-discussion"
};

export function parseLogicalCatalogPage(value: string | string[] | undefined) {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (!candidate || !/^[1-9]\d*$/.test(candidate)) return 1;
  const page = Number(candidate);
  return Number.isSafeInteger(page) ? page : 1;
}

export function logicalPracticeActionHref(
  taskType: PracticeTaskType,
  action: LogicalPracticeActionName,
  target: LogicalPracticeSourceAction | LogicalPracticeAttemptAction | null
) {
  if (!target) return null;

  if (taskType === "build_sentence") {
    if (action === "view_result" && "attempt_id" in target) {
      return `/student/results/${encodeURIComponent(target.attempt_id)}`;
    }
    if ((action === "start" || action === "retake") && target.source_set_id) {
      return `/student/practice/${encodeURIComponent(target.source_set_id)}`;
    }
    return null;
  }

  const root = LOGICAL_PRACTICE_ROOTS[taskType];
  if (action === "view_result" && "attempt_id" in target) {
    return `${root}/submission/${encodeURIComponent(target.attempt_id)}`;
  }
  if (action === "resume" && "attempt_id" in target && target.source_question_id) {
    return `${root}/practice/${encodeURIComponent(target.source_question_id)}?attempt=${encodeURIComponent(target.attempt_id)}`;
  }
  if ((action === "start" || action === "retake") && target.source_question_id) {
    const practiceHref = `${root}/practice/${encodeURIComponent(target.source_question_id)}`;
    return action === "retake" ? `${practiceHref}?new=1` : practiceHref;
  }
  return null;
}

export const DEFAULT_TEACHER_WRITING_REVIEW_RETURN_TO = "/teacher/writing/reviews";

const ASSIGNMENT_DETAIL_RETURN_TO =
  /^\/teacher\/writing\/assignments\/(?:batches\/)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function safeWritingReviewReturnTo(value: unknown) {
  if (
    value === DEFAULT_TEACHER_WRITING_REVIEW_RETURN_TO ||
    value === "/teacher/writing/assignments" ||
    (typeof value === "string" && ASSIGNMENT_DETAIL_RETURN_TO.test(value))
  ) {
    return value;
  }
  return DEFAULT_TEACHER_WRITING_REVIEW_RETURN_TO;
}

export function teacherWritingReviewWorkspaceHref(
  attemptId: string,
  returnTo: unknown = DEFAULT_TEACHER_WRITING_REVIEW_RETURN_TO
) {
  return `/teacher/writing/reviews/${encodeURIComponent(attemptId)}?returnTo=${encodeURIComponent(
    safeWritingReviewReturnTo(returnTo)
  )}`;
}

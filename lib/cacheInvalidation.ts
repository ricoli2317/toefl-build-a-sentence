import type { OfficialAttemptStatus } from "@/lib/studentSetStatus";

export const CACHE_INVALIDATION_CHANNEL = "tps-cache-invalidation-v1";
export const CACHE_INVALIDATION_LOCAL_EVENT = "tps-cache-invalidation";

export type CacheInvalidationMutation =
  | "PRACTICE_CATALOG_UPDATED"
  | "BAS_ATTEMPT_SUBMITTED"
  | "WRITING_DRAFT_UPDATED"
  | "WRITING_ATTEMPT_SUBMITTED"
  | "WRITING_REVIEW_UPDATED"
  | "WRITING_REVIEW_PUBLISHED"
  | "ASSIGNMENT_UPDATED"
  | "TEACHER_STATS_UPDATED";

export type CacheInvalidationDomain =
  | "studentPracticeCatalog"
  | "studentPracticeState"
  | "studentPracticeHistory"
  | "studentAttemptResult"
  | "studentWrongQuestions"
  | "studentWritingCatalog"
  | "studentWritingOverview"
  | "studentWritingHistory"
  | "studentPublishedReviews"
  | "studentAssignments"
  | "teacherStats"
  | "teacherQuestionBank"
  | "teacherWritingReviews"
  | "teacherWritingReviewWorkspace"
  | "teacherAssignments";

export type CacheInvalidationEvent = {
  type: CacheInvalidationMutation;
  studentId?: string;
  attemptId?: string;
  assignmentId?: string | null;
  assignmentQuestionSource?: "question_bank" | "custom";
  isWrongQuestionsPractice?: boolean;
  attempt?: OfficialAttemptStatus;
};

const BASE_INVALIDATION_MATRIX: Record<
  CacheInvalidationMutation,
  readonly CacheInvalidationDomain[]
> = {
  PRACTICE_CATALOG_UPDATED: [
    "studentPracticeCatalog",
    "studentPracticeHistory",
    "studentAttemptResult",
    "studentWritingCatalog",
    "studentWritingHistory",
    "studentPublishedReviews",
    "teacherStats",
    "teacherQuestionBank",
    "teacherWritingReviews",
    "teacherWritingReviewWorkspace"
  ],
  BAS_ATTEMPT_SUBMITTED: [
    "studentPracticeState",
    "studentPracticeHistory",
    "studentWrongQuestions",
    "teacherStats"
  ],
  WRITING_DRAFT_UPDATED: ["studentWritingOverview"],
  WRITING_ATTEMPT_SUBMITTED: [
    "studentWritingOverview",
    "studentWritingHistory",
    "studentPracticeHistory",
    "teacherWritingReviews"
  ],
  WRITING_REVIEW_UPDATED: [
    "teacherWritingReviews",
    "teacherWritingReviewWorkspace",
    "teacherAssignments"
  ],
  WRITING_REVIEW_PUBLISHED: [
    "teacherWritingReviews",
    "teacherWritingReviewWorkspace",
    "teacherAssignments",
    "studentWritingOverview",
    "studentPublishedReviews"
  ],
  ASSIGNMENT_UPDATED: [
    "studentAssignments",
    "studentWritingOverview",
    "teacherAssignments"
  ],
  TEACHER_STATS_UPDATED: ["teacherStats"]
};

export function cacheDomainsForEvent(
  event: CacheInvalidationEvent
): readonly CacheInvalidationDomain[] {
  const domains = new Set(BASE_INVALIDATION_MATRIX[event.type]);

  if (
    event.type === "WRITING_DRAFT_UPDATED" ||
    event.type === "WRITING_ATTEMPT_SUBMITTED"
  ) {
    if (event.assignmentId) {
      domains.add("studentAssignments");
      if (event.type === "WRITING_ATTEMPT_SUBMITTED") {
        domains.add("teacherAssignments");
      }
    } else {
      domains.add("studentWritingCatalog");
      domains.add("studentPracticeCatalog");
    }
  }

  if (event.type === "WRITING_REVIEW_PUBLISHED" && event.assignmentId) {
    domains.add("studentAssignments");
  }

  return Array.from(domains);
}

export function publishCacheInvalidation(event: CacheInvalidationEvent) {
  if (typeof window === "undefined") return;

  window.dispatchEvent(
    new CustomEvent<CacheInvalidationEvent>(CACHE_INVALIDATION_LOCAL_EVENT, {
      detail: event
    })
  );

  if (typeof BroadcastChannel === "undefined") return;
  const channel = new BroadcastChannel(CACHE_INVALIDATION_CHANNEL);
  channel.postMessage(event);
  channel.close();
}

export function subscribeToCacheInvalidation(
  callback: (event: CacheInvalidationEvent) => void
) {
  if (typeof window === "undefined") return () => undefined;

  const onLocalEvent = (event: Event) => {
    const detail = (event as CustomEvent<CacheInvalidationEvent>).detail;
    if (detail?.type) callback(detail);
  };
  window.addEventListener(CACHE_INVALIDATION_LOCAL_EVENT, onLocalEvent);

  const channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(CACHE_INVALIDATION_CHANNEL);
  const onMessage = (event: MessageEvent<CacheInvalidationEvent>) => {
    if (event.data?.type) callback(event.data);
  };
  channel?.addEventListener("message", onMessage);

  return () => {
    window.removeEventListener(CACHE_INVALIDATION_LOCAL_EVENT, onLocalEvent);
    channel?.removeEventListener("message", onMessage);
    channel?.close();
  };
}

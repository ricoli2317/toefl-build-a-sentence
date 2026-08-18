import type { OfficialAttemptStatus } from "@/lib/studentSetStatus";
import {
  publishCacheInvalidation,
  subscribeToCacheInvalidation
} from "@/lib/cacheInvalidation";

export type StudentPracticeCompletedEvent = {
  studentId: string;
  isWrongQuestionsPractice: boolean;
  attempt?: OfficialAttemptStatus;
};

export function broadcastStudentPracticeCompleted(event: StudentPracticeCompletedEvent) {
  publishCacheInvalidation({
    type: "BAS_ATTEMPT_SUBMITTED",
    ...event,
    attemptId: event.attempt?.attempt_id
  });
}

export function subscribeToStudentPracticeCompleted(
  callback: (event: StudentPracticeCompletedEvent) => void
) {
  return subscribeToCacheInvalidation((event) => {
    if (event.type !== "BAS_ATTEMPT_SUBMITTED" || !event.studentId) return;
    callback({
      studentId: event.studentId,
      isWrongQuestionsPractice: Boolean(event.isWrongQuestionsPractice),
      attempt: event.attempt
    });
  });
}

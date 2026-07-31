import type { OfficialAttemptStatus } from "@/lib/studentSetStatus";

const STUDENT_PRACTICE_COMPLETED_CHANNEL = "student-practice-completed";

export type StudentPracticeCompletedEvent = {
  studentId: string;
  isWrongQuestionsPractice: boolean;
  attempt?: OfficialAttemptStatus;
};

export function broadcastStudentPracticeCompleted(event: StudentPracticeCompletedEvent) {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return;

  const channel = new BroadcastChannel(STUDENT_PRACTICE_COMPLETED_CHANNEL);
  channel.postMessage(event);
  window.setTimeout(() => channel.close(), 0);
}

export function subscribeToStudentPracticeCompleted(
  callback: (event: StudentPracticeCompletedEvent) => void
) {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") {
    return () => undefined;
  }

  const channel = new BroadcastChannel(STUDENT_PRACTICE_COMPLETED_CHANNEL);
  const onMessage = (message: MessageEvent<StudentPracticeCompletedEvent>) => {
    if (message.data?.studentId) callback(message.data);
  };
  channel.addEventListener("message", onMessage);

  return () => {
    channel.removeEventListener("message", onMessage);
    channel.close();
  };
}

const STUDENT_PRACTICE_COMPLETED_CHANNEL = "student-practice-completed";

export type StudentPracticeCompletedEvent = {
  studentId: string;
  isWrongQuestionsPractice: boolean;
};

export function broadcastStudentPracticeCompleted(event: StudentPracticeCompletedEvent) {
  if (typeof window === "undefined" || typeof BroadcastChannel === "undefined") return;

  const channel = new BroadcastChannel(STUDENT_PRACTICE_COMPLETED_CHANNEL);
  channel.postMessage(event);
  channel.close();
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

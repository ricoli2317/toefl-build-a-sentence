import { assignmentDateKey } from "./writingAssignments.ts";

/**
 * The one server-side business date for wrong-question daily pending.
 *
 * It reuses the project's existing server calendar rule (`assignmentDateKey`,
 * Asia/Shanghai) instead of defining a second "today". The client never
 * supplies this date: every wrong-question API derives it on the server.
 */
export function wrongQuestionBusinessDate(now: Date = new Date()): string {
  return assignmentDateKey(now);
}

export function isWrongQuestionBusinessDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

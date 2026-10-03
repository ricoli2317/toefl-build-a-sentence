import type {
  WritingAttempt,
  WritingOvertimeRange,
  WritingTaskType
} from "./writing.ts";
import { normalizeWritingOvertimeRanges } from "./writingOvertime.ts";

/**
 * One-time recovery backup for a writing attempt. It only exists after the
 * student explicitly chooses "备份并重新登录" and lives in the current tab's
 * sessionStorage; normal writing never touches local storage. Credentials are
 * deliberately absent from the shape.
 */
export const WRITING_RECOVERY_STORAGE_PREFIX = "tps:writing-recovery:";
export const WRITING_RECOVERY_VERSION = 1 as const;

export type WritingRecoveryStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export type WritingRecoveryBackup = {
  version: typeof WRITING_RECOVERY_VERSION;
  attemptId: string;
  studentId: string;
  taskType: WritingTaskType;
  assignmentId: string | null;
  questionId: string;
  text: string;
  overtimeRanges: WritingOvertimeRange[];
  elapsedSeconds: number;
  remainingSeconds: number;
  savedAt: string;
};

export type WritingRecoveryAttemptIdentity = Pick<
  WritingAttempt,
  "attempt_id" | "assignment_id" | "question_id" | "task_type" | "user_id" | "status"
>;

export function getWritingRecoveryStorage(): WritingRecoveryStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function writingRecoveryStorageKey(attemptId: string) {
  return `${WRITING_RECOVERY_STORAGE_PREFIX}${attemptId}`;
}

export function createWritingRecoveryBackup(input: {
  attemptId: string;
  studentId: string;
  taskType: WritingTaskType;
  assignmentId: string | null;
  questionId: string;
  text: string;
  overtimeRanges: WritingOvertimeRange[];
  elapsedSeconds: number;
  remainingSeconds: number;
  savedAt: string;
}): WritingRecoveryBackup {
  return {
    version: WRITING_RECOVERY_VERSION,
    attemptId: input.attemptId,
    studentId: input.studentId,
    taskType: input.taskType,
    assignmentId: input.assignmentId ?? null,
    questionId: input.questionId,
    text: input.text,
    overtimeRanges: normalizeWritingOvertimeRanges(input.overtimeRanges, input.text.length),
    elapsedSeconds: Math.max(0, Math.floor(input.elapsedSeconds)),
    remainingSeconds: Math.max(0, Math.floor(input.remainingSeconds)),
    savedAt: input.savedAt
  };
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function parseWritingRecoveryBackup(raw: unknown): WritingRecoveryBackup | null {
  if (typeof raw !== "string" || !raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  if (value.version !== WRITING_RECOVERY_VERSION) return null;
  if (!isNonEmptyString(value.attemptId) || !isNonEmptyString(value.studentId)) return null;
  if (value.taskType !== "email" && value.taskType !== "academic_discussion") return null;
  if (!isNonEmptyString(value.questionId)) return null;
  if (typeof value.text !== "string") return null;
  if (
    value.assignmentId !== null
    && value.assignmentId !== undefined
    && typeof value.assignmentId !== "string"
  ) {
    return null;
  }
  const elapsedSeconds = Number(value.elapsedSeconds);
  const remainingSeconds = Number(value.remainingSeconds);
  if (
    !Number.isFinite(elapsedSeconds)
    || elapsedSeconds < 0
    || !Number.isFinite(remainingSeconds)
    || remainingSeconds < 0
  ) {
    return null;
  }
  return {
    version: WRITING_RECOVERY_VERSION,
    attemptId: value.attemptId,
    studentId: value.studentId,
    taskType: value.taskType,
    assignmentId: isNonEmptyString(value.assignmentId) ? value.assignmentId : null,
    questionId: value.questionId,
    text: value.text,
    overtimeRanges: normalizeWritingOvertimeRanges(value.overtimeRanges, value.text.length),
    elapsedSeconds: Math.floor(elapsedSeconds),
    remainingSeconds: Math.floor(remainingSeconds),
    savedAt: typeof value.savedAt === "string" ? value.savedAt : ""
  };
}

export function readWritingRecoveryBackup(
  storage: WritingRecoveryStorage | null,
  attemptId: string
): WritingRecoveryBackup | null {
  if (!storage || !attemptId) return null;
  try {
    return parseWritingRecoveryBackup(storage.getItem(writingRecoveryStorageKey(attemptId)));
  } catch {
    return null;
  }
}

export function writeWritingRecoveryBackup(
  storage: WritingRecoveryStorage | null,
  backup: WritingRecoveryBackup
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(writingRecoveryStorageKey(backup.attemptId), JSON.stringify(backup));
    return true;
  } catch {
    return false;
  }
}

export function clearWritingRecoveryBackup(
  storage: WritingRecoveryStorage | null,
  attemptId: string
) {
  if (!storage || !attemptId) return;
  try {
    storage.removeItem(writingRecoveryStorageKey(attemptId));
  } catch {
    // Removing a recovery hint is best effort.
  }
}

/**
 * A backup may only be restored by the same student into the same attempt,
 * question and assignment. Anything else is ignored (and kept untouched).
 */
export function writingRecoveryMatchesAttempt(input: {
  attempt: WritingRecoveryAttemptIdentity;
  backup: WritingRecoveryBackup;
  studentId: string;
}) {
  const { attempt, backup, studentId } = input;
  return (
    backup.studentId === studentId
    && attempt.user_id === backup.studentId
    && attempt.attempt_id === backup.attemptId
    && attempt.task_type === backup.taskType
    && attempt.question_id === backup.questionId
    && (attempt.assignment_id ?? null) === backup.assignmentId
  );
}

export function applyWritingRecoveryBackup(
  attempt: WritingAttempt,
  backup: WritingRecoveryBackup
): WritingAttempt {
  return {
    ...attempt,
    response_text: backup.text,
    overtime_ranges: backup.overtimeRanges,
    elapsed_seconds: backup.elapsedSeconds,
    remaining_seconds: backup.remainingSeconds
  };
}

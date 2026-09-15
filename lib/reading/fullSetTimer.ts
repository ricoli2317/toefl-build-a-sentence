import {
  readingFullSetCurrentModuleAttempt,
  readingFullSetRemainingSeconds,
  type ReadingFullSetAttemptSummary
} from "./fullSetAttempts.ts";

export type ReadingFullSetTimerState = {
  anchorClientMs: number;
  anchorRemainingSeconds: number;
  moduleAttemptId: string;
  running: boolean;
  timerRevision: number;
};

export type ReadingFullSetTimerMergeMode = "authoritative" | "preserve_active";

export function createReadingFullSetTimerState(
  attempt: ReadingFullSetAttemptSummary,
  clientNowMs = Date.now()
): ReadingFullSetTimerState | null {
  const moduleAttempt = readingFullSetCurrentModuleAttempt(attempt);
  if (!moduleAttempt) return null;

  const running = moduleAttempt.status === "active" && Boolean(moduleAttempt.deadlineAt);
  const remaining = running
    ? readingFullSetRemainingSeconds({
        clientNowAtSyncMs: clientNowMs,
        clientNowMs,
        deadlineAt: moduleAttempt.deadlineAt!,
        serverNow: attempt.serverNow
      })
    : moduleAttempt.status === "submitted"
      ? 0
      : moduleAttempt.remainingSeconds;

  return {
    anchorClientMs: clientNowMs,
    anchorRemainingSeconds: clampRemaining(remaining, moduleAttempt.timeLimitSeconds),
    moduleAttemptId: moduleAttempt.moduleAttemptId,
    running,
    timerRevision: moduleAttempt.timerRevision
  };
}

export function readReadingFullSetTimer(
  timer: ReadingFullSetTimerState | null,
  clientNowMs = Date.now()
) {
  if (!timer) return 0;
  if (!timer.running) return timer.anchorRemainingSeconds;
  const elapsedMilliseconds = Math.max(0, clientNowMs - timer.anchorClientMs);
  return Math.max(
    0,
    Math.ceil((timer.anchorRemainingSeconds * 1000 - elapsedMilliseconds) / 1000)
  );
}

/**
 * Routine answer/cursor/load responses may carry an older deadline snapshot.
 * They can advance metadata, but they never rebase a running client clock.
 * Only bootstrap, resume, and the completion of a server-protected load use an
 * authoritative rebase.
 */
export function mergeReadingFullSetTimerState(input: {
  clientNowMs?: number;
  current: ReadingFullSetTimerState | null;
  incomingAttempt: ReadingFullSetAttemptSummary;
  mode?: ReadingFullSetTimerMergeMode;
}) {
  const clientNowMs = input.clientNowMs ?? Date.now();
  const incoming = createReadingFullSetTimerState(input.incomingAttempt, clientNowMs);
  if (!incoming || !input.current || incoming.moduleAttemptId !== input.current.moduleAttemptId) {
    return incoming;
  }
  if (incoming.timerRevision < input.current.timerRevision) return input.current;
  if (input.mode === "authoritative" || !input.current.running || !incoming.running) return incoming;
  return {
    ...input.current,
    timerRevision: Math.max(input.current.timerRevision, incoming.timerRevision)
  };
}

export function isReadingFullSetAttemptTimerStale(
  current: ReadingFullSetAttemptSummary,
  incoming: ReadingFullSetAttemptSummary
) {
  if (current.attemptId !== incoming.attemptId) return true;
  if (attemptProgressRank(incoming) < attemptProgressRank(current)) return true;
  const currentModule = readingFullSetCurrentModuleAttempt(current);
  const incomingModule = readingFullSetCurrentModuleAttempt(incoming);
  if (!currentModule || !incomingModule) return false;
  if (incomingModule.moduleNumber < currentModule.moduleNumber) return true;
  return incomingModule.moduleAttemptId === currentModule.moduleAttemptId
    && incomingModule.timerRevision < currentModule.timerRevision;
}

function attemptProgressRank(attempt: ReadingFullSetAttemptSummary) {
  if (attempt.status === "completed") return 5;
  if (attempt.module2) return 4;
  if (attempt.module1.status === "submitted") return 3;
  return 2;
}

function clampRemaining(value: number, timeLimitSeconds: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(timeLimitSeconds, Math.ceil(value)));
}

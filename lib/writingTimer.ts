import type { WritingMode } from "./writing.ts";

export type ActiveWritingTimerSnapshot = {
  elapsedSeconds: number;
  remainingSeconds: number;
};

export function calculateActiveWritingTimer(input: {
  persistedElapsedSeconds: number | null | undefined;
  persistedRemainingSeconds: number;
  sessionStartedAtMs: number;
  writingMode: WritingMode;
  nowMs?: number;
}): ActiveWritingTimerSnapshot {
  const activeSeconds = Math.max(
    0,
    Math.floor(((input.nowMs ?? Date.now()) - input.sessionStartedAtMs) / 1000)
  );
  const persistedElapsedSeconds = Math.max(
    0,
    Math.floor(input.persistedElapsedSeconds ?? 0)
  );
  const persistedRemainingSeconds = Math.max(
    0,
    Math.floor(input.persistedRemainingSeconds)
  );
  return {
    elapsedSeconds: persistedElapsedSeconds + activeSeconds,
    remainingSeconds:
      input.writingMode === "exam"
        ? Math.max(0, persistedRemainingSeconds - activeSeconds)
        : persistedRemainingSeconds
  };
}

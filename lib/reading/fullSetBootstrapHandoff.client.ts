"use client";

import type {
  ReadingFullSetBootstrapPayload,
  ReadingFullSetModuleAttemptSummary
} from "./fullSetAttempts.ts";
import type { ReadingFullSetPerformanceTrace } from "./fullSetPerformance.client.ts";

export type ReadingFullSetBootstrapHandoff = ReadingFullSetBootstrapPayload & {
  storedAt: number;
  trace: ReadingFullSetPerformanceTrace;
};

const HANDOFF_TTL_MS = 60_000;
const handoffs = new Map<string, ReadingFullSetBootstrapHandoff>();

export function readingFullSetBootstrapHandoffKey(
  attemptId: string,
  moduleAttempt: ReadingFullSetModuleAttemptSummary
) {
  return `${attemptId}:${moduleAttempt.moduleNumber}:${moduleAttempt.moduleAttemptId}`;
}

export function storeReadingFullSetBootstrapHandoff(
  payload: ReadingFullSetBootstrapPayload,
  trace: ReadingFullSetPerformanceTrace,
  now = Date.now()
) {
  pruneExpiredHandoffs(now);
  const moduleAttempt = payload.runner.attempt.module1;
  const key = readingFullSetBootstrapHandoffKey(payload.runner.attempt.attemptId, moduleAttempt);
  handoffs.set(key, { ...payload, storedAt: now, trace });
  return key;
}

export function consumeReadingFullSetBootstrapHandoff(input: {
  attemptId: string;
  expectedFullSetId: string;
  now?: number;
}) {
  const now = input.now ?? Date.now();
  pruneExpiredHandoffs(now);
  const prefix = `${input.attemptId}:1:`;
  for (const [key, handoff] of Array.from(handoffs.entries())) {
    if (!key.startsWith(prefix)) continue;
    handoffs.delete(key);
    if (
      handoff.runner.attempt.attemptId !== input.attemptId
      || handoff.runner.attempt.fullSetId !== input.expectedFullSetId
      || handoff.runner.attempt.module1.moduleAttemptId !== key.slice(prefix.length)
    ) return null;
    return handoff;
  }
  return null;
}

export function clearReadingFullSetBootstrapHandoffs() {
  handoffs.clear();
}

function pruneExpiredHandoffs(now: number) {
  for (const [key, handoff] of Array.from(handoffs.entries())) {
    if (now - handoff.storedAt > HANDOFF_TTL_MS) handoffs.delete(key);
  }
}

import { publishCacheInvalidation } from "./cacheInvalidation.ts";

/**
 * Teacher Writing Review moderation (退回 / 忽略), shared by the list UI and
 * the teacher API route.
 *
 * 待批改 is the only state a teacher may moderate; the server re-validates it
 * at request time (see the moderate_teacher_writing_attempts RPC), so every
 * helper here treats the server result as the single source of truth.
 */

export type WritingReviewModerationAction = "return" | "ignore";

export type WritingReviewModerationOutcome = "returned" | "ignored" | "skipped";

export type WritingReviewModerationReason =
  | "not_found"
  | "not_submitted"
  | "already_reviewed"
  | "draft_exists"
  | "failed";

export type WritingReviewModerationResult = {
  attemptId: string;
  outcome: WritingReviewModerationOutcome;
  reason: WritingReviewModerationReason | null;
};

export const WRITING_REVIEW_MODERATION_MAX_ATTEMPTS = 100;

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const MODERATION_OUTCOMES: readonly WritingReviewModerationOutcome[] = [
  "returned",
  "ignored",
  "skipped"
];

const MODERATION_REASONS: readonly WritingReviewModerationReason[] = [
  "not_found",
  "not_submitted",
  "already_reviewed",
  "draft_exists",
  "failed"
];

export function isWritingReviewModerationAction(
  value: unknown
): value is WritingReviewModerationAction {
  return value === "return" || value === "ignore";
}

/**
 * Validates the client-provided attempt ids exactly once: every id must be a
 * UUID, duplicates collapse, and the request is capped so one batch stays a
 * single bounded transaction.
 */
export function normalizeWritingReviewModerationAttemptIds(
  value: unknown
): string[] {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const id = item.trim().toLowerCase();
    if (!UUID_PATTERN.test(id) || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= WRITING_REVIEW_MODERATION_MAX_ATTEMPTS) break;
  }
  return ids;
}

export function parseWritingReviewModerationResult(
  value: unknown
): WritingReviewModerationResult | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const attemptId =
    typeof record.attemptId === "string"
      ? record.attemptId
      : typeof record.attempt_id === "string"
        ? record.attempt_id
        : "";
  const outcome = record.outcome;
  if (!UUID_PATTERN.test(attemptId)) return null;
  if (
    typeof outcome !== "string" ||
    !MODERATION_OUTCOMES.includes(outcome as WritingReviewModerationOutcome)
  ) {
    return null;
  }
  const reason =
    typeof record.reason === "string" &&
    MODERATION_REASONS.includes(record.reason as WritingReviewModerationReason)
      ? (record.reason as WritingReviewModerationReason)
      : null;
  return {
    attemptId: attemptId.toLowerCase(),
    outcome: outcome as WritingReviewModerationOutcome,
    reason
  };
}

export function parseWritingReviewModerationResponse(
  value: unknown
): { results: WritingReviewModerationResult[] } | null {
  if (typeof value !== "object" || value === null) return null;
  const results = (value as { results?: unknown }).results;
  if (!Array.isArray(results)) return null;
  const parsed: WritingReviewModerationResult[] = [];
  for (const item of results) {
    const result = parseWritingReviewModerationResult(item);
    if (!result) return null;
    parsed.push(result);
  }
  return { results: parsed };
}

export function writingReviewModerationSucceededIds(
  results: readonly WritingReviewModerationResult[]
): Set<string> {
  const succeeded = new Set<string>();
  for (const result of results) {
    if (result.outcome !== "skipped") succeeded.add(result.attemptId);
  }
  return succeeded;
}

/**
 * The list view after a moderation batch: a returned attempt disappears from
 * every teacher view (it is a student draft again); an ignored attempt stays
 * in 全部 / 已忽略 with its new status.
 */
export function applyWritingReviewModerationToEntries<
  T extends { attemptId: string; reviewStatus: string }
>(
  entries: readonly T[],
  action: WritingReviewModerationAction,
  results: readonly WritingReviewModerationResult[]
): T[] {
  const succeeded = writingReviewModerationSucceededIds(results);
  if (succeeded.size === 0) return [...entries];
  if (action === "return") {
    return entries.filter((entry) => !succeeded.has(entry.attemptId));
  }
  return entries.map((entry) =>
    succeeded.has(entry.attemptId)
      ? { ...entry, reviewStatus: "ignored" }
      : entry
  );
}

export function writingReviewModerationNotice(
  action: WritingReviewModerationAction,
  results: readonly WritingReviewModerationResult[]
) {
  const succeeded = writingReviewModerationSucceededIds(results).size;
  const skipped = results.length - succeeded;
  const verb = action === "return" ? "已退回" : "已忽略";
  const base = `${verb} ${succeeded} 条。`;
  if (skipped <= 0) return base;
  const skipHint =
    action === "return"
      ? "可能已进入批改或已有新的草稿"
      : "可能已进入批改或状态已变化";
  return `${base}另有 ${skipped} 条未处理（${skipHint}）。`;
}

/**
 * Teacher and student caches consumed by one moderation batch. Events are
 * grouped by (student, assignment) so a standalone return only refreshes the
 * standalone catalog and an assignment return only refreshes that student's
 * assignment list. Publishing happens before the acting tab stores its own
 * optimistic payload, so this tab's own invalidation can never overwrite it.
 */
export function publishWritingReviewModerationInvalidation(
  action: WritingReviewModerationAction,
  attempts: ReadonlyArray<{
    attemptId: string;
    studentId: string;
    assignmentId: string | null;
  }>,
  results: readonly WritingReviewModerationResult[]
) {
  const succeeded = writingReviewModerationSucceededIds(results);
  if (succeeded.size === 0) return;
  const groups = new Map<
    string,
    { studentId: string; assignmentId: string | null; attemptIds: string[] }
  >();
  for (const attempt of attempts) {
    if (!succeeded.has(attempt.attemptId)) continue;
    const key = `${attempt.studentId}\u0000${attempt.assignmentId ?? ""}`;
    const group = groups.get(key) ?? {
      studentId: attempt.studentId,
      assignmentId: attempt.assignmentId,
      attemptIds: []
    };
    group.attemptIds.push(attempt.attemptId);
    groups.set(key, group);
  }
  for (const group of Array.from(groups.values())) {
    publishCacheInvalidation({
      type:
        action === "return"
          ? "WRITING_ATTEMPT_RETURNED"
          : "WRITING_REVIEW_UPDATED",
      studentId: group.studentId,
      assignmentId: group.assignmentId,
      ...(group.attemptIds.length === 1 ? { attemptId: group.attemptIds[0] } : {})
    });
  }
}

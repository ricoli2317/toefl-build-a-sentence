import type { WritingAttempt } from "./writing.ts";
import { correctionVersion, frozenWritingCorrectionSource } from "./writingCorrection.ts";
import { hydratePublishedWritingReviewSnapshot } from "./writingPublishedReview.ts";
import { parseWritingRevisionState, revisionStateKey, type WritingRevisionState } from "./writingRevisionState.ts";

// Deliberately closed, not an environment-variable override of the DB gate.
// Opening the production entry requires a separately approved release.
export const WRITING_CORRECTION_ENTRY_ENABLED = true;

export function correctionAnnotations(attempt: WritingAttempt) {
  const source = frozenWritingCorrectionSource(attempt);
  const review = source.published_review;
  const hydrated = hydratePublishedWritingReviewSnapshot({
    taskType: attempt.task_type,
    responseText: source.original_response_text,
    publishedLanguageEdits: review.language_edits,
    publishedContentFeedback: review.content_feedback,
    publishedScores: review.scores,
    publishedTeacherComment: review.teacher_comment,
    publishedAt: review.published_at
  });
  // Scores, overall feedback, teacher comment and sample never reach the view.
  return { language_edits: hydrated.language_edits, content_feedback: { items: hydrated.content_feedback.items } };
}

export class CorrectionRequestError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.status = status; this.code = code;
  }
}

export type WritingCorrectionClient = ReturnType<typeof createWritingCorrectionClient>;
export type CorrectionSend = (path: string, init: RequestInit) => Promise<Response>;

export type WritingCorrectionHistoryItem = Pick<WritingAttempt,
  "attempt_id" | "original_attempt_id" | "task_type" | "status" | "word_count" |
  "draft_version" | "saved_at" | "submitted_at" | "created_at"> & {
  reviewStatus: "pending" | "reviewing" | "published" | "ignored" | null;
};

/** Same transport contract for the authenticated API and network-free fixtures. */
export function createWritingCorrectionClient(send: CorrectionSend, onUpdated?: (attempt: WritingAttempt) => void) {
  async function request(path: string, init: RequestInit, expectedId: string, mode: "create" | "load" | "save" | "submit") {
    const response = await send(path, { ...init, cache: "no-store" });
    const result = await response.json();
    if (!response.ok || result.error) {
      throw new CorrectionRequestError(response.status, result.code ?? "CORRECTION_REQUEST_FAILED",
        result.code === "WRITING_CORRECTION_NOT_ENABLED"
          ? mode === "submit" ? "订正功能尚未开放，未能提交；已保存的正文仍保留。" : "订正功能尚未开放。当前内容未保存。"
          : result.error ?? "订正操作失败，请稍后重试。");
    }
    const attempt = result.attempt as WritingAttempt | undefined;
    if (!attempt || !["draft", "submitted"].includes(attempt.status) || !attempt.original_attempt_id
      || (attempt.status === "submitted" && !attempt.submitted_at)
      || ((mode === "create" || mode === "save") && attempt.status !== "draft")
      || (mode === "submit" && (attempt.status !== "submitted" || !attempt.submitted_at))
      || (mode === "create" ? attempt.original_attempt_id !== expectedId : attempt.attempt_id !== expectedId)
      || typeof attempt.response_text !== "string") {
      throw new Error("无法编辑这份订正草稿，请返回原稿批改页。");
    }
    correctionVersion(attempt.draft_version);
    const source = frozenWritingCorrectionSource(attempt);
    if (attempt.revision_state != null) attempt.revision_state = parseWritingRevisionState(attempt.revision_state, source.original_response_text, attempt.response_text);
    correctionAnnotations(attempt);
    // Even an idempotent retry must refresh this browser's history: the first
    // response (and its mutation metadata) may have been lost in transit.
    if (mode === "submit" || result.cacheInvalidation?.type === "WRITING_CORRECTION_UPDATED") onUpdated?.(attempt);
    return attempt;
  }
  const json = (body: unknown) => ({ headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return {
    create: (originalAttemptId: string) => request("/api/writing/corrections", {
      method: "POST", ...json({ originalAttemptId })
    }, originalAttemptId, "create"),
    load: (attemptId: string) => request(`/api/writing/corrections/${encodeURIComponent(attemptId)}`, {
      method: "GET"
    }, attemptId, "load"),
    save: async (attemptId: string, responseText: string, expectedDraftVersion: number, revisionState?: WritingRevisionState) => {
      const saved = await request(
      `/api/writing/corrections/${encodeURIComponent(attemptId)}`, {
        method: "PATCH", ...json({ action: "save", responseText, expectedDraftVersion, ...(revisionState ? { revisionState } : {}) })
      }, attemptId, "save");
      if (revisionState && (saved.response_text !== responseText || !saved.revision_state ||
        revisionStateKey(saved.revision_state) !== revisionStateKey(revisionState) || saved.draft_version !== expectedDraftVersion + 1)) throw new Error("保存确认的正文、修订状态或版本不一致，已保留本地修改。");
      return saved;
    },
    submit: (attemptId: string, expectedDraftVersion: number) => request(
      `/api/writing/corrections/${encodeURIComponent(attemptId)}`, {
        method: "PATCH", ...json({ action: "submit", expectedDraftVersion })
      }, attemptId, "submit"),
    history: async (originalAttemptId: string): Promise<WritingCorrectionHistoryItem[]> => {
      const response = await send(`/api/writing/corrections?originalAttemptId=${encodeURIComponent(originalAttemptId)}`, { method: "GET", cache: "no-store" });
      const result = await response.json();
      if (!response.ok || result.error) throw new CorrectionRequestError(response.status, result.code ?? "CORRECTION_REQUEST_FAILED", result.error ?? "无法加载订正历史。");
      if (result.originalAttemptId !== originalAttemptId || !Array.isArray(result.attempts)
        || result.attempts.some((item: WritingCorrectionHistoryItem) => item.original_attempt_id !== originalAttemptId)) throw new Error("订正历史关联无效。");
      return result.attempts;
    }
  };
}

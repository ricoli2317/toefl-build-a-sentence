import type { WritingAttempt, WritingCorrectionSourceSnapshot } from "./writing.ts";

export class WritingCorrectionError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "WritingCorrectionError";
    this.code = code;
    this.status = status;
  }
}

export function correctionId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value)) {
    throw new WritingCorrectionError("INVALID_INPUT", "写作记录标识无效。", 400);
  }
  return value.toLowerCase();
}

export function correctionBody(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !fields.includes(key))) {
    throw new WritingCorrectionError("INVALID_INPUT", "订正请求字段无效。", 400);
  }
  return value as Record<string, unknown>;
}

export function correctionVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new WritingCorrectionError("INVALID_INPUT", "请提供有效的草稿版本。", 400);
  }
  return value;
}

/** Only the immutable v1 source, never a fresh query of the parent's review. */
export function frozenWritingCorrectionSource(attempt: Pick<WritingAttempt,
  "attempt_kind" | "task_type" | "question_id" | "set_id" | "correction_source_snapshot">): WritingCorrectionSourceSnapshot {
  const s = attempt.correction_source_snapshot;
  if (attempt.attempt_kind !== "correction" || !s || s.schema_version !== 1
    || typeof s.original_response_text !== "string" || !s.original_context
    || !s.question || typeof s.question !== "object" || Array.isArray(s.question)
    || s.question.question_id !== attempt.question_id || s.question.set_id !== attempt.set_id
    || (s.question_source !== "custom" && s.question_source !== "question_bank")
    || !s.published_review || !Array.isArray(s.published_review.language_edits)
    || !s.published_review.content_feedback || !s.published_review.scores
    || typeof s.published_review.review_id !== "string"
    || typeof s.published_review.published_at !== "string"
    || typeof s.published_review.teacher_comment !== "string") {
    throw new WritingCorrectionError("CORRECTION_SOURCE_INVALID", "订正来源数据无效。", 500);
  }
  return s;
}

export function correctionDatabaseError(error: { code?: string; message?: string }): WritingCorrectionError {
  const message = error.message ?? "";
  const errors: Record<string, [number, string]> = {
    WRITING_CORRECTION_NOT_ENABLED: [503, "订正功能尚未开放。"],
    WRITING_CORRECTION_NOT_FOUND: [404, "未找到这条写作记录。"],
    WRITING_CORRECTION_ACCOUNT_FORBIDDEN: [403, "当前账号不能进行订正。"],
    WRITING_CORRECTION_ORIGINAL_MISMATCH: [409, "只能订正本人已提交的原始作文。"],
    WRITING_CORRECTION_PUBLISHED_REVIEW_REQUIRED: [409, "原稿尚无已发布批改。"],
    WRITING_CORRECTION_QUESTION_REQUIRED: [409, "无法加载订正原题。"],
    WRITING_CORRECTION_VERSION_CONFLICT: [409, "草稿版本已变化，请重新读取后再保存。"],
    WRITING_CORRECTION_SUBMITTED_LOCKED: [409, "订正已提交，不能修改正文。"],
    WRITING_CORRECTION_INVALID_INPUT: [400, "订正请求无效。"],
    WRITING_CORRECTION_REVISION_REQUIRED: [409, "请先同时保存正文和修订状态，再提交订正。"],
    WRITING_CORRECTION_REVISION_INVALID: [400, "修订状态与冻结原文、正文或版本不一致。"]
  };
  const code = Object.keys(errors).find((key) => message === key);
  if (code) return new WritingCorrectionError(code, errors[code][1], errors[code][0]);
  if (["PGRST202", "PGRST205", "42883", "42P01"].includes(error.code ?? "")) {
    return new WritingCorrectionError("CORRECTION_BACKEND_NOT_READY", "订正后端尚未就绪。", 503);
  }
  return new WritingCorrectionError("CORRECTION_DATABASE_FAILED", "订正操作失败，请稍后重试。", 500);
}

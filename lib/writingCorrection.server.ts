import type { SupabaseClient } from "@supabase/supabase-js";
import type { WritingAttempt } from "./writing.ts";
import { readAllSupabaseRows } from "./supabasePagination.ts";
import { correctionBody, correctionDatabaseError, correctionId, correctionVersion,
  frozenWritingCorrectionSource, WritingCorrectionError } from "./writingCorrection.ts";
import { initializeWritingRevision, parseWritingRevisionState, type WritingRevisionState } from "./writingRevisionState.ts";

type CorrectionResult = { attempt: WritingAttempt; resumed?: boolean; alreadySubmitted?: boolean };

/** userId comes ONLY from requireWritingStudent, never from a request body. */
export async function createOrResumeWritingCorrection(db: SupabaseClient, userId: string, value: unknown) {
  const body = correctionBody(value, ["originalAttemptId"]);
  return runCorrectionRpc(db, "create_or_resume_writing_correction", {
    p_student: userId, p_original_attempt: correctionId(body.originalAttemptId)
  });
}

export async function mutateWritingCorrection(db: SupabaseClient, userId: string, attemptId: string, value: unknown) {
  const body = correctionBody(value, ["action", "expectedDraftVersion", "responseText", "revisionState"]);
  const action = body.action;
  if (action !== "save" && action !== "submit") {
    throw new WritingCorrectionError("INVALID_INPUT", "订正操作无效。", 400);
  }
  if (action === "save" ? typeof body.responseText !== "string" : "responseText" in body || "revisionState" in body) {
    throw new WritingCorrectionError("INVALID_INPUT", "保存需提供正文；提交只能提交已保存的正文。", 400);
  }
  const version = correctionVersion(body.expectedDraftVersion);
  let state: WritingRevisionState | undefined;
  if (action === "save") {
    const owned = await loadOwnedWritingCorrection(db, userId, attemptId);
    if (owned.attempt.status !== "draft") throw new WritingCorrectionError("WRITING_CORRECTION_SUBMITTED_LOCKED", "订正已提交，不能修改正文。", 409);
    if (owned.attempt.draft_version !== version) throw new WritingCorrectionError("WRITING_CORRECTION_VERSION_CONFLICT", "草稿版本已变化，请重新读取后再保存。", 409);
    if (owned.attempt.revision_state && body.revisionState == null) throw new WritingCorrectionError("INVALID_INPUT", "已使用修订编辑器的草稿必须同时保存修订状态。", 400);
    try { state = initializeWritingRevision(owned.attempt.correction_source_snapshot!.original_response_text, body.responseText as string, body.revisionState as WritingRevisionState | undefined); }
    catch { throw new WritingCorrectionError("INVALID_INPUT", "修订状态与冻结原文或保存正文不一致。", 400); }
  }
  return runCorrectionRpc(db, action === "save" ? "save_writing_correction_revision" : "submit_writing_correction", {
    p_student: userId, p_attempt: correctionId(attemptId),
    p_expected_version: version,
    ...(action === "save" ? { p_response_text: body.responseText, p_revision_state: state } : {})
  });
}

async function runCorrectionRpc(db: SupabaseClient, name: string, args: Record<string, unknown>) {
  const { data, error } = await db.rpc(name, args);
  if (error) throw correctionDatabaseError(error);
  const result = data as CorrectionResult | null;
  if (!result?.attempt || result.attempt.attempt_kind !== "correction"
    || result.attempt.user_id !== args.p_student
    || (args.p_attempt !== undefined && result.attempt.attempt_id !== args.p_attempt)
    || (args.p_original_attempt !== undefined && result.attempt.original_attempt_id !== args.p_original_attempt)) {
    throw new WritingCorrectionError("CORRECTION_DATABASE_FAILED", "订正返回数据无效。", 500);
  }
  frozenWritingCorrectionSource(result.attempt);
  result.attempt = await attachWritingCorrectionRevision(db, result.attempt);
  return {
    ...result,
    // Returned as metadata; server-side code never emits browser events.
    cacheInvalidation: result.resumed || result.alreadySubmitted ? null : {
      type: "WRITING_CORRECTION_UPDATED" as const, attemptKind: "correction" as const,
      studentId: result.attempt.user_id, attemptId: result.attempt.attempt_id,
      originalAttemptId: result.attempt.original_attempt_id
    }
  };
}

export async function loadOwnedWritingCorrection(db: SupabaseClient, userId: string, attemptId: string) {
  const { data, error } = await db.from("writing_attempts").select("*")
    .eq("attempt_kind", "correction").eq("user_id", userId)
    .eq("attempt_id", correctionId(attemptId)).maybeSingle();
  if (error) throw correctionDatabaseError(error);
  if (!data) throw new WritingCorrectionError("WRITING_CORRECTION_NOT_FOUND", "未找到这条订正。", 404);
  const attempt = await attachWritingCorrectionRevision(db, data as WritingAttempt);
  const source = frozenWritingCorrectionSource(attempt);
  return { attempt, question: source.question, question_source: source.question_source };
}

/** Called only AFTER owner/teacher authorization. Never queries an arbitrary
 * attempt on behalf of a browser. Read skew fails closed, not silent Diff repair. */
export async function attachWritingCorrectionRevision<T extends Pick<WritingAttempt, "attempt_id" | "attempt_kind" | "task_type" | "question_id" | "set_id" | "correction_source_snapshot" | "draft_version" | "response_text">>(db: SupabaseClient, attempt: T): Promise<T & { revision_state: WritingRevisionState | null }> {
  const { data, error } = await db.from("writing_correction_revision_states").select("revision_state,saved_draft_version").eq("attempt_id", attempt.attempt_id).maybeSingle();
  if (error) throw correctionDatabaseError(error);
  if (!data) return { ...attempt, revision_state: null };
  const row = data as { revision_state: unknown; saved_draft_version: number };
  try {
    if (!Number.isSafeInteger(row.saved_draft_version) || row.saved_draft_version > attempt.draft_version) throw new Error("Read version skew");
    const source = frozenWritingCorrectionSource(attempt);
    return { ...attempt, revision_state: parseWritingRevisionState(row.revision_state, source.original_response_text, attempt.response_text) };
  } catch { throw new WritingCorrectionError("CORRECTION_REVISION_INVALID", "修订数据与正文版本不一致，请重新读取；未覆盖任何内容。", 409); }
}

export async function loadWritingCorrectionHistory(db: SupabaseClient, userId: string, originalAttemptId: string) {
  const parentId = correctionId(originalAttemptId);
  const parent = await db.from("writing_attempts").select("attempt_id")
    .eq("attempt_kind", "original").eq("user_id", userId).eq("attempt_id", parentId).maybeSingle();
  if (parent.error) throw correctionDatabaseError(parent.error);
  if (!parent.data) throw new WritingCorrectionError("WRITING_CORRECTION_NOT_FOUND", "未找到这条原稿。", 404);
  const result = await readAllSupabaseRows((from, to) => db.from("writing_attempts")
    .select("attempt_id,attempt_kind,original_attempt_id,task_type,status,word_count,draft_version,saved_at,submitted_at,created_at,writing_correction_reviews(status,published_at)")
    .eq("attempt_kind", "correction").eq("user_id", userId).eq("original_attempt_id", parentId)
    .order("created_at", { ascending: false }).order("attempt_id", { ascending: false }).range(from, to));
  if (result.error) throw correctionDatabaseError(result.error);
  return { originalAttemptId: parentId, attempts: (result.data ?? []).map((row) => {
    const reviews = row.writing_correction_reviews as { status: string; published_at: string | null }[] | { status: string; published_at: string | null } | null;
    const review = Array.isArray(reviews) ? reviews[0] : reviews;
    const { writing_correction_reviews: _reviews, ...item } = row;
    return { ...item, reviewStatus: row.status === "draft" ? null : review?.published_at ? "published" : review?.status ?? "pending" };
  }) };
}

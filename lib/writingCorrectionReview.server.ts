import type { SupabaseClient } from "@supabase/supabase-js";
import { isDeepStrictEqual } from "node:util";
import { countEnglishWords, type WritingQuestion, type WritingTaskType } from "./writing.ts";
import type { WritingCorrectionSourceSnapshot } from "./writing.ts";
import { frozenWritingCorrectionSource, WritingCorrectionError } from "./writingCorrection.ts";
import {
  assertWritingReviewTeacher,
  loadAuthorizedWritingReviewSource,
  WritingReviewWorkspaceServerError
} from "./writingReviewWorkspaceServer.ts";
import {
  getWritingReviewProviderConfig,
  isWritingReviewProviderError,
  requestWritingReviewStructuredOutput
} from "./writingReviewProvider.ts";
import {
  runWritingReviewHedgedRequest,
  type WritingReviewHedgeRun
} from "./writingReviewHedgedRequest.ts";
import { writingReviewPipelineTiming } from "./writingReviewPipeline.ts";
import {
  buildWritingCorrectionMessages,
  WRITING_CORRECTION_PROMPT_VERSION,
  type CorrectionPromptInput
} from "./writingCorrectionReviewPrompt.ts";
import {
  validateWritingCorrectionReview,
  WRITING_CORRECTION_SCHEMA_NAME,
  WRITING_CORRECTION_SCHEMA_VERSION,
  writingCorrectionReviewJsonSchema,
  type WritingCorrectionReview
} from "./writingCorrectionReviewSchema.ts";
import type { CorrectionWorkspace } from "./writingCorrectionReview.ts";
import {
  assertCorrectionReviewMatchesSource,
  assertPublishedSnapshot,
  buildCorrectionPublishedSnapshot,
  correctionOriginalScore,
  correctionReviewState,
  correctionSourceIssues,
  parseCorrectionTeacherOverrides,
  CorrectionReviewValidationError,
  type CorrectionPublishedSnapshot,
  type CorrectionReviewState,
  type CorrectionSourceIssue,
  type CorrectionTeacherOverrides
} from "./writingCorrectionReview.ts";
import { getPreferredUserDisplayName } from "./userDisplayName.ts";
import type { AccountActor } from "./accountAccess.ts";
import { attachWritingCorrectionRevision } from "./writingCorrection.server.ts";
import { correctionDisplayName } from "./writingCorrectionTitle.server.ts";
import { persistWritingReviewAiLogBestEffort, classifyWritingReviewAiFailure } from "./writingReviewAiLog.ts";
import type { OpenRouterWritingReviewResponse } from "./openrouterWritingReview.ts";

const REVIEW_FIELDS =
  "review_id,attempt_id,task_type,status,prompt_version,schema_version,ai_model,ai_generated_at,ai_review,teacher_overrides,published_review,published_at,created_at,updated_at";

export type { CorrectionWorkspace };

export type CorrectionReviewErrorCode =
  | "UNAUTHORIZED"
  | "CORRECTION_NOT_FOUND"
  | "CORRECTION_NOT_SUBMITTED"
  | "CORRECTION_REVIEW_INVALID"
  | "CORRECTION_REVIEW_LOCKED"
  | "CORRECTION_AI_FAILED"
  | "CORRECTION_AI_TIMEOUT"
  | "CORRECTION_REVIEW_SAVE_FAILED"
  | "CORRECTION_REVIEW_PUBLISH_FAILED";

export class CorrectionReviewServerError extends Error {
  code: CorrectionReviewErrorCode;
  status: number;
  cause?: unknown;
  constructor(code: CorrectionReviewErrorCode, message: string, status: number, cause?: unknown) {
    super(message);
    this.name = "CorrectionReviewServerError";
    this.code = code;
    this.status = status;
    this.cause = cause;
  }
}

type ReviewRow = {
  review_id: string;
  attempt_id: string;
  task_type: string;
  status: string;
  prompt_version: string;
  schema_version: string;
  ai_model: string | null;
  ai_generated_at: string | null;
  ai_review: unknown;
  teacher_overrides: unknown;
  published_review: unknown;
  published_at: string | null;
  created_at: string;
  updated_at: string;
};

export async function loadCorrectionReviewWorkspace(
  supabase: SupabaseClient,
  actor: AccountActor,
  attemptId: string
): Promise<CorrectionWorkspace> {
  assertWritingReviewTeacher({ error: null, userId: actor.userId });
  const source = await loadAuthorizedWritingReviewSource(supabase, actor, attemptId, {
    allowCorrectionSource: true
  });
  const attempt = source.attempt;
  if (attempt.attempt_kind !== "correction") {
    throw new CorrectionReviewServerError(
      "CORRECTION_NOT_FOUND",
      "未找到这条订正。",
      404
    );
  }
  if (attempt.status !== "submitted") {
    throw new CorrectionReviewServerError(
      "CORRECTION_NOT_SUBMITTED",
      "只有已提交的订正才能进行 AI 评价。",
      409
    );
  }
  const snapshot = frozenWritingCorrectionSource(attempt);
  const revisionAttempt = await attachWritingCorrectionRevision(supabase, attempt);
  // Phase 1A already enforces this in the database; the server repeats it so a
  // corrupted snapshot can never be scored under the wrong rubric.
  const snapshotTaskType = snapshot.original_context.task_type;
  if (snapshotTaskType !== attempt.task_type) {
    throw new CorrectionReviewServerError(
      "CORRECTION_REVIEW_INVALID",
      "订正快照的题型与订正记录不一致。",
      500
    );
  }
  const issues = correctionSourceIssues(snapshot);
  const originalScore = correctionOriginalScore(snapshot);

  const [reviewResult, profileResult] = await Promise.all([
    supabase
      .from("writing_correction_reviews")
      .select(REVIEW_FIELDS)
      .eq("attempt_id", attemptId)
      .maybeSingle(),
    supabase
      .from("profiles")
      .select("id,email,full_name")
      .eq("id", attempt.user_id)
      .maybeSingle()
  ]);
  if (reviewResult.error) {
    throw new CorrectionReviewServerError(
      "CORRECTION_REVIEW_SAVE_FAILED",
      "暂时无法加载订正评价，请稍后重试。",
      500,
      reviewResult.error
    );
  }
  if (profileResult.error) {
    throw new CorrectionReviewServerError(
      "CORRECTION_REVIEW_SAVE_FAILED",
      "暂时无法加载学生信息。",
      500,
      profileResult.error
    );
  }

  const row = (reviewResult.data as ReviewRow | null) ?? null;
  if (row && row.task_type !== attempt.task_type) {
    throw new CorrectionReviewServerError(
      "CORRECTION_REVIEW_INVALID",
      "订正评价的题型与订正记录不一致。",
      500
    );
  }
  const ai = row ? readAiReview(row) : null;
  const teacher = row
    ? parseCorrectionTeacherOverrides(row.teacher_overrides, issues, ai?.new_issues.length ?? 0)
    : parseCorrectionTeacherOverrides(null, issues, 0);
  const question = snapshot.question as WritingQuestion;
  const profile = profileResult.data as { email?: string | null; full_name?: string | null } | null;
  const published = row?.status === "published"
    ? assertPublishedSnapshot(row.published_review)
    : null;
  if (row?.status === "published" && !published) {
    throw new CorrectionReviewServerError(
      "CORRECTION_REVIEW_INVALID",
      "已发布订正评价缺少冻结快照。",
      500
    );
  }

  return {
    attempt: {
      attempt_id: attempt.attempt_id,
      original_attempt_id: attempt.original_attempt_id ?? "",
      user_id: attempt.user_id,
      assignment_id: attempt.assignment_id ?? null,
      task_type: attempt.task_type,
      student_name: getPreferredUserDisplayName({
        email: profile?.email,
        profileFullName: profile?.full_name
      }),
      word_count: attempt.word_count,
      submitted_at: attempt.submitted_at
    },
    question,
    display_name: await correctionDisplayName(supabase, attempt),
    question_source: snapshot.question_source,
    source: {
      original_response_text: snapshot.original_response_text,
      original_score: originalScore,
      published_at: snapshot.published_review.published_at,
      review_id: snapshot.published_review.review_id
    },
    corrected_response_text: attempt.response_text,
    corrected_word_count: countEnglishWords(attempt.response_text),
    revision_state: revisionAttempt.revision_state,
    review: {
      review_id: row?.review_id ?? null,
      status: row?.status === "published" ? "published" : row?.status === "ignored" ? "ignored" : "reviewing",
      updated_at: row?.updated_at ?? null,
      prompt_version: row?.prompt_version ?? WRITING_CORRECTION_PROMPT_VERSION,
      schema_version: row?.schema_version ?? WRITING_CORRECTION_SCHEMA_VERSION,
      ai_model: row?.ai_model ?? null,
      ai_generated_at: row?.ai_generated_at ?? null,
      published_at: row?.published_at ?? null,
      teacher,
      ai,
      // Teachers always edit the working draft. Students use ONLY published_review.
      state: correctionReviewState({ issues, originalScore, ai, teacher }),
      published
    }
  };
}

export async function saveCorrectionReview(
  supabase: SupabaseClient,
  actor: AccountActor,
  attemptId: string,
  body: unknown,
  options?: { publish?: boolean; now?: () => Date }
): Promise<CorrectionWorkspace> {
  const workspace = await loadCorrectionReviewWorkspace(supabase, actor, attemptId);
  const payload = isRecord(body) ? body : {};
  const issues = correctionSourceIssues(
    frozenWritingCorrectionSource(
      await reloadCorrectionAttempt(supabase, actor, attemptId)
    )
  );
  const teacher = parseCorrectionTeacherOverrides(
    payload.teacher,
    issues,
    workspace.review.state.new_issues.length
  );
  const publish = options?.publish === true;
  const now = (options?.now ?? (() => new Date()))().toISOString();
  const state = correctionReviewState({
    issues,
    originalScore: workspace.source.original_score,
    ai: workspace.review.ai,
    teacher
  });

  const mutation: Record<string, unknown> = {
    attempt_id: attemptId,
    task_type: workspace.attempt.task_type,
    status: publish || workspace.review.status === "published" ? "published" : "reviewing",
    prompt_version: WRITING_CORRECTION_PROMPT_VERSION,
    schema_version: WRITING_CORRECTION_SCHEMA_VERSION,
    teacher_overrides: teacher
  };
  if (publish) {
    const snapshot = buildCorrectionPublishedSnapshot({
      state,
      aiModel: workspace.review.ai_model,
      aiGeneratedAt: workspace.review.ai_generated_at,
      publishedAt: now
    });
    if (workspace.review.published && isDeepStrictEqual(
      { ...snapshot, published_at: workspace.review.published.published_at }, workspace.review.published
    ) && isDeepStrictEqual(teacher, workspace.review.teacher)) return workspace;
    mutation.published_review = snapshot;
    mutation.published_at = now;
  }

  let query = workspace.review.review_id
    ? supabase.from("writing_correction_reviews").update(mutation).eq("review_id", workspace.review.review_id)
    : supabase.from("writing_correction_reviews").insert(mutation);
  if (workspace.review.review_id && workspace.review.updated_at) query = query.eq("updated_at", workspace.review.updated_at);
  const { data, error } = await query.select("review_id").maybeSingle();
  if (error || !data) {
    throw new CorrectionReviewServerError(
      publish ? "CORRECTION_REVIEW_PUBLISH_FAILED" : "CORRECTION_REVIEW_SAVE_FAILED",
      !error ? "评价已被另一窗口更新，请重新读取后再修改。" : publish ? "发布失败，请稍后重试。" : "保存失败，请稍后重试。",
      !error ? 409 : 500,
      error
    );
  }
  return loadCorrectionReviewWorkspace(supabase, actor, attemptId);
}

export async function generateCorrectionReview(
  supabase: SupabaseClient,
  actor: AccountActor,
  attemptId: string,
  options?: {
    now?: () => Date;
    env?: Partial<NodeJS.ProcessEnv>;
    /** Test seam; production always uses the real provider layer. */
    requestStructuredOutput?: typeof requestWritingReviewStructuredOutput;
  }
): Promise<{
  workspace: CorrectionWorkspace;
  teacher_overrides_preserved: boolean;
  telemetry: ReturnType<typeof correctionTelemetry>;
}> {
  const workspace = await loadCorrectionReviewWorkspace(supabase, actor, attemptId);
  if (workspace.review.status === "published") {
    throw new CorrectionReviewServerError(
      "CORRECTION_REVIEW_LOCKED",
      "订正评价已发布，重新生成会改变已冻结的结果，已阻止。",
      409
    );
  }
  const source = await reloadCorrectionAttempt(supabase, actor, attemptId);
  const snapshot = frozenWritingCorrectionSource(source);
  const issues = correctionSourceIssues(snapshot);
  const promptInput = correctionPromptInput(source, snapshot);
  const messages = buildWritingCorrectionMessages(promptInput);
  const requestId = crypto.randomUUID();
  let config: ReturnType<typeof getWritingReviewProviderConfig>;
  try {
    config = getWritingReviewProviderConfig(options?.env);
  } catch (error) {
    await persistWritingReviewAiLogBestEffort(supabase, {
      ...classifyWritingReviewAiFailure(error), request_id: requestId,
      operation: workspace.review.ai ? "full_regenerate" : "generate_ai", attempt_id: attemptId,
      task_type: source.task_type, model: "not_configured", prompt_version: WRITING_CORRECTION_PROMPT_VERSION,
      schema_version: WRITING_CORRECTION_SCHEMA_VERSION, elapsed_ms: 0
    }, "writing_correction_ai_logs");
    throw error;
  }
  const requestStructuredOutput =
    options?.requestStructuredOutput ?? requestWritingReviewStructuredOutput;

  const timing = writingReviewPipelineTiming("c3", options?.env);
  const run: WritingReviewHedgeRun<CorrectionOutcome> =
    await runWritingReviewHedgedRequest<CorrectionOutcome>({
      hedgeDelayMs: timing.hedgeDelayMs,
      overallDeadlineMs: timing.deadlineMs,
      request: async (_branch, signal) => {
        try {
          const response = await requestStructuredOutput(config, messages, {
            jsonSchema: writingCorrectionReviewJsonSchema as unknown as Record<string, unknown>,
            schemaName: WRITING_CORRECTION_SCHEMA_NAME,
            reasoningEffort: "high",
            signal
          });
          let parsed: unknown;
          try {
            parsed = JSON.parse(response.content);
          } catch {
            return { result: "invalid_json", review: null, response, failure: null };
          }
          const validation = validateWritingCorrectionReview(
            parsed,
            issues.map((issue) => issue.issue_id)
          );
          if (!validation.ok) {
            return {
              result: "semantic_schema_error",
              review: null,
              response,
              failure: new CorrectionReviewValidationError(validation.errors.join("; "))
            };
          }
          const review = parsed as WritingCorrectionReview;
          assertCorrectionReviewMatchesSource(review, issues, source.task_type);
          return { result: "success", review, response, failure: null };
        } catch (error) {
          return {
            result: outcomeResultFor(error),
            review: null,
            response: null,
            failure: error
          };
        }
      },
      isSuccess: (outcome) => outcome.result === "success",
      resultOf: (outcome) => outcome.result
    });

  const winner = run.winner_outcome;
  const log = async (status: "success" | "failed", stage: "review_persistence" | "schema_validation" | "response_parsing" | "provider_request", error?: unknown) => {
    const response = (winner ?? run.final_outcome)?.response;
    const failure = error ? classifyWritingReviewAiFailure(error) : null;
    await persistWritingReviewAiLogBestEffort(supabase, {
      request_id: requestId, operation: workspace.review.ai ? "full_regenerate" : "generate_ai",
      attempt_id: attemptId, task_type: source.task_type, model: response?.model ?? config.model,
      prompt_version: WRITING_CORRECTION_PROMPT_VERSION, schema_version: WRITING_CORRECTION_SCHEMA_VERSION,
      ...failure, status, pipeline_stage: stage,
      ...(status === "failed" && !error ? { error_type: run.final_outcome?.result ?? "timeout", error_code: "CORRECTION_AI_FAILED", error_message: "订正 AI 调用未产生有效评价。" } : {}),
      elapsed_ms: run.end_to_end_elapsed_ms, end_to_end_elapsed_ms: run.end_to_end_elapsed_ms,
      generation_id: response?.generationId ?? null, ...response?.usage,
      hedge_triggered: run.hedge_triggered, requests_started: run.requests_started, winner: run.winner,
      primary_result: run.primary.result, primary_elapsed_ms: run.primary.elapsed_ms,
      hedge_result: run.hedge?.result ?? null, hedge_elapsed_ms: run.hedge?.elapsed_ms ?? null,
      loser_status: run.loser_status,
      diagnostics: { cost_observability: response?.costObservability ?? null, correction: true }
    }, "writing_correction_ai_logs");
  };
  if (!winner || winner.result !== "success" || !winner.review || !winner.response) {
    const failure = run.final_outcome?.failure;
    const result = run.final_outcome?.result;
    await log("failed", run.timed_out || result === "provider_error" || result === "timeout" ? "provider_request" : result === "invalid_json" ? "response_parsing" : "schema_validation", failure);
    if (run.timed_out) {
      throw new CorrectionReviewServerError(
        "CORRECTION_AI_TIMEOUT",
        "订正评价请求超时，未保存任何结果。",
        504,
        failure
      );
    }
    if (isWritingReviewProviderError(failure)) {
      throw new CorrectionReviewServerError(
        "CORRECTION_AI_FAILED",
        "AI 订正评价失败，未保存任何结果。",
        502,
        failure
      );
    }
    throw new CorrectionReviewServerError(
      "CORRECTION_AI_FAILED",
      "AI 订正评价结果未通过校验，未保存任何结果。",
      502,
      failure
    );
  }

  const now = (options?.now ?? (() => new Date()))().toISOString();
  const preserved = Object.keys(workspace.review.teacher.issue_statuses).length > 0 ||
    workspace.review.teacher.correction_score !== null;
  const { error } = await supabase
    .from("writing_correction_reviews")
    .upsert(
      {
        attempt_id: attemptId,
        task_type: source.task_type,
        status: "reviewing",
        prompt_version: WRITING_CORRECTION_PROMPT_VERSION,
        schema_version: WRITING_CORRECTION_SCHEMA_VERSION,
        ai_model: winner.response.model,
        ai_generated_at: now,
        ai_review: winner.review
      },
      { onConflict: "attempt_id" }
    );
  if (error) {
    await log("failed", "review_persistence", error);
    throw new CorrectionReviewServerError(
      "CORRECTION_REVIEW_SAVE_FAILED",
      "AI 结果已生成，但保存失败，请重试。",
      500,
      error
    );
  }

  await log("success", "review_persistence");

  return {
    workspace: await loadCorrectionReviewWorkspace(supabase, actor, attemptId),
    teacher_overrides_preserved: preserved,
    telemetry: correctionTelemetry(run, timing.deadlineMs, timing.hedgeDelayMs)
  };
}

type CorrectionOutcome = {
  result: string;
  review: WritingCorrectionReview | null;
  response: OpenRouterWritingReviewResponse | null;
  failure: unknown;
};

function outcomeResultFor(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  if (code === "AI_REQUEST_TIMEOUT") return "timeout";
  return "provider_error";
}

function correctionTelemetry(
  run: WritingReviewHedgeRun<CorrectionOutcome>,
  deadlineMs: number,
  hedgeDelayMs: number
) {
  return {
    hedge_triggered: run.hedge_triggered,
    requests_started: run.requests_started,
    winner: run.winner,
    end_to_end_elapsed_ms: run.end_to_end_elapsed_ms,
    primary_result: run.primary.result,
    hedge_result: run.hedge?.result ?? null,
    timed_out: run.timed_out,
    deadline_ms: deadlineMs,
    hedge_delay_ms: hedgeDelayMs,
    model: run.winner_outcome?.response?.model ?? null,
    generation_id: run.winner_outcome?.response?.generationId ?? null
  };
}

async function reloadCorrectionAttempt(
  supabase: SupabaseClient,
  actor: AccountActor,
  attemptId: string
) {
  const source = await loadAuthorizedWritingReviewSource(supabase, actor, attemptId, {
    allowCorrectionSource: true
  });
  if (source.attempt.attempt_kind !== "correction" || source.attempt.status !== "submitted") {
    throw new CorrectionReviewServerError("CORRECTION_NOT_FOUND", "未找到这条订正。", 404);
  }
  return source.attempt;
}

function correctionPromptInput(
  attempt: { task_type: WritingTaskType; response_text: string },
  snapshot: WritingCorrectionSourceSnapshot
): CorrectionPromptInput {
  const review = snapshot.published_review;
  const languageEdits = (Array.isArray(review.language_edits) ? review.language_edits : [])
    .map((raw) => raw as Record<string, unknown>)
    .filter((edit) => typeof edit?.edit_id === "string")
    .map((edit) => ({
      issue_id: edit.edit_id as string,
      category: typeof edit.category === "string" ? edit.category : "other",
      severity: typeof edit.severity === "string" ? edit.severity : "minor",
      original_text: typeof edit.original_text === "string" ? edit.original_text : "",
      replacement_text:
        typeof edit.replacement_text === "string" ? edit.replacement_text : "",
      explanation: typeof edit.explanation === "string" ? edit.explanation : ""
    }));
  const feedback = review.content_feedback as { items?: unknown } | null;
  const contentFeedback = (Array.isArray(feedback?.items) ? feedback!.items : [])
    .map((raw) => raw as Record<string, unknown>)
    .filter((item) => typeof item?.feedback_id === "string")
    .map((item) => ({
      issue_id: item.feedback_id as string,
      category: typeof item.category === "string" ? item.category : "other",
      original_sentence:
        typeof item.original_sentence === "string" ? item.original_sentence : "",
      issue: typeof item.issue === "string" ? item.issue : "",
      suggestion: typeof item.suggestion === "string" ? item.suggestion : "",
      proposed_revision:
        typeof item.proposed_revision === "string" ? item.proposed_revision : ""
    }));
  return {
    taskType: snapshot.original_context.task_type ?? attempt.task_type,
    question: snapshot.question as unknown as Record<string, unknown>,
    originalResponseText: snapshot.original_response_text,
    correctedResponseText: attempt.response_text,
    correctedWordCount: countEnglishWords(attempt.response_text),
    originalScore: correctionOriginalScore(snapshot),
    languageEdits,
    contentFeedback
  };
}

function readAiReview(row: ReviewRow): WritingCorrectionReview | null {
  if (!row.ai_review) return null;
  return row.ai_review as WritingCorrectionReview;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function correctionReviewServerError(error: unknown): CorrectionReviewServerError | null {
  if (error instanceof CorrectionReviewServerError) return error;
  if (error instanceof CorrectionReviewValidationError) {
    return new CorrectionReviewServerError(
      "CORRECTION_REVIEW_INVALID",
      error.message,
      error.status
    );
  }
  if (error instanceof WritingReviewWorkspaceServerError) {
    return new CorrectionReviewServerError("CORRECTION_NOT_FOUND", error.message, error.status);
  }
  if (error instanceof WritingCorrectionError) {
    return new CorrectionReviewServerError(
      "CORRECTION_REVIEW_INVALID",
      error.message,
      error.status
    );
  }
  return null;
}

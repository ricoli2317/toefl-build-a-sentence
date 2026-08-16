import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import {
  OpenRouterWritingReviewError,
  EMPTY_OPENROUTER_USAGE,
  WRITING_REVIEW_PROMPT_VERSION,
  requestOpenRouterWritingReview,
  type OpenRouterTokenUsage
} from "@/lib/openrouterWritingReview";
import {
  classifyWritingReviewAiFailure,
  persistWritingReviewAiLogBestEffort,
  writingReviewAiProviderDiagnostic
} from "@/lib/writingReviewAiLog";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  regenerateFullWritingReview,
  WritingReviewFullRegenerationError,
  type FullRegenerationUpdate,
  type WritingReviewFullRegenerationRepository
} from "@/lib/writingReviewFullRegeneration";
import {
  AI_REVIEW_SCHEMA_VERSION_V22,
  AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA,
  parseAIReviewRawResultV22,
  parseAIReviewRawResultV22ForResponse
} from "@/lib/writingReviewSchemaV22";
import {
  requestProductionWritingReviewHedged,
  WRITING_REVIEW_PRODUCTION_MODEL,
  WRITING_REVIEW_PRODUCTION_REASONING,
  WritingReviewProductionValidationError,
  type WritingReviewProductionHedgeTelemetry
} from "@/lib/writingReviewProductionHedge";
import {
  readWritingAttemptForReview,
  readWritingQuestionForReview
} from "@/lib/writingReviewSource";
import {
  assertWritingReviewTeacher,
  loadWritingReviewWorkspace,
  WritingReviewWorkspaceServerError
} from "@/lib/writingReviewWorkspaceServer";
import type { LanguageEditOverlapNormalizationDiagnostic } from "@/lib/writingReviewLanguageEditNormalization";

export const dynamic = "force-dynamic";

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}

function createRepository(
  supabase: ReturnType<typeof createServiceSupabase>
): WritingReviewFullRegenerationRepository {
  return {
    async findAttempt(attemptId) {
      const { data, error } = await readWritingAttemptForReview(supabase, attemptId);
      if (error) throw error;
      return data;
    },
    async findReview(attemptId) {
      const { data, error } = await supabase
        .from("writing_reviews")
        .select("review_id,status,ai_review_raw,language_edits,scores,content_feedback,teacher_comment")
        .eq("attempt_id", attemptId)
        .maybeSingle();
      if (error) throw error;
      if (!data) return null;
      return {
        review_id: String(data.review_id),
        status: data.status === "published" ? "published" : "reviewing",
        ai_review_raw: data.ai_review_raw,
        language_edits: data.language_edits,
        scores: data.scores,
        content_feedback: data.content_feedback,
        teacher_comment: data.teacher_comment
      };
    },
    async findQuestion(taskType, questionId) {
      const { data, error } = await readWritingQuestionForReview(
        supabase,
        taskType,
        questionId
      );
      if (error) throw error;
      return data;
    },
    async updateWorkingReview(attemptId, update: FullRegenerationUpdate) {
      const { data, error } = await supabase
        .from("writing_reviews")
        .update(update)
        .eq("attempt_id", attemptId)
        .select("review_id")
        .maybeSingle();
      if (error || !data) throw error ?? new Error("Review update returned no row.");
      return { review_id: String(data.review_id) };
    }
  };
}

export async function POST(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  const requestId = crypto.randomUUID();
  let operationStartedAt: number | null = null;
  let aiStartedAt: number | null = null;
  let aiTaskType: "email" | "academic_discussion" | null = null;
  let aiModel: string = WRITING_REVIEW_PRODUCTION_MODEL;
  let aiUsage: OpenRouterTokenUsage = { ...EMPTY_OPENROUTER_USAGE };
  let hedgeTelemetry: WritingReviewProductionHedgeTelemetry | null = null;
  let generationId: string | null = null;
  let overlapDiagnostic: LanguageEditOverlapNormalizationDiagnostic | null = null;
  const overlapDiagnosticsByBranch = new Map<
    "primary" | "hedge",
    LanguageEditOverlapNormalizationDiagnostic
  >();
  let aiLogClient: ReturnType<typeof createServiceSupabase> | null = null;
  try {
    assertWritingReviewTeacher(
      await requireUserWithRole(bearerToken(request), "teacher")
    );
    const supabase = createServiceSupabase();
    aiLogClient = supabase;
    operationStartedAt = Date.now();
    const overwriteTeacherContent =
      new URL(request.url).searchParams.get("teacher_content") === "overwrite";
    await regenerateFullWritingReview(params.attemptId, {
      repository: createRepository(supabase),
      requestAI: async (input) => {
        aiStartedAt = Date.now();
        aiTaskType = input.taskType;
        try {
          const result = await requestProductionWritingReviewHedged(input, {
            requestAI: (requestInput, signal) =>
              requestOpenRouterWritingReview(requestInput, {
                jsonSchema:
                  AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA as unknown as Record<
                    string,
                    unknown
                  >,
                modelOverride: WRITING_REVIEW_PRODUCTION_MODEL,
                reasoningEffort: WRITING_REVIEW_PRODUCTION_REASONING,
                signal
              }),
            parseRawReview: parseAIReviewRawResultV22,
            parseReview: (value, responseText, branch) =>
              parseAIReviewRawResultV22ForResponse(value, responseText, {
                attemptId: params.attemptId,
                requestId,
                onLanguageEditOverlapNormalization(diagnostic) {
                  overlapDiagnosticsByBranch.set(branch, diagnostic);
                }
              }),
            onComplete(telemetry) {
              hedgeTelemetry = telemetry;
              aiUsage = telemetry.winner_usage ?? telemetry.final_usage ?? {
                ...EMPTY_OPENROUTER_USAGE
              };
              aiModel =
                telemetry.winner_model ?? WRITING_REVIEW_PRODUCTION_MODEL;
              generationId =
                telemetry.winner_generation_id ?? telemetry.final_generation_id;
              overlapDiagnostic = telemetry.winner
                ? overlapDiagnosticsByBranch.get(telemetry.winner) ?? null
                : null;
            }
          });
          return result.response;
        } catch (error) {
          if (error instanceof WritingReviewProductionValidationError) {
            throw new WritingReviewFullRegenerationError(
              "AI_RESPONSE_INVALID",
              "新的 AI 初批未通过 v2.2 格式或原文定位校验，原批改未改变。",
              502,
              error
            );
          }
          throw error;
        }
      },
      parseReview: (value, responseText) =>
        parseAIReviewRawResultV22ForResponse(value, responseText)
    }, {
      preserveTeacherContent: !overwriteTeacherContent
    });
    const workspace = await loadWritingReviewWorkspace(supabase, params.attemptId);
    await logPipeline();
    return json({ review: workspace.review });
  } catch (error) {
    await logPipeline(error);
    if (
      error instanceof WritingReviewFullRegenerationError ||
      error instanceof WritingReviewWorkspaceServerError ||
      error instanceof OpenRouterWritingReviewError
    ) {
      return json(
        { error: error.code, code: error.code, message: error.message },
        { status: error.status }
      );
    }
    console.error("Unexpected full writing review regeneration error", {
      attemptId: params.attemptId,
      error: error instanceof Error ? error.message : "Unknown error"
    });
    return json(
      { code: "INTERNAL_SERVER_ERROR", message: "AI 初批重新生成失败，原批改未改变。" },
      { status: 500 }
    );
  }

  async function logPipeline(error?: unknown) {
    if (operationStartedAt === null || !aiLogClient) return;
    const classified = error ? classifyWritingReviewAiFailure(error) : null;
    const outcome = classified
      ? aiStartedAt === null && classified.pipeline_stage === "review_persistence"
        ? { ...classified, pipeline_stage: "request_preparation" as const }
        : classified
      : overlapDiagnostic
        ? {
            status: "recovered" as const,
            pipeline_stage: "normalization" as const,
            error_type: "language_edit_overlap",
            error_code: "LANGUAGE_EDIT_OVERLAP",
            error_message: "Overlapping Language Edits were normalized deterministically.",
            validation_issues: []
          }
        : {
            status: "success" as const,
            pipeline_stage: "review_persistence" as const,
            error_type: null,
            error_code: null,
            error_message: null,
            validation_issues: []
          };
    await persistWritingReviewAiLogBestEffort(aiLogClient, {
      request_id: requestId,
      operation: "full_regenerate",
      attempt_id: params.attemptId,
      task_type: aiTaskType,
      model: aiModel,
      prompt_version: WRITING_REVIEW_PROMPT_VERSION,
      schema_version: AI_REVIEW_SCHEMA_VERSION_V22,
      ...outcome,
      elapsed_ms:
        hedgeTelemetry?.end_to_end_elapsed_ms ??
        Date.now() - (aiStartedAt ?? operationStartedAt),
      end_to_end_elapsed_ms:
        operationStartedAt === null ? null : Date.now() - operationStartedAt,
      generation_id: generationId,
      normalization_applied: overlapDiagnostic !== null,
      diagnostics: overlapDiagnostic
        ? { language_edit_overlap: overlapDiagnostic }
        : {},
      ...writingReviewAiProviderDiagnostic(error),
      ...aiUsage,
      ...(hedgeTelemetry
        ? {
            hedge_triggered: hedgeTelemetry.hedge_triggered,
            requests_started: hedgeTelemetry.requests_started,
            winner: hedgeTelemetry.winner,
            primary_result: hedgeTelemetry.primary_result,
            primary_elapsed_ms: hedgeTelemetry.primary_elapsed_ms,
            primary_cost: hedgeTelemetry.primary_cost,
            hedge_result: hedgeTelemetry.hedge_result,
            hedge_elapsed_ms: hedgeTelemetry.hedge_elapsed_ms,
            hedge_cost: hedgeTelemetry.hedge_cost,
            loser_status: hedgeTelemetry.loser_status,
            winner_cost: hedgeTelemetry.winner_cost,
            observed_completed_cost: hedgeTelemetry.observed_completed_cost
          }
        : {})
    });
    aiStartedAt = null;
  }
}

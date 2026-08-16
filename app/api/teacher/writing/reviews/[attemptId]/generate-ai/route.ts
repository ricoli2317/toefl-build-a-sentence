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
  AIReviewValidationError
} from "@/lib/writingReviewSchema";
import {
  AI_REVIEW_SCHEMA_VERSION_V22,
  AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA,
  parseAIReviewRawResultV22,
  parseAIReviewRawResultV22ForResponse,
  type AIReviewResultV22
} from "@/lib/writingReviewSchemaV22";
import {
  requestProductionWritingReviewHedged,
  WRITING_REVIEW_PRODUCTION_MODEL,
  WRITING_REVIEW_PRODUCTION_REASONING,
  WritingReviewProductionValidationError,
  type WritingReviewProductionHedgeTelemetry
} from "@/lib/writingReviewProductionHedge";
import {
  WritingReviewGenerationError,
  generateAndSaveWritingReview,
  writingReviewAttemptResponseText,
  type ReviewableWritingAttempt,
  type ReviewQuestion,
  type WritingReviewInsert,
  type WritingReviewRepository
} from "@/lib/writingReviewGeneration";
import {
  readWritingAttemptForReview,
  readWritingQuestionForReview
} from "@/lib/writingReviewSource";
import type { LanguageEditOverlapNormalizationDiagnostic } from "@/lib/writingReviewLanguageEditNormalization";
import {
  mergeRegeneratedWritingReviewItems,
  mergeRegeneratedWritingReviewTeacherState
} from "@/lib/writingReviewFullRegeneration";
import { loadWritingReviewWorkspace } from "@/lib/writingReviewWorkspaceServer";

export const dynamic = "force-dynamic";

type DatabaseError = { message: string };

class WritingReviewDatabaseError extends Error {
  code: "DATABASE_READ_FAILED" | "REVIEW_SAVE_FAILED";
  status = 500;

  constructor(code: "DATABASE_READ_FAILED" | "REVIEW_SAVE_FAILED", message: string) {
    super(message);
    this.name = "WritingReviewDatabaseError";
    this.code = code;
  }
}

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}

function createWritingReviewRepository(
  supabase: ReturnType<typeof createServiceSupabase>,
  overwriteTeacherContent: boolean
): WritingReviewRepository {
  let reviewResponseText = "";
  let manualReview: {
    review_id: string;
    ai_review_raw: unknown;
    language_edits: unknown;
    scores: unknown;
    content_feedback: unknown;
    teacher_comment: unknown;
  } | null = null;
  return {
    async findAttempt(attemptId) {
      const { data, error } = await readWritingAttemptForReview(supabase, attemptId);
      throwReadError(error, "writing attempt");
      reviewResponseText = writingReviewAttemptResponseText(data);
      return data as ReviewableWritingAttempt | null;
    },

    async findExistingReview(attemptId) {
      const { data, error } = await supabase
        .from("writing_reviews")
        .select("review_id,ai_generated_at,ai_review_raw,language_edits,scores,content_feedback,teacher_comment")
        .eq("attempt_id", attemptId)
        .maybeSingle();
      throwReadError(error, "existing writing review");
      if (!data) return null;
      if (typeof data.ai_generated_at === "string" && data.ai_generated_at.length > 0) {
        return { review_id: String(data.review_id) };
      }
      manualReview = {
        review_id: String(data.review_id),
        ai_review_raw: data.ai_review_raw,
        language_edits: data.language_edits,
        scores: data.scores,
        content_feedback: data.content_feedback,
        teacher_comment: data.teacher_comment
      };
      return null;
    },

    async findQuestion(taskType, questionId) {
      const { data, error } = await readWritingQuestionForReview(
        supabase,
        taskType,
        questionId
      );
      throwReadError(error, "original writing question");
      return data as ReviewQuestion | null;
    },

    async insertReview(input: WritingReviewInsert) {
      if (manualReview) {
        const aiScores = input.scores as AIReviewResultV22["scores"];
        const mergedItems = overwriteTeacherContent
          ? {
              language_edits: input.language_edits,
              content_feedback: input.content_feedback.items
            }
          : mergeRegeneratedWritingReviewItems(
              reviewResponseText,
              input.language_edits as AIReviewResultV22["language_edits"],
              input.content_feedback.items as AIReviewResultV22["content_feedback"],
              manualReview
            );
        const teacherState = overwriteTeacherContent
          ? {
              scores: structuredClone(aiScores),
              overall_feedback: input.content_feedback.overall_feedback,
              teacher_comment: ""
            }
          : mergeRegeneratedWritingReviewTeacherState(
              aiScores,
              manualReview,
              input.content_feedback.overall_feedback
            );
        const { data, error } = await supabase
          .from("writing_reviews")
          .update({
            ai_model: input.ai_model,
            ai_review_raw: input.ai_review_raw,
            ai_generated_at: input.ai_generated_at,
            language_edits: mergedItems.language_edits,
            scores: teacherState.scores,
            content_feedback: {
              items: mergedItems.content_feedback,
              overall_feedback: teacherState.overall_feedback
            },
            teacher_comment: teacherState.teacher_comment
          })
          .eq("review_id", manualReview.review_id)
          .select("review_id")
          .maybeSingle();
        if (error || !data) {
          throw new WritingReviewDatabaseError(
            "REVIEW_SAVE_FAILED",
            "The validated AI writing review could not be saved."
          );
        }
        return { review_id: String(data.review_id) };
      }
      const { data, error } = await supabase
        .from("writing_reviews")
        .insert(input)
        .select("review_id")
        .single();
      if (error || !data) {
        throw new WritingReviewDatabaseError(
          "REVIEW_SAVE_FAILED",
          "The validated AI writing review could not be saved."
        );
      }
      return { review_id: String(data.review_id) };
    }
  };
}

function throwReadError(error: DatabaseError | null, resource: string) {
  if (error) {
    throw new WritingReviewDatabaseError(
      "DATABASE_READ_FAILED",
      `Could not read ${resource}.`
    );
  }
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
    const auth = await requireUserWithRole(bearerToken(request), "teacher");
    if (auth.error || !auth.userId) {
      const status = auth.error === "Unauthorized" ? 403 : 401;
      return json(
        { code: "UNAUTHORIZED", message: auth.error ?? "Unauthorized" },
        { status }
      );
    }

    const supabase = createServiceSupabase();
    aiLogClient = supabase;
    operationStartedAt = Date.now();
    const overwriteTeacherContent =
      new URL(request.url).searchParams.get("teacher_content") === "overwrite";
    await generateAndSaveWritingReview(params.attemptId, {
      repository: createWritingReviewRepository(
        supabase,
        overwriteTeacherContent
      ),
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
            throw new WritingReviewGenerationError(
              "AI_RESPONSE_INVALID",
              error.result === "invalid_json"
                ? "AI response content was not valid JSON."
                : "AI response failed raw schema or exact text-location validation.",
              502,
              error
            );
          }
          throw error;
        }
      },
      parseReview: (value, responseText) =>
        parseAIReviewRawResultV22ForResponse(value, responseText)
    });

    const workspace = await loadWritingReviewWorkspace(supabase, params.attemptId);
    await logPipeline();
    return json({ review: workspace.review }, { status: 201 });
  } catch (error) {
    await logPipeline(error);
    if (error instanceof WritingReviewGenerationError) {
      if (error.code === "AI_RESPONSE_INVALID") {
        logInvalidAIResponse(params.attemptId, error.cause);
      }
      return json({ error: error.code, code: error.code, message: error.message }, { status: error.status });
    }
    if (error instanceof OpenRouterWritingReviewError) {
      console.error("Writing review OpenRouter error", {
        attemptId: params.attemptId,
        code: error.code,
        status: error.status
      });
      return json({ error: error.code, code: error.code, message: error.message }, { status: error.status });
    }
    if (error instanceof WritingReviewDatabaseError) {
      console.error("Writing review database error", {
        attemptId: params.attemptId,
        code: error.code
      });
      return json({ code: error.code, message: error.message }, { status: error.status });
    }

    console.error("Unexpected writing review generation error", {
      attemptId: params.attemptId,
      error: error instanceof Error ? error.message : "Unknown error"
    });
    return json(
      { code: "INTERNAL_SERVER_ERROR", message: "Writing review generation failed." },
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
      operation: "generate_ai",
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

function logInvalidAIResponse(attemptId: string, cause: unknown) {
  console.error("Invalid AI writing review response", {
    attemptId,
    issues: cause instanceof AIReviewValidationError ? cause.issues : undefined,
    error:
      cause instanceof Error && !(cause instanceof AIReviewValidationError)
        ? cause.message
        : undefined
  });
}

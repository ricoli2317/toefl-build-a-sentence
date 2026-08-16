import { NextResponse } from "next/server";
import { bearerToken, requireUserWithRole } from "@/lib/auth";
import {
  EMPTY_OPENROUTER_USAGE,
  requestOpenRouterStructuredOutput,
  type OpenRouterTokenUsage,
  WRITING_FEEDBACK_REQUEST_TIMEOUT_MS
} from "@/lib/openrouterWritingReview";
import {
  classifyWritingReviewAiFailure,
  persistWritingReviewAiLogBestEffort,
  writingReviewAiProviderDiagnostic
} from "@/lib/writingReviewAiLog";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  assertWritingReviewTeacher,
  WritingReviewWorkspaceServerError
} from "@/lib/writingReviewWorkspaceServer";
import {
  regenerateWritingContentFeedback,
  WRITING_FEEDBACK_REGEN_PROMPT_VERSION,
  WRITING_FEEDBACK_REGEN_SCHEMA_VERSION,
  WRITING_FEEDBACK_REGENERATION_JSON_SCHEMA,
  WritingFeedbackRegenerationError,
  type WritingFeedbackRegenerationRepository
} from "@/lib/writingReviewFeedbackRegeneration";
import {
  readWritingAttemptForReview,
  readWritingQuestionForReview
} from "@/lib/writingReviewSource";

export const dynamic = "force-dynamic";

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}

function createRepository(
  supabase: ReturnType<typeof createServiceSupabase>
): WritingFeedbackRegenerationRepository {
  return {
    async findAttempt(attemptId) {
      const { data, error } = await readWritingAttemptForReview(supabase, attemptId);
      if (error) throw databaseReadFailure();
      return data;
    },

    async findReview(attemptId) {
      const { data, error } = await supabase
        .from("writing_reviews")
        .select("content_feedback")
        .eq("attempt_id", attemptId)
        .maybeSingle();
      if (error) throw databaseReadFailure();
      return data as { content_feedback: unknown } | null;
    },

    async findQuestion(taskType, questionId, assignmentId) {
      const { data, error } = await readWritingQuestionForReview(
        supabase,
        taskType,
        questionId,
        assignmentId
      );
      if (error) throw databaseReadFailure();
      return data;
    },

    async updateContentFeedback(attemptId, contentFeedback) {
      const { data, error } = await supabase
        .from("writing_reviews")
        .update({ content_feedback: contentFeedback })
        .eq("attempt_id", attemptId)
        .select("updated_at")
        .maybeSingle();
      if (error || !data || typeof data.updated_at !== "string") {
        throw new WritingFeedbackRegenerationError(
          "REVIEW_UPDATE_FAILED",
          "反馈更新失败，请稍后重试。",
          500
        );
      }
      return { updated_at: data.updated_at };
    }
  };
}

export async function POST(
  request: Request,
  {
    params
  }: { params: { attemptId: string; feedbackId: string } }
) {
  const requestId = crypto.randomUUID();
  let operationStartedAt: number | null = null;
  let aiStartedAt: number | null = null;
  let aiTaskType: "email" | "academic_discussion" | null = null;
  let aiModel = process.env.OPENROUTER_WRITING_MODEL?.trim() || "unknown";
  let aiUsage: OpenRouterTokenUsage = { ...EMPTY_OPENROUTER_USAGE };
  let generationId: string | null = null;
  let aiLogClient: ReturnType<typeof createServiceSupabase> | null = null;
  try {
    assertWritingReviewTeacher(
      await requireUserWithRole(bearerToken(request), "teacher")
    );
    const supabase = createServiceSupabase();
    aiLogClient = supabase;
    operationStartedAt = Date.now();
    const result = await regenerateWritingContentFeedback(
      params.attemptId,
      params.feedbackId,
      await request.json().catch(() => null),
      {
        repository: createRepository(supabase),
        requestAI: async (messages, context) => {
          aiStartedAt = Date.now();
          aiTaskType = context.taskType;
          const response = await requestOpenRouterStructuredOutput(messages, {
            jsonSchema:
              WRITING_FEEDBACK_REGENERATION_JSON_SCHEMA as unknown as Record<
                string,
                unknown
              >,
            schemaName: "tps_writing_feedback_regeneration",
            timeoutMs: WRITING_FEEDBACK_REQUEST_TIMEOUT_MS,
            timeoutMessage: "AI 建议生成超时，请稍后重试。"
          });
          aiModel = response.model;
          aiUsage = response.usage;
          generationId = response.generationId;
          return response;
        }
      }
    );
    await logPipeline();
    return json(result);
  } catch (error) {
    await logPipeline(error);
    if (
      error instanceof WritingFeedbackRegenerationError ||
      error instanceof WritingReviewWorkspaceServerError
    ) {
      return json(
        { error: error.code, code: error.code, message: error.message },
        { status: error.status }
      );
    }
    console.error("Unexpected writing feedback regeneration error", {
      attemptId: params.attemptId,
      feedbackId: params.feedbackId,
      error: error instanceof Error ? error.message : "Unknown error"
    });
    return json(
      { code: "AI_SERVICE_ERROR", message: "反馈重新生成失败，请稍后重试。" },
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
      operation: "feedback_regenerate",
      attempt_id: params.attemptId,
      task_type: aiTaskType,
      model: aiModel,
      prompt_version: WRITING_FEEDBACK_REGEN_PROMPT_VERSION,
      schema_version: WRITING_FEEDBACK_REGEN_SCHEMA_VERSION,
      ...outcome,
      elapsed_ms: Date.now() - (aiStartedAt ?? operationStartedAt),
      end_to_end_elapsed_ms:
        operationStartedAt === null ? null : Date.now() - operationStartedAt,
      generation_id: generationId,
      ...writingReviewAiProviderDiagnostic(error),
      ...aiUsage
    });
    aiStartedAt = null;
  }
}

function databaseReadFailure() {
  return new WritingFeedbackRegenerationError(
    "DATABASE_READ_FAILED",
    "暂时无法读取批改数据，请稍后重试。",
    500
  );
}

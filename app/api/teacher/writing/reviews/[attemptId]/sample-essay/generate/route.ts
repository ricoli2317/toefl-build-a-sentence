import { NextResponse } from "next/server";
import { bearerToken, requireTeacherOnly } from "@/lib/auth";
import {
  EMPTY_OPENROUTER_USAGE,
  WRITING_FEEDBACK_REQUEST_TIMEOUT_MS,
  type OpenRouterTokenUsage
} from "@/lib/openrouterWritingReview";
import {
  getWritingReviewProviderConfig,
  requestWritingReviewTextOutput
} from "@/lib/writingReviewProvider";
import {
  classifyWritingReviewAiFailure,
  persistWritingReviewAiLogBestEffort,
  writingReviewAiProviderDiagnostic
} from "@/lib/writingReviewAiLog";
import { createServiceSupabase } from "@/lib/supabase/server";
import {
  assertWritingReviewTeacher,
  loadAuthorizedWritingReviewSource,
  WritingReviewWorkspaceServerError
} from "@/lib/writingReviewWorkspaceServer";
import {
  readWritingQuestionForReview,
  type WritingReviewWorkspaceSource
} from "@/lib/writingReviewSource";
import {
  buildManualWritingReviewDraft,
  buildWritingReviewSaveUpdate
} from "@/lib/writingReviewWorkspace";
import {
  generateWritingSampleEssay,
  WRITING_SAMPLE_ESSAY_PROMPT_VERSION,
  WRITING_SAMPLE_ESSAY_SCHEMA_VERSION,
  WritingSampleEssayError,
  type WritingSampleEssayRepository,
  type WritingSampleEssayState
} from "@/lib/writingReviewSampleEssay";

export const dynamic = "force-dynamic";
// One plain-text generation under the shared 120s request window plus overhead.
export const maxDuration = 180;

const SAMPLE_ESSAY_FIELDS =
  "sample_essay_instruction,sample_essay_draft,updated_at";

function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, {
    ...init,
    headers: { ...init?.headers, "Cache-Control": "no-store" }
  });
}

function readSampleEssayState(
  row: Record<string, unknown> | null
): WritingSampleEssayState | null {
  if (!row) return null;
  return {
    instruction:
      typeof row.sample_essay_instruction === "string"
        ? row.sample_essay_instruction
        : null,
    draft:
      typeof row.sample_essay_draft === "string" ? row.sample_essay_draft : null,
    updated_at: typeof row.updated_at === "string" ? row.updated_at : null
  };
}

function createRepository(
  supabase: ReturnType<typeof createServiceSupabase>,
  source: WritingReviewWorkspaceSource
): WritingSampleEssayRepository {
  const readState = async (attemptId: string) => {
    const { data, error } = await supabase
      .from("writing_reviews")
      .select(SAMPLE_ESSAY_FIELDS)
      .eq("attempt_id", attemptId)
      .maybeSingle();
    if (error) {
      throw new WritingSampleEssayError(
        "DATABASE_READ_FAILED",
        "暂时无法读取范文数据，请稍后重试。",
        500
      );
    }
    return readSampleEssayState(data as Record<string, unknown> | null);
  };
  return {
    async findAttempt() {
      return source.attempt;
    },

    async findQuestion(taskType, questionId, assignmentId) {
      const { data, error } = await readWritingQuestionForReview(
        supabase,
        taskType,
        questionId,
        assignmentId,
        assignmentId && assignmentId === source.attempt.assignment_id
          ? { assignment: source.assignment }
          : undefined
      );
      if (error) {
        throw new WritingSampleEssayError(
          "DATABASE_READ_FAILED",
          "暂时无法读取范文数据，请稍后重试。",
          500
        );
      }
      return data;
    },

    readSampleEssayState: readState,

    async compareAndSaveSampleEssay({
      attemptId,
      taskType,
      expected,
      instruction,
      draft
    }) {
      if (expected) {
        const updated = await compareAndUpdate(
          supabase,
          attemptId,
          expected,
          instruction,
          draft
        );
        if (updated) return updated;
        const current = await readState(attemptId);
        if (current) {
          throw new WritingSampleEssayError(
            "SAMPLE_ESSAY_CONFLICT",
            "范文已在其他页面更新，本次生成结果未覆盖新版本，请重试。",
            409
          );
        }
      }

      const manual = buildWritingReviewSaveUpdate(
        buildManualWritingReviewDraft(taskType)
      );
      const { data, error } = await supabase
        .from("writing_reviews")
        .insert({
          attempt_id: attemptId,
          task_type: taskType,
          status: "reviewing",
          ai_model: null,
          ai_generated_at: null,
          ai_review_raw: null,
          ...manual,
          sample_essay_instruction: instruction,
          sample_essay_draft: draft
        })
        .select(SAMPLE_ESSAY_FIELDS)
        .maybeSingle();
      if (error?.code === "23505") {
        throw new WritingSampleEssayError(
          "SAMPLE_ESSAY_CONFLICT",
          "范文已在其他页面更新，本次生成结果未覆盖新版本，请重试。",
          409
        );
      }
      if (error || !data) {
        throw new WritingSampleEssayError(
          "SAMPLE_ESSAY_SAVE_FAILED",
          "范文保存失败，请稍后重试。",
          500
        );
      }
      return readSampleEssayState(data as Record<string, unknown>)!;
    }
  };
}

async function compareAndUpdate(
  supabase: ReturnType<typeof createServiceSupabase>,
  attemptId: string,
  expected: WritingSampleEssayState,
  instruction: string,
  draft: string
) {
  let query = supabase
    .from("writing_reviews")
    .update({
      sample_essay_instruction: instruction,
      sample_essay_draft: draft
    })
    .eq("attempt_id", attemptId);
  query =
    expected.instruction === null
      ? query.is("sample_essay_instruction", null)
      : query.eq("sample_essay_instruction", expected.instruction);
  query =
    expected.draft === null
      ? query.is("sample_essay_draft", null)
      : query.eq("sample_essay_draft", expected.draft);
  const { data, error } = await query
    .select(SAMPLE_ESSAY_FIELDS)
    .maybeSingle();
  if (error) {
    throw new WritingSampleEssayError(
      "SAMPLE_ESSAY_SAVE_FAILED",
      "范文保存失败，请稍后重试。",
      500
    );
  }
  return readSampleEssayState(data as Record<string, unknown> | null);
}

export async function POST(
  request: Request,
  { params }: { params: { attemptId: string } }
) {
  const requestId = crypto.randomUUID();
  let operationStartedAt: number | null = null;
  let aiStartedAt: number | null = null;
  let aiTaskType: "email" | "academic_discussion" | null = null;
  let aiModel = "unknown";
  let aiUsage: OpenRouterTokenUsage = { ...EMPTY_OPENROUTER_USAGE };
  let generationId: string | null = null;
  let costObservability: Record<string, unknown> | null = null;
  let aiLogClient: ReturnType<typeof createServiceSupabase> | null = null;
  try {
    const auth = await requireTeacherOnly(bearerToken(request));
    assertWritingReviewTeacher(auth);
    const supabase = createServiceSupabase();
    const source = await loadAuthorizedWritingReviewSource(
      supabase,
      { userId: auth.userId!, role: auth.role! },
      params.attemptId
    );
    aiLogClient = supabase;
    operationStartedAt = Date.now();
    const result = await generateWritingSampleEssay(
      params.attemptId,
      await request.json().catch(() => null),
      {
        repository: createRepository(supabase, source),
        requestAI: async (messages, context) => {
          aiStartedAt = Date.now();
          aiTaskType = context.taskType;
          const providerConfig = getWritingReviewProviderConfig();
          const response = await requestWritingReviewTextOutput(
            providerConfig,
            messages,
            {
              timeoutMs: WRITING_FEEDBACK_REQUEST_TIMEOUT_MS,
              timeoutMessage: "AI 范文生成超时，请稍后重试。"
            }
          );
          aiModel = response.model;
          aiUsage = response.usage;
          costObservability =
            (response as typeof response & {
              costObservability?: Record<string, unknown>;
            }).costObservability ?? null;
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
      error instanceof WritingSampleEssayError ||
      error instanceof WritingReviewWorkspaceServerError
    ) {
      return json(
        { error: error.code, code: error.code, message: error.message },
        { status: error.status }
      );
    }
    console.error("Unexpected writing sample essay error", {
      attemptId: params.attemptId,
      error: error instanceof Error ? error.message : "Unknown error"
    });
    return json(
      { code: "AI_SERVICE_ERROR", message: "范文生成失败，请稍后重试。" },
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
      operation: "sample_essay_generate",
      attempt_id: params.attemptId,
      task_type: aiTaskType,
      model: aiModel,
      prompt_version: WRITING_SAMPLE_ESSAY_PROMPT_VERSION,
      schema_version: WRITING_SAMPLE_ESSAY_SCHEMA_VERSION,
      ...outcome,
      elapsed_ms: Date.now() - (aiStartedAt ?? operationStartedAt),
      end_to_end_elapsed_ms:
        operationStartedAt === null ? null : Date.now() - operationStartedAt,
      generation_id: generationId,
      diagnostics: {
        pipeline: "sample_essay",
        ...(costObservability ? { cost_observability: costObservability } : {})
      },
      ...writingReviewAiProviderDiagnostic(error),
      ...aiUsage
    });
    aiStartedAt = null;
  }
}

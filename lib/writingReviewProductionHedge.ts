import {
  EMPTY_OPENROUTER_USAGE,
  OpenRouterWritingReviewError,
  type OpenRouterTokenUsage,
  type OpenRouterWritingReviewInput,
  type OpenRouterWritingReviewResponse
} from "./openrouterWritingReview.ts";
import {
  runWritingReviewHedgedRequest,
  WRITING_REVIEW_HEDGE_DEADLINE_MS,
  WRITING_REVIEW_HEDGE_DELAY_MS,
  type WritingReviewHedgeBranch,
  type WritingReviewHedgeLoserStatus,
  type WritingReviewHedgeRequestLabel,
  type WritingReviewHedgeRun
} from "./writingReviewHedgedRequest.ts";
import type {
  AIReviewRawResultV22,
  AIReviewResultV22
} from "./writingReviewSchemaV22.ts";

export const WRITING_REVIEW_PRODUCTION_MODEL = "moonshotai/kimi-k3" as const;
export const WRITING_REVIEW_PRODUCTION_REASONING = "high" as const;
export const WRITING_REVIEW_PRODUCTION_RETRY = 0 as const;

type TerminalResult =
  | "provider_error"
  | "invalid_json"
  | "validation_error"
  | "localization_error";
type RequestResult = "success" | TerminalResult;
type TimerHandle = ReturnType<typeof setTimeout>;

type ProductionRequestOutcome = {
  result: RequestResult;
  response: OpenRouterWritingReviewResponse | null;
  review: AIReviewResultV22 | null;
  raw: AIReviewRawResultV22 | null;
  error: unknown;
  usage: OpenRouterTokenUsage;
  schema_valid: boolean;
  localization_valid: boolean | null;
};

export type WritingReviewProductionHedgeTelemetry = {
  hedge_triggered: boolean;
  requests_started: 1 | 2;
  winner: WritingReviewHedgeRequestLabel | null;
  end_to_end_elapsed_ms: number;
  primary_result: string;
  primary_elapsed_ms: number;
  primary_cost: number | null;
  hedge_result: string | null;
  hedge_elapsed_ms: number | null;
  hedge_cost: number | null;
  loser_status: WritingReviewHedgeLoserStatus;
  winner_cost: number | null;
  observed_completed_cost: number | null;
  winner_usage: OpenRouterTokenUsage | null;
  final_usage: OpenRouterTokenUsage | null;
  winner_model: string | null;
  winner_generation_id: string | null;
  final_generation_id: string | null;
};

export type WritingReviewProductionHedgeDependencies = {
  requestAI(
    input: OpenRouterWritingReviewInput,
    signal: AbortSignal
  ): Promise<OpenRouterWritingReviewResponse>;
  parseRawReview(value: unknown): AIReviewRawResultV22;
  parseReview(
    value: unknown,
    responseText: string,
    request: WritingReviewHedgeRequestLabel
  ): AIReviewResultV22;
  onComplete?(telemetry: WritingReviewProductionHedgeTelemetry): void;
  now?: () => number;
  setTimeoutImpl?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeoutImpl?: (handle: TimerHandle) => void;
};

export class WritingReviewProductionValidationError extends Error {
  code = "AI_RESPONSE_INVALID" as const;
  status = 502;
  result: Exclude<TerminalResult, "provider_error">;
  cause?: unknown;

  constructor(
    result: Exclude<TerminalResult, "provider_error">,
    message: string,
    cause?: unknown
  ) {
    super(message);
    this.name = "WritingReviewProductionValidationError";
    this.result = result;
    this.cause = cause;
  }
}

export async function requestProductionWritingReviewHedged(
  input: OpenRouterWritingReviewInput,
  dependencies: WritingReviewProductionHedgeDependencies
) {
  const run = await runWritingReviewHedgedRequest<ProductionRequestOutcome>({
    hedgeDelayMs: WRITING_REVIEW_HEDGE_DELAY_MS,
    overallDeadlineMs: WRITING_REVIEW_HEDGE_DEADLINE_MS,
    now: dependencies.now,
    setTimeoutImpl: dependencies.setTimeoutImpl,
    clearTimeoutImpl: dependencies.clearTimeoutImpl,
    request: (request, signal) =>
      evaluateRequest(input, signal, request, dependencies),
    isSuccess: (outcome) => outcome.result === "success",
    resultOf: (outcome) => outcome.result
  });
  const telemetry = buildTelemetry(run);
  dependencies.onComplete?.(telemetry);

  const winner = run.winner_outcome;
  if (winner?.response && winner.review && winner.raw) {
    return {
      response: winner.response,
      review: winner.review,
      raw: winner.raw,
      telemetry
    };
  }
  if (run.timed_out) {
    throw new OpenRouterWritingReviewError(
      "AI_REQUEST_TIMEOUT",
      "AI 初批生成超时，请稍后重试。",
      504
    );
  }
  const failure = run.final_outcome?.error;
  if (failure instanceof Error) throw failure;
  throw new OpenRouterWritingReviewError(
    "OPENROUTER_REQUEST_FAILED",
    "AI 初批生成失败，请稍后重试。",
    502
  );
}

async function evaluateRequest(
  input: OpenRouterWritingReviewInput,
  signal: AbortSignal,
  request: WritingReviewHedgeRequestLabel,
  dependencies: WritingReviewProductionHedgeDependencies
): Promise<ProductionRequestOutcome> {
  let usage = { ...EMPTY_OPENROUTER_USAGE };
  try {
    const response = await dependencies.requestAI(input, signal);
    usage = response.usage;
    let value: unknown;
    try {
      value = JSON.parse(response.content) as unknown;
    } catch (error) {
      return failureOutcome(
        "invalid_json",
        response,
        usage,
        new WritingReviewProductionValidationError(
          "invalid_json",
          "AI response content was not valid JSON.",
          error
        )
      );
    }

    let raw: AIReviewRawResultV22;
    try {
      raw = dependencies.parseRawReview(value);
      if (raw.schema_version !== "2.2" || raw.task_type !== input.taskType) {
        throw new Error("AI response did not match the current v2.2 task.");
      }
    } catch (error) {
      return failureOutcome(
        "validation_error",
        response,
        usage,
        new WritingReviewProductionValidationError(
          "validation_error",
          "AI response failed v2.2 schema or business validation.",
          error
        )
      );
    }

    try {
      const review = dependencies.parseReview(value, input.responseText, request);
      return {
        result: "success",
        response,
        review,
        raw,
        error: null,
        usage,
        schema_valid: true,
        localization_valid: true
      };
    } catch (error) {
      return {
        result: "localization_error",
        response,
        review: null,
        raw,
        error: new WritingReviewProductionValidationError(
          "localization_error",
          "AI response failed strict source-text localization.",
          error
        ),
        usage,
        schema_valid: true,
        localization_valid: false
      };
    }
  } catch (error) {
    return {
      result: "provider_error",
      response: null,
      review: null,
      raw: null,
      error,
      usage,
      schema_valid: false,
      localization_valid: null
    };
  }
}

function failureOutcome(
  result: "invalid_json" | "validation_error",
  response: OpenRouterWritingReviewResponse,
  usage: OpenRouterTokenUsage,
  error: WritingReviewProductionValidationError
): ProductionRequestOutcome {
  return {
    result,
    response,
    review: null,
    raw: null,
    error,
    usage,
    schema_valid: false,
    localization_valid: null
  };
}

function buildTelemetry(
  run: WritingReviewHedgeRun<ProductionRequestOutcome>
): WritingReviewProductionHedgeTelemetry {
  const winner = run.winner_outcome;
  const completed = [run.primary, run.hedge].flatMap((branch) =>
    branch?.outcome ? [branch.outcome] : []
  );
  const costs = completed
    .map((outcome) => outcome.usage.cost)
    .filter((cost): cost is number => typeof cost === "number");
  return {
    hedge_triggered: run.hedge_triggered,
    requests_started: run.requests_started,
    winner: run.winner,
    end_to_end_elapsed_ms: run.end_to_end_elapsed_ms,
    primary_result: run.primary.result,
    primary_elapsed_ms: run.primary.elapsed_ms,
    primary_cost: branchCost(run.primary),
    hedge_result: run.hedge?.result ?? null,
    hedge_elapsed_ms: run.hedge?.elapsed_ms ?? null,
    hedge_cost: run.hedge ? branchCost(run.hedge) : null,
    loser_status: run.loser_status,
    winner_cost: winner?.usage.cost ?? null,
    observed_completed_cost:
      costs.length === 0
        ? null
        : costs.reduce((sum, cost) => sum + cost, 0),
    winner_usage: winner?.usage ?? null,
    final_usage: run.final_outcome?.usage ?? null,
    winner_model: winner?.response?.model ?? null,
    winner_generation_id: winner?.response?.generationId ?? null,
    final_generation_id: run.final_outcome?.response?.generationId ?? null
  };
}

function branchCost(
  branch: WritingReviewHedgeBranch<ProductionRequestOutcome>
) {
  return branch.outcome?.usage.cost ?? null;
}

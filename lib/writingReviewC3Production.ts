import type {
  OpenRouterMessage,
  OpenRouterWritingReviewInput,
  OpenRouterWritingReviewResponse
} from "./openrouterWritingReview.ts";
import {
  requestWritingReviewStructuredOutput,
  type WritingReviewProviderConfig
} from "./writingReviewProvider.ts";
import {
  runWritingReviewHedgedRequest,
  type WritingReviewHedgeRun
} from "./writingReviewHedgedRequest.ts";
import { buildWritingReviewTextUnits } from "./writingReviewTextUnits.ts";
import { buildAnchoredWritingResponse } from "./writingReviewAnchors.ts";
import { buildWritingReviewSemanticC3Messages } from "./writingReviewSemanticPrompt.ts";
import {
  parseWritingReviewSemanticC3,
  WRITING_REVIEW_C3_SCHEMA_NAME,
  writingReviewC3JsonSchema
} from "./writingReviewSemanticSchema.ts";
import {
  assembleWritingReviewV22FromC3,
  writingReviewRawV22FromAssembled
} from "./writingReviewV22Assembler.ts";
import type { LanguageEditOverlapNormalizationDiagnostic } from "./writingReviewLanguageEditNormalization.ts";
import {
  WRITING_REVIEW_C3_HEDGE_DELAY_MS,
  writingReviewPipelineTiming
} from "./writingReviewPipeline.ts";
import {
  observedWritingReviewCost,
  withBillingCompleteness,
  type BillingCompleteness,
  type CostObservability
} from "./writingReviewCost.ts";
import type { WritingReviewProductionHedgeTelemetry } from "./writingReviewProductionHedge.ts";

export type WritingReviewC3ErrorCode =
  | "PREPROCESSING_INVALID"
  | "C3_INVALID_JSON"
  | "C3_SCHEMA_INVALID"
  | "C3_SCORE_CONTRACT_INVALID"
  | "C3_UNIT_VALIDATION_FAILED"
  | "C3_ANCHOR_LEAKAGE"
  | "C3_ASSEMBLY_INVALID";

export class WritingReviewC3Error extends Error {
  code: WritingReviewC3ErrorCode;
  cause?: unknown;

  constructor(
    code: WritingReviewC3ErrorCode,
    message: string,
    cause?: unknown
  ) {
    super(message);
    this.name = "WritingReviewC3Error";
    this.code = code;
    this.cause = cause;
  }
}

type OutcomeResult =
  | "success"
  | "provider_error"
  | "invalid_json"
  | "semantic_schema_error"
  | "unit_validation_error"
  | "anchor_leakage"
  | "assembly_error";

export type WritingReviewC3Outcome = {
  result: OutcomeResult;
  response: OpenRouterWritingReviewResponse | null;
  review: ReturnType<typeof assembleWritingReviewV22FromC3> | null;
  normalizationDiagnostic: LanguageEditOverlapNormalizationDiagnostic | null;
  error: unknown;
};

export type WritingReviewC3Dependencies = {
  requestStructuredOutput?: (
    provider: WritingReviewProviderConfig,
    messages: OpenRouterMessage[],
    options: {
      jsonSchema: Record<string, unknown>;
      schemaName: string;
      reasoningEffort: "high";
      signal: AbortSignal;
    }
  ) => Promise<OpenRouterWritingReviewResponse>;
};

export function writingReviewC3TelemetryDiagnostic(
  run: WritingReviewHedgeRun<WritingReviewC3Outcome>,
  deadlineMs: number,
  hedgeDelayMs = WRITING_REVIEW_C3_HEDGE_DELAY_MS
) : WritingReviewProductionHedgeTelemetry & {
  pipeline: "c3";
  hedge_delay_ms: number;
  deadline_ms: number;
  timed_out: boolean;
} {
  const primaryObservation = branchCostObservability(run.primary);
  const hedgeObservation = branchCostObservability(run.hedge);
  const primaryCost = observedAmount(primaryObservation);
  const hedgeCost = observedAmount(hedgeObservation);
  const winnerCost = run.winner === "primary" ? primaryCost : run.winner === "hedge" ? hedgeCost : null;
  const billingCompleteness: BillingCompleteness = startedBranches(run).every(
    (branch) => observedAmount(branchCostObservability(branch)) !== null
  )
    ? "complete_for_observed_requests"
    : "partial_or_unknown";
  const winnerObservation =
    run.winner === "primary"
      ? primaryObservation
      : run.winner === "hedge"
        ? hedgeObservation
        : null;
  const finalObservation = responseCostObservability(
    run.final_outcome?.response ?? null
  );
  const observedObservation = observedWritingReviewCost(
    [primaryObservation, hedgeObservation],
    billingCompleteness
  );
  return {
    pipeline: "c3",
    hedge_delay_ms: hedgeDelayMs,
    deadline_ms: deadlineMs,
    hedge_triggered: run.hedge_triggered,
    requests_started: run.requests_started,
    winner: run.winner,
    end_to_end_elapsed_ms: run.end_to_end_elapsed_ms,
    primary_result: run.primary.result,
    primary_elapsed_ms: run.primary.elapsed_ms,
    hedge_result: run.hedge?.result ?? null,
    hedge_elapsed_ms: run.hedge?.elapsed_ms ?? null,
    loser_status: run.loser_status,
    timed_out: run.timed_out,
    primary_cost: primaryCost,
    hedge_cost: hedgeCost,
    winner_cost: winnerCost,
    observed_completed_cost: observedObservation?.amount ?? null,
    billing_completeness: billingCompleteness,
    primary_cost_observability: withBillingCompleteness(
      primaryObservation,
      billingCompleteness
    ),
    hedge_cost_observability: withBillingCompleteness(
      hedgeObservation,
      billingCompleteness
    ),
    winner_cost_observability: withBillingCompleteness(
      winnerObservation,
      billingCompleteness
    ),
    final_cost_observability: withBillingCompleteness(
      finalObservation,
      billingCompleteness
    ),
    observed_cost_observability: observedObservation,
    winner_usage: run.winner_outcome?.response?.usage ?? null,
    final_usage: run.final_outcome?.response?.usage ?? null,
    winner_model: run.winner_outcome?.response?.model ?? null,
    winner_generation_id:
      run.winner_outcome?.response?.generationId ?? null,
    final_generation_id: run.final_outcome?.response?.generationId ?? null
  };
}

function responseCostObservability(
  response: OpenRouterWritingReviewResponse | null
) {
  return response?.costObservability ?? null;
}

function branchCostObservability(
  branch: WritingReviewHedgeRun<WritingReviewC3Outcome>["primary"] | null
) {
  return responseCostObservability(branch?.outcome?.response ?? null);
}

function observedAmount(cost: CostObservability | null) {
  return typeof cost?.amount === "number" && Number.isFinite(cost.amount)
    ? cost.amount
    : null;
}

function startedBranches(run: WritingReviewHedgeRun<WritingReviewC3Outcome>) {
  return run.requests_started === 1
    ? [run.primary]
    : [run.primary, run.hedge].filter(
        (branch): branch is NonNullable<typeof branch> => branch !== null
      );
}

/** Returns only safe branch timing/state captured by the C3 hedge runner. */
export function writingReviewC3FailureTelemetryDiagnostic(error: unknown) {
  if (!error || typeof error !== "object") return null;
  const record = error as {
    run?: WritingReviewHedgeRun<WritingReviewC3Outcome>;
    c3Timing?: { deadlineMs: number; hedgeDelayMs: number };
  };
  return record.run && record.c3Timing
    ? writingReviewC3TelemetryDiagnostic(
        record.run,
        record.c3Timing.deadlineMs,
        record.c3Timing.hedgeDelayMs
      )
    : null;
}

function outcomeResultFor(error: unknown): OutcomeResult {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  switch (code) {
    case "C3_INVALID_JSON":
      return "invalid_json";
    case "C3_SCHEMA_INVALID":
      return "semantic_schema_error";
    case "C3_SCORE_CONTRACT_INVALID":
      return "semantic_schema_error";
    case "C3_UNIT_VALIDATION_FAILED":
      return "unit_validation_error";
    case "C3_ANCHOR_LEAKAGE":
      return "anchor_leakage";
    case "C3_ASSEMBLY_INVALID":
      return "assembly_error";
    default:
      return "provider_error";
  }
}

export async function requestProductionC3WritingReview(
  input: OpenRouterWritingReviewInput,
  provider: WritingReviewProviderConfig,
  env: Partial<NodeJS.ProcessEnv> = process.env,
  dependencies: WritingReviewC3Dependencies = {}
) {
  let units;
  let anchored;
  let messages: OpenRouterMessage[];
  try {
    units = buildWritingReviewTextUnits(input.responseText);
    anchored = buildAnchoredWritingResponse(input.responseText, units);
    messages = buildWritingReviewSemanticC3Messages({
      taskType: input.taskType,
      question: input.question,
      anchoredResponse: anchored.anchoredResponse
    });
  } catch (error) {
    throw new WritingReviewC3Error(
      "PREPROCESSING_INVALID",
      "C3 preprocessing validation failed.",
      error
    );
  }

  const timing = writingReviewPipelineTiming("c3", env);
  const requestStructuredOutput =
    dependencies.requestStructuredOutput ?? requestWritingReviewStructuredOutput;
  const run = await runWritingReviewHedgedRequest<WritingReviewC3Outcome>({
    hedgeDelayMs: timing.hedgeDelayMs,
    overallDeadlineMs: timing.deadlineMs,
    request: async (_branch, signal) => {
      let response: OpenRouterWritingReviewResponse | null = null;
      let normalizationDiagnostic: LanguageEditOverlapNormalizationDiagnostic | null = null;
      try {
        response = await requestStructuredOutput(provider, messages, {
          jsonSchema: writingReviewC3JsonSchema(input.taskType) as unknown as Record<string, unknown>,
          schemaName: `${WRITING_REVIEW_C3_SCHEMA_NAME}_${input.taskType}`,
          reasoningEffort: "high",
          signal
        });
        const semantic = parseWritingReviewSemanticC3(
          response.content,
          input.taskType,
          units
        );
        const review = assembleWritingReviewV22FromC3({
          taskType: input.taskType,
          responseText: input.responseText,
          units,
          semantic,
          onLanguageEditOverlapNormalization(diagnostic) {
            normalizationDiagnostic = diagnostic;
          }
        });
        return {
          result: "success",
          response,
          review,
          normalizationDiagnostic,
          error: null
        };
      } catch (error) {
        return {
          result: outcomeResultFor(error),
          response,
          review: null,
          normalizationDiagnostic,
          error
        };
      }
    },
    isSuccess: (outcome) => outcome.result === "success",
    resultOf: (outcome) => outcome.result
  });

  if (run.winner_outcome?.response && run.winner_outcome.review) {
    const response = {
      ...run.winner_outcome.response,
      content: JSON.stringify(writingReviewRawV22FromAssembled(run.winner_outcome.review))
    };
    return {
      response,
      review: run.winner_outcome.review,
      units,
      anchorNamespace: anchored.namespace,
      timing,
      telemetry: run,
      normalizationDiagnostic:
        run.winner_outcome.normalizationDiagnostic ?? null
    };
  }
  if (run.timed_out) {
    throw Object.assign(new Error("C3 writing review timed out."), {
      code: "AI_REQUEST_TIMEOUT",
      status: 504,
      run,
      c3Timing: timing
    });
  }
  const failure =
    run.final_outcome?.error instanceof Error
      ? run.final_outcome.error
      : new WritingReviewC3Error(
          "C3_ASSEMBLY_INVALID",
          "C3 writing review did not pass final validation."
        );
  Object.assign(failure, { run, c3Timing: timing });
  throw failure;
}

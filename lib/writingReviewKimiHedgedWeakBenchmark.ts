import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMPTY_OPENROUTER_USAGE,
  getOpenRouterErrorDiagnostic,
  type OpenRouterTokenUsage,
  type OpenRouterWritingReviewInput,
  type OpenRouterWritingReviewResponse
} from "./openrouterWritingReview.ts";
import {
  runWritingReviewHedgedRequest,
  WRITING_REVIEW_HEDGE_DEADLINE_MS as SHARED_HEDGE_DEADLINE_MS,
  WRITING_REVIEW_HEDGE_DELAY_MS as SHARED_HEDGE_DELAY_MS,
  type WritingReviewHedgeBranch,
  type WritingReviewHedgeLoserStatus,
  type WritingReviewHedgeRequestLabel
} from "./writingReviewHedgedRequest.ts";
import { WRITING_REVIEW_KIMI_WEAK_RETEST_CASES } from "./writingReviewKimiWeakRetestBenchmark.ts";
import type {
  AIReviewRawResultV22,
  AIReviewResultV22
} from "./writingReviewSchemaV22.ts";

export const WRITING_REVIEW_KIMI_HEDGED_WEAK_CASES =
  WRITING_REVIEW_KIMI_WEAK_RETEST_CASES;
export const WRITING_REVIEW_KIMI_HEDGED_WEAK_PROVIDER = "openrouter" as const;
export const WRITING_REVIEW_KIMI_HEDGED_WEAK_MODEL =
  "moonshotai/kimi-k3" as const;
export const WRITING_REVIEW_KIMI_HEDGED_WEAK_EFFORT = "high" as const;
export const WRITING_REVIEW_KIMI_HEDGED_WEAK_OPERATION =
  "kimi_hedged_weak_benchmark" as const;
export const WRITING_REVIEW_KIMI_HEDGE_DELAY_MS = SHARED_HEDGE_DELAY_MS;
export const WRITING_REVIEW_KIMI_HEDGE_DEADLINE_MS =
  SHARED_HEDGE_DEADLINE_MS;
export const WRITING_REVIEW_KIMI_HEDGED_WEAK_OUTPUT_DIR =
  "tmp/writing-review-kimi-hedged-weak";
export const WRITING_REVIEW_KIMI_HEDGED_BASELINE_SOURCES = [
  {
    run: "historical_reasoning_stability",
    directory: "tmp/writing-review-reasoning-stability",
    fileName(caseLabel: CaseLabel) {
      return `${caseLabel}-high.json`;
    }
  },
  {
    run: "current_prompt_round1",
    directory: "tmp/writing-review-kimi-current-prompt",
    fileName(caseLabel: CaseLabel) {
      return `${caseLabel.replace("_", "-")}.json`;
    }
  },
  {
    run: "weak_retest",
    directory: "tmp/writing-review-kimi-weak-retest",
    fileName(caseLabel: CaseLabel) {
      return `${caseLabel.replace("_", "-")}.json`;
    }
  }
] as const;

type WeakCase = (typeof WRITING_REVIEW_KIMI_HEDGED_WEAK_CASES)[number];
export type CaseLabel = WeakCase["case_label"];
type RequestLabel = WritingReviewHedgeRequestLabel;
type TerminalResult =
  | "provider_error"
  | "invalid_json"
  | "validation_error"
  | "localization_error"
  | "timeout";
type RequestResult = "success" | TerminalResult | "aborted_due_to_winner";
type LoserStatus = WritingReviewHedgeLoserStatus;
type ScoreMap = Record<string, number>;
type CategoryCounts = Record<string, number>;
type ValidationIssue = { path: string; message: string };
type TimerHandle = ReturnType<typeof setTimeout>;

export type WritingReviewKimiHedgedWeakInput = OpenRouterWritingReviewInput & {
  attemptId: string;
  caseLabel: CaseLabel;
  qualityLabel: "weak";
};

export type WritingReviewKimiHedgedRequestRecord = {
  request: RequestLabel;
  started_at_ms: number;
  finished_at_ms: number;
  result: RequestResult;
  elapsed_ms: number;
  usage: OpenRouterTokenUsage;
  cost: number | null;
  schema_valid: boolean;
  localization_valid: boolean | null;
  error_code: string | null;
  error: string | null;
  http_status: number | null;
  provider_error_type: string | null;
  provider_error_code: string | number | null;
  provider_name: string | null;
  localization_issue_count: number;
  localization_issues: ValidationIssue[];
  validated_raw_result: AIReviewRawResultV22 | null;
};

export type WritingReviewKimiHedgedWeakResult = {
  case_label: CaseLabel;
  attempt_id: string;
  task_type: WeakCase["task_type"];
  quality_label: "weak";
  provider: typeof WRITING_REVIEW_KIMI_HEDGED_WEAK_PROVIDER;
  model: typeof WRITING_REVIEW_KIMI_HEDGED_WEAK_MODEL;
  reasoning_effort: typeof WRITING_REVIEW_KIMI_HEDGED_WEAK_EFFORT;
  operation: typeof WRITING_REVIEW_KIMI_HEDGED_WEAK_OPERATION;
  hedge_delay_ms: typeof WRITING_REVIEW_KIMI_HEDGE_DELAY_MS;
  overall_deadline_ms: typeof WRITING_REVIEW_KIMI_HEDGE_DEADLINE_MS;
  hedge_triggered: boolean;
  requests_started: 1 | 2;
  winner: RequestLabel | null;
  end_to_end_elapsed_ms: number;
  primary: WritingReviewKimiHedgedRequestRecord;
  hedge: WritingReviewKimiHedgedRequestRecord | null;
  loser_status: LoserStatus;
  result: "success" | TerminalResult;
  observed_completed_cost: number | null;
  winner_cost: number | null;
  official_score: number | null;
  dimension_scores: ScoreMap | null;
  language_edit_count: number | null;
  content_feedback_count: number | null;
  content_feedback_categories: CategoryCounts;
  overall_feedback: string | null;
  validated_result: AIReviewResultV22 | null;
};

export type WritingReviewKimiSingleBaselineRun = OpenRouterTokenUsage & {
  case_label: CaseLabel;
  attempt_id: string;
  run: (typeof WRITING_REVIEW_KIMI_HEDGED_BASELINE_SOURCES)[number]["run"];
  result: string;
  elapsed_ms: number | null;
  schema_valid: boolean;
  official_score: number | null;
};

export type WritingReviewKimiSingleBaselineSummary = {
  runs: WritingReviewKimiSingleBaselineRun[];
  run_count: 3;
  success_count: number;
  timeout_count: number;
  success_rate: number;
  successful_elapsed_times_ms: number[];
  successful_median_elapsed_ms: number | null;
  successful_costs: number[];
  successful_reasoning_tokens: number[];
};

export type WritingReviewKimiHedgedWeakSummary = {
  provider: typeof WRITING_REVIEW_KIMI_HEDGED_WEAK_PROVIDER;
  model: typeof WRITING_REVIEW_KIMI_HEDGED_WEAK_MODEL;
  reasoning_effort: typeof WRITING_REVIEW_KIMI_HEDGED_WEAK_EFFORT;
  hedge_delay_ms: typeof WRITING_REVIEW_KIMI_HEDGE_DELAY_MS;
  overall_deadline_ms: typeof WRITING_REVIEW_KIMI_HEDGE_DEADLINE_MS;
  baseline_sources: Array<{ run: string; directory: string }>;
  single_request_recalled: false;
  hedged_observations_per_case: 1;
  cases: Array<{
    case_label: CaseLabel;
    attempt_id: string;
    single_request_baseline: WritingReviewKimiSingleBaselineSummary;
    hedged_run: Omit<WritingReviewKimiHedgedWeakResult, "validated_result">;
    hedged_minus_single_success_median_elapsed_ms: number | null;
  }>;
};

export type WritingReviewKimiHedgedDependencies = {
  now?: () => number;
  setTimeoutImpl?: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeoutImpl?: (handle: TimerHandle) => void;
  onRequestStart?(
    input: WritingReviewKimiHedgedWeakInput,
    request: RequestLabel
  ): void;
  requestAI(
    input: OpenRouterWritingReviewInput,
    signal: AbortSignal
  ): Promise<OpenRouterWritingReviewResponse>;
  parseRawReview(value: unknown): AIReviewRawResultV22;
  parseReview(value: unknown, responseText: string): AIReviewResultV22;
};

type AttemptOutcome = {
  record: WritingReviewKimiHedgedRequestRecord;
  review: AIReviewResultV22 | null;
};

export async function benchmarkWritingReviewKimiHedgedWeak(
  inputs: WritingReviewKimiHedgedWeakInput[],
  dependencies: WritingReviewKimiHedgedDependencies
) {
  assertInputs(inputs);
  const results: WritingReviewKimiHedgedWeakResult[] = [];
  for (const input of inputs) {
    results.push(await runWritingReviewKimiHedgedCase(input, dependencies));
  }
  return results;
}

export async function runWritingReviewKimiHedgedCase(
  input: WritingReviewKimiHedgedWeakInput,
  dependencies: WritingReviewKimiHedgedDependencies
): Promise<WritingReviewKimiHedgedWeakResult> {
  assertCase(input);
  const now = dependencies.now ?? (() => Date.now());
  const caseStartedAt = now();
  const run = await runWritingReviewHedgedRequest<AttemptOutcome>({
    hedgeDelayMs: WRITING_REVIEW_KIMI_HEDGE_DELAY_MS,
    overallDeadlineMs: WRITING_REVIEW_KIMI_HEDGE_DEADLINE_MS,
    now,
    setTimeoutImpl: dependencies.setTimeoutImpl,
    clearTimeoutImpl: dependencies.clearTimeoutImpl,
    request: (request, signal) =>
      startAttempt(input, request, signal, caseStartedAt, dependencies, now),
    isSuccess: (outcome) => outcome.record.result === "success",
    resultOf: (outcome) => outcome.record.result
  });
  const primary = branchOutcome(run.primary);
  const hedge = run.hedge ? branchOutcome(run.hedge) : null;
  const completed = [run.primary, run.hedge].flatMap((branch) =>
    branch?.outcome ? [branch.outcome] : []
  );
  const finalFailure = run.winner_outcome
    ? null
    : run.timed_out
      ? "timeout"
      : asTerminal(requiredOutcome(run.final_outcome).record.result);
  return buildFinalResult(
    input,
    caseStartedAt,
    () => caseStartedAt + run.end_to_end_elapsed_ms,
    {
      hedgeTriggered: run.hedge_triggered,
      primary,
      hedge,
      winner: run.winner_outcome,
      winnerLabel: run.winner,
      finalFailure,
      loserStatus: run.loser_status,
      completed
    }
  );
}

async function startAttempt(
  input: WritingReviewKimiHedgedWeakInput,
  request: RequestLabel,
  signal: AbortSignal,
  caseStartedAt: number,
  dependencies: WritingReviewKimiHedgedDependencies,
  now: () => number
): Promise<AttemptOutcome> {
  const startedAt = elapsed(caseStartedAt, now);
  dependencies.onRequestStart?.(input, request);
  let usage = { ...EMPTY_OPENROUTER_USAGE };
  try {
    const response = await dependencies.requestAI(input, signal);
    usage = response.usage;
    let value: unknown;
    try {
      value = JSON.parse(response.content) as unknown;
    } catch {
      return failureOutcome(
        request,
        startedAt,
        elapsed(caseStartedAt, now),
        usage,
        "invalid_json",
        "AI_RESPONSE_INVALID_JSON",
        new Error("OpenRouter returned invalid JSON.")
      );
    }

    let raw: AIReviewRawResultV22;
    try {
      raw = dependencies.parseRawReview(value);
      if (raw.schema_version !== "2.2" || raw.task_type !== input.taskType) {
        throw new Error("Response did not match this case's v2.2 task schema.");
      }
    } catch (error) {
      return failureOutcome(
        request,
        startedAt,
        elapsed(caseStartedAt, now),
        usage,
        "validation_error",
        "AI_RESPONSE_SCHEMA_INVALID",
        error
      );
    }

    try {
      const review = dependencies.parseReview(value, input.responseText);
      const finishedAt = elapsed(caseStartedAt, now);
      return {
        record: {
          ...baseRequestRecord(request, startedAt, finishedAt, usage),
          result: "success",
          schema_valid: true,
          localization_valid: true,
          error_code: null,
          error: null,
          http_status: null,
          provider_error_type: null,
          provider_error_code: null,
          provider_name: null,
          localization_issue_count: 0,
          localization_issues: [],
          validated_raw_result: null
        },
        review
      };
    } catch (error) {
      const issues = safeIssues(error);
      const finishedAt = elapsed(caseStartedAt, now);
      return {
        record: {
          ...baseRequestRecord(request, startedAt, finishedAt, usage),
          result: "localization_error",
          schema_valid: true,
          localization_valid: false,
          error_code: "AI_RESPONSE_LOCALIZATION_FAILED",
          error: safeErrorMessage(error),
          http_status: null,
          provider_error_type: null,
          provider_error_code: null,
          provider_name: null,
          localization_issue_count: issues.length,
          localization_issues: issues,
          validated_raw_result: raw
        },
        review: null
      };
    }
  } catch (error) {
    return failureOutcome(
      request,
      startedAt,
      elapsed(caseStartedAt, now),
      usage,
      "provider_error",
      errorCode(error),
      error
    );
  }
}

function buildFinalResult(
  input: WritingReviewKimiHedgedWeakInput,
  caseStartedAt: number,
  now: () => number,
  state: {
    hedgeTriggered: boolean;
    primary: AttemptOutcome;
    hedge: AttemptOutcome | null;
    winner: AttemptOutcome | null;
    winnerLabel: RequestLabel | null;
    finalFailure: TerminalResult | null;
    loserStatus: LoserStatus;
    completed: AttemptOutcome[];
  }
): WritingReviewKimiHedgedWeakResult {
  const review = state.winner?.review ?? null;
  const costs = state.completed
    .map((outcome) => outcome.record.cost)
    .filter((cost): cost is number => typeof cost === "number");
  return {
    case_label: input.caseLabel,
    attempt_id: input.attemptId,
    task_type: input.taskType,
    quality_label: input.qualityLabel,
    provider: WRITING_REVIEW_KIMI_HEDGED_WEAK_PROVIDER,
    model: WRITING_REVIEW_KIMI_HEDGED_WEAK_MODEL,
    reasoning_effort: WRITING_REVIEW_KIMI_HEDGED_WEAK_EFFORT,
    operation: WRITING_REVIEW_KIMI_HEDGED_WEAK_OPERATION,
    hedge_delay_ms: WRITING_REVIEW_KIMI_HEDGE_DELAY_MS,
    overall_deadline_ms: WRITING_REVIEW_KIMI_HEDGE_DEADLINE_MS,
    hedge_triggered: state.hedgeTriggered,
    requests_started: state.hedgeTriggered ? 2 : 1,
    winner: state.winnerLabel,
    end_to_end_elapsed_ms: elapsed(caseStartedAt, now),
    primary: state.primary.record,
    hedge: state.hedge?.record ?? null,
    loser_status: state.loserStatus,
    result: review ? "success" : requiredFailure(state.finalFailure),
    observed_completed_cost:
      costs.length === 0
        ? null
        : costs.reduce((sum, cost) => sum + cost, 0),
    winner_cost: state.winner?.record.cost ?? null,
    official_score: review?.scores.official_score.ai_score ?? null,
    dimension_scores: review ? scoreDimensions(review) : null,
    language_edit_count: review?.language_edits.length ?? null,
    content_feedback_count: review?.content_feedback.length ?? null,
    content_feedback_categories: review ? countCategories(review) : {},
    overall_feedback: review?.overall_feedback ?? null,
    validated_result: review
  };
}

function branchOutcome(
  branch: WritingReviewHedgeBranch<AttemptOutcome>
): AttemptOutcome {
  if (branch.outcome) return branch.outcome;
  if (
    branch.result !== "timeout" &&
    branch.result !== "aborted_due_to_winner"
  ) {
    throw new Error(`Missing outcome for ${branch.request}: ${branch.result}.`);
  }
  return {
    record: syntheticRecord(
      branch.request,
      branch.started_at_ms,
      branch.finished_at_ms,
      branch.result
    ),
    review: null
  };
}

function failureOutcome(
  request: RequestLabel,
  startedAt: number,
  finishedAt: number,
  usage: OpenRouterTokenUsage,
  result: Exclude<TerminalResult, "timeout" | "localization_error">,
  errorCodeValue: string,
  error: unknown
): AttemptOutcome {
  const diagnostic = getOpenRouterErrorDiagnostic(error);
  return {
    record: {
      ...baseRequestRecord(request, startedAt, finishedAt, usage),
      result,
      schema_valid: false,
      localization_valid: null,
      error_code: errorCodeValue,
      error: safeErrorMessage(error),
      http_status: diagnostic.http_status,
      provider_error_type: diagnostic.error_type,
      provider_error_code: diagnostic.provider_code,
      provider_name: diagnostic.provider_name,
      localization_issue_count: 0,
      localization_issues: [],
      validated_raw_result: null
    },
    review: null
  };
}

function baseRequestRecord(
  request: RequestLabel,
  startedAt: number,
  finishedAt: number,
  usage: OpenRouterTokenUsage
) {
  return {
    request,
    started_at_ms: startedAt,
    finished_at_ms: finishedAt,
    elapsed_ms: Math.max(0, finishedAt - startedAt),
    usage,
    cost: usage.cost
  };
}

function syntheticRecord(
  request: RequestLabel,
  startedAt: number,
  finishedAt: number,
  result: "timeout" | "aborted_due_to_winner"
): WritingReviewKimiHedgedRequestRecord {
  return {
    ...baseRequestRecord(
      request,
      startedAt,
      finishedAt,
      EMPTY_OPENROUTER_USAGE
    ),
    result,
    schema_valid: false,
    localization_valid: null,
    error_code:
      result === "timeout" ? "AI_REQUEST_TIMEOUT" : "ABORTED_DUE_TO_WINNER",
    error:
      result === "timeout"
        ? "Hedged request reached the overall deadline."
        : "Request was aborted after the other request completed successfully.",
    http_status: null,
    provider_error_type: null,
    provider_error_code: null,
    provider_name: null,
    localization_issue_count: 0,
    localization_issues: [],
    validated_raw_result: null
  };
}

export function readWritingReviewKimiSingleBaseline(
  benchmarkCase: WeakCase,
  run: WritingReviewKimiSingleBaselineRun["run"],
  filePath: string,
  readFile: typeof readFileSync = readFileSync
): WritingReviewKimiSingleBaselineRun | null {
  try {
    const value = JSON.parse(readFile(filePath, "utf8")) as unknown;
    if (!isRecord(value)) return null;
    if (
      value.case_label !== benchmarkCase.case_label ||
      value.attempt_id !== benchmarkCase.attempt_id ||
      value.task_type !== benchmarkCase.task_type ||
      value.provider !== WRITING_REVIEW_KIMI_HEDGED_WEAK_PROVIDER ||
      value.model !== WRITING_REVIEW_KIMI_HEDGED_WEAK_MODEL ||
      value.reasoning_effort !== WRITING_REVIEW_KIMI_HEDGED_WEAK_EFFORT
    ) {
      return null;
    }
    const result = readString(value.result);
    if (result === null) return null;
    return {
      case_label: benchmarkCase.case_label,
      attempt_id: benchmarkCase.attempt_id,
      run,
      result,
      elapsed_ms: readNumber(value.elapsed_ms),
      ...readUsage(value),
      schema_valid: value.schema_valid === true,
      official_score:
        readNumber(value.official_score) ?? readNumber(value.raw_official_score)
    };
  } catch {
    return null;
  }
}

export function buildWritingReviewKimiSingleBaselineSummary(
  runs: WritingReviewKimiSingleBaselineRun[]
): WritingReviewKimiSingleBaselineSummary {
  if (runs.length !== 3) {
    throw new Error("Single-request baseline requires exactly three runs.");
  }
  const successful = runs.filter((run) => run.result === "success");
  const elapsedTimes = successful
    .map((run) => run.elapsed_ms)
    .filter((value): value is number => typeof value === "number");
  return {
    runs,
    run_count: 3,
    success_count: successful.length,
    timeout_count: runs.filter((run) => run.result === "timeout").length,
    success_rate: successful.length / 3,
    successful_elapsed_times_ms: elapsedTimes,
    successful_median_elapsed_ms: median(elapsedTimes),
    successful_costs: successful
      .map((run) => run.cost)
      .filter((value): value is number => typeof value === "number"),
    successful_reasoning_tokens: successful
      .map((run) => run.reasoning_tokens)
      .filter((value): value is number => typeof value === "number")
  };
}

export function buildWritingReviewKimiHedgedWeakSummary(
  results: WritingReviewKimiHedgedWeakResult[],
  baselines: WritingReviewKimiSingleBaselineRun[][]
): WritingReviewKimiHedgedWeakSummary {
  assertAligned(results, baselines);
  return {
    provider: WRITING_REVIEW_KIMI_HEDGED_WEAK_PROVIDER,
    model: WRITING_REVIEW_KIMI_HEDGED_WEAK_MODEL,
    reasoning_effort: WRITING_REVIEW_KIMI_HEDGED_WEAK_EFFORT,
    hedge_delay_ms: WRITING_REVIEW_KIMI_HEDGE_DELAY_MS,
    overall_deadline_ms: WRITING_REVIEW_KIMI_HEDGE_DEADLINE_MS,
    baseline_sources: WRITING_REVIEW_KIMI_HEDGED_BASELINE_SOURCES.map(
      ({ run, directory }) => ({ run, directory })
    ),
    single_request_recalled: false,
    hedged_observations_per_case: 1,
    cases: results.map((result, index) => {
      const baseline = buildWritingReviewKimiSingleBaselineSummary(
        baselines[index]
      );
      const { validated_result: _validatedResult, ...hedgedRun } = result;
      return {
        case_label: result.case_label,
        attempt_id: result.attempt_id,
        single_request_baseline: baseline,
        hedged_run: hedgedRun,
        hedged_minus_single_success_median_elapsed_ms: difference(
          result.end_to_end_elapsed_ms,
          baseline.successful_median_elapsed_ms
        )
      };
    })
  };
}

export function writeWritingReviewKimiHedgedWeakFiles(
  outputDir: string,
  results: WritingReviewKimiHedgedWeakResult[],
  baselines: WritingReviewKimiSingleBaselineRun[][],
  fileSystem: {
    mkdirSync: typeof mkdirSync;
    writeFileSync: typeof writeFileSync;
  } = { mkdirSync, writeFileSync }
) {
  assertAligned(results, baselines);
  fileSystem.mkdirSync(outputDir, { recursive: true });
  results.forEach((result) => {
    fileSystem.writeFileSync(
      join(outputDir, `${result.case_label.replace("_", "-")}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  });
  const summary = buildWritingReviewKimiHedgedWeakSummary(results, baselines);
  fileSystem.writeFileSync(
    join(outputDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  fileSystem.writeFileSync(
    join(outputDir, "comparison.md"),
    buildWritingReviewKimiHedgedWeakMarkdown(results, baselines),
    { encoding: "utf8", mode: 0o600 }
  );
  return summary;
}

export function buildWritingReviewKimiHedgedWeakMarkdown(
  results: WritingReviewKimiHedgedWeakResult[],
  baselines: WritingReviewKimiSingleBaselineRun[][]
) {
  const summary = buildWritingReviewKimiHedgedWeakSummary(results, baselines);
  const lines = [
    "# Kimi K3 High — Single Request vs 60s Hedged Request"
  ];
  results.forEach((result, index) => {
    const baseline = summary.cases[index].single_request_baseline;
    lines.push(
      "",
      `## ${result.case_label}`,
      "",
      "### Single-request history",
      "",
      "| Run | Result | Time | Reasoning | Cost |",
      "| --- | --- | ---: | ---: | ---: |",
      ...baseline.runs.map(
        (run) =>
          `| ${run.run} | ${run.result} | ${display(run.elapsed_ms)} | ${display(run.reasoning_tokens)} | ${display(run.cost)} |`
      ),
      "",
      `- Runs: ${baseline.run_count}`,
      `- Success: ${baseline.success_count}`,
      `- Timeout: ${baseline.timeout_count}/${baseline.run_count}`,
      `- Success rate: ${baseline.success_rate}`,
      `- Successful elapsed times: ${formatNumbers(baseline.successful_elapsed_times_ms)}`,
      `- Successful median elapsed: ${display(baseline.successful_median_elapsed_ms)}`,
      `- Successful costs: ${formatNumbers(baseline.successful_costs)}`,
      `- Successful reasoning tokens: ${formatNumbers(baseline.successful_reasoning_tokens)}`,
      "",
      "### Hedged run",
      "",
      "| Metric | Value |",
      "| --- | --- |",
      metricRow("hedge_triggered", result.hedge_triggered),
      metricRow("requests_started", result.requests_started),
      metricRow("winner", result.winner),
      metricRow("result", result.result),
      metricRow("end_to_end_elapsed_ms", result.end_to_end_elapsed_ms),
      metricRow("primary_result", result.primary.result),
      metricRow("primary_elapsed_ms", result.primary.elapsed_ms),
      metricRow("hedge_result", result.hedge?.result ?? null),
      metricRow("hedge_elapsed_ms", result.hedge?.elapsed_ms ?? null),
      metricRow("loser_status", result.loser_status),
      metricRow("winner_cost", result.winner_cost),
      metricRow("observed_completed_total_cost", result.observed_completed_cost),
      metricRow("official_score", result.official_score),
      metricRow(
        "dimension_scores",
        formatRecord(result.dimension_scores ?? {})
      ),
      metricRow("language_edit_count", result.language_edit_count),
      metricRow("content_feedback_count", result.content_feedback_count),
      metricRow(
        "content_feedback_categories",
        formatRecord(result.content_feedback_categories)
      ),
      "",
      "### Latency comparison",
      "",
      `- Hedged end-to-end latency: ${result.end_to_end_elapsed_ms} ms`,
      `- Single-request successful median latency: ${display(baseline.successful_median_elapsed_ms)} ms`,
      `- Delta (hedged - single successful median): ${display(summary.cases[index].hedged_minus_single_success_median_elapsed_ms)} ms`,
      `- Single-request timeouts: ${baseline.timeout_count}/${baseline.run_count}`,
      "",
      "> This case has one hedged observation. No automatic conclusion is made that hedging is better.",
      "",
      "> Aborting a loser does not guarantee that the provider will not charge it. Aborted requests without returned usage keep cost=null and are not estimated."
    );
  });
  return `${lines.join("\n")}\n`;
}

function assertInputs(inputs: WritingReviewKimiHedgedWeakInput[]) {
  if (inputs.length !== 2) {
    throw new Error("Kimi hedged weak benchmark requires exactly two cases.");
  }
  inputs.forEach(assertCase);
  WRITING_REVIEW_KIMI_HEDGED_WEAK_CASES.forEach((expected, index) => {
    if (inputs[index].caseLabel !== expected.case_label) {
      throw new Error(`Unexpected hedged case order at position ${index + 1}.`);
    }
  });
}

function assertCase(input: WritingReviewKimiHedgedWeakInput) {
  const expected = WRITING_REVIEW_KIMI_HEDGED_WEAK_CASES.find(
    (item) => item.case_label === input.caseLabel
  );
  if (
    !expected ||
    input.attemptId !== expected.attempt_id ||
    input.taskType !== expected.task_type ||
    input.qualityLabel !== expected.quality_label
  ) {
    throw new Error(`Unexpected Kimi hedged case: ${input.caseLabel}.`);
  }
}

function assertAligned(
  results: WritingReviewKimiHedgedWeakResult[],
  baselines: WritingReviewKimiSingleBaselineRun[][]
) {
  if (results.length !== 2 || baselines.length !== 2) {
    throw new Error("Hedged weak output requires two aligned cases.");
  }
  WRITING_REVIEW_KIMI_HEDGED_WEAK_CASES.forEach((expected, index) => {
    if (
      results[index].case_label !== expected.case_label ||
      results[index].attempt_id !== expected.attempt_id ||
      baselines[index].length !== 3 ||
      baselines[index].some(
        (baseline) =>
          baseline.case_label !== expected.case_label ||
          baseline.attempt_id !== expected.attempt_id
      )
    ) {
      throw new Error(`Unexpected hedged output at position ${index + 1}.`);
    }
  });
}

function requiredOutcome(value: AttemptOutcome | null) {
  if (!value) throw new Error("Missing hedged request outcome.");
  return value;
}

function requiredFailure(value: TerminalResult | null) {
  if (!value) throw new Error("Missing final hedged failure status.");
  return value;
}

function asTerminal(value: RequestResult): TerminalResult {
  if (value === "success" || value === "aborted_due_to_winner") {
    throw new Error(`Expected terminal failure, received ${value}.`);
  }
  return value;
}

function elapsed(startedAt: number, now: () => number) {
  return Math.max(0, now() - startedAt);
}

function scoreDimensions(review: AIReviewResultV22) {
  return Object.fromEntries(
    Object.entries(review.scores.dimension_scores).map(([key, score]) => [
      key,
      score.ai_score
    ])
  );
}

function countCategories(review: AIReviewResultV22) {
  return review.content_feedback.reduce<CategoryCounts>((counts, feedback) => {
    counts[feedback.category] = (counts[feedback.category] ?? 0) + 1;
    return counts;
  }, {});
}

function safeIssues(error: unknown): ValidationIssue[] {
  if (!isRecord(error) || !Array.isArray(error.issues)) return [];
  return error.issues.flatMap((issue) =>
    isRecord(issue) &&
    typeof issue.path === "string" &&
    typeof issue.message === "string"
      ? [{ path: issue.path, message: issue.message }]
      : []
  );
}

function errorCode(error: unknown) {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : "OPENROUTER_REQUEST_FAILED";
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown benchmark error.";
}

function readUsage(value: Record<string, unknown>): OpenRouterTokenUsage {
  return {
    prompt_tokens: readNumber(value.prompt_tokens),
    cached_tokens: readNumber(value.cached_tokens),
    completion_tokens: readNumber(value.completion_tokens),
    reasoning_tokens: readNumber(value.reasoning_tokens),
    accepted_prediction_tokens: readNumber(value.accepted_prediction_tokens),
    rejected_prediction_tokens: readNumber(value.rejected_prediction_tokens),
    total_tokens: readNumber(value.total_tokens),
    cost: readNumber(value.cost),
    upstream_inference_cost: readNumber(value.upstream_inference_cost),
    upstream_inference_prompt_cost: readNumber(
      value.upstream_inference_prompt_cost
    ),
    upstream_inference_completions_cost: readNumber(
      value.upstream_inference_completions_cost
    )
  };
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function difference(left: number | null, right: number | null) {
  return left === null || right === null ? null : left - right;
}

function metricRow(label: string, value: string | number | boolean | null) {
  return `| ${label} | ${value === null ? "—" : String(value)} |`;
}

function formatNumbers(values: number[]) {
  return values.length === 0 ? "—" : values.join(", ");
}

function formatRecord(value: CategoryCounts) {
  const entries = Object.entries(value);
  return entries.length === 0
    ? "—"
    : entries.map(([key, count]) => `${key}: ${count}`).join(", ");
}

function display(value: number | null) {
  return value === null ? "—" : String(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

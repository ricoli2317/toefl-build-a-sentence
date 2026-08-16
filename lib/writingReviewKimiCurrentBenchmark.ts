import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMPTY_OPENROUTER_USAGE,
  getOpenRouterErrorDiagnostic,
  OpenRouterWritingReviewError,
  requestOpenRouterWithTimeout,
  type OpenRouterTokenUsage,
  type OpenRouterWritingReviewInput,
  type OpenRouterWritingReviewResponse
} from "./openrouterWritingReview.ts";
import {
  readWritingReviewDeepSeekKimiBaseline,
  WRITING_REVIEW_DEEPSEEK_STABILITY_ALL_CASES,
  type WritingReviewDeepSeekStabilityBaseline
} from "./writingReviewDeepSeekStabilityBenchmark.ts";
import type {
  AIReviewRawResultV22,
  AIReviewResultV22
} from "./writingReviewSchemaV22.ts";
import type { WritingTaskType } from "./writing.ts";

export const WRITING_REVIEW_KIMI_CURRENT_CASES =
  WRITING_REVIEW_DEEPSEEK_STABILITY_ALL_CASES;
export const WRITING_REVIEW_KIMI_CURRENT_MODEL = "moonshotai/kimi-k3" as const;
export const WRITING_REVIEW_KIMI_CURRENT_PROVIDER = "openrouter" as const;
export const WRITING_REVIEW_KIMI_CURRENT_EFFORT = "high" as const;
export const WRITING_REVIEW_KIMI_CURRENT_OPERATION =
  "kimi_current_prompt_benchmark" as const;
export const WRITING_REVIEW_KIMI_CURRENT_TIMEOUT_MS = 240_000;
export const WRITING_REVIEW_KIMI_CURRENT_OUTPUT_DIR =
  "tmp/writing-review-kimi-current-prompt";
export const WRITING_REVIEW_KIMI_CURRENT_HISTORICAL_DIR =
  "tmp/writing-review-reasoning-stability";

type BenchmarkCase = (typeof WRITING_REVIEW_KIMI_CURRENT_CASES)[number];
export type WritingReviewKimiBenchmarkCase = Pick<
  BenchmarkCase,
  "case_label" | "attempt_id" | "task_type" | "quality_label"
>;
export type WritingReviewKimiCurrentCaseLabel = BenchmarkCase["case_label"];
type QualityLabel = BenchmarkCase["quality_label"];
type ScoreMap = Record<string, number>;
type CategoryCounts = Record<string, number>;
type ValidationIssue = { path: string; message: string };
type ResultKind =
  | "success"
  | "timeout"
  | "provider_error"
  | "invalid_json"
  | "validation_error"
  | "localization_error";
type EditPair = Pick<
  AIReviewRawResultV22["language_edits"][number],
  "original_text" | "replacement_text"
>;

export type WritingReviewKimiCurrentInput = OpenRouterWritingReviewInput & {
  attemptId: string;
  caseLabel: WritingReviewKimiCurrentCaseLabel;
  qualityLabel: QualityLabel;
};

export type WritingReviewKimiCurrentResult = OpenRouterTokenUsage & {
  case_label: WritingReviewKimiCurrentCaseLabel;
  attempt_id: string;
  task_type: WritingTaskType;
  quality_label: QualityLabel;
  provider: typeof WRITING_REVIEW_KIMI_CURRENT_PROVIDER;
  model: typeof WRITING_REVIEW_KIMI_CURRENT_MODEL;
  reasoning_effort: typeof WRITING_REVIEW_KIMI_CURRENT_EFFORT;
  operation: typeof WRITING_REVIEW_KIMI_CURRENT_OPERATION;
  elapsed_ms: number;
  result: ResultKind;
  error_code: string | null;
  error: string | null;
  http_status: number | null;
  provider_error_type: string | null;
  provider_error_code: string | number | null;
  provider_name: string | null;
  schema_valid: boolean;
  official_score: number | null;
  dimension_scores: ScoreMap | null;
  language_edits: AIReviewResultV22["language_edits"] | null;
  content_feedback: AIReviewResultV22["content_feedback"] | null;
  language_edit_count: number | null;
  content_feedback_count: number | null;
  content_feedback_categories: CategoryCounts;
  overall_feedback: string | null;
  raw_official_score: number | null;
  raw_dimension_scores: ScoreMap | null;
  raw_language_edit_count: number | null;
  raw_content_feedback_count: number | null;
  raw_content_feedback_categories: CategoryCounts;
  localization_issue_count: number;
  localization_issues: ValidationIssue[];
  validated_result: AIReviewResultV22 | null;
  validated_raw_result: AIReviewRawResultV22 | null;
};

export type WritingReviewKimiCurrentComparison = {
  case_label: WritingReviewKimiCurrentCaseLabel;
  baseline_available: boolean;
  historical_result: string | null;
  current_result: ResultKind;
  official_score_delta: number | null;
  dimension_score_deltas: Record<string, number | null>;
  language_edit_count_delta: number | null;
  content_feedback_count_delta: number | null;
  historical_feedback_categories: CategoryCounts;
  current_feedback_categories: CategoryCounts;
  feedback_category_deltas: CategoryCounts;
  shared_edits: EditPair[];
  historical_only_edits: EditPair[];
  current_only_edits: EditPair[];
};

export type WritingReviewKimiCurrentStatistics = {
  total_cases: 4;
  success: number;
  timeout: number;
  provider_error: number;
  invalid_json: number;
  validation_error: number;
  localization_error: number;
  schema_success_count: number;
  localization_success_count: number;
  success_rate: number;
  email_weak_timeout_reproduced: boolean;
  ad_good_invalid_json_reproduced: boolean;
};

export type WritingReviewKimiCurrentAggregate = {
  successful_cases: number;
  avg_elapsed_ms: number | null;
  median_elapsed_ms: number | null;
  avg_reasoning_tokens: number | null;
  avg_completion_tokens: number | null;
  avg_total_tokens: number | null;
  avg_cost: number | null;
};

export type WritingReviewKimiCurrentSummary = {
  provider: typeof WRITING_REVIEW_KIMI_CURRENT_PROVIDER;
  model: typeof WRITING_REVIEW_KIMI_CURRENT_MODEL;
  reasoning_effort: typeof WRITING_REVIEW_KIMI_CURRENT_EFFORT;
  operation: typeof WRITING_REVIEW_KIMI_CURRENT_OPERATION;
  cases: typeof WRITING_REVIEW_KIMI_CURRENT_CASES;
  results: Array<
    Omit<
      WritingReviewKimiCurrentResult,
      | "validated_result"
      | "validated_raw_result"
      | "localization_issues"
      | "language_edits"
      | "content_feedback"
    >
  >;
  historical_baselines: Array<
    Omit<WritingReviewDeepSeekStabilityBaseline, "validated_result"> | null
  >;
  comparisons: WritingReviewKimiCurrentComparison[];
  statistics: WritingReviewKimiCurrentStatistics;
  aggregate: WritingReviewKimiCurrentAggregate;
};

export type WritingReviewKimiCurrentDependencies = {
  now?: () => number;
  timeoutMs?: number;
  onRequestStart?(input: WritingReviewKimiCurrentInput): void;
  onRequestComplete?(result: WritingReviewKimiCurrentResult): void;
  requestWithTimeout?<T>(
    request: (signal: AbortSignal) => Promise<T>,
    options: { timeoutMs: number; timeoutMessage: string }
  ): Promise<T>;
  requestAI(
    input: OpenRouterWritingReviewInput,
    signal: AbortSignal
  ): Promise<OpenRouterWritingReviewResponse>;
  parseRawReview(value: unknown): AIReviewRawResultV22;
  parseReview(value: unknown, responseText: string): AIReviewResultV22;
};

export async function benchmarkWritingReviewKimiCurrent(
  inputs: WritingReviewKimiCurrentInput[],
  dependencies: WritingReviewKimiCurrentDependencies
) {
  return runWritingReviewKimiBenchmarkCases(
    inputs,
    WRITING_REVIEW_KIMI_CURRENT_CASES,
    dependencies
  );
}

export async function runWritingReviewKimiBenchmarkCases(
  inputs: WritingReviewKimiCurrentInput[],
  expectedCases: readonly WritingReviewKimiBenchmarkCase[],
  dependencies: WritingReviewKimiCurrentDependencies
) {
  assertExpectedInputs(inputs, expectedCases);
  const now = dependencies.now ?? (() => Date.now());
  const timeoutMs = dependencies.timeoutMs ?? WRITING_REVIEW_KIMI_CURRENT_TIMEOUT_MS;
  const withTimeout = dependencies.requestWithTimeout ?? requestOpenRouterWithTimeout;
  const results: WritingReviewKimiCurrentResult[] = [];

  for (const input of inputs) {
    dependencies.onRequestStart?.(input);
    const startedAt = now();
    let usage: OpenRouterTokenUsage = { ...EMPTY_OPENROUTER_USAGE };
    let result: WritingReviewKimiCurrentResult;
    try {
      const response = await withTimeout(
        (signal) => dependencies.requestAI(input, signal),
        { timeoutMs, timeoutMessage: `${input.caseLabel} timed out.` }
      );
      usage = response.usage;
      let value: unknown;
      try {
        value = JSON.parse(response.content) as unknown;
      } catch {
        result = failureResult(input, now() - startedAt, usage, {
          result: "invalid_json",
          errorCode: "AI_RESPONSE_INVALID_JSON",
          error: new Error("OpenRouter returned invalid JSON.")
        });
        results.push(result);
        dependencies.onRequestComplete?.(result);
        continue;
      }

      let raw: AIReviewRawResultV22;
      try {
        raw = dependencies.parseRawReview(value);
        if (raw.schema_version !== "2.2" || raw.task_type !== input.taskType) {
          throw new Error("Response did not match this case's v2.2 task schema.");
        }
      } catch (error) {
        result = failureResult(input, now() - startedAt, usage, {
          result: "validation_error",
          errorCode: "AI_RESPONSE_SCHEMA_INVALID",
          error
        });
        results.push(result);
        dependencies.onRequestComplete?.(result);
        continue;
      }

      try {
        result = successResult(
          input,
          now() - startedAt,
          usage,
          dependencies.parseReview(value, input.responseText)
        );
      } catch (error) {
        result = localizationFailureResult(
          input,
          now() - startedAt,
          usage,
          raw,
          error
        );
      }
    } catch (error) {
      const timedOut =
        error instanceof OpenRouterWritingReviewError &&
        error.code === "AI_REQUEST_TIMEOUT";
      result = failureResult(input, now() - startedAt, usage, {
        result: timedOut ? "timeout" : "provider_error",
        errorCode: timedOut ? "AI_REQUEST_TIMEOUT" : errorCode(error),
        error
      });
    }
    results.push(result);
    dependencies.onRequestComplete?.(result);
  }
  return results;
}

function baseResult(
  input: WritingReviewKimiCurrentInput,
  elapsedMs: number,
  usage: OpenRouterTokenUsage
) {
  return {
    case_label: input.caseLabel,
    attempt_id: input.attemptId,
    task_type: input.taskType,
    quality_label: input.qualityLabel,
    provider: WRITING_REVIEW_KIMI_CURRENT_PROVIDER,
    model: WRITING_REVIEW_KIMI_CURRENT_MODEL,
    reasoning_effort: WRITING_REVIEW_KIMI_CURRENT_EFFORT,
    operation: WRITING_REVIEW_KIMI_CURRENT_OPERATION,
    elapsed_ms: Math.max(0, elapsedMs),
    ...usage
  };
}

function successResult(
  input: WritingReviewKimiCurrentInput,
  elapsedMs: number,
  usage: OpenRouterTokenUsage,
  validated: AIReviewResultV22
): WritingReviewKimiCurrentResult {
  return {
    ...baseResult(input, elapsedMs, usage),
    result: "success",
    error_code: null,
    error: null,
    http_status: null,
    provider_error_type: null,
    provider_error_code: null,
    provider_name: null,
    schema_valid: true,
    official_score: validated.scores.official_score.ai_score,
    dimension_scores: scoreDimensions(validated),
    language_edits: validated.language_edits,
    content_feedback: validated.content_feedback,
    language_edit_count: validated.language_edits.length,
    content_feedback_count: validated.content_feedback.length,
    content_feedback_categories: countCategories(validated),
    overall_feedback: validated.overall_feedback,
    raw_official_score: null,
    raw_dimension_scores: null,
    raw_language_edit_count: null,
    raw_content_feedback_count: null,
    raw_content_feedback_categories: {},
    localization_issue_count: 0,
    localization_issues: [],
    validated_result: validated,
    validated_raw_result: null
  };
}

function localizationFailureResult(
  input: WritingReviewKimiCurrentInput,
  elapsedMs: number,
  usage: OpenRouterTokenUsage,
  raw: AIReviewRawResultV22,
  error: unknown
): WritingReviewKimiCurrentResult {
  const issues = safeIssues(error);
  return {
    ...baseResult(input, elapsedMs, usage),
    result: "localization_error",
    error_code: "AI_RESPONSE_LOCALIZATION_FAILED",
    error: safeErrorMessage(error),
    http_status: null,
    provider_error_type: null,
    provider_error_code: null,
    provider_name: null,
    schema_valid: true,
    official_score: null,
    dimension_scores: null,
    language_edits: null,
    content_feedback: null,
    language_edit_count: null,
    content_feedback_count: null,
    content_feedback_categories: {},
    overall_feedback: null,
    raw_official_score: raw.scores.official_score.ai_score,
    raw_dimension_scores: scoreDimensions(raw),
    raw_language_edit_count: raw.language_edits.length,
    raw_content_feedback_count: raw.content_feedback.length,
    raw_content_feedback_categories: countCategories(raw),
    localization_issue_count: issues.length,
    localization_issues: issues,
    validated_result: null,
    validated_raw_result: raw
  };
}

function failureResult(
  input: WritingReviewKimiCurrentInput,
  elapsedMs: number,
  usage: OpenRouterTokenUsage,
  failure: {
    result: Exclude<ResultKind, "success" | "localization_error">;
    errorCode: string;
    error: unknown;
  }
): WritingReviewKimiCurrentResult {
  const diagnostic = getOpenRouterErrorDiagnostic(failure.error);
  return {
    ...baseResult(input, elapsedMs, usage),
    result: failure.result,
    error_code: failure.errorCode,
    error: safeErrorMessage(failure.error),
    http_status: diagnostic.http_status,
    provider_error_type: diagnostic.error_type,
    provider_error_code: diagnostic.provider_code,
    provider_name: diagnostic.provider_name,
    schema_valid: false,
    official_score: null,
    dimension_scores: null,
    language_edits: null,
    content_feedback: null,
    language_edit_count: null,
    content_feedback_count: null,
    content_feedback_categories: {},
    overall_feedback: null,
    raw_official_score: null,
    raw_dimension_scores: null,
    raw_language_edit_count: null,
    raw_content_feedback_count: null,
    raw_content_feedback_categories: {},
    localization_issue_count: 0,
    localization_issues: [],
    validated_result: null,
    validated_raw_result: null
  };
}

export function readWritingReviewKimiHistoricalBaseline(
  benchmarkCase: BenchmarkCase,
  filePath: string,
  readFile?: Parameters<typeof readWritingReviewDeepSeekKimiBaseline>[2]
) {
  return readWritingReviewDeepSeekKimiBaseline(benchmarkCase, filePath, readFile);
}

export function buildWritingReviewKimiCurrentSummary(
  results: WritingReviewKimiCurrentResult[],
  historical: Array<WritingReviewDeepSeekStabilityBaseline | null>
): WritingReviewKimiCurrentSummary {
  assertResults(results);
  assertHistorical(historical);
  return {
    provider: WRITING_REVIEW_KIMI_CURRENT_PROVIDER,
    model: WRITING_REVIEW_KIMI_CURRENT_MODEL,
    reasoning_effort: WRITING_REVIEW_KIMI_CURRENT_EFFORT,
    operation: WRITING_REVIEW_KIMI_CURRENT_OPERATION,
    cases: WRITING_REVIEW_KIMI_CURRENT_CASES,
    results: results.map(
      ({
        validated_result: _validatedResult,
        validated_raw_result: _validatedRawResult,
        localization_issues: _localizationIssues,
        language_edits: _languageEdits,
        content_feedback: _contentFeedback,
        ...result
      }) => result
    ),
    historical_baselines: historical.map((baseline) =>
      baseline
        ? (({ validated_result: _validatedResult, ...summary }) => summary)(baseline)
        : null
    ),
    comparisons: results.map((result, index) =>
      compareCase(result, historical[index])
    ),
    statistics: statistics(results),
    aggregate: aggregate(results)
  };
}

export function writeWritingReviewKimiCurrentFiles(
  outputDir: string,
  results: WritingReviewKimiCurrentResult[],
  historical: Array<WritingReviewDeepSeekStabilityBaseline | null>,
  fileSystem: {
    mkdirSync: typeof mkdirSync;
    writeFileSync: typeof writeFileSync;
  } = { mkdirSync, writeFileSync }
) {
  assertResults(results);
  fileSystem.mkdirSync(outputDir, { recursive: true });
  for (const result of results) {
    fileSystem.writeFileSync(
      join(outputDir, `${result.case_label.replace("_", "-")}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }
  const summary = buildWritingReviewKimiCurrentSummary(results, historical);
  fileSystem.writeFileSync(
    join(outputDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  fileSystem.writeFileSync(
    join(outputDir, "comparison.md"),
    buildWritingReviewKimiCurrentMarkdown(results, historical),
    { encoding: "utf8", mode: 0o600 }
  );
  return summary;
}

export function buildWritingReviewKimiCurrentMarkdown(
  results: WritingReviewKimiCurrentResult[],
  historical: Array<WritingReviewDeepSeekStabilityBaseline | null>
) {
  const summary = buildWritingReviewKimiCurrentSummary(results, historical);
  const lines = [
    "# Kimi K3 High — Current Prompt Stability Benchmark",
    "",
    "| Case | Result | Time | Reasoning | Total | Cost | Score | Edits | Feedback |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...results.map(topRow)
  ];

  results.forEach((result, index) => {
    const baseline = historical[index];
    const comparison = summary.comparisons[index];
    const review = comparableReview(result);
    const scores = comparableScores(result);
    lines.push(
      "",
      `## ${result.case_label}`,
      "",
      "### Result and Performance",
      "",
      "| Version | Result | Time | Reasoning | Total | Cost |",
      "| --- | --- | ---: | ---: | ---: | ---: |",
      baseline
        ? performanceRow("Historical Kimi high", baseline)
        : "| Historical Kimi high | unavailable | — | — | — | — |",
      performanceRow("Current Prompt Kimi high", result),
      "",
      "### Scores",
      "",
      "| Dimension | Historical | Current | Delta (Current - Historical) |",
      "| --- | ---: | ---: | ---: |",
      scoreRow("official", baseline?.official_score ?? null, scores.official)
    );
    for (const dimension of Object.keys(comparison.dimension_score_deltas)) {
      lines.push(
        scoreRow(
          dimension,
          baseline?.dimension_scores?.[dimension] ?? null,
          scores.dimensions?.[dimension] ?? null
        )
      );
    }
    lines.push(
      "",
      result.result === "localization_error"
        ? "### Raw Language Edits Before Localization"
        : "### Language Edits",
      "",
      ...(result.result === "localization_error" ? ["**Localization failed.**", ""] : []),
      ...formatEdits(review),
      "",
      `- Count delta: ${display(comparison.language_edit_count_delta)}`,
      `- Exact shared (${comparison.shared_edits.length}): ${formatEditPairs(comparison.shared_edits)}`,
      `- Historical only (${comparison.historical_only_edits.length}): ${formatEditPairs(comparison.historical_only_edits)}`,
      `- Current only (${comparison.current_only_edits.length}): ${formatEditPairs(comparison.current_only_edits)}`,
      "",
      "> The current prompt changed the span rule, so different spans do not necessarily mean different error coverage. Exact matching cannot determine quality automatically.",
      "",
      "### Content Feedback",
      "",
      ...formatFeedback(review),
      "",
      `- Count delta: ${display(comparison.content_feedback_count_delta)}`,
      `- Historical categories: ${formatRecord(comparison.historical_feedback_categories)}`,
      `- Current categories: ${formatRecord(comparison.current_feedback_categories)}`,
      `- Category deltas: ${formatRecord(comparison.feedback_category_deltas)}`,
      "",
      "### Localization Issues",
      "",
      ...formatIssues(result.localization_issues),
      "",
      "### Overall Feedback",
      "",
      result.overall_feedback ?? result.validated_raw_result?.overall_feedback ?? "—",
      "",
      `### Manual QA — ${result.case_label}`,
      "",
      ...manualQa(result.case_label)
    );
  });

  lines.push(
    "",
    "## Current Prompt Statistics",
    "",
    ...Object.entries(summary.statistics).map(([key, value]) => `- ${key}: ${value}`),
    "",
    "## Successful-Result Aggregate",
    "",
    ...Object.entries(summary.aggregate).map(
      ([key, value]) => `- ${key}: ${value === null ? "—" : value}`
    ),
    ""
  );
  return `${lines.join("\n")}\n`;
}

function compareCase(
  result: WritingReviewKimiCurrentResult,
  baseline: WritingReviewDeepSeekStabilityBaseline | null
): WritingReviewKimiCurrentComparison {
  const currentScores = comparableScores(result);
  const currentEdits = editMap(comparableReview(result));
  const historicalEdits = editMap(baseline?.validated_result ?? null);
  const dimensions = new Set([
    ...Object.keys(baseline?.dimension_scores ?? {}),
    ...Object.keys(currentScores.dimensions ?? {})
  ]);
  const currentCategories = comparableCategories(result);
  const categories = new Set([
    ...Object.keys(baseline?.content_feedback_categories ?? {}),
    ...Object.keys(currentCategories)
  ]);
  return {
    case_label: result.case_label,
    baseline_available: baseline !== null,
    historical_result: baseline?.result ?? null,
    current_result: result.result,
    official_score_delta: difference(
      currentScores.official,
      baseline?.official_score ?? null
    ),
    dimension_score_deltas: Object.fromEntries(
      Array.from(dimensions).map((key) => [
        key,
        difference(
          currentScores.dimensions?.[key] ?? null,
          baseline?.dimension_scores?.[key] ?? null
        )
      ])
    ),
    language_edit_count_delta: difference(
      comparableEditCount(result),
      baseline?.language_edit_count ?? null
    ),
    content_feedback_count_delta: difference(
      comparableFeedbackCount(result),
      baseline?.content_feedback_count ?? null
    ),
    historical_feedback_categories: baseline?.content_feedback_categories ?? {},
    current_feedback_categories: currentCategories,
    feedback_category_deltas: Object.fromEntries(
      Array.from(categories).map((key) => [
        key,
        (currentCategories[key] ?? 0) -
          (baseline?.content_feedback_categories[key] ?? 0)
      ])
    ),
    shared_edits: intersection(currentEdits, historicalEdits),
    historical_only_edits: differenceMap(historicalEdits, currentEdits),
    current_only_edits: differenceMap(currentEdits, historicalEdits)
  };
}

function statistics(results: WritingReviewKimiCurrentResult[]) {
  const count = (kind: ResultKind) =>
    results.filter((result) => result.result === kind).length;
  return {
    total_cases: 4 as const,
    success: count("success"),
    timeout: count("timeout"),
    provider_error: count("provider_error"),
    invalid_json: count("invalid_json"),
    validation_error: count("validation_error"),
    localization_error: count("localization_error"),
    schema_success_count: results.filter((result) => result.schema_valid).length,
    localization_success_count: count("success"),
    success_rate: count("success") / 4,
    email_weak_timeout_reproduced:
      results.find((result) => result.case_label === "email_weak")?.result ===
      "timeout",
    ad_good_invalid_json_reproduced:
      results.find((result) => result.case_label === "ad_good")?.result ===
      "invalid_json"
  };
}

function aggregate(results: WritingReviewKimiCurrentResult[]) {
  const successful = results.filter((result) => result.result === "success");
  return {
    successful_cases: successful.length,
    avg_elapsed_ms: average(values(successful, "elapsed_ms")),
    median_elapsed_ms: median(values(successful, "elapsed_ms")),
    avg_reasoning_tokens: average(values(successful, "reasoning_tokens")),
    avg_completion_tokens: average(values(successful, "completion_tokens")),
    avg_total_tokens: average(values(successful, "total_tokens")),
    avg_cost: average(values(successful, "cost"))
  };
}

function assertExpectedInputs(
  inputs: WritingReviewKimiCurrentInput[],
  expectedCases: readonly WritingReviewKimiBenchmarkCase[]
) {
  if (inputs.length !== expectedCases.length) {
    const expectedCount = expectedCases.length === 4 ? "four" : expectedCases.length;
    throw new Error(
      `Kimi benchmark requires exactly ${expectedCount} fixed cases.`
    );
  }
  expectedCases.forEach((expected, index) => {
    const input = inputs[index];
    if (
      input.attemptId !== expected.attempt_id ||
      input.caseLabel !== expected.case_label ||
      input.qualityLabel !== expected.quality_label ||
      input.taskType !== expected.task_type
    ) {
      throw new Error(`Unexpected Kimi current case at position ${index + 1}.`);
    }
  });
}

function assertResults(results: WritingReviewKimiCurrentResult[]) {
  if (results.length !== WRITING_REVIEW_KIMI_CURRENT_CASES.length) {
    throw new Error("Kimi current summary requires exactly four results.");
  }
  WRITING_REVIEW_KIMI_CURRENT_CASES.forEach((expected, index) => {
    if (
      results[index].case_label !== expected.case_label ||
      results[index].attempt_id !== expected.attempt_id
    ) {
      throw new Error(`Unexpected Kimi current result at position ${index + 1}.`);
    }
  });
}

function assertHistorical(
  historical: Array<WritingReviewDeepSeekStabilityBaseline | null>
) {
  if (historical.length !== WRITING_REVIEW_KIMI_CURRENT_CASES.length) {
    throw new Error("Kimi current summary requires four historical baseline slots.");
  }
  historical.forEach((baseline, index) => {
    if (
      baseline &&
      baseline.case_label !== WRITING_REVIEW_KIMI_CURRENT_CASES[index].case_label
    ) {
      throw new Error(`Unexpected historical baseline at position ${index + 1}.`);
    }
  });
}

function comparableReview(result: WritingReviewKimiCurrentResult) {
  return result.validated_result ?? result.validated_raw_result;
}

function comparableScores(result: WritingReviewKimiCurrentResult) {
  return {
    official: result.official_score ?? result.raw_official_score,
    dimensions: result.dimension_scores ?? result.raw_dimension_scores
  };
}

function comparableEditCount(result: WritingReviewKimiCurrentResult) {
  return result.language_edit_count ?? result.raw_language_edit_count;
}

function comparableFeedbackCount(result: WritingReviewKimiCurrentResult) {
  return result.content_feedback_count ?? result.raw_content_feedback_count;
}

function comparableCategories(result: WritingReviewKimiCurrentResult) {
  return result.result === "localization_error"
    ? result.raw_content_feedback_categories
    : result.content_feedback_categories;
}

function scoreDimensions(review: AIReviewRawResultV22 | AIReviewResultV22) {
  return Object.fromEntries(
    Object.entries(review.scores.dimension_scores).map(([key, value]) => [
      key,
      value.ai_score
    ])
  );
}

function countCategories(review: AIReviewRawResultV22 | AIReviewResultV22) {
  return review.content_feedback.reduce<CategoryCounts>((counts, feedback) => {
    counts[feedback.category] = (counts[feedback.category] ?? 0) + 1;
    return counts;
  }, {});
}

function editMap(review: AIReviewRawResultV22 | AIReviewResultV22 | null) {
  return new Map(
    (review?.language_edits ?? []).map((edit) => {
      const pair = {
        original_text: edit.original_text,
        replacement_text: edit.replacement_text
      };
      return [`${pair.original_text}\u0000${pair.replacement_text}`, pair] as const;
    })
  );
}

function intersection(first: Map<string, EditPair>, second: Map<string, EditPair>) {
  return Array.from(first.entries())
    .filter(([key]) => second.has(key))
    .map(([, pair]) => pair);
}

function differenceMap(first: Map<string, EditPair>, second: Map<string, EditPair>) {
  return Array.from(first.entries())
    .filter(([key]) => !second.has(key))
    .map(([, pair]) => pair);
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

function values(
  results: WritingReviewKimiCurrentResult[],
  key:
    | "elapsed_ms"
    | "reasoning_tokens"
    | "completion_tokens"
    | "total_tokens"
    | "cost"
) {
  return results
    .map((result) => result[key])
    .filter((value): value is number => typeof value === "number");
}

function average(items: number[]) {
  return items.length === 0
    ? null
    : items.reduce((sum, value) => sum + value, 0) / items.length;
}

function median(items: number[]) {
  if (items.length === 0) return null;
  const sorted = [...items].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function difference(left: number | null, right: number | null) {
  return left === null || right === null ? null : left - right;
}

function topRow(result: WritingReviewKimiCurrentResult) {
  return `| ${result.case_label} | ${result.result} | ${result.elapsed_ms} | ${display(result.reasoning_tokens)} | ${display(result.total_tokens)} | ${display(result.cost)} | ${display(result.official_score ?? result.raw_official_score)} | ${display(result.language_edit_count ?? result.raw_language_edit_count)} | ${display(result.content_feedback_count ?? result.raw_content_feedback_count)} |`;
}

function performanceRow(
  label: string,
  result: WritingReviewKimiCurrentResult | WritingReviewDeepSeekStabilityBaseline
) {
  return `| ${label} | ${result.result} | ${display(result.elapsed_ms)} | ${display(result.reasoning_tokens)} | ${display(result.total_tokens)} | ${display(result.cost)} |`;
}

function scoreRow(label: string, historical: number | null, current: number | null) {
  return `| ${escapeTable(label)} | ${display(historical)} | ${display(current)} | ${display(difference(current, historical))} |`;
}

function formatEdits(review: AIReviewRawResultV22 | AIReviewResultV22 | null) {
  if (!review || review.language_edits.length === 0) return ["- —"];
  return review.language_edits.map(
    (edit) =>
      `- \`${escapeInline(edit.original_text)}\` → \`${escapeInline(edit.replacement_text)}\` — ${escapeInline(edit.category)}, ${escapeInline(edit.severity)}: ${escapeInline(edit.explanation)}`
  );
}

function formatEditPairs(edits: EditPair[]) {
  return edits.length === 0
    ? "—"
    : edits
        .map(
          (edit) =>
            `\`${escapeInline(edit.original_text)}\` → \`${escapeInline(edit.replacement_text)}\``
        )
        .join("; ");
}

function formatFeedback(review: AIReviewRawResultV22 | AIReviewResultV22 | null) {
  if (!review || review.content_feedback.length === 0) return ["- —"];
  return review.content_feedback.map(
    (feedback) =>
      `- **${escapeInline(feedback.category)}** — \`${escapeInline(feedback.original_sentence)}\` — ${escapeInline(feedback.issue)} — ${escapeInline(feedback.suggestion)} — Proposed: \`${escapeInline(feedback.proposed_revision)}\``
  );
}

function formatIssues(issues: ValidationIssue[]) {
  return issues.length === 0
    ? ["- —"]
    : issues.map(
        (issue) => `- \`${escapeInline(issue.path)}\`: ${escapeInline(issue.message)}`
      );
}

function formatRecord(record: Record<string, number>) {
  const entries = Object.entries(record);
  return entries.length === 0
    ? "—"
    : entries.map(([key, value]) => `${key}: ${value}`).join(", ");
}

function manualQa(caseLabel: WritingReviewKimiCurrentCaseLabel) {
  const checklists: Record<WritingReviewKimiCurrentCaseLabel, string[]> = {
    email_good: [
      "是否仍为 5",
      "是否因轻微 Word Choice 过度扣分",
      "是否制造不必要修改"
    ],
    email_weak: [
      "是否再次 timeout",
      "若成功，communicative purpose / elaboration / grammar / Word Choice 是否合理"
    ],
    ad_good: [
      "是否再次 invalid_json",
      "Schema / localization 是否成功",
      "是否为 5",
      "是否只抓真实语言问题"
    ],
    ad_weak: [
      "是否仍为 3",
      "teenage years vs age 10",
      "nurture 论证不足",
      "growth environments",
      "kindful people",
      "grammar / Word Choice / content feedback 覆盖"
    ]
  };
  return checklists[caseLabel].map((item) => `- ${item}`);
}

function errorCode(error: unknown) {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : "OPENROUTER_REQUEST_FAILED";
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Unknown benchmark error.";
}

function display(value: number | null) {
  return value === null ? "—" : String(value);
}

function escapeInline(value: string) {
  return value.replace(/\s+/g, " ").replace(/`/g, "\\`").trim();
}

function escapeTable(value: string) {
  return escapeInline(value).replace(/\|/g, "\\|");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

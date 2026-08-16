import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMPTY_OPENROUTER_USAGE,
  getOpenRouterErrorDiagnostic,
  OpenRouterWritingReviewError,
  requestOpenRouterWithTimeout,
  WRITING_REVIEW_FULL_REQUEST_TIMEOUT_MS,
  type OpenRouterTokenUsage,
  type OpenRouterWritingReviewInput,
  type OpenRouterWritingReviewResponse
} from "./openrouterWritingReview.ts";
import type {
  AIReviewRawResultV22,
  AIReviewResultV22
} from "./writingReviewSchemaV22.ts";
import type { WritingTaskType } from "./writing.ts";

export const WRITING_REVIEW_DEEPSEEK_STABILITY_NEW_CASES = [
  {
    case_label: "email_good",
    attempt_id: "a20ed773-23cc-4a10-83e0-4493c4f619de",
    task_type: "email",
    quality_label: "good"
  },
  {
    case_label: "email_weak",
    attempt_id: "cde72af6-e6d0-439b-b3ac-91fb2ab117b1",
    task_type: "email",
    quality_label: "weak"
  },
  {
    case_label: "ad_good",
    attempt_id: "a292bcdb-6a86-4ab8-a00a-4c4e6c707c9c",
    task_type: "academic_discussion",
    quality_label: "good"
  }
] as const;
export const WRITING_REVIEW_DEEPSEEK_STABILITY_EXISTING_CASE = {
  case_label: "ad_weak",
  attempt_id: "a7ad7e9f-b4ef-4ee0-9b39-43f1d7020cdc",
  task_type: "academic_discussion",
  quality_label: "weak"
} as const;
export const WRITING_REVIEW_DEEPSEEK_STABILITY_ALL_CASES = [
  ...WRITING_REVIEW_DEEPSEEK_STABILITY_NEW_CASES,
  WRITING_REVIEW_DEEPSEEK_STABILITY_EXISTING_CASE
] as const;
export const WRITING_REVIEW_DEEPSEEK_STABILITY_MODEL =
  "deepseek/deepseek-v4-pro" as const;
export const WRITING_REVIEW_DEEPSEEK_STABILITY_PROVIDER = "openrouter" as const;
export const WRITING_REVIEW_DEEPSEEK_STABILITY_EFFORT = "high" as const;
export const WRITING_REVIEW_DEEPSEEK_STABILITY_OPERATION =
  "deepseek_stability_benchmark" as const;
export const WRITING_REVIEW_DEEPSEEK_STABILITY_TIMEOUT_MS =
  WRITING_REVIEW_FULL_REQUEST_TIMEOUT_MS;
export const WRITING_REVIEW_DEEPSEEK_STABILITY_OUTPUT_DIR =
  "tmp/writing-review-deepseek-stability";
export const WRITING_REVIEW_DEEPSEEK_STABILITY_KIMI_DIR =
  "tmp/writing-review-reasoning-stability";
export const WRITING_REVIEW_DEEPSEEK_STABILITY_EXISTING_PRO_PATH =
  "tmp/writing-review-deepseek-comparison/deepseek-pro-high.json";

type NewCase = (typeof WRITING_REVIEW_DEEPSEEK_STABILITY_NEW_CASES)[number];
type AllCase = (typeof WRITING_REVIEW_DEEPSEEK_STABILITY_ALL_CASES)[number];
export type WritingReviewDeepSeekStabilityCaseLabel = AllCase["case_label"];
type QualityLabel = AllCase["quality_label"];
type ScoreMap = Record<string, number>;
type CategoryCounts = Record<string, number>;
type ValidationIssue = { path: string; message: string };
type EditPair = Pick<
  AIReviewRawResultV22["language_edits"][number],
  "original_text" | "replacement_text"
>;
type BenchmarkResultKind =
  | "success"
  | "timeout"
  | "provider_error"
  | "invalid_json"
  | "validation_error"
  | "localization_error";

export type WritingReviewDeepSeekStabilityInput = OpenRouterWritingReviewInput & {
  attemptId: string;
  caseLabel: NewCase["case_label"];
  qualityLabel: QualityLabel;
};

export type WritingReviewDeepSeekStabilityResult = OpenRouterTokenUsage & {
  case_label: WritingReviewDeepSeekStabilityCaseLabel;
  attempt_id: string;
  task_type: WritingTaskType;
  quality_label: QualityLabel;
  source: "new" | "existing";
  provider: typeof WRITING_REVIEW_DEEPSEEK_STABILITY_PROVIDER;
  model: typeof WRITING_REVIEW_DEEPSEEK_STABILITY_MODEL;
  reasoning_effort: typeof WRITING_REVIEW_DEEPSEEK_STABILITY_EFFORT;
  operation: typeof WRITING_REVIEW_DEEPSEEK_STABILITY_OPERATION;
  elapsed_ms: number;
  result: BenchmarkResultKind;
  error_code: string | null;
  error: string | null;
  http_status: number | null;
  provider_error_type: string | null;
  provider_error_code: string | number | null;
  provider_name: string | null;
  schema_valid: boolean;
  official_score: number | null;
  dimension_scores: ScoreMap | null;
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

export type WritingReviewDeepSeekStabilityBaseline = OpenRouterTokenUsage & {
  case_label: WritingReviewDeepSeekStabilityCaseLabel;
  attempt_id: string;
  task_type: WritingTaskType;
  provider: string;
  model: string;
  reasoning_effort: "high";
  elapsed_ms: number | null;
  result: string;
  schema_valid: boolean;
  official_score: number | null;
  dimension_scores: ScoreMap | null;
  language_edit_count: number | null;
  content_feedback_count: number | null;
  content_feedback_categories: CategoryCounts;
  overall_feedback: string | null;
  validated_result: AIReviewResultV22 | null;
};

export type WritingReviewDeepSeekStabilityComparison = {
  case_label: WritingReviewDeepSeekStabilityCaseLabel;
  attempt_id: string;
  task_type: WritingTaskType;
  baseline_available: boolean;
  kimi_result: string | null;
  deepseek_result: BenchmarkResultKind;
  official_score_delta: number | null;
  dimension_score_deltas: Record<string, number | null>;
  language_edit_count_delta: number | null;
  content_feedback_count_delta: number | null;
  shared_edits: EditPair[];
  kimi_only_edits: EditPair[];
  deepseek_only_edits: EditPair[];
  kimi_feedback_categories: CategoryCounts;
  deepseek_feedback_categories: CategoryCounts;
  feedback_category_deltas: Record<string, number>;
};

export type WritingReviewDeepSeekStabilityStatistics = {
  total_cases: 4;
  success_rate: number;
  result_counts: Record<BenchmarkResultKind, number>;
  schema_success_count: number;
  localization_success_count: number;
};

export type WritingReviewDeepSeekStabilityAggregate = {
  successful_cases: number;
  avg_elapsed_ms: number | null;
  median_elapsed_ms: number | null;
  avg_reasoning_tokens: number | null;
  avg_total_tokens: number | null;
  avg_cost: number | null;
};

export type WritingReviewDeepSeekStabilitySummary = {
  provider: typeof WRITING_REVIEW_DEEPSEEK_STABILITY_PROVIDER;
  model: typeof WRITING_REVIEW_DEEPSEEK_STABILITY_MODEL;
  reasoning_effort: typeof WRITING_REVIEW_DEEPSEEK_STABILITY_EFFORT;
  operation: typeof WRITING_REVIEW_DEEPSEEK_STABILITY_OPERATION;
  cases: typeof WRITING_REVIEW_DEEPSEEK_STABILITY_ALL_CASES;
  results: Array<
    Omit<
      WritingReviewDeepSeekStabilityResult,
      "validated_result" | "validated_raw_result" | "localization_issues"
    >
  >;
  baselines: Array<
    Omit<WritingReviewDeepSeekStabilityBaseline, "validated_result"> | null
  >;
  comparisons: WritingReviewDeepSeekStabilityComparison[];
  statistics: WritingReviewDeepSeekStabilityStatistics;
  aggregate: WritingReviewDeepSeekStabilityAggregate;
};

export type WritingReviewDeepSeekStabilityDependencies = {
  now?: () => number;
  timeoutMs?: number;
  onRequestStart?(input: WritingReviewDeepSeekStabilityInput): void;
  onRequestComplete?(result: WritingReviewDeepSeekStabilityResult): void;
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

export async function benchmarkWritingReviewDeepSeekStability(
  inputs: WritingReviewDeepSeekStabilityInput[],
  dependencies: WritingReviewDeepSeekStabilityDependencies
) {
  assertFixedInputs(inputs);
  const now = dependencies.now ?? (() => Date.now());
  const timeoutMs =
    dependencies.timeoutMs ?? WRITING_REVIEW_DEEPSEEK_STABILITY_TIMEOUT_MS;
  const withTimeout = dependencies.requestWithTimeout ?? requestOpenRouterWithTimeout;
  const results: WritingReviewDeepSeekStabilityResult[] = [];

  for (const input of inputs) {
    dependencies.onRequestStart?.(input);
    const startedAt = now();
    let usage: OpenRouterTokenUsage = { ...EMPTY_OPENROUTER_USAGE };
    let result: WritingReviewDeepSeekStabilityResult;
    try {
      const response = await withTimeout(
        (signal) => dependencies.requestAI(input, signal),
        {
          timeoutMs,
          timeoutMessage: `${input.caseLabel} timed out.`
        }
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
  input: WritingReviewDeepSeekStabilityInput,
  elapsedMs: number,
  usage: OpenRouterTokenUsage
) {
  return {
    case_label: input.caseLabel,
    attempt_id: input.attemptId,
    task_type: input.taskType,
    quality_label: input.qualityLabel,
    source: "new" as const,
    provider: WRITING_REVIEW_DEEPSEEK_STABILITY_PROVIDER,
    model: WRITING_REVIEW_DEEPSEEK_STABILITY_MODEL,
    reasoning_effort: WRITING_REVIEW_DEEPSEEK_STABILITY_EFFORT,
    operation: WRITING_REVIEW_DEEPSEEK_STABILITY_OPERATION,
    elapsed_ms: Math.max(0, elapsedMs),
    ...usage
  };
}

function successResult(
  input: WritingReviewDeepSeekStabilityInput,
  elapsedMs: number,
  usage: OpenRouterTokenUsage,
  validated: AIReviewResultV22
): WritingReviewDeepSeekStabilityResult {
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
    language_edit_count: validated.language_edits.length,
    content_feedback_count: validated.content_feedback.length,
    content_feedback_categories: countFeedbackCategories(validated),
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
  input: WritingReviewDeepSeekStabilityInput,
  elapsedMs: number,
  usage: OpenRouterTokenUsage,
  raw: AIReviewRawResultV22,
  error: unknown
): WritingReviewDeepSeekStabilityResult {
  const issues = safeValidationIssues(error);
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
    language_edit_count: null,
    content_feedback_count: null,
    content_feedback_categories: {},
    overall_feedback: null,
    raw_official_score: raw.scores.official_score.ai_score,
    raw_dimension_scores: scoreDimensions(raw),
    raw_language_edit_count: raw.language_edits.length,
    raw_content_feedback_count: raw.content_feedback.length,
    raw_content_feedback_categories: countFeedbackCategories(raw),
    localization_issue_count: issues.length,
    localization_issues: issues,
    validated_result: null,
    validated_raw_result: raw
  };
}

function failureResult(
  input: WritingReviewDeepSeekStabilityInput,
  elapsedMs: number,
  usage: OpenRouterTokenUsage,
  failure: {
    result: Exclude<BenchmarkResultKind, "success" | "localization_error">;
    errorCode: string;
    error: unknown;
  }
): WritingReviewDeepSeekStabilityResult {
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

export function readWritingReviewDeepSeekExistingAdWeak(
  filePath: string,
  readFile: typeof readFileSync = readFileSync
): WritingReviewDeepSeekStabilityResult | null {
  try {
    const value = JSON.parse(readFile(filePath, "utf8")) as unknown;
    if (!isRecord(value)) return null;
    if (
      value.attempt_id !== WRITING_REVIEW_DEEPSEEK_STABILITY_EXISTING_CASE.attempt_id ||
      value.model !== WRITING_REVIEW_DEEPSEEK_STABILITY_MODEL ||
      value.reasoning_effort !== WRITING_REVIEW_DEEPSEEK_STABILITY_EFFORT
    ) {
      return null;
    }
    return normalizeStoredDeepSeekResult(
      value,
      WRITING_REVIEW_DEEPSEEK_STABILITY_EXISTING_CASE
    );
  } catch {
    return null;
  }
}

export function readWritingReviewDeepSeekKimiBaseline(
  benchmarkCase: AllCase,
  filePath: string,
  readFile: typeof readFileSync = readFileSync
): WritingReviewDeepSeekStabilityBaseline | null {
  try {
    const value = JSON.parse(readFile(filePath, "utf8")) as unknown;
    if (!isRecord(value)) return null;
    if (
      value.case_label !== benchmarkCase.case_label ||
      value.attempt_id !== benchmarkCase.attempt_id ||
      value.task_type !== benchmarkCase.task_type ||
      value.reasoning_effort !== "high"
    ) {
      return null;
    }
    return {
      case_label: benchmarkCase.case_label,
      attempt_id: benchmarkCase.attempt_id,
      task_type: benchmarkCase.task_type,
      provider: readString(value.provider) ?? "openrouter",
      model: readString(value.model) ?? "moonshotai/kimi-k3",
      reasoning_effort: "high",
      elapsed_ms: readNumber(value.elapsed_ms),
      ...readUsage(value),
      result: readString(value.result) ?? "unknown",
      schema_valid: value.schema_valid === true,
      official_score: readNumber(value.official_score),
      dimension_scores: readNumberRecord(value.dimension_scores),
      language_edit_count: readNumber(value.language_edit_count),
      content_feedback_count: readNumber(value.content_feedback_count),
      content_feedback_categories:
        readNumberRecord(value.content_feedback_categories) ?? {},
      overall_feedback: readString(value.overall_feedback),
      validated_result: isFinalReview(value.validated_result)
        ? (value.validated_result as AIReviewResultV22)
        : null
    };
  } catch {
    return null;
  }
}

function normalizeStoredDeepSeekResult(
  value: Record<string, unknown>,
  benchmarkCase: typeof WRITING_REVIEW_DEEPSEEK_STABILITY_EXISTING_CASE
): WritingReviewDeepSeekStabilityResult | null {
  const result = readResultKind(value.result);
  if (!result) return null;
  const final = isFinalReview(value.validated_result)
    ? (value.validated_result as AIReviewResultV22)
    : null;
  const raw = isRawReview(value.validated_raw_result)
    ? (value.validated_raw_result as AIReviewRawResultV22)
    : null;
  const issues = readIssues(value.localization_issues);
  return {
    case_label: benchmarkCase.case_label,
    attempt_id: benchmarkCase.attempt_id,
    task_type: benchmarkCase.task_type,
    quality_label: benchmarkCase.quality_label,
    source: "existing",
    provider: WRITING_REVIEW_DEEPSEEK_STABILITY_PROVIDER,
    model: WRITING_REVIEW_DEEPSEEK_STABILITY_MODEL,
    reasoning_effort: WRITING_REVIEW_DEEPSEEK_STABILITY_EFFORT,
    operation: WRITING_REVIEW_DEEPSEEK_STABILITY_OPERATION,
    elapsed_ms: readNumber(value.elapsed_ms) ?? 0,
    ...readUsage(value),
    result,
    error_code: readString(value.error_code),
    error: readString(value.error),
    http_status: readNumber(value.http_status),
    provider_error_type: readString(value.provider_error_type),
    provider_error_code: readStringOrNumber(value.provider_error_code),
    provider_name: readString(value.provider_name),
    schema_valid: value.schema_valid === true,
    official_score: readNumber(value.official_score),
    dimension_scores: readNumberRecord(value.dimension_scores),
    language_edit_count: readNumber(value.language_edit_count),
    content_feedback_count: readNumber(value.content_feedback_count),
    content_feedback_categories:
      readNumberRecord(value.content_feedback_categories) ?? {},
    overall_feedback: readString(value.overall_feedback),
    raw_official_score: readNumber(value.raw_official_score),
    raw_dimension_scores: readNumberRecord(value.raw_dimension_scores),
    raw_language_edit_count: readNumber(value.raw_language_edit_count),
    raw_content_feedback_count: readNumber(value.raw_content_feedback_count),
    raw_content_feedback_categories:
      readNumberRecord(value.raw_content_feedback_categories) ?? {},
    localization_issue_count: readNumber(value.localization_issue_count) ?? issues.length,
    localization_issues: issues,
    validated_result: final,
    validated_raw_result: raw
  };
}

export function buildWritingReviewDeepSeekStabilitySummary(
  results: WritingReviewDeepSeekStabilityResult[],
  baselines: Array<WritingReviewDeepSeekStabilityBaseline | null>
): WritingReviewDeepSeekStabilitySummary {
  assertAllResults(results);
  assertBaselines(baselines);
  return {
    provider: WRITING_REVIEW_DEEPSEEK_STABILITY_PROVIDER,
    model: WRITING_REVIEW_DEEPSEEK_STABILITY_MODEL,
    reasoning_effort: WRITING_REVIEW_DEEPSEEK_STABILITY_EFFORT,
    operation: WRITING_REVIEW_DEEPSEEK_STABILITY_OPERATION,
    cases: WRITING_REVIEW_DEEPSEEK_STABILITY_ALL_CASES,
    results: results.map(
      ({
        validated_result: _validatedResult,
        validated_raw_result: _validatedRawResult,
        localization_issues: _localizationIssues,
        ...result
      }) => result
    ),
    baselines: baselines.map((baseline) =>
      baseline
        ? (({ validated_result: _validatedResult, ...summary }) => summary)(baseline)
        : null
    ),
    comparisons: results.map((result, index) =>
      compareCase(result, baselines[index])
    ),
    statistics: buildStatistics(results),
    aggregate: buildAggregate(results)
  };
}

export function writeWritingReviewDeepSeekStabilityFiles(
  outputDir: string,
  results: WritingReviewDeepSeekStabilityResult[],
  baselines: Array<WritingReviewDeepSeekStabilityBaseline | null>,
  fileSystem: {
    mkdirSync: typeof mkdirSync;
    writeFileSync: typeof writeFileSync;
  } = { mkdirSync, writeFileSync }
) {
  assertAllResults(results);
  fileSystem.mkdirSync(outputDir, { recursive: true });
  for (const result of results) {
    fileSystem.writeFileSync(
      join(outputDir, `${result.case_label.replace("_", "-")}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }
  const summary = buildWritingReviewDeepSeekStabilitySummary(results, baselines);
  fileSystem.writeFileSync(
    join(outputDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  fileSystem.writeFileSync(
    join(outputDir, "comparison.md"),
    buildWritingReviewDeepSeekStabilityMarkdown(results, baselines),
    { encoding: "utf8", mode: 0o600 }
  );
  return summary;
}

export function buildWritingReviewDeepSeekStabilityMarkdown(
  results: WritingReviewDeepSeekStabilityResult[],
  baselines: Array<WritingReviewDeepSeekStabilityBaseline | null>
) {
  const summary = buildWritingReviewDeepSeekStabilitySummary(results, baselines);
  const lines = [
    "# DeepSeek V4 Pro High Stability Benchmark",
    "",
    "| Case | Model | Result | Time | Reasoning | Total | Cost | Score | Edits | Feedback |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  ];
  results.forEach((result, index) => {
    const baseline = baselines[index];
    lines.push(
      baseline
        ? topRow(result.case_label, "Kimi high", baseline)
        : `| ${result.case_label} | Kimi high | unavailable | — | — | — | — | — | — | — |`,
      topRow(
        result.case_label,
        result.source === "existing" ? "DeepSeek Pro high (existing)" : "DeepSeek Pro high",
        result
      )
    );
  });

  results.forEach((result, index) => {
    const baseline = baselines[index];
    const comparison = summary.comparisons[index];
    const review = comparableReview(result);
    const scores = comparableScores(result);
    lines.push(
      "",
      `## ${result.case_label}`,
      "",
      `Source: ${result.source}${result.source === "existing" ? " (no API request)" : ""}.`,
      "",
      "### Scores",
      "",
      "| Dimension | Kimi high | DeepSeek Pro high | Delta (Pro - Kimi) |",
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
      ...formatFullEdits(review),
      "",
      `- Language edit count delta (Pro - Kimi): ${display(comparison.language_edit_count_delta)}`,
      `- Exact shared (${comparison.shared_edits.length}): ${formatEditPairs(comparison.shared_edits)}`,
      `- Kimi only (${comparison.kimi_only_edits.length}): ${formatEditPairs(comparison.kimi_only_edits)}`,
      `- DeepSeek only (${comparison.deepseek_only_edits.length}): ${formatEditPairs(comparison.deepseek_only_edits)}`,
      "",
      "> Different spans may represent the same error. Exact matching is an aid and cannot determine quality automatically.",
      "",
      "### Content Feedback",
      "",
      ...formatFeedback(review),
      "",
      `- Content feedback count delta (Pro - Kimi): ${display(comparison.content_feedback_count_delta)}`,
      `- Kimi categories: ${formatRecord(baseline?.content_feedback_categories ?? {})}`,
      `- DeepSeek categories: ${formatRecord(comparableCategories(result))}`,
      `- Category deltas (Pro - Kimi): ${formatRecord(comparison.feedback_category_deltas)}`,
      "",
      "### Overall Feedback",
      "",
      comparableOverallFeedback(result) ?? "—",
      "",
      "### Localization Issues",
      "",
      ...formatIssues(result.localization_issues),
      "",
      "### Performance",
      "",
      "| Model | Result | Time | Reasoning | Total | Cost |",
      "| --- | --- | ---: | ---: | ---: | ---: |",
      baseline
        ? performanceRow("Kimi high", baseline)
        : "| Kimi high | unavailable | — | — | — | — |",
      performanceRow("DeepSeek Pro high", result),
      "",
      `### Manual QA — ${result.case_label}`,
      "",
      ...manualQa(result.case_label)
    );
  });

  lines.push(
    "",
    "## DeepSeek Stability Statistics",
    "",
    `- total_cases: ${summary.statistics.total_cases}`,
    `- success_rate: ${summary.statistics.success_rate}`,
    ...Object.entries(summary.statistics.result_counts).map(
      ([key, value]) => `- ${key}: ${value}`
    ),
    `- schema_success_count: ${summary.statistics.schema_success_count}`,
    `- localization_success_count: ${summary.statistics.localization_success_count}`,
    "",
    "## Successful-Result Performance",
    "",
    `- successful_cases: ${summary.aggregate.successful_cases}`,
    `- avg_elapsed_ms: ${display(summary.aggregate.avg_elapsed_ms)}`,
    `- median_elapsed_ms: ${display(summary.aggregate.median_elapsed_ms)}`,
    `- avg_reasoning_tokens: ${display(summary.aggregate.avg_reasoning_tokens)}`,
    `- avg_total_tokens: ${display(summary.aggregate.avg_total_tokens)}`,
    `- avg_cost: ${display(summary.aggregate.avg_cost)}`,
    ""
  );
  return `${lines.join("\n")}\n`;
}

function compareCase(
  result: WritingReviewDeepSeekStabilityResult,
  baseline: WritingReviewDeepSeekStabilityBaseline | null
): WritingReviewDeepSeekStabilityComparison {
  const scores = comparableScores(result);
  const deepseekEdits = editMap(comparableReview(result));
  const kimiEdits = editMap(baseline?.validated_result ?? null);
  const dimensions = new Set([
    ...Object.keys(baseline?.dimension_scores ?? {}),
    ...Object.keys(scores.dimensions ?? {})
  ]);
  const categories = new Set([
    ...Object.keys(baseline?.content_feedback_categories ?? {}),
    ...Object.keys(comparableCategories(result))
  ]);
  return {
    case_label: result.case_label,
    attempt_id: result.attempt_id,
    task_type: result.task_type,
    baseline_available: baseline !== null,
    kimi_result: baseline?.result ?? null,
    deepseek_result: result.result,
    official_score_delta: difference(scores.official, baseline?.official_score ?? null),
    dimension_score_deltas: Object.fromEntries(
      Array.from(dimensions).map((key) => [
        key,
        difference(
          scores.dimensions?.[key] ?? null,
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
    shared_edits: mapIntersection(deepseekEdits, kimiEdits),
    kimi_only_edits: mapDifference(kimiEdits, deepseekEdits),
    deepseek_only_edits: mapDifference(deepseekEdits, kimiEdits),
    kimi_feedback_categories: baseline?.content_feedback_categories ?? {},
    deepseek_feedback_categories: comparableCategories(result),
    feedback_category_deltas: Object.fromEntries(
      Array.from(categories).map((key) => [
        key,
        (comparableCategories(result)[key] ?? 0) -
          (baseline?.content_feedback_categories[key] ?? 0)
      ])
    )
  };
}

function buildStatistics(
  results: WritingReviewDeepSeekStabilityResult[]
): WritingReviewDeepSeekStabilityStatistics {
  const kinds: BenchmarkResultKind[] = [
    "success",
    "timeout",
    "provider_error",
    "invalid_json",
    "validation_error",
    "localization_error"
  ];
  return {
    total_cases: 4,
    success_rate:
      results.filter((result) => result.result === "success").length / 4,
    result_counts: Object.fromEntries(
      kinds.map((kind) => [
        kind,
        results.filter((result) => result.result === kind).length
      ])
    ) as Record<BenchmarkResultKind, number>,
    schema_success_count: results.filter((result) => result.schema_valid).length,
    localization_success_count: results.filter(
      (result) => result.result === "success"
    ).length
  };
}

function buildAggregate(
  results: WritingReviewDeepSeekStabilityResult[]
): WritingReviewDeepSeekStabilityAggregate {
  const successful = results.filter((result) => result.result === "success");
  return {
    successful_cases: successful.length,
    avg_elapsed_ms: average(numericValues(successful, "elapsed_ms")),
    median_elapsed_ms: median(numericValues(successful, "elapsed_ms")),
    avg_reasoning_tokens: average(numericValues(successful, "reasoning_tokens")),
    avg_total_tokens: average(numericValues(successful, "total_tokens")),
    avg_cost: average(numericValues(successful, "cost"))
  };
}

function comparableReview(result: WritingReviewDeepSeekStabilityResult) {
  return result.validated_result ?? result.validated_raw_result;
}

function comparableScores(result: WritingReviewDeepSeekStabilityResult) {
  return {
    official: result.official_score ?? result.raw_official_score,
    dimensions: result.dimension_scores ?? result.raw_dimension_scores
  };
}

function comparableEditCount(result: WritingReviewDeepSeekStabilityResult) {
  return result.language_edit_count ?? result.raw_language_edit_count;
}

function comparableFeedbackCount(result: WritingReviewDeepSeekStabilityResult) {
  return result.content_feedback_count ?? result.raw_content_feedback_count;
}

function comparableCategories(result: WritingReviewDeepSeekStabilityResult) {
  return result.result === "localization_error"
    ? result.raw_content_feedback_categories
    : result.content_feedback_categories;
}

function comparableOverallFeedback(result: WritingReviewDeepSeekStabilityResult) {
  return result.overall_feedback ?? result.validated_raw_result?.overall_feedback ?? null;
}

function scoreDimensions(review: AIReviewRawResultV22 | AIReviewResultV22) {
  return Object.fromEntries(
    Object.entries(review.scores.dimension_scores).map(([key, score]) => [
      key,
      score.ai_score
    ])
  );
}

function countFeedbackCategories(
  review: AIReviewRawResultV22 | AIReviewResultV22
) {
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

function mapIntersection(first: Map<string, EditPair>, second: Map<string, EditPair>) {
  return Array.from(first.entries())
    .filter(([key]) => second.has(key))
    .map(([, value]) => value);
}

function mapDifference(first: Map<string, EditPair>, second: Map<string, EditPair>) {
  return Array.from(first.entries())
    .filter(([key]) => !second.has(key))
    .map(([, value]) => value);
}

function numericValues(
  results: WritingReviewDeepSeekStabilityResult[],
  key: "elapsed_ms" | "reasoning_tokens" | "total_tokens" | "cost"
) {
  return results
    .map((result) => result[key])
    .filter((value): value is number => typeof value === "number");
}

function average(values: number[]) {
  return values.length === 0
    ? null
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function assertFixedInputs(inputs: WritingReviewDeepSeekStabilityInput[]) {
  if (inputs.length !== WRITING_REVIEW_DEEPSEEK_STABILITY_NEW_CASES.length) {
    throw new Error("DeepSeek stability benchmark requires exactly three new cases.");
  }
  WRITING_REVIEW_DEEPSEEK_STABILITY_NEW_CASES.forEach((expected, index) => {
    const input = inputs[index];
    if (
      input.attemptId !== expected.attempt_id ||
      input.caseLabel !== expected.case_label ||
      input.qualityLabel !== expected.quality_label ||
      input.taskType !== expected.task_type
    ) {
      throw new Error(`Unexpected DeepSeek stability case at position ${index + 1}.`);
    }
  });
}

function assertAllResults(results: WritingReviewDeepSeekStabilityResult[]) {
  if (results.length !== WRITING_REVIEW_DEEPSEEK_STABILITY_ALL_CASES.length) {
    throw new Error("DeepSeek stability summary requires exactly four cases.");
  }
  WRITING_REVIEW_DEEPSEEK_STABILITY_ALL_CASES.forEach((expected, index) => {
    const result = results[index];
    if (
      result.case_label !== expected.case_label ||
      result.attempt_id !== expected.attempt_id ||
      result.task_type !== expected.task_type ||
      (index < 3 ? result.source !== "new" : result.source !== "existing")
    ) {
      throw new Error(`Unexpected DeepSeek result at position ${index + 1}.`);
    }
  });
}

function assertBaselines(
  baselines: Array<WritingReviewDeepSeekStabilityBaseline | null>
) {
  if (baselines.length !== WRITING_REVIEW_DEEPSEEK_STABILITY_ALL_CASES.length) {
    throw new Error("DeepSeek stability summary requires four baseline slots.");
  }
  baselines.forEach((baseline, index) => {
    if (
      baseline &&
      baseline.case_label !== WRITING_REVIEW_DEEPSEEK_STABILITY_ALL_CASES[index].case_label
    ) {
      throw new Error(`Unexpected Kimi baseline at position ${index + 1}.`);
    }
  });
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

function readResultKind(value: unknown): BenchmarkResultKind | null {
  return value === "success" ||
    value === "timeout" ||
    value === "provider_error" ||
    value === "invalid_json" ||
    value === "validation_error" ||
    value === "localization_error"
    ? value
    : null;
}

function isFinalReview(value: unknown) {
  return (
    isRecord(value) &&
    value.schema_version === "2.2" &&
    Array.isArray(value.language_edits) &&
    Array.isArray(value.content_feedback) &&
    isRecord(value.scores)
  );
}

function isRawReview(value: unknown) {
  return isFinalReview(value);
}

function safeValidationIssues(error: unknown): ValidationIssue[] {
  if (!isRecord(error) || !Array.isArray(error.issues)) return [];
  return readIssues(error.issues);
}

function readIssues(value: unknown): ValidationIssue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((issue) =>
    isRecord(issue) &&
    typeof issue.path === "string" &&
    typeof issue.message === "string"
      ? [{ path: issue.path, message: issue.message }]
      : []
  );
}

function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readString(value: unknown) {
  return typeof value === "string" ? value : null;
}

function readStringOrNumber(value: unknown) {
  return typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value))
    ? value
    : null;
}

function readNumberRecord(value: unknown) {
  if (!isRecord(value)) return null;
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, number] =>
        typeof entry[1] === "number" && Number.isFinite(entry[1])
    )
  );
}

function difference(left: number | null, right: number | null) {
  return left === null || right === null ? null : left - right;
}

function topRow(
  caseLabel: string,
  model: string,
  result: WritingReviewDeepSeekStabilityResult | WritingReviewDeepSeekStabilityBaseline
) {
  const score =
    "raw_official_score" in result
      ? result.official_score ?? result.raw_official_score
      : result.official_score;
  const edits =
    "raw_language_edit_count" in result
      ? result.language_edit_count ?? result.raw_language_edit_count
      : result.language_edit_count;
  const feedback =
    "raw_content_feedback_count" in result
      ? result.content_feedback_count ?? result.raw_content_feedback_count
      : result.content_feedback_count;
  return `| ${caseLabel} | ${model} | ${result.result} | ${display(result.elapsed_ms)} | ${display(result.reasoning_tokens)} | ${display(result.total_tokens)} | ${display(result.cost)} | ${display(score)} | ${display(edits)} | ${display(feedback)} |`;
}

function scoreRow(
  dimension: string,
  kimi: number | null,
  deepseek: number | null
) {
  return `| ${escapeTable(dimension)} | ${display(kimi)} | ${display(deepseek)} | ${display(difference(deepseek, kimi))} |`;
}

function performanceRow(
  label: string,
  result: WritingReviewDeepSeekStabilityResult | WritingReviewDeepSeekStabilityBaseline
) {
  return `| ${label} | ${result.result} | ${display(result.elapsed_ms)} | ${display(result.reasoning_tokens)} | ${display(result.total_tokens)} | ${display(result.cost)} |`;
}

function formatFullEdits(review: AIReviewRawResultV22 | AIReviewResultV22 | null) {
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

function manualQa(caseLabel: WritingReviewDeepSeekStabilityCaseLabel) {
  const checklists: Record<WritingReviewDeepSeekStabilityCaseLabel, string[]> = {
    email_good: [
      "official 5 是否合理",
      "是否出现过度扣分",
      "是否把轻微自然度问题当 grammar error",
      "Word Choice 是否正确分类",
      "是否为了必须给反馈而制造问题",
      "language edits 是否过度润色",
      "social conventions 是否合理",
      "是否存在不必要 content feedback"
    ],
    email_weak: [
      "required communicative actions 是否识别",
      "communicative purpose 与 elaboration 是否正确区分",
      "缺少 why/how/detail 是否进入 elaboration",
      "social conventions 是否合理",
      "grammar 是否漏检",
      "Word Choice 是否错误进入 language_edits",
      "proposed revisions 是否自然",
      "official score 是否合理"
    ],
    ad_good: [
      "relevance 是否合理",
      "elaboration 是否合理",
      "是否给高质量作文制造多余问题",
      "Word Choice 是否过度挑剔",
      "grammar edits 是否只抓真实错误",
      "official 5 是否合理",
      "dimension 是否合理",
      "是否过度润色"
    ],
    ad_weak: [
      "teenage years vs age 10",
      "necessary 的论证问题",
      "growth environments",
      "kindful people",
      "grammar coverage",
      "Word Choice 分类",
      "proposed revision",
      "localization"
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

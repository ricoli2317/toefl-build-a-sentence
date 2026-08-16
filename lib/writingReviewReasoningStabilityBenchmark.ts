import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMPTY_OPENROUTER_USAGE,
  OpenRouterWritingReviewError,
  requestOpenRouterWithTimeout,
  WRITING_REVIEW_FULL_REQUEST_TIMEOUT_MS,
  type OpenRouterTokenUsage,
  type OpenRouterWritingReviewInput,
  type OpenRouterWritingReviewResponse
} from "./openrouterWritingReview.ts";
import { WRITING_REVIEW_REASONING_BENCHMARK_MODEL } from "./writingReviewReasoningBenchmark.ts";
import type { AIReviewResultV22 } from "./writingReviewSchemaV22.ts";
import type { WritingTaskType } from "./writing.ts";

export const WRITING_REVIEW_REASONING_STABILITY_CASES = [
  {
    attempt_id: "a20ed773-23cc-4a10-83e0-4493c4f619de",
    case_label: "email_good",
    quality_label: "good",
    task_type: "email"
  },
  {
    attempt_id: "cde72af6-e6d0-439b-b3ac-91fb2ab117b1",
    case_label: "email_weak",
    quality_label: "weak",
    task_type: "email"
  },
  {
    attempt_id: "a292bcdb-6a86-4ab8-a00a-4c4e6c707c9c",
    case_label: "ad_good",
    quality_label: "good",
    task_type: "academic_discussion"
  },
  {
    attempt_id: "a7ad7e9f-b4ef-4ee0-9b39-43f1d7020cdc",
    case_label: "ad_weak",
    quality_label: "weak",
    task_type: "academic_discussion"
  }
] as const;

export const WRITING_REVIEW_REASONING_STABILITY_EFFORTS = ["max", "high"] as const;
export const WRITING_REVIEW_REASONING_STABILITY_PROVIDER = "openrouter" as const;
export const WRITING_REVIEW_REASONING_STABILITY_MODEL =
  WRITING_REVIEW_REASONING_BENCHMARK_MODEL;
export const WRITING_REVIEW_REASONING_STABILITY_OPERATION =
  "reasoning_stability_benchmark" as const;
export const WRITING_REVIEW_REASONING_STABILITY_TIMEOUT_MS =
  WRITING_REVIEW_FULL_REQUEST_TIMEOUT_MS;
export const WRITING_REVIEW_REASONING_STABILITY_OUTPUT_DIR =
  "tmp/writing-review-reasoning-stability";

export type WritingReviewReasoningStabilityEffort =
  (typeof WRITING_REVIEW_REASONING_STABILITY_EFFORTS)[number];
export type WritingReviewReasoningStabilityCaseLabel =
  (typeof WRITING_REVIEW_REASONING_STABILITY_CASES)[number]["case_label"];
export type WritingReviewReasoningStabilityQualityLabel = "good" | "weak";

type DimensionScores = Record<string, number>;
type FeedbackCategoryCounts = Record<string, number>;
type NormalizedEdit = Pick<
  AIReviewResultV22["language_edits"][number],
  "original_text" | "replacement_text"
>;

export type WritingReviewReasoningStabilityInput = OpenRouterWritingReviewInput & {
  attemptId: string;
  caseLabel: WritingReviewReasoningStabilityCaseLabel;
  qualityLabel: WritingReviewReasoningStabilityQualityLabel;
};

export type WritingReviewReasoningStabilityResult = OpenRouterTokenUsage & {
  attempt_id: string;
  case_label: WritingReviewReasoningStabilityCaseLabel;
  task_type: WritingTaskType;
  quality_label: WritingReviewReasoningStabilityQualityLabel;
  provider: typeof WRITING_REVIEW_REASONING_STABILITY_PROVIDER;
  model: string;
  reasoning_effort: WritingReviewReasoningStabilityEffort;
  operation: typeof WRITING_REVIEW_REASONING_STABILITY_OPERATION;
  elapsed_ms: number;
  result:
    | "success"
    | "timeout"
    | "provider_error"
    | "invalid_json"
    | "validation_error";
  error_code: string | null;
  error: string | null;
  schema_valid: boolean;
  official_score: number | null;
  dimension_scores: DimensionScores | null;
  language_edit_count: number | null;
  content_feedback_count: number | null;
  content_feedback_categories: FeedbackCategoryCounts;
  overall_feedback: string | null;
  validated_result: AIReviewResultV22 | null;
};

export type WritingReviewReasoningStabilityAggregate = {
  success_count: number;
  failure_count: number;
  avg_elapsed_ms: number | null;
  median_elapsed_ms: number | null;
  avg_reasoning_tokens: number | null;
  median_reasoning_tokens: number | null;
  avg_completion_tokens: number | null;
  avg_total_tokens: number | null;
  avg_cost: number | null;
};

export type WritingReviewReasoningStabilityComparison = {
  attempt_id: string;
  case_label: WritingReviewReasoningStabilityCaseLabel;
  task_type: WritingTaskType;
  quality_label: WritingReviewReasoningStabilityQualityLabel;
  official_score_delta: number | null;
  dimension_score_deltas: Record<string, number | null>;
  max_language_edit_count: number | null;
  high_language_edit_count: number | null;
  language_edit_count_delta: number | null;
  shared_edits: NormalizedEdit[];
  max_only_edits: NormalizedEdit[];
  high_only_edits: NormalizedEdit[];
  max_feedback_count: number | null;
  high_feedback_count: number | null;
  feedback_category_counts: {
    max: FeedbackCategoryCounts;
    high: FeedbackCategoryCounts;
    delta: FeedbackCategoryCounts;
  };
};

export type WritingReviewReasoningStabilitySummary = {
  provider: typeof WRITING_REVIEW_REASONING_STABILITY_PROVIDER;
  model: typeof WRITING_REVIEW_REASONING_STABILITY_MODEL;
  operation: typeof WRITING_REVIEW_REASONING_STABILITY_OPERATION;
  cases: typeof WRITING_REVIEW_REASONING_STABILITY_CASES;
  results: Array<Omit<WritingReviewReasoningStabilityResult, "validated_result">>;
  comparisons: WritingReviewReasoningStabilityComparison[];
  aggregate: Record<
    WritingReviewReasoningStabilityEffort,
    WritingReviewReasoningStabilityAggregate
  >;
};

export type WritingReviewReasoningStabilityDependencies = {
  now?: () => number;
  timeoutMs?: number;
  onRequestStart?(
    input: WritingReviewReasoningStabilityInput,
    effort: WritingReviewReasoningStabilityEffort
  ): void;
  onRequestComplete?(result: WritingReviewReasoningStabilityResult): void;
  requestWithTimeout?<T>(
    request: (signal: AbortSignal) => Promise<T>,
    options: { timeoutMs: number; timeoutMessage: string }
  ): Promise<T>;
  requestAI(
    input: OpenRouterWritingReviewInput,
    effort: WritingReviewReasoningStabilityEffort,
    signal: AbortSignal
  ): Promise<OpenRouterWritingReviewResponse>;
  parseReview(value: unknown, responseText: string): AIReviewResultV22;
};

export async function benchmarkWritingReviewReasoningStability(
  inputs: WritingReviewReasoningStabilityInput[],
  dependencies: WritingReviewReasoningStabilityDependencies
) {
  assertFixedInputs(inputs);
  const now = dependencies.now ?? (() => Date.now());
  const timeoutMs =
    dependencies.timeoutMs ?? WRITING_REVIEW_REASONING_STABILITY_TIMEOUT_MS;
  const withTimeout = dependencies.requestWithTimeout ?? requestOpenRouterWithTimeout;
  const results: WritingReviewReasoningStabilityResult[] = [];

  for (const input of inputs) {
    for (const effort of WRITING_REVIEW_REASONING_STABILITY_EFFORTS) {
      dependencies.onRequestStart?.(input, effort);
      const startedAt = now();
      let usage: OpenRouterTokenUsage = { ...EMPTY_OPENROUTER_USAGE };
      let result: WritingReviewReasoningStabilityResult;
      try {
        const response = await withTimeout(
          (signal) => dependencies.requestAI(input, effort, signal),
          {
            timeoutMs,
            timeoutMessage: `${input.caseLabel} ${effort} timed out.`
          }
        );
        usage = response.usage;
        let raw: unknown;
        try {
          raw = JSON.parse(response.content) as unknown;
        } catch (error) {
          result = failureResult(input, effort, response.model, now() - startedAt, usage, {
            result: "invalid_json",
            errorCode: "AI_RESPONSE_INVALID",
            error
          });
          results.push(result);
          dependencies.onRequestComplete?.(result);
          continue;
        }

        let validated: AIReviewResultV22;
        try {
          validated = dependencies.parseReview(raw, input.responseText);
          if (
            validated.schema_version !== "2.2" ||
            validated.task_type !== input.taskType
          ) {
            throw new Error(
              "AI response did not match the stability case task or v2.2 schema."
            );
          }
        } catch (error) {
          result = failureResult(input, effort, response.model, now() - startedAt, usage, {
            result: "validation_error",
            errorCode: "AI_RESPONSE_INVALID",
            error
          });
          results.push(result);
          dependencies.onRequestComplete?.(result);
          continue;
        }
        result = successResult(
          input,
          effort,
          response.model,
          now() - startedAt,
          usage,
          validated
        );
      } catch (error) {
        const timedOut =
          error instanceof OpenRouterWritingReviewError &&
          error.code === "AI_REQUEST_TIMEOUT";
        result = failureResult(
          input,
          effort,
          WRITING_REVIEW_REASONING_BENCHMARK_MODEL,
          now() - startedAt,
          usage,
          {
            result: timedOut ? "timeout" : "provider_error",
            errorCode: timedOut ? "AI_REQUEST_TIMEOUT" : errorCode(error),
            error
          }
        );
      }
      results.push(result);
      dependencies.onRequestComplete?.(result);
    }
  }

  return results;
}

function successResult(
  input: WritingReviewReasoningStabilityInput,
  effort: WritingReviewReasoningStabilityEffort,
  model: string,
  elapsedMs: number,
  usage: OpenRouterTokenUsage,
  validated: AIReviewResultV22
): WritingReviewReasoningStabilityResult {
  return {
    attempt_id: input.attemptId,
    case_label: input.caseLabel,
    task_type: input.taskType,
    quality_label: input.qualityLabel,
    provider: WRITING_REVIEW_REASONING_STABILITY_PROVIDER,
    model,
    reasoning_effort: effort,
    operation: WRITING_REVIEW_REASONING_STABILITY_OPERATION,
    elapsed_ms: Math.max(0, elapsedMs),
    ...usage,
    result: "success",
    error_code: null,
    error: null,
    schema_valid: true,
    official_score: validated.scores.official_score.ai_score,
    dimension_scores: Object.fromEntries(
      Object.entries(validated.scores.dimension_scores).map(([key, value]) => [
        key,
        value.ai_score
      ])
    ),
    language_edit_count: validated.language_edits.length,
    content_feedback_count: validated.content_feedback.length,
    content_feedback_categories: countFeedbackCategories(validated),
    overall_feedback: validated.overall_feedback,
    validated_result: validated
  };
}

function failureResult(
  input: WritingReviewReasoningStabilityInput,
  effort: WritingReviewReasoningStabilityEffort,
  model: string,
  elapsedMs: number,
  usage: OpenRouterTokenUsage,
  failure: {
    result: "timeout" | "provider_error" | "invalid_json" | "validation_error";
    errorCode: string;
    error: unknown;
  }
): WritingReviewReasoningStabilityResult {
  return {
    attempt_id: input.attemptId,
    case_label: input.caseLabel,
    task_type: input.taskType,
    quality_label: input.qualityLabel,
    provider: WRITING_REVIEW_REASONING_STABILITY_PROVIDER,
    model,
    reasoning_effort: effort,
    operation: WRITING_REVIEW_REASONING_STABILITY_OPERATION,
    elapsed_ms: Math.max(0, elapsedMs),
    ...usage,
    result: failure.result,
    error_code: failure.errorCode,
    error: safeErrorMessage(failure.error),
    schema_valid: false,
    official_score: null,
    dimension_scores: null,
    language_edit_count: null,
    content_feedback_count: null,
    content_feedback_categories: {},
    overall_feedback: null,
    validated_result: null
  };
}

export function buildWritingReviewReasoningStabilitySummary(
  results: WritingReviewReasoningStabilityResult[]
): WritingReviewReasoningStabilitySummary {
  return {
    provider: WRITING_REVIEW_REASONING_STABILITY_PROVIDER,
    model: WRITING_REVIEW_REASONING_STABILITY_MODEL,
    operation: WRITING_REVIEW_REASONING_STABILITY_OPERATION,
    cases: WRITING_REVIEW_REASONING_STABILITY_CASES,
    results: results.map(({ validated_result: _validatedResult, ...result }) => result),
    comparisons: WRITING_REVIEW_REASONING_STABILITY_CASES.map((benchmarkCase) =>
      compareCase(results, benchmarkCase.case_label)
    ),
    aggregate: {
      max: aggregateEffort(results, "max"),
      high: aggregateEffort(results, "high")
    }
  };
}

export function buildWritingReviewReasoningStabilityMarkdown(
  results: WritingReviewReasoningStabilityResult[]
) {
  const summary = buildWritingReviewReasoningStabilitySummary(results);
  const sections = ["# Writing Review Reasoning Stability", ""];
  for (const comparison of summary.comparisons) {
    const max = findResult(results, comparison.case_label, "max");
    const high = findResult(results, comparison.case_label, "high");
    sections.push(
      `## ${comparison.case_label}`,
      "",
      "### Scores",
      "",
      "| Dimension | max | high | high - max |",
      "| --- | ---: | ---: | ---: |",
      `| official | ${display(max.official_score)} | ${display(high.official_score)} | ${display(comparison.official_score_delta)} |`
    );
    for (const [dimension, delta] of Object.entries(
      comparison.dimension_score_deltas
    )) {
      sections.push(
        `| ${escapeTable(dimension)} | ${display(max.dimension_scores?.[dimension] ?? null)} | ${display(high.dimension_scores?.[dimension] ?? null)} | ${display(delta)} |`
      );
    }
    sections.push(
      "",
      "### Language edits",
      "",
      `- Shared (${comparison.shared_edits.length}): ${formatEditList(comparison.shared_edits)}`,
      `- max only (${comparison.max_only_edits.length}): ${formatEditList(comparison.max_only_edits)}`,
      `- high only (${comparison.high_only_edits.length}): ${formatEditList(comparison.high_only_edits)}`,
      "",
      "### Content feedback",
      "",
      "| Category | max | high | delta |",
      "| --- | ---: | ---: | ---: |"
    );
    for (const category of Object.keys(
      comparison.feedback_category_counts.delta
    )) {
      sections.push(
        `| ${escapeTable(category)} | ${comparison.feedback_category_counts.max[category] ?? 0} | ${comparison.feedback_category_counts.high[category] ?? 0} | ${comparison.feedback_category_counts.delta[category]} |`
      );
    }
    sections.push(
      "",
      "#### max feedback",
      "",
      ...formatFeedback(max.validated_result),
      "",
      "#### high feedback",
      "",
      ...formatFeedback(high.validated_result),
      "",
      "### Performance",
      "",
      "| Effort | Result | Time (ms) | Reasoning tokens | Total tokens | Cost |",
      "| --- | --- | ---: | ---: | ---: | ---: |",
      performanceRow(max),
      performanceRow(high),
      ""
    );
  }
  return `${sections.join("\n")}\n`;
}

export function writeWritingReviewReasoningStabilityFiles(
  outputDir: string,
  results: WritingReviewReasoningStabilityResult[],
  fileSystem: {
    mkdirSync: typeof mkdirSync;
    writeFileSync: typeof writeFileSync;
  } = { mkdirSync, writeFileSync }
) {
  fileSystem.mkdirSync(outputDir, { recursive: true });
  for (const result of results) {
    fileSystem.writeFileSync(
      join(outputDir, `${result.case_label}-${result.reasoning_effort}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }
  const summary = buildWritingReviewReasoningStabilitySummary(results);
  fileSystem.writeFileSync(
    join(outputDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  fileSystem.writeFileSync(
    join(outputDir, "comparison.md"),
    buildWritingReviewReasoningStabilityMarkdown(results),
    { encoding: "utf8", mode: 0o600 }
  );
  return summary;
}

function compareCase(
  results: WritingReviewReasoningStabilityResult[],
  caseLabel: WritingReviewReasoningStabilityCaseLabel
): WritingReviewReasoningStabilityComparison {
  const max = findResult(results, caseLabel, "max");
  const high = findResult(results, caseLabel, "high");
  const maxEdits = normalizedEditMap(max.validated_result);
  const highEdits = normalizedEditMap(high.validated_result);
  const sharedKeys = Array.from(maxEdits.keys()).filter((key) => highEdits.has(key));
  const maxOnlyKeys = Array.from(maxEdits.keys()).filter(
    (key) => !highEdits.has(key)
  );
  const highOnlyKeys = Array.from(highEdits.keys()).filter(
    (key) => !maxEdits.has(key)
  );
  const dimensionKeys = new Set([
    ...Object.keys(max.dimension_scores ?? {}),
    ...Object.keys(high.dimension_scores ?? {})
  ]);
  const categoryKeys = new Set([
    ...Object.keys(max.content_feedback_categories),
    ...Object.keys(high.content_feedback_categories)
  ]);
  return {
    attempt_id: max.attempt_id,
    case_label: caseLabel,
    task_type: max.task_type,
    quality_label: max.quality_label,
    official_score_delta: difference(high.official_score, max.official_score),
    dimension_score_deltas: Object.fromEntries(
      Array.from(dimensionKeys).map((key) => [
        key,
        difference(
          high.dimension_scores?.[key] ?? null,
          max.dimension_scores?.[key] ?? null
        )
      ])
    ),
    max_language_edit_count: max.language_edit_count,
    high_language_edit_count: high.language_edit_count,
    language_edit_count_delta: difference(
      high.language_edit_count,
      max.language_edit_count
    ),
    shared_edits: sharedKeys.map((key) => maxEdits.get(key)!),
    max_only_edits: maxOnlyKeys.map((key) => maxEdits.get(key)!),
    high_only_edits: highOnlyKeys.map((key) => highEdits.get(key)!),
    max_feedback_count: max.content_feedback_count,
    high_feedback_count: high.content_feedback_count,
    feedback_category_counts: {
      max: max.content_feedback_categories,
      high: high.content_feedback_categories,
      delta: Object.fromEntries(
        Array.from(categoryKeys).map((key) => [
          key,
          (high.content_feedback_categories[key] ?? 0) -
            (max.content_feedback_categories[key] ?? 0)
        ])
      )
    }
  };
}

function aggregateEffort(
  results: WritingReviewReasoningStabilityResult[],
  effort: WritingReviewReasoningStabilityEffort
): WritingReviewReasoningStabilityAggregate {
  const matching = results.filter((result) => result.reasoning_effort === effort);
  const successful = matching.filter((result) => result.result === "success");
  return {
    success_count: successful.length,
    failure_count: matching.length - successful.length,
    avg_elapsed_ms: average(numericValues(successful, "elapsed_ms")),
    median_elapsed_ms: median(numericValues(successful, "elapsed_ms")),
    avg_reasoning_tokens: average(numericValues(successful, "reasoning_tokens")),
    median_reasoning_tokens: median(
      numericValues(successful, "reasoning_tokens")
    ),
    avg_completion_tokens: average(
      numericValues(successful, "completion_tokens")
    ),
    avg_total_tokens: average(numericValues(successful, "total_tokens")),
    avg_cost: average(numericValues(successful, "cost"))
  };
}

function numericValues(
  results: WritingReviewReasoningStabilityResult[],
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

function findResult(
  results: WritingReviewReasoningStabilityResult[],
  caseLabel: WritingReviewReasoningStabilityCaseLabel,
  effort: WritingReviewReasoningStabilityEffort
) {
  const result = results.find(
    (item) => item.case_label === caseLabel && item.reasoning_effort === effort
  );
  if (!result) throw new Error(`Missing stability result: ${caseLabel}/${effort}`);
  return result;
}

function normalizedEditMap(result: AIReviewResultV22 | null) {
  return new Map(
    (result?.language_edits ?? []).map((edit) => {
      const normalized = {
        original_text: edit.original_text,
        replacement_text: edit.replacement_text
      };
      return [`${normalized.original_text}\u0000${normalized.replacement_text}`, normalized];
    })
  );
}

function countFeedbackCategories(result: AIReviewResultV22) {
  return result.content_feedback.reduce<FeedbackCategoryCounts>((counts, feedback) => {
    counts[feedback.category] = (counts[feedback.category] ?? 0) + 1;
    return counts;
  }, {});
}

function difference(high: number | null, max: number | null) {
  return high === null || max === null ? null : high - max;
}

function assertFixedInputs(inputs: WritingReviewReasoningStabilityInput[]) {
  if (inputs.length !== WRITING_REVIEW_REASONING_STABILITY_CASES.length) {
    throw new Error("Reasoning stability benchmark requires exactly four fixed cases.");
  }
  WRITING_REVIEW_REASONING_STABILITY_CASES.forEach((expected, index) => {
    const input = inputs[index];
    if (
      input.attemptId !== expected.attempt_id ||
      input.caseLabel !== expected.case_label ||
      input.qualityLabel !== expected.quality_label ||
      input.taskType !== expected.task_type
    ) {
      throw new Error(`Unexpected reasoning stability case at position ${index + 1}.`);
    }
  });
}

function formatEditList(edits: NormalizedEdit[]) {
  return edits.length === 0
    ? "—"
    : edits
        .map(
          (edit) =>
            `\`${escapeInline(edit.original_text)}\` → \`${escapeInline(edit.replacement_text)}\``
        )
        .join("; ");
}

function formatFeedback(result: AIReviewResultV22 | null) {
  if (!result || result.content_feedback.length === 0) return ["- —"];
  return result.content_feedback.map(
    (feedback) =>
      `- **${escapeInline(feedback.category)}** — \`${escapeInline(feedback.original_sentence)}\`: ${escapeInline(feedback.issue)}`
  );
}

function performanceRow(result: WritingReviewReasoningStabilityResult) {
  return `| ${result.reasoning_effort} | ${result.result} | ${result.elapsed_ms} | ${display(result.reasoning_tokens)} | ${display(result.total_tokens)} | ${display(result.cost)} |`;
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

function errorCode(error: unknown) {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : "OPENROUTER_REQUEST_FAILED";
}

function safeErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return "Unknown stability benchmark error.";
  const issues = "issues" in error ? (error as { issues?: unknown }).issues : undefined;
  return Array.isArray(issues)
    ? `${error.message} Issues: ${JSON.stringify(issues)}`
    : error.message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

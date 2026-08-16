import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  EMPTY_OPENROUTER_USAGE,
  OpenRouterWritingReviewError,
  requestOpenRouterWithTimeout,
  WRITING_REVIEW_FULL_REQUEST_TIMEOUT_MS,
  type OpenRouterReasoningEffort,
  type OpenRouterTokenUsage,
  type OpenRouterWritingReviewInput,
  type OpenRouterWritingReviewResponse
} from "./openrouterWritingReview.ts";
import type { AIReviewResultV22 } from "./writingReviewSchemaV22.ts";
import type { WritingTaskType } from "./writing.ts";

export const WRITING_REVIEW_REASONING_EFFORTS = ["max", "high", "low"] as const;
export const WRITING_REVIEW_REASONING_BENCHMARK_MODEL = "moonshotai/kimi-k3";
export const WRITING_REVIEW_REASONING_BENCHMARK_OPERATION =
  "reasoning_benchmark" as const;
export const WRITING_REVIEW_REASONING_BENCHMARK_TIMEOUT_MS =
  WRITING_REVIEW_FULL_REQUEST_TIMEOUT_MS;
export const DEFAULT_WRITING_REVIEW_REASONING_BENCHMARK_ATTEMPT_ID =
  "a7ad7e9f-b4ef-4ee0-9b39-43f1d7020cdc";
export const WRITING_REVIEW_REASONING_BENCHMARK_OUTPUT_DIR =
  "tmp/writing-review-reasoning-benchmark";

type DimensionScores = Record<string, number>;
type FeedbackCategoryCounts = Record<string, number>;

export type WritingReviewReasoningBenchmarkResult = OpenRouterTokenUsage & {
  reasoning_effort: OpenRouterReasoningEffort;
  operation: typeof WRITING_REVIEW_REASONING_BENCHMARK_OPERATION;
  attempt_id: string;
  task_type: WritingTaskType;
  model: string;
  elapsed_ms: number;
  result: "success" | "timeout" | "provider_error" | "invalid_json" | "validation_error";
  error_code: string | null;
  error: string | null;
  schema_valid: boolean;
  official_score: number | null;
  dimension_scores: DimensionScores | null;
  language_edit_count: number | null;
  content_feedback_count: number | null;
  content_feedback_categories: FeedbackCategoryCounts;
  validated_result: AIReviewResultV22 | null;
};

export type WritingReviewReasoningBenchmarkSummary = {
  attempt_id: string;
  task_type: WritingTaskType;
  model: string;
  operation: typeof WRITING_REVIEW_REASONING_BENCHMARK_OPERATION;
  results: Array<Omit<WritingReviewReasoningBenchmarkResult, "validated_result">>;
};

export type WritingReviewReasoningBenchmarkDependencies = {
  now?: () => number;
  timeoutMs?: number;
  onEffortStart?(effort: OpenRouterReasoningEffort): void;
  onEffortComplete?(result: WritingReviewReasoningBenchmarkResult): void;
  requestWithTimeout?<T>(
    request: (signal: AbortSignal) => Promise<T>,
    options: { timeoutMs: number; timeoutMessage: string }
  ): Promise<T>;
  requestAI(
    input: OpenRouterWritingReviewInput,
    effort: OpenRouterReasoningEffort,
    signal: AbortSignal
  ): Promise<OpenRouterWritingReviewResponse>;
  parseReview(value: unknown, responseText: string): AIReviewResultV22;
};

export async function benchmarkWritingReviewReasoning(
  input: OpenRouterWritingReviewInput & { attemptId: string },
  dependencies: WritingReviewReasoningBenchmarkDependencies
) {
  const now = dependencies.now ?? (() => Date.now());
  const timeoutMs =
    dependencies.timeoutMs ?? WRITING_REVIEW_REASONING_BENCHMARK_TIMEOUT_MS;
  const withTimeout = dependencies.requestWithTimeout ?? requestOpenRouterWithTimeout;
  const results: WritingReviewReasoningBenchmarkResult[] = [];

  for (const effort of WRITING_REVIEW_REASONING_EFFORTS) {
    dependencies.onEffortStart?.(effort);
    const startedAt = now();
    let usage: OpenRouterTokenUsage = { ...EMPTY_OPENROUTER_USAGE };
    let result: WritingReviewReasoningBenchmarkResult;

    try {
      const response = await withTimeout(
        (signal) => dependencies.requestAI(input, effort, signal),
        {
          timeoutMs,
          timeoutMessage: `Reasoning benchmark ${effort} timed out.`
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
        dependencies.onEffortComplete?.(result);
        continue;
      }

      let validated: AIReviewResultV22;
      try {
        validated = dependencies.parseReview(raw, input.responseText);
        if (
          validated.schema_version !== "2.2" ||
          validated.task_type !== input.taskType
        ) {
          throw new Error("AI response did not match the benchmark task or v2.2 schema.");
        }
      } catch (error) {
        result = failureResult(input, effort, response.model, now() - startedAt, usage, {
          result: "validation_error",
          errorCode: "AI_RESPONSE_INVALID",
          error
        });
        results.push(result);
        dependencies.onEffortComplete?.(result);
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
      result = failureResult(input, effort, WRITING_REVIEW_REASONING_BENCHMARK_MODEL, now() - startedAt, usage, {
        result: timedOut ? "timeout" : "provider_error",
        errorCode: timedOut ? "AI_REQUEST_TIMEOUT" : errorCode(error),
        error
      });
    }

    results.push(result);
    dependencies.onEffortComplete?.(result);
  }

  return results;
}

function successResult(
  input: OpenRouterWritingReviewInput & { attemptId: string },
  effort: OpenRouterReasoningEffort,
  model: string,
  elapsedMs: number,
  usage: OpenRouterTokenUsage,
  validated: AIReviewResultV22
): WritingReviewReasoningBenchmarkResult {
  return {
    reasoning_effort: effort,
    operation: WRITING_REVIEW_REASONING_BENCHMARK_OPERATION,
    attempt_id: input.attemptId,
    task_type: input.taskType,
    model,
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
    validated_result: validated
  };
}

function failureResult(
  input: OpenRouterWritingReviewInput & { attemptId: string },
  effort: OpenRouterReasoningEffort,
  model: string,
  elapsedMs: number,
  usage: OpenRouterTokenUsage,
  failure: {
    result: "timeout" | "provider_error" | "invalid_json" | "validation_error";
    errorCode: string;
    error: unknown;
  }
): WritingReviewReasoningBenchmarkResult {
  return {
    reasoning_effort: effort,
    operation: WRITING_REVIEW_REASONING_BENCHMARK_OPERATION,
    attempt_id: input.attemptId,
    task_type: input.taskType,
    model,
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
    validated_result: null
  };
}

function countFeedbackCategories(result: AIReviewResultV22) {
  return result.content_feedback.reduce<FeedbackCategoryCounts>((counts, feedback) => {
    counts[feedback.category] = (counts[feedback.category] ?? 0) + 1;
    return counts;
  }, {});
}

export function buildWritingReviewReasoningBenchmarkSummary(
  results: WritingReviewReasoningBenchmarkResult[]
): WritingReviewReasoningBenchmarkSummary {
  if (results.length === 0) throw new Error("Reasoning benchmark produced no results.");
  return {
    attempt_id: results[0].attempt_id,
    task_type: results[0].task_type,
    model: WRITING_REVIEW_REASONING_BENCHMARK_MODEL,
    operation: WRITING_REVIEW_REASONING_BENCHMARK_OPERATION,
    results: results.map(({ validated_result: _validatedResult, ...result }) => result)
  };
}

export function writeWritingReviewReasoningBenchmarkFiles(
  outputDir: string,
  results: WritingReviewReasoningBenchmarkResult[],
  fileSystem: {
    mkdirSync: typeof mkdirSync;
    writeFileSync: typeof writeFileSync;
  } = { mkdirSync, writeFileSync }
) {
  fileSystem.mkdirSync(outputDir, { recursive: true });
  for (const result of results) {
    fileSystem.writeFileSync(
      join(outputDir, `${result.reasoning_effort}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }
  const summary = buildWritingReviewReasoningBenchmarkSummary(results);
  fileSystem.writeFileSync(
    join(outputDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  return summary;
}

function errorCode(error: unknown) {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : "OPENROUTER_REQUEST_FAILED";
}

function safeErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return "Unknown benchmark error.";
  const issues = "issues" in error ? (error as { issues?: unknown }).issues : undefined;
  return Array.isArray(issues)
    ? `${error.message} Issues: ${JSON.stringify(issues)}`
    : error.message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

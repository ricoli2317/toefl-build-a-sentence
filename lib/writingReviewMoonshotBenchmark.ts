import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  MOONSHOT_WRITING_REVIEW_MODEL,
  MoonshotWritingReviewError,
  requestMoonshotWithTimeout,
  type MoonshotReasoningEffort,
  type MoonshotWritingReviewResponse
} from "./moonshotWritingReview.ts";
import {
  EMPTY_OPENROUTER_USAGE,
  WRITING_REVIEW_FULL_REQUEST_TIMEOUT_MS,
  type OpenRouterTokenUsage,
  type OpenRouterWritingReviewInput
} from "./openrouterWritingReview.ts";
import type { AIReviewResultV22 } from "./writingReviewSchemaV22.ts";
import type { WritingTaskType } from "./writing.ts";

export const WRITING_REVIEW_MOONSHOT_BENCHMARK_EFFORTS = [
  "max",
  "high"
] as const;
export const WRITING_REVIEW_MOONSHOT_BENCHMARK_PROVIDER =
  "moonshot-direct" as const;
export const WRITING_REVIEW_MOONSHOT_BENCHMARK_OPERATION =
  "moonshot_direct_benchmark" as const;
export const WRITING_REVIEW_MOONSHOT_BENCHMARK_TIMEOUT_MS =
  WRITING_REVIEW_FULL_REQUEST_TIMEOUT_MS;
export const DEFAULT_WRITING_REVIEW_MOONSHOT_BENCHMARK_ATTEMPT_ID =
  "a7ad7e9f-b4ef-4ee0-9b39-43f1d7020cdc";
export const WRITING_REVIEW_MOONSHOT_BENCHMARK_OUTPUT_DIR =
  "tmp/writing-review-provider-benchmark";

type DimensionScores = Record<string, number>;
type FeedbackCategoryCounts = Record<string, number>;

export type WritingReviewMoonshotBenchmarkResult = OpenRouterTokenUsage & {
  provider: typeof WRITING_REVIEW_MOONSHOT_BENCHMARK_PROVIDER;
  reasoning_effort: MoonshotReasoningEffort;
  operation: typeof WRITING_REVIEW_MOONSHOT_BENCHMARK_OPERATION;
  attempt_id: string;
  task_type: WritingTaskType;
  model: typeof MOONSHOT_WRITING_REVIEW_MODEL;
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
  validated_result: AIReviewResultV22 | null;
};

export type WritingReviewMoonshotBenchmarkDependencies = {
  now?: () => number;
  timeoutMs?: number;
  onEffortStart?(effort: MoonshotReasoningEffort): void;
  onEffortComplete?(result: WritingReviewMoonshotBenchmarkResult): void;
  requestWithTimeout?<T>(
    request: (signal: AbortSignal) => Promise<T>,
    options: { timeoutMs: number; timeoutMessage: string }
  ): Promise<T>;
  requestAI(
    input: OpenRouterWritingReviewInput,
    effort: MoonshotReasoningEffort,
    signal: AbortSignal
  ): Promise<MoonshotWritingReviewResponse>;
  parseReview(value: unknown, responseText: string): AIReviewResultV22;
};

export async function benchmarkWritingReviewMoonshot(
  input: OpenRouterWritingReviewInput & { attemptId: string },
  dependencies: WritingReviewMoonshotBenchmarkDependencies
) {
  const now = dependencies.now ?? (() => Date.now());
  const timeoutMs =
    dependencies.timeoutMs ?? WRITING_REVIEW_MOONSHOT_BENCHMARK_TIMEOUT_MS;
  const withTimeout = dependencies.requestWithTimeout ?? requestMoonshotWithTimeout;
  const results: WritingReviewMoonshotBenchmarkResult[] = [];

  for (const effort of WRITING_REVIEW_MOONSHOT_BENCHMARK_EFFORTS) {
    dependencies.onEffortStart?.(effort);
    const startedAt = now();
    let usage: OpenRouterTokenUsage = { ...EMPTY_OPENROUTER_USAGE };
    let result: WritingReviewMoonshotBenchmarkResult;
    try {
      const response = await withTimeout(
        (signal) => dependencies.requestAI(input, effort, signal),
        {
          timeoutMs,
          timeoutMessage: `Moonshot ${effort} benchmark timed out.`
        }
      );
      usage = response.usage;
      let raw: unknown;
      try {
        raw = JSON.parse(response.content) as unknown;
      } catch (error) {
        result = failureResult(input, effort, now() - startedAt, usage, {
          result: "invalid_json",
          errorCode: "MOONSHOT_RESPONSE_INVALID",
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
          throw new Error("Moonshot result did not match the benchmark task or v2.2 schema.");
        }
      } catch (error) {
        result = failureResult(input, effort, now() - startedAt, usage, {
          result: "validation_error",
          errorCode: "AI_RESPONSE_INVALID",
          error
        });
        results.push(result);
        dependencies.onEffortComplete?.(result);
        continue;
      }

      result = successResult(input, effort, now() - startedAt, usage, validated);
    } catch (error) {
      const timedOut =
        error instanceof MoonshotWritingReviewError &&
        error.code === "AI_REQUEST_TIMEOUT";
      result = failureResult(input, effort, now() - startedAt, usage, {
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
  effort: MoonshotReasoningEffort,
  elapsedMs: number,
  usage: OpenRouterTokenUsage,
  validated: AIReviewResultV22
): WritingReviewMoonshotBenchmarkResult {
  return {
    provider: WRITING_REVIEW_MOONSHOT_BENCHMARK_PROVIDER,
    reasoning_effort: effort,
    operation: WRITING_REVIEW_MOONSHOT_BENCHMARK_OPERATION,
    attempt_id: input.attemptId,
    task_type: input.taskType,
    model: MOONSHOT_WRITING_REVIEW_MODEL,
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
    content_feedback_categories: validated.content_feedback.reduce<FeedbackCategoryCounts>(
      (counts, feedback) => {
        counts[feedback.category] = (counts[feedback.category] ?? 0) + 1;
        return counts;
      },
      {}
    ),
    validated_result: validated
  };
}

function failureResult(
  input: OpenRouterWritingReviewInput & { attemptId: string },
  effort: MoonshotReasoningEffort,
  elapsedMs: number,
  usage: OpenRouterTokenUsage,
  failure: {
    result: "timeout" | "provider_error" | "invalid_json" | "validation_error";
    errorCode: string;
    error: unknown;
  }
): WritingReviewMoonshotBenchmarkResult {
  return {
    provider: WRITING_REVIEW_MOONSHOT_BENCHMARK_PROVIDER,
    reasoning_effort: effort,
    operation: WRITING_REVIEW_MOONSHOT_BENCHMARK_OPERATION,
    attempt_id: input.attemptId,
    task_type: input.taskType,
    model: MOONSHOT_WRITING_REVIEW_MODEL,
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

export function buildWritingReviewMoonshotBenchmarkSummary(
  results: WritingReviewMoonshotBenchmarkResult[]
) {
  if (results.length === 0) throw new Error("Moonshot benchmark produced no results.");
  return {
    attempt_id: results[0].attempt_id,
    task_type: results[0].task_type,
    provider: WRITING_REVIEW_MOONSHOT_BENCHMARK_PROVIDER,
    model: MOONSHOT_WRITING_REVIEW_MODEL,
    operation: WRITING_REVIEW_MOONSHOT_BENCHMARK_OPERATION,
    results: results.map(({ validated_result: _validatedResult, ...result }) => result)
  };
}

export function writeWritingReviewMoonshotBenchmarkFiles(
  outputDir: string,
  results: WritingReviewMoonshotBenchmarkResult[],
  fileSystem: {
    mkdirSync: typeof mkdirSync;
    writeFileSync: typeof writeFileSync;
  } = { mkdirSync, writeFileSync }
) {
  fileSystem.mkdirSync(outputDir, { recursive: true });
  for (const result of results) {
    fileSystem.writeFileSync(
      join(outputDir, `moonshot-${result.reasoning_effort}.json`),
      `${JSON.stringify(result, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 }
    );
  }
  const summary = buildWritingReviewMoonshotBenchmarkSummary(results);
  fileSystem.writeFileSync(
    join(outputDir, "moonshot-summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 }
  );
  return summary;
}

function errorCode(error: unknown) {
  return isRecord(error) && typeof error.code === "string"
    ? error.code
    : "MOONSHOT_REQUEST_FAILED";
}

function safeErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return "Unknown Moonshot benchmark error.";
  const issues = "issues" in error ? (error as { issues?: unknown }).issues : undefined;
  return Array.isArray(issues)
    ? `${error.message} Issues: ${JSON.stringify(issues)}`
    : error.message;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

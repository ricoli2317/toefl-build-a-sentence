import type { WritingTaskType } from "@/lib/writing";
import type { AIReviewResult } from "@/lib/writingReviewSchema";
import type { AIReviewResultV2 } from "@/lib/writingReviewSchemaV2";
import type { AIReviewResultV21 } from "@/lib/writingReviewSchemaV21";
import type { AIReviewResultV22 } from "@/lib/writingReviewSchemaV22";
import {
  EMPTY_OPENROUTER_USAGE,
  type OpenRouterTokenUsage
} from "./openrouterWritingReview.ts";

export const WRITING_REVIEW_COMPARISON_MODELS = [
  "deepseek/deepseek-v4-flash",
  "qwen/qwen3.8-max",
  "moonshotai/kimi-k3"
] as const;

export const WRITING_REVIEW_MODEL_TIMEOUT_MS = 300_000;

export const WRITING_REVIEW_COMPARISON_MODEL_ALIASES = {
  deepseek: WRITING_REVIEW_COMPARISON_MODELS[0],
  qwen: WRITING_REVIEW_COMPARISON_MODELS[1],
  kimi: WRITING_REVIEW_COMPARISON_MODELS[2]
} as const;

export function parseWritingReviewComparisonArguments(arguments_: string[]) {
  const normalized = arguments_.filter((argument) => argument !== "--");
  let attemptId = "";
  let model: string | null = null;
  let sourceOnly = false;
  let unknownOption: string | null = null;

  for (let index = 0; index < normalized.length; index += 1) {
    const argument = normalized[index];
    if (argument === "--source-only") {
      sourceOnly = true;
    } else if (argument === "--model") {
      const value = normalized[index + 1];
      if (!value || value.startsWith("--")) {
        unknownOption = "--model (missing value)";
      } else {
        model = value.trim();
        index += 1;
      }
    } else if (argument.startsWith("--")) {
      unknownOption ??= argument;
    } else if (!attemptId) {
      attemptId = argument.trim();
    } else {
      unknownOption ??= argument;
    }
  }

  return {
    attemptId,
    sourceOnly,
    model,
    unknownOption
  };
}

export function resolveWritingReviewComparisonModel(model: string) {
  const normalized = model.trim();
  const alias = WRITING_REVIEW_COMPARISON_MODEL_ALIASES[
    normalized as keyof typeof WRITING_REVIEW_COMPARISON_MODEL_ALIASES
  ];
  if (alias) return alias;
  if (normalized.includes("/")) return normalized;
  throw new Error(
    `Unknown model "${normalized}". Use deepseek, qwen, kimi, or a full model ID.`
  );
}

export type WritingReviewComparisonInput = {
  taskType: WritingTaskType;
  question: Record<string, unknown>;
  responseText: string;
};

export type WritingReviewModelComparison = {
  model: string;
  success: boolean;
  latency_ms: number;
  result: AIReviewResult | AIReviewResultV2 | AIReviewResultV21 | AIReviewResultV22 | null;
  error: string | null;
  prompt_tokens: number | null;
  cached_tokens: number | null;
  completion_tokens: number | null;
  reasoning_tokens: number | null;
  accepted_prediction_tokens: number | null;
  rejected_prediction_tokens: number | null;
  total_tokens: number | null;
  cost: number | null;
  upstream_inference_cost: number | null;
  upstream_inference_prompt_cost: number | null;
  upstream_inference_completions_cost: number | null;
};

export type WritingReviewComparisonDependencies = {
  now?: () => number;
  timeoutMs?: number;
  models?: readonly string[];
  onModelStart?(model: string): void;
  onModelComplete?(comparison: WritingReviewModelComparison): void;
  parseReview(
    value: unknown,
    responseText: string
  ): AIReviewResult | AIReviewResultV2 | AIReviewResultV21 | AIReviewResultV22;
  requestAI(
    input: WritingReviewComparisonInput,
    model: string,
    signal: AbortSignal
  ): Promise<{
    content: string;
    model: string;
    usage: OpenRouterTokenUsage;
  }>;
};

const EMPTY_USAGE: OpenRouterTokenUsage = EMPTY_OPENROUTER_USAGE;

export async function compareWritingReviewModels(
  input: WritingReviewComparisonInput,
  dependencies: WritingReviewComparisonDependencies
) {
  const comparisons: WritingReviewModelComparison[] = [];
  const now = dependencies.now ?? (() => Date.now());
  const timeoutMs = dependencies.timeoutMs ?? WRITING_REVIEW_MODEL_TIMEOUT_MS;
  const models = dependencies.models ?? WRITING_REVIEW_COMPARISON_MODELS;

  for (const model of models) {
    dependencies.onModelStart?.(model);
    const startedAt = now();
    let usage = EMPTY_USAGE;
    const controller = new AbortController();
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          reject(new Error("MODEL_TIMEOUT"));
        }, timeoutMs);
      });
      const response = await Promise.race([
        dependencies.requestAI(input, model, controller.signal),
        timeout
      ]);
      usage = response.usage;
      let parsed: unknown;
      try {
        parsed = JSON.parse(response.content) as unknown;
      } catch {
        throw new Error("AI response content was not valid JSON.");
      }

      const result = dependencies.parseReview(parsed, input.responseText);
      if (result.task_type !== input.taskType) {
        throw new Error("AI response task_type did not match the writing attempt.");
      }

      const comparison = {
        model,
        success: true,
        latency_ms: Math.max(0, now() - startedAt),
        result,
        error: null,
        ...response.usage
      } satisfies WritingReviewModelComparison;
      comparisons.push(comparison);
      dependencies.onModelComplete?.(comparison);
    } catch (error) {
      const comparison = {
        model,
        success: false,
        latency_ms: Math.max(0, now() - startedAt),
        result: null,
        error: timedOut ? "MODEL_TIMEOUT" : safeErrorMessage(error),
        ...usage
      } satisfies WritingReviewModelComparison;
      comparisons.push(comparison);
      dependencies.onModelComplete?.(comparison);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return comparisons;
}

function safeErrorMessage(error: unknown) {
  if (!(error instanceof Error)) return "Unknown model comparison error.";
  const issues = "issues" in error ? (error as { issues?: unknown }).issues : undefined;
  if (Array.isArray(issues)) {
    return `${error.message} Issues: ${JSON.stringify(issues)}`;
  }
  return error.message;
}

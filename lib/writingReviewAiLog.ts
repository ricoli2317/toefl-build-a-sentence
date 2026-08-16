import {
  getOpenRouterErrorDiagnostic,
  OpenRouterWritingReviewError
} from "./openrouterWritingReview.ts";
import { AIReviewValidationError } from "./writingReviewSchema.ts";

export type WritingReviewAiOperation =
  | "generate_ai"
  | "full_regenerate"
  | "feedback_regenerate";
export type WritingReviewAiStatus = "success" | "recovered" | "failed";
export type WritingReviewAiPipelineStage =
  | "request_preparation"
  | "provider_request"
  | "provider_response"
  | "response_parsing"
  | "schema_validation"
  | "localization"
  | "normalization"
  | "final_validation"
  | "review_persistence"
  | "unknown";
export type WritingReviewAiValidationIssue = { path: string; message: string };

export type WritingReviewAiLogEntry = {
  request_id: string;
  operation: WritingReviewAiOperation;
  attempt_id: string;
  task_type: "email" | "academic_discussion" | null;
  model: string;
  prompt_version: string;
  schema_version: string;
  status: WritingReviewAiStatus;
  pipeline_stage: WritingReviewAiPipelineStage;
  error_type?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  elapsed_ms: number;
  end_to_end_elapsed_ms?: number | null;
  generation_id?: string | null;
  provider_request_id?: string | null;
  prompt_tokens?: number | null;
  cached_tokens?: number | null;
  completion_tokens?: number | null;
  reasoning_tokens?: number | null;
  accepted_prediction_tokens?: number | null;
  rejected_prediction_tokens?: number | null;
  total_tokens?: number | null;
  cost?: number | null;
  upstream_inference_cost?: number | null;
  upstream_inference_prompt_cost?: number | null;
  upstream_inference_completions_cost?: number | null;
  http_status?: number | null;
  provider_error_type?: string | null;
  provider_error_code?: string | number | null;
  provider_name?: string | null;
  hedge_triggered?: boolean | null;
  requests_started?: 1 | 2 | null;
  winner?: "primary" | "hedge" | null;
  primary_result?: string | null;
  primary_elapsed_ms?: number | null;
  primary_cost?: number | null;
  hedge_result?: string | null;
  hedge_elapsed_ms?: number | null;
  hedge_cost?: number | null;
  loser_status?: string | null;
  winner_cost?: number | null;
  observed_completed_cost?: number | null;
  normalization_applied?: boolean;
  validation_issues?: WritingReviewAiValidationIssue[];
  diagnostics?: Record<string, unknown>;
};

export type WritingReviewAiFailureClassification = Pick<
  WritingReviewAiLogEntry,
  | "status"
  | "pipeline_stage"
  | "error_type"
  | "error_code"
  | "error_message"
  | "validation_issues"
>;

type PersistenceClient = {
  from(table: string): {
    insert(row: Record<string, unknown>): PromiseLike<{
      error: { message?: string } | null;
    }>;
  };
};

export function logWritingReviewAi(entry: WritingReviewAiLogEntry) {
  console.info("[writing-review-ai]", {
    request_id: entry.request_id,
    operation: entry.operation,
    attempt_id: entry.attempt_id,
    task_type: entry.task_type,
    model: entry.model,
    prompt_version: entry.prompt_version,
    schema_version: entry.schema_version,
    status: entry.status,
    pipeline_stage: entry.pipeline_stage,
    error_type: entry.error_type ?? null,
    error_code: entry.error_code ?? null,
    elapsed_ms: entry.elapsed_ms,
    normalization_applied: entry.normalization_applied ?? false,
    hedge_triggered: entry.hedge_triggered ?? null,
    requests_started: entry.requests_started ?? null,
    winner: entry.winner ?? null,
    total_tokens: entry.total_tokens ?? null,
    cost: entry.cost ?? null
  });
}

export async function persistWritingReviewAiLogBestEffort(
  client: PersistenceClient,
  entry: WritingReviewAiLogEntry
) {
  logWritingReviewAi(entry);
  try {
    const { error } = await client
      .from("writing_review_ai_logs")
      .insert(writingReviewAiLogDatabaseRow(entry));
    if (error) throw new Error(error.message || "Unknown insert error");
  } catch (error) {
    console.error("[writing-review-ai] persistence_failed", {
      request_id: entry.request_id,
      attempt_id: entry.attempt_id,
      error_code: "OBSERVABILITY_PERSISTENCE_FAILED",
      message: boundedMessage(error)
    });
  }
}

export function writingReviewAiLogDatabaseRow(entry: WritingReviewAiLogEntry) {
  return {
    request_id: entry.request_id,
    attempt_id: entry.attempt_id,
    task_type: entry.task_type,
    operation: entry.operation,
    generation_id: entry.generation_id ?? null,
    provider_request_id: entry.provider_request_id ?? null,
    model: entry.model,
    prompt_version: entry.prompt_version,
    schema_version: entry.schema_version,
    status: entry.status,
    pipeline_stage: entry.pipeline_stage,
    error_type: entry.error_type ?? null,
    error_code: entry.error_code ?? null,
    error_message: entry.error_message
      ? boundedText(entry.error_message, 500)
      : null,
    elapsed_ms: entry.elapsed_ms,
    end_to_end_elapsed_ms: entry.end_to_end_elapsed_ms ?? null,
    prompt_tokens: entry.prompt_tokens ?? null,
    cached_tokens: entry.cached_tokens ?? null,
    completion_tokens: entry.completion_tokens ?? null,
    reasoning_tokens: entry.reasoning_tokens ?? null,
    accepted_prediction_tokens: entry.accepted_prediction_tokens ?? null,
    rejected_prediction_tokens: entry.rejected_prediction_tokens ?? null,
    total_tokens: entry.total_tokens ?? null,
    cost: entry.cost ?? null,
    upstream_inference_cost: entry.upstream_inference_cost ?? null,
    upstream_inference_prompt_cost: entry.upstream_inference_prompt_cost ?? null,
    upstream_inference_completions_cost:
      entry.upstream_inference_completions_cost ?? null,
    provider_name: entry.provider_name ?? null,
    http_status: entry.http_status ?? null,
    provider_error_type: entry.provider_error_type ?? null,
    provider_error_code:
      entry.provider_error_code === undefined || entry.provider_error_code === null
        ? null
        : String(entry.provider_error_code),
    hedge_triggered: entry.hedge_triggered ?? null,
    requests_started: entry.requests_started ?? null,
    winner: entry.winner ?? null,
    primary_result: entry.primary_result ?? null,
    primary_elapsed_ms: entry.primary_elapsed_ms ?? null,
    primary_cost: entry.primary_cost ?? null,
    hedge_result: entry.hedge_result ?? null,
    hedge_elapsed_ms: entry.hedge_elapsed_ms ?? null,
    hedge_cost: entry.hedge_cost ?? null,
    loser_status: entry.loser_status ?? null,
    winner_cost: entry.winner_cost ?? null,
    observed_completed_cost: entry.observed_completed_cost ?? null,
    normalization_applied: entry.normalization_applied ?? false,
    validation_issues: (entry.validation_issues ?? []).map((item) => ({
      path: boundedText(item.path, 500),
      message: boundedText(item.message, 1000)
    })),
    diagnostics: sanitizeDiagnostics(entry.diagnostics ?? {})
  };
}

export function classifyWritingReviewAiFailure(
  error: unknown
): WritingReviewAiFailureClassification {
  const chain = errorChain(error);
  const validation = chain.find(
    (item): item is AIReviewValidationError => item instanceof AIReviewValidationError
  );
  if (validation) {
    const localizationIssue = validation.issues.find(({ message }) =>
      /occur exactly (in|once)/i.test(message)
    );
    const overlapIssue = validation.issues.find(({ message }) =>
      /must not overlap/i.test(message)
    );
    if (localizationIssue) {
      return failure(
        "localization",
        "localization_error",
        /exactly once/i.test(localizationIssue.message)
          ? "ORIGINAL_TEXT_NOT_UNIQUE"
          : "ORIGINAL_TEXT_NOT_FOUND",
        error,
        validation.issues
      );
    }
    if (overlapIssue) {
      return failure(
        "final_validation",
        "language_edit_overlap",
        "LANGUAGE_EDIT_OVERLAP",
        error,
        validation.issues
      );
    }
    return failure(
      "schema_validation",
      "schema_validation_error",
      "INVALID_AI_RESPONSE_SCHEMA",
      error,
      validation.issues
    );
  }

  const code = firstString(chain, "code");
  const result = firstString(chain, "result");
  if (
    code === "OPENROUTER_API_KEY_MISSING" ||
    code === "OPENROUTER_MODEL_MISSING"
  ) {
    return failure(
      "request_preparation",
      "configuration_error",
      "AI_CONFIGURATION_MISSING",
      error
    );
  }
  if (
    code === "ATTEMPT_NOT_FOUND" ||
    code === "ATTEMPT_NOT_SUBMITTED" ||
    code === "REVIEW_ALREADY_EXISTS" ||
    code === "REVIEW_NOT_FOUND" ||
    code === "QUESTION_NOT_FOUND" ||
    code === "INVALID_TEACHER_PROMPT" ||
    code === "FEEDBACK_NOT_FOUND" ||
    code === "TEACHER_FEEDBACK_UNSUPPORTED" ||
    code === "LEGACY_FEEDBACK_UNSUPPORTED" ||
    code === "FEEDBACK_POSITION_INVALID"
  ) {
    return failure(
      "request_preparation",
      "request_preparation_error",
      code,
      error
    );
  }
  if (code === "AI_REQUEST_TIMEOUT") {
    return failure("provider_request", "timeout", "AI_REQUEST_TIMEOUT", error);
  }
  if (result === "invalid_json") {
    return failure(
      "response_parsing",
      "response_parse_error",
      "INVALID_STRUCTURED_RESPONSE",
      error
    );
  }
  if (result === "validation_error") {
    return failure(
      "schema_validation",
      "schema_validation_error",
      "INVALID_AI_RESPONSE_SCHEMA",
      error
    );
  }
  if (result === "localization_error") {
    return failure(
      "localization",
      "localization_error",
      "LOCALIZATION_FAILED",
      error
    );
  }
  if (
    code === "AI_RESPONSE_INVALID" &&
    chain.some((item) => item instanceof SyntaxError)
  ) {
    return failure(
      "response_parsing",
      "response_parse_error",
      "INVALID_STRUCTURED_RESPONSE",
      error
    );
  }
  if (
    code === "AI_RESPONSE_INVALID" &&
    chain.some((item) => item instanceof OpenRouterWritingReviewError)
  ) {
    return failure(
      "provider_response",
      "response_parse_error",
      "INVALID_STRUCTURED_RESPONSE",
      error
    );
  }
  const provider = getOpenRouterErrorDiagnostic(error);
  if (
    chain.some((item) => item instanceof OpenRouterWritingReviewError) ||
    provider.http_status !== null
  ) {
    return failure(
      "provider_request",
      "provider_error",
      provider.http_status === null
        ? "PROVIDER_REQUEST_FAILED"
        : "PROVIDER_HTTP_ERROR",
      error
    );
  }
  if (
    code === "REVIEW_SAVE_FAILED" ||
    code === "REVIEW_UPDATE_FAILED" ||
    code === "DATABASE_READ_FAILED"
  ) {
    return failure(
      "review_persistence",
      "persistence_error",
      code,
      error
    );
  }
  if (code === "AI_RESPONSE_INVALID") {
    return failure(
      "schema_validation",
      "schema_validation_error",
      "INVALID_AI_RESPONSE_SCHEMA",
      error
    );
  }
  return failure("unknown", "unknown_error", "WRITING_AI_UNKNOWN_ERROR", error);
}

/** Retained for existing coarse-result callers. */
export function classifyWritingReviewAiError(error: unknown) {
  const type = classifyWritingReviewAiFailure(error).error_type;
  if (type === "timeout") return "timeout" as const;
  if (type === "provider_error") return "openrouter_error" as const;
  if (type === "persistence_error") return "database_error" as const;
  if (
    type === "schema_validation_error" ||
    type === "localization_error" ||
    type === "language_edit_overlap"
  ) {
    return "validation_error" as const;
  }
  return "invalid_ai_response" as const;
}

export function writingReviewAiProviderDiagnostic(error: unknown) {
  const diagnostic = getOpenRouterErrorDiagnostic(error);
  return {
    http_status: diagnostic.http_status,
    provider_error_type: diagnostic.error_type,
    provider_error_code: diagnostic.provider_code,
    provider_name: diagnostic.provider_name
  };
}

function failure(
  pipeline_stage: WritingReviewAiPipelineStage,
  error_type: string,
  error_code: string,
  error: unknown,
  validation_issues: WritingReviewAiValidationIssue[] = []
): WritingReviewAiFailureClassification {
  return {
    status: "failed",
    pipeline_stage,
    error_type,
    error_code,
    error_message: boundedMessage(error),
    validation_issues
  };
}

function errorChain(error: unknown) {
  const values: unknown[] = [];
  const visited = new Set<unknown>();
  let current = error;
  for (let depth = 0; depth < 8 && current !== null; depth += 1) {
    if (visited.has(current)) break;
    visited.add(current);
    values.push(current);
    if (!isRecord(current)) break;
    current = current.cause;
  }
  return values;
}

function firstString(values: unknown[], key: string) {
  for (const value of values) {
    if (isRecord(value) && typeof value[key] === "string") {
      return value[key] as string;
    }
  }
  return null;
}

function boundedMessage(error: unknown) {
  const value = error instanceof Error ? error.message : "Unknown writing AI error";
  return value.length <= 500 ? value : `${value.slice(0, 497)}...`;
}

const FORBIDDEN_DIAGNOSTIC_KEYS = new Set([
  "api_key",
  "authorization",
  "full_prompt",
  "original_question",
  "prompt",
  "provider_response",
  "response_text",
  "system_prompt",
  "user_prompt"
]);

function sanitizeDiagnostics(value: Record<string, unknown>) {
  return sanitizeLogJsonValue(value, 0) as Record<string, unknown>;
}

function sanitizeLogJsonValue(value: unknown, depth: number): unknown {
  if (depth > 8) return "[depth limit]";
  if (typeof value === "string") return boundedText(value, 2000);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, 200)
      .map((item) => sanitizeLogJsonValue(item, depth + 1));
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !FORBIDDEN_DIAGNOSTIC_KEYS.has(key.toLowerCase()))
        .slice(0, 200)
        .map(([key, item]) => [key, sanitizeLogJsonValue(item, depth + 1)])
    );
  }
  return String(value);
}

function boundedText(value: string, maxLength: number) {
  return value.length <= maxLength
    ? value
    : `${value.slice(0, maxLength - 3)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

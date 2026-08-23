import type {
  BillingCompleteness,
  CostObservability
} from "./writingReviewCost.ts";

export const WRITING_REVIEW_AI_LOG_SAFE_COLUMNS = [
  "id",
  "created_at",
  "attempt_id",
  "task_type",
  "operation",
  "request_id",
  "generation_id",
  "provider_request_id",
  "model",
  "prompt_version",
  "schema_version",
  "status",
  "pipeline_stage",
  "error_type",
  "error_code",
  "error_message",
  "elapsed_ms",
  "end_to_end_elapsed_ms",
  "prompt_tokens",
  "cached_tokens",
  "completion_tokens",
  "reasoning_tokens",
  "accepted_prediction_tokens",
  "rejected_prediction_tokens",
  "total_tokens",
  "cost",
  "upstream_inference_cost",
  "upstream_inference_prompt_cost",
  "upstream_inference_completions_cost",
  "provider_name",
  "http_status",
  "provider_error_type",
  "provider_error_code",
  "hedge_triggered",
  "requests_started",
  "winner",
  "primary_result",
  "primary_elapsed_ms",
  "primary_cost",
  "hedge_result",
  "hedge_elapsed_ms",
  "hedge_cost",
  "loser_status",
  "winner_cost",
  "observed_completed_cost",
  "normalization_applied",
  "validation_issues",
  "diagnostics"
] as const;

const COST_KEYS = [
  "amount",
  "currency",
  "source",
  "estimate_kind",
  "reason",
  "pricing_version",
  "official_pricing_url",
  "pricing_verified_at",
  "cached_input_tokens",
  "uncached_input_tokens",
  "output_tokens",
  "reasoning_tokens",
  "reasoning_included_in_output",
  "billing_completeness",
  "endpoint_hostname"
] as const;

export function projectWritingReviewAiLog(
  row: Record<string, unknown>,
  options: { includeDiagnostics?: boolean } = {}
) {
  const diagnostics = asRecord(row.diagnostics) ?? {};
  const billingCompleteness = validBillingCompleteness(
    diagnostics.billing_completeness
  );
  const topCost = safeCostObservability(
    diagnostics.cost_observability,
    row.cost,
    billingCompleteness
  );
  const primaryCost = safeCostObservability(
    diagnostics.primary_cost_observability,
    row.primary_cost,
    billingCompleteness,
    topCost
  );
  const hedgeCost = safeCostObservability(
    diagnostics.hedge_cost_observability,
    row.hedge_cost,
    billingCompleteness,
    topCost
  );
  const winnerCost = safeCostObservability(
    diagnostics.winner_cost_observability,
    row.winner_cost,
    billingCompleteness,
    topCost
  );
  const observedCost = safeCostObservability(
    diagnostics.observed_cost_observability,
    row.observed_completed_cost,
    billingCompleteness,
    topCost
  );
  const projected = Object.fromEntries(
    WRITING_REVIEW_AI_LOG_SAFE_COLUMNS
      .filter((key) => key !== "diagnostics")
      .map((key) => [key, row[key] ?? null])
  );
  const upstreamCurrency =
    topCost?.currency === "USD" ? "USD" : null;
  return {
    ...projected,
    cost_observability: topCost,
    primary_cost_observability: primaryCost,
    hedge_cost_observability: hedgeCost,
    winner_cost_observability: winnerCost,
    observed_cost_observability: observedCost,
    cost_currency: topCost?.currency ?? null,
    cost_source: topCost?.source ?? null,
    estimate_kind: topCost?.estimate_kind ?? null,
    upstream_cost_currency: upstreamCurrency,
    billing_completeness:
      billingCompleteness ?? topCost?.billing_completeness ?? null,
    ...(options.includeDiagnostics
      ? {
          diagnostics: safeDetailDiagnostics(diagnostics)
        }
      : {})
  };
}

function safeCostObservability(
  value: unknown,
  numericFallback: unknown,
  billingCompleteness: BillingCompleteness | null,
  metadataFallback?: Partial<CostObservability> | null
): Partial<CostObservability> | null {
  const record = asRecord(value);
  const amount = finiteNumber(record?.amount ?? numericFallback);
  if (!record && amount === null) return null;
  const projected: Record<string, unknown> = {};
  if (record) {
    for (const key of COST_KEYS) {
      const safe = safeCostValue(key, record[key]);
      if (safe !== undefined) projected[key] = safe;
    }
  }
  projected.amount = amount;
  projected.currency = record
    ? validCurrency(projected.currency)
    : metadataFallback?.currency ?? (amount === null ? null : "USD");
  projected.source = record
    ? typeof projected.source === "string"
      ? projected.source
      : null
    : metadataFallback?.source ??
      (amount === null ? null : "legacy_provider_reported");
  projected.estimate_kind =
    typeof projected.estimate_kind === "string"
      ? projected.estimate_kind
      : metadataFallback?.estimate_kind ?? null;
  projected.billing_completeness =
    validBillingCompleteness(projected.billing_completeness) ??
    billingCompleteness ??
    metadataFallback?.billing_completeness ??
    undefined;
  return projected as Partial<CostObservability>;
}

function safeCostValue(key: (typeof COST_KEYS)[number], value: unknown) {
  if (value === null) return null;
  if (
    key === "amount" ||
    key === "cached_input_tokens" ||
    key === "uncached_input_tokens" ||
    key === "output_tokens" ||
    key === "reasoning_tokens"
  ) {
    return finiteNumber(value) ?? undefined;
  }
  if (key === "reasoning_included_in_output") {
    return value === true ? true : undefined;
  }
  if (typeof value === "string") return value.slice(0, 500);
  return undefined;
}

function safeDetailDiagnostics(diagnostics: Record<string, unknown>) {
  const overlap = diagnostics.language_edit_overlap;
  return overlap === undefined
    ? {}
    : { language_edit_overlap: boundedJson(overlap, 0) };
}

function boundedJson(value: unknown, depth: number): unknown {
  if (depth > 6) return "[depth limit]";
  if (typeof value === "string") return value.slice(0, 1000);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.slice(0, 100).map((item) => boundedJson(item, depth + 1));
  }
  const record = asRecord(value);
  if (!record) return null;
  return Object.fromEntries(
    Object.entries(record)
      .slice(0, 100)
      .map(([key, item]) => [key.slice(0, 100), boundedJson(item, depth + 1)])
  );
}

function validCurrency(value: unknown) {
  return value === "CNY" || value === "USD" ? value : null;
}

function validBillingCompleteness(
  value: unknown
): BillingCompleteness | null {
  return value === "complete_for_observed_requests" ||
    value === "partial_or_unknown"
    ? value
    : null;
}

function finiteNumber(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

import type { OpenRouterTokenUsage } from "./openrouterWritingReview.ts";

export const MOONSHOT_KIMI_K3_PRICING = {
  model: "kimi-k3", provider: "Moonshot China", currency: "CNY",
  pricing_version: "moonshot_kimi_k3_cn_2026-07-17",
  official_pricing_url: "https://platform.kimi.com/docs/pricing/chat-k3",
  pricing_verified_at: "2026-08-23",
  cached_input_rate_per_million: 2, uncached_input_rate_per_million: 20,
  output_rate_per_million: 100
} as const;

export const DEEPSEEK_V4_FLASH_PRICING = {
  model: "deepseek-v4-flash",
  provider: "DeepSeek China",
  currency: "CNY",
  pricing_version: "deepseek_v4_flash_cn_peak_offpeak_2026-08-16",
  official_pricing_url: "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/",
  pricing_verified_at: "2026-08-24",
  off_peak: {
    cached_input_rate_per_million: 0.05,
    uncached_input_rate_per_million: 1.5,
    output_rate_per_million: 4.5
  },
  peak: {
    cached_input_rate_per_million: 0.1,
    uncached_input_rate_per_million: 3,
    output_rate_per_million: 9
  }
} as const;

export type CostObservability = {
  amount: number | null; currency: "CNY" | "USD" | null; source: "local_usage_estimate" | "provider_reported" | "legacy_provider_reported" | null;
  estimate_kind: "usage_based_estimate" | "upper_bound_no_cache_detail" | null; reason?: string;
  pricing_version?: string; official_pricing_url?: string; pricing_verified_at?: string;
  pricing_period?: "peak" | "off_peak";
  cached_input_tokens?: number; uncached_input_tokens?: number; output_tokens?: number; reasoning_tokens?: number; reasoning_included_in_output?: true;
  billing_completeness?: "complete_for_observed_requests" | "partial_or_unknown";
  endpoint_hostname?: string;
};

export type BillingCompleteness = NonNullable<
  CostObservability["billing_completeness"]
>;

const int = (v: unknown) =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;

export function moonshotKimiK3Cost(usage: OpenRouterTokenUsage): CostObservability {
  if (!int(usage.prompt_tokens) || !int(usage.completion_tokens)) return { amount:null,currency:null,source:null,estimate_kind:null,reason:"usage_tokens_missing_or_invalid" };
  const prompt = usage.prompt_tokens as number;
  const completion = usage.completion_tokens as number;
  if (
    usage.total_tokens !== null &&
    (!int(usage.total_tokens) || usage.total_tokens !== prompt + completion)
  ) {
    return {
      amount: null,
      currency: null,
      source: null,
      estimate_kind: null,
      reason: "total_tokens_mismatch"
    };
  }
  if (
    usage.reasoning_tokens !== null &&
    (!int(usage.reasoning_tokens) || usage.reasoning_tokens > completion)
  ) {
    return {
      amount: null,
      currency: null,
      source: null,
      estimate_kind: null,
      reason: "reasoning_tokens_invalid"
    };
  }
  const cached = usage.cached_tokens === null ? 0 : usage.cached_tokens;
  if (!int(cached) || cached > prompt) return { amount:null,currency:null,source:null,estimate_kind:null,reason:"cached_tokens_invalid" };
  const uncached = prompt - cached;
  const micro = cached * 2 + uncached * 20 + completion * 100;
  return { amount: micro / 1_000_000, currency:"CNY", source:"local_usage_estimate", estimate_kind: usage.cached_tokens === null ? "upper_bound_no_cache_detail" : "usage_based_estimate", pricing_version:MOONSHOT_KIMI_K3_PRICING.pricing_version, official_pricing_url:MOONSHOT_KIMI_K3_PRICING.official_pricing_url, pricing_verified_at:MOONSHOT_KIMI_K3_PRICING.pricing_verified_at, cached_input_tokens:cached, uncached_input_tokens:uncached, output_tokens:completion, reasoning_tokens:usage.reasoning_tokens ?? undefined, reasoning_included_in_output:true };
}

export function deepSeekV4FlashCost(
  usage: OpenRouterTokenUsage,
  at = new Date()
): CostObservability {
  if (!int(usage.prompt_tokens) || !int(usage.completion_tokens)) {
    return { amount:null,currency:null,source:null,estimate_kind:null,reason:"usage_tokens_missing_or_invalid" };
  }
  const prompt = usage.prompt_tokens as number;
  const completion = usage.completion_tokens as number;
  if (
    usage.total_tokens !== null &&
    (!int(usage.total_tokens) || usage.total_tokens !== prompt + completion)
  ) {
    return { amount:null,currency:null,source:null,estimate_kind:null,reason:"total_tokens_mismatch" };
  }
  if (
    usage.reasoning_tokens !== null &&
    (!int(usage.reasoning_tokens) || usage.reasoning_tokens > completion)
  ) {
    return { amount:null,currency:null,source:null,estimate_kind:null,reason:"reasoning_tokens_invalid" };
  }
  const cached = usage.cached_tokens === null ? 0 : usage.cached_tokens;
  if (!int(cached) || cached > prompt) {
    return { amount:null,currency:null,source:null,estimate_kind:null,reason:"cached_tokens_invalid" };
  }
  const pricingPeriod = deepSeekPricingPeriod(at);
  const rates = DEEPSEEK_V4_FLASH_PRICING[pricingPeriod];
  const uncached = prompt - cached;
  const amount = (
    cached * rates.cached_input_rate_per_million +
    uncached * rates.uncached_input_rate_per_million +
    completion * rates.output_rate_per_million
  ) / 1_000_000;
  return {
    amount: Math.round(amount * 1_000_000) / 1_000_000,
    currency: "CNY",
    source: "local_usage_estimate",
    estimate_kind: usage.cached_tokens === null
      ? "upper_bound_no_cache_detail"
      : "usage_based_estimate",
    pricing_version: DEEPSEEK_V4_FLASH_PRICING.pricing_version,
    official_pricing_url: DEEPSEEK_V4_FLASH_PRICING.official_pricing_url,
    pricing_verified_at: DEEPSEEK_V4_FLASH_PRICING.pricing_verified_at,
    pricing_period: pricingPeriod,
    cached_input_tokens: cached,
    uncached_input_tokens: uncached,
    output_tokens: completion,
    reasoning_tokens: usage.reasoning_tokens ?? undefined,
    reasoning_included_in_output: true
  };
}

export function deepSeekPricingPeriod(at: Date): "peak" | "off_peak" {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23"
  }).formatToParts(at);
  const weekday = parts.find((part) => part.type === "weekday")?.value;
  const hour = Number(parts.find((part) => part.type === "hour")?.value);
  const workday = weekday !== "Sat" && weekday !== "Sun";
  return workday && ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))
    ? "peak"
    : "off_peak";
}

export function withBillingCompleteness(
  cost: CostObservability | null | undefined,
  billingCompleteness: BillingCompleteness
): CostObservability | null {
  return cost ? { ...cost, billing_completeness: billingCompleteness } : null;
}

export function observedWritingReviewCost(
  costs: Array<CostObservability | null | undefined>,
  billingCompleteness: BillingCompleteness
): CostObservability | null {
  const observed = costs.filter(
    (cost): cost is CostObservability =>
      cost !== null &&
      cost !== undefined &&
      typeof cost.amount === "number" &&
      Number.isFinite(cost.amount) &&
      (cost.currency === "CNY" || cost.currency === "USD")
  );
  if (observed.length === 0) return null;
  const currency = observed[0].currency;
  if (observed.some((cost) => cost.currency !== currency)) return null;
  const template = observed.some(
    (cost) => cost.estimate_kind === "upper_bound_no_cache_detail"
  )
    ? observed.find(
        (cost) => cost.estimate_kind === "upper_bound_no_cache_detail"
      )!
    : observed[0];
  const precision = currency === "CNY" ? 1_000_000 : 10_000_000_000;
  return {
    ...template,
    amount:
      Math.round(
        observed.reduce((sum, cost) => sum + (cost.amount ?? 0), 0) *
          precision
      ) / precision,
    cached_input_tokens: sumOptionalTokens(observed, "cached_input_tokens"),
    uncached_input_tokens: sumOptionalTokens(
      observed,
      "uncached_input_tokens"
    ),
    output_tokens: sumOptionalTokens(observed, "output_tokens"),
    reasoning_tokens: sumOptionalTokens(observed, "reasoning_tokens"),
    billing_completeness: billingCompleteness
  };
}

function sumOptionalTokens(
  costs: CostObservability[],
  key:
    | "cached_input_tokens"
    | "uncached_input_tokens"
    | "output_tokens"
    | "reasoning_tokens"
) {
  const values = costs.map((cost) => cost[key]);
  return values.every((value) => typeof value === "number")
    ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : undefined;
}
export function enrichWritingReviewUsage(provider: string, model: string, usage: OpenRouterTokenUsage, endpointHostname?: string | null): { usage: OpenRouterTokenUsage; cost: CostObservability } {
  if (provider === "moonshot" && model === "kimi-k3" && endpointHostname === "api.moonshot.cn") { const cost={...moonshotKimiK3Cost(usage),endpoint_hostname:endpointHostname}; return { usage:{...usage,cost:cost.amount},cost }; }
  if (provider === "moonshot") return { usage, cost:{ amount:null,currency:null,source:null,estimate_kind:null,reason:"official_moonshot_endpoint_or_model_not_confirmed", endpoint_hostname:endpointHostname ?? undefined } };
  if (provider === "deepseek_flash" && model === "deepseek-v4-flash" && endpointHostname === "api.deepseek.com") { const cost={...deepSeekV4FlashCost(usage),endpoint_hostname:endpointHostname}; return { usage:{...usage,cost:cost.amount},cost }; }
  if (provider === "deepseek_flash") return { usage, cost:{ amount:null,currency:null,source:null,estimate_kind:null,reason:"official_deepseek_endpoint_or_model_not_confirmed", endpoint_hostname:endpointHostname ?? undefined } };
  return { usage, cost:{ amount:usage.cost, currency:usage.cost === null ? null : "USD", source:usage.cost === null ? null : "provider_reported", estimate_kind:null } };
}

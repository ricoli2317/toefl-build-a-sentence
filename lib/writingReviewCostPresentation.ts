export function formatWritingReviewCost(value: unknown, currency?: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  if (currency === "CNY") return `¥${number.toFixed(6)}`;
  if (currency === "USD") return `$${number.toFixed(6)}`;
  return `${number.toFixed(6)}（币种未知）`;
}

export function writingReviewCostSourceLabel(value: unknown) {
  if (value === "local_usage_estimate") return "本地 usage 估算";
  if (value === "provider_reported") return "Provider 报告费用";
  if (value === "legacy_provider_reported") return "历史 Provider 费用";
  return "费用来源未知";
}

export function writingReviewEstimateKindLabel(value: unknown) {
  if (value === "upper_bound_no_cache_detail") {
    return "无缓存明细的保守上限";
  }
  if (value === "usage_based_estimate") return "按 usage 明细估算";
  return "非本地估算或类型未知";
}

export function writingReviewBillingWarning(value: unknown) {
  return value === "partial_or_unknown"
    ? "可观测费用不完整；被取消或未返回 usage 的请求仍可能产生上游账单。"
    : null;
}

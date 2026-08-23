import test from "node:test";
import assert from "node:assert/strict";
import {
  enrichWritingReviewUsage,
  moonshotKimiK3Cost,
  observedWritingReviewCost
} from "../lib/writingReviewCost.ts";
import { getWritingReviewProviderConfig } from "../lib/writingReviewProvider.ts";

function usage(prompt_tokens, cached_tokens, completion_tokens, overrides = {}) {
  return {
    prompt_tokens,
    cached_tokens,
    completion_tokens,
    reasoning_tokens: 0,
    total_tokens:
      typeof prompt_tokens === "number" && typeof completion_tokens === "number"
        ? prompt_tokens + completion_tokens
        : null,
    cost: null,
    accepted_prediction_tokens: null,
    rejected_prediction_tokens: null,
    upstream_inference_cost: null,
    upstream_inference_prompt_cost: null,
    upstream_inference_completions_cost: null,
    ...overrides
  };
}

test("four C3v4 usage estimates and aggregate projections are exact", () => {
  const amounts = [
    moonshotKimiK3Cost(usage(1169, 256, 1105)).amount,
    moonshotKimiK3Cost(usage(1259, null, 1573)).amount,
    moonshotKimiK3Cost(usage(1214, null, 807)).amount,
    moonshotKimiK3Cost(usage(1186, 256, 579)).amount
  ];
  assert.deepEqual(amounts, [0.129272, 0.18248, 0.10498, 0.077012]);
  const total = Math.round(amounts.reduce((sum, amount) => sum + amount, 0) * 1_000_000) / 1_000_000;
  assert.equal(total, 0.493744);
  assert.equal(total / 4, 0.123436);
});

test("zero and fully cached prompt tokens use the correct input rates", () => {
  assert.equal(moonshotKimiK3Cost(usage(100, 0, 10)).amount, 0.003);
  assert.equal(moonshotKimiK3Cost(usage(100, 100, 10)).amount, 0.0012);
});

test("missing cache detail is a conservative upper bound", () => {
  const cost = moonshotKimiK3Cost(usage(10, null, 2));
  assert.equal(cost.amount, 0.0004);
  assert.equal(cost.estimate_kind, "upper_bound_no_cache_detail");
  assert.equal(cost.cached_input_tokens, 0);
  assert.equal(cost.uncached_input_tokens, 10);
});

test("reasoning is reported but not charged in addition to completion", () => {
  const withoutReasoning = moonshotKimiK3Cost(usage(10, 0, 20));
  const withReasoning = moonshotKimiK3Cost(
    usage(10, 0, 20, { reasoning_tokens: 15 })
  );
  assert.equal(withReasoning.amount, withoutReasoning.amount);
  assert.equal(withReasoning.reasoning_tokens, 15);
  assert.equal(withReasoning.reasoning_included_in_output, true);
});

test("invalid token identities never invent a local cost", () => {
  assert.equal(moonshotKimiK3Cost(usage(1, 2, 1)).reason, "cached_tokens_invalid");
  assert.equal(moonshotKimiK3Cost(usage(null, null, 1)).reason, "usage_tokens_missing_or_invalid");
  assert.equal(
    moonshotKimiK3Cost(usage(1, 0, 1, { total_tokens: 99 })).reason,
    "total_tokens_mismatch"
  );
  assert.equal(
    moonshotKimiK3Cost(usage(1, 0, 1, { reasoning_tokens: 2 })).reason,
    "reasoning_tokens_invalid"
  );
});

test("official Moonshot identity is required for local CNY pricing", () => {
  const official = enrichWritingReviewUsage(
    "moonshot", "kimi-k3", usage(10, 0, 2), "api.moonshot.cn"
  );
  assert.equal(official.cost.currency, "CNY");
  assert.equal(official.usage.cost, 0.0004);
  for (const hostname of ["proxy.example.com", null]) {
    const unconfirmed = enrichWritingReviewUsage(
      "moonshot", "kimi-k3", usage(10, 0, 2), hostname
    );
    assert.equal(unconfirmed.cost.amount, null);
    assert.equal(unconfirmed.usage.cost, null);
  }
});

test("provider configuration normalizes official paths and rejects invalid endpoints", () => {
  for (const base of [
    "https://api.moonshot.cn/v1",
    "https://api.moonshot.cn/v1/",
    "https://api.moonshot.cn"
  ]) {
    assert.equal(
      getWritingReviewProviderConfig({ MOONSHOT_API_BASE_URL: base }).endpointHostname,
      "api.moonshot.cn"
    );
  }
  assert.equal(
    getWritingReviewProviderConfig({ MOONSHOT_API_BASE_URL: "not a valid URL" }).endpointHostname,
    null
  );
});

test("OpenRouter keeps provider-reported USD even when its model is kimi-k3", () => {
  const enriched = enrichWritingReviewUsage(
    "openrouter", "kimi-k3", usage(10, 0, 2, { cost: 0.0123 }), null
  );
  assert.equal(enriched.usage.cost, 0.0123);
  assert.equal(enriched.cost.amount, 0.0123);
  assert.equal(enriched.cost.currency, "USD");
  assert.equal(enriched.cost.source, "provider_reported");
});

test("observed totals sum only compatible currencies and preserve completeness", () => {
  const cny = moonshotKimiK3Cost(usage(10, 0, 2));
  const combined = observedWritingReviewCost(
    [cny, cny], "complete_for_observed_requests"
  );
  assert.equal(combined.amount, 0.0008);
  assert.equal(combined.currency, "CNY");
  assert.equal(combined.billing_completeness, "complete_for_observed_requests");
  assert.equal(
    observedWritingReviewCost(
      [cny, { ...cny, amount: 0.1, currency: "USD" }],
      "complete_for_observed_requests"
    ),
    null
  );
  const usd = {
    amount: 0.0000000001,
    currency: "USD",
    source: "provider_reported",
    estimate_kind: null
  };
  assert.equal(
    observedWritingReviewCost(
      [usd, usd],
      "complete_for_observed_requests"
    ).amount,
    0.0000000002
  );
});

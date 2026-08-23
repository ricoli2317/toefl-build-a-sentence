import test from "node:test";
import assert from "node:assert/strict";
import {
  formatWritingReviewCost,
  writingReviewBillingWarning,
  writingReviewCostSourceLabel,
  writingReviewEstimateKindLabel
} from "../lib/writingReviewCostPresentation.ts";

test("cost presentation distinguishes CNY, USD, unknown, and missing", () => {
  assert.equal(formatWritingReviewCost(0.1, "CNY"), "¥0.100000");
  assert.equal(formatWritingReviewCost(0.1, "USD"), "$0.100000");
  assert.equal(formatWritingReviewCost(0.1, null), "0.100000（币种未知）");
  assert.equal(formatWritingReviewCost(null, "USD"), "—");
});

test("cost descriptions explain local estimates and cache upper bounds", () => {
  assert.equal(writingReviewCostSourceLabel("local_usage_estimate"), "本地 usage 估算");
  assert.equal(
    writingReviewEstimateKindLabel("upper_bound_no_cache_detail"),
    "无缓存明细的保守上限"
  );
});

test("partial billing has an explicit non-zero-cost warning", () => {
  assert.match(writingReviewBillingWarning("partial_or_unknown"), /仍可能产生上游账单/);
  assert.equal(writingReviewBillingWarning("complete_for_observed_requests"), null);
});

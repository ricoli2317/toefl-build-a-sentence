import test from "node:test";
import assert from "node:assert/strict";
import { projectWritingReviewAiLog } from "../lib/writingReviewAiLogProjection.ts";

function row(overrides = {}) {
  return {
    id: "log-1", attempt_id: "attempt-1", cost: 0.1,
    primary_cost: 0.1, hedge_cost: null, winner_cost: 0.1,
    observed_completed_cost: 0.1,
    diagnostics: {
      cost_observability: {
        amount: 0.1, currency: "CNY", source: "local_usage_estimate",
        estimate_kind: "usage_based_estimate", pricing_version: "v1",
        endpoint_hostname: "api.moonshot.cn"
      },
      primary_cost_observability: {
        amount: 0.1, currency: "CNY", source: "local_usage_estimate"
      },
      billing_completeness: "complete_for_observed_requests",
      language_edit_overlap: { group_count: 1 },
      provider_response: "must not leave the server",
      arbitrary_secret: "must not leave the server"
    },
    ...overrides
  };
}

test("list projection exposes cost whitelist without diagnostics", () => {
  const projected = projectWritingReviewAiLog(row());
  assert.equal(projected.cost_currency, "CNY");
  assert.equal(projected.primary_cost_observability.currency, "CNY");
  assert.equal(projected.billing_completeness, "complete_for_observed_requests");
  assert.equal("diagnostics" in projected, false);
  assert.equal(JSON.stringify(projected).includes("must not leave"), false);
});

test("detail projection includes only bounded overlap diagnostics", () => {
  const projected = projectWritingReviewAiLog(row(), { includeDiagnostics: true });
  assert.deepEqual(projected.diagnostics, {
    language_edit_overlap: { group_count: 1 }
  });
  assert.equal(JSON.stringify(projected).includes("arbitrary_secret"), false);
});

test("historical numeric costs are explicit legacy USD fallbacks", () => {
  const projected = projectWritingReviewAiLog(
    row({ diagnostics: {}, cost: 0.25, primary_cost: 0.25 })
  );
  assert.equal(projected.cost_currency, "USD");
  assert.equal(projected.cost_source, "legacy_provider_reported");
  assert.equal(projected.primary_cost_observability.currency, "USD");
});

test("malformed supplied metadata is not guessed as USD", () => {
  const projected = projectWritingReviewAiLog(row({
    diagnostics: { cost_observability: { amount: 0.1, currency: "XYZ" } }
  }));
  assert.equal(projected.cost_currency, null);
  assert.equal(projected.cost_source, null);
});

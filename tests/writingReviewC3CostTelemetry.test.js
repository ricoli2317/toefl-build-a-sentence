import test from "node:test";
import assert from "node:assert/strict";
import {
  writingReviewC3FailureTelemetryDiagnostic,
  writingReviewC3TelemetryDiagnostic
} from "../lib/writingReviewC3Production.ts";

function cost(amount, currency = "CNY") {
  return {
    amount,
    currency,
    source: currency === "CNY" ? "local_usage_estimate" : "provider_reported",
    estimate_kind: currency === "CNY" ? "usage_based_estimate" : null
  };
}

function response(amount, currency = "CNY") {
  return {
    content: "{}",
    model: "kimi-k3",
    generationId: `generation-${amount}`,
    usage: {
      prompt_tokens: 1, cached_tokens: 0, completion_tokens: 1,
      reasoning_tokens: 0, accepted_prediction_tokens: null,
      rejected_prediction_tokens: null, total_tokens: 2, cost: amount,
      upstream_inference_cost: null,
      upstream_inference_prompt_cost: null,
      upstream_inference_completions_cost: null
    },
    costObservability: cost(amount, currency)
  };
}

function outcome(result, amount = null, currency = "CNY") {
  return {
    result,
    response: amount === null ? null : response(amount, currency),
    review: result === "success" ? {} : null,
    error: result === "success" ? null : new Error(result)
  };
}

function branch(request, result, branchOutcome) {
  return {
    request,
    started_at_ms: request === "primary" ? 0 : 60,
    finished_at_ms: 80,
    elapsed_ms: request === "primary" ? 80 : 20,
    result,
    outcome: branchOutcome
  };
}

function run(overrides = {}) {
  const primaryOutcome = outcome("success", 0.1);
  return {
    hedge_triggered: false,
    requests_started: 1,
    winner: "primary",
    winner_outcome: primaryOutcome,
    final_outcome: primaryOutcome,
    timed_out: false,
    end_to_end_elapsed_ms: 80,
    primary: branch("primary", "success", primaryOutcome),
    hedge: null,
    loser_status: null,
    ...overrides
  };
}

test("one successful primary is a complete observable bill", () => {
  const telemetry = writingReviewC3TelemetryDiagnostic(run(), 120_000);
  assert.equal(telemetry.hedge_delay_ms, 90_000);
  assert.equal(telemetry.primary_cost, 0.1);
  assert.equal(telemetry.winner_cost, 0.1);
  assert.equal(telemetry.observed_completed_cost, 0.1);
  assert.equal(telemetry.hedge_cost, null);
  assert.equal(telemetry.billing_completeness, "complete_for_observed_requests");
  assert.equal(telemetry.winner_cost_observability.currency, "CNY");
});

test("two completed branches are summed and preserve the actual winner", () => {
  const primaryOutcome = outcome("semantic_schema_error", 0.1);
  const hedgeOutcome = outcome("success", 0.2);
  const telemetry = writingReviewC3TelemetryDiagnostic(run({
    hedge_triggered: true, requests_started: 2, winner: "hedge",
    winner_outcome: hedgeOutcome, final_outcome: hedgeOutcome,
    primary: branch("primary", "semantic_schema_error", primaryOutcome),
    hedge: branch("hedge", "success", hedgeOutcome),
    loser_status: "terminal_failure"
  }), 120_000);
  assert.equal(telemetry.primary_cost, 0.1);
  assert.equal(telemetry.hedge_cost, 0.2);
  assert.equal(telemetry.winner_cost, 0.2);
  assert.equal(telemetry.observed_completed_cost, 0.3);
  assert.equal(telemetry.billing_completeness, "complete_for_observed_requests");
});

test("an aborted loser without usage is unknown rather than free", () => {
  const primaryOutcome = outcome("success", 0.1);
  const telemetry = writingReviewC3TelemetryDiagnostic(run({
    hedge_triggered: true, requests_started: 2,
    primary: branch("primary", "success", primaryOutcome),
    hedge: branch("hedge", "aborted_due_to_winner", null),
    loser_status: "aborted_due_to_winner"
  }), 120_000);
  assert.equal(telemetry.hedge_cost, null);
  assert.equal(telemetry.observed_completed_cost, 0.1);
  assert.equal(telemetry.billing_completeness, "partial_or_unknown");
  assert.equal(telemetry.observed_cost_observability.billing_completeness, "partial_or_unknown");
});

test("post-response validation failures retain their observed request cost", () => {
  const failed = outcome("assembly_error", 0.13);
  const failedRun = run({
    winner: null, winner_outcome: null, final_outcome: failed,
    primary: branch("primary", "assembly_error", failed)
  });
  const telemetry = writingReviewC3TelemetryDiagnostic(failedRun, 120_000);
  assert.equal(telemetry.winner_cost, null);
  assert.equal(telemetry.primary_cost, 0.13);
  assert.equal(telemetry.final_usage.cost, 0.13);
  assert.equal(telemetry.billing_completeness, "complete_for_observed_requests");
  const failureTelemetry = writingReviewC3FailureTelemetryDiagnostic({
    run: failedRun, c3Timing: { deadlineMs: 210_000, hedgeDelayMs: 90_000 }
  });
  assert.equal(failureTelemetry.hedge_delay_ms, 90_000);
  assert.equal(failureTelemetry.deadline_ms, 210_000);
  assert.equal(failureTelemetry.primary_cost, 0.13);
  assert.equal(failureTelemetry.final_cost_observability.amount, 0.13);
});

test("transport failures without usage remain partial and do not invent cost", () => {
  const failed = outcome("provider_error");
  const telemetry = writingReviewC3TelemetryDiagnostic(run({
    winner: null, winner_outcome: null, final_outcome: failed,
    primary: branch("primary", "provider_error", failed)
  }), 120_000);
  assert.equal(telemetry.primary_cost, null);
  assert.equal(telemetry.observed_completed_cost, null);
  assert.equal(telemetry.billing_completeness, "partial_or_unknown");
});

test("different branch currencies are never added", () => {
  const primaryOutcome = outcome("semantic_schema_error", 0.1, "CNY");
  const hedgeOutcome = outcome("success", 0.2, "USD");
  const telemetry = writingReviewC3TelemetryDiagnostic(run({
    hedge_triggered: true, requests_started: 2, winner: "hedge",
    winner_outcome: hedgeOutcome, final_outcome: hedgeOutcome,
    primary: branch("primary", "semantic_schema_error", primaryOutcome),
    hedge: branch("hedge", "success", hedgeOutcome),
    loser_status: "terminal_failure"
  }), 120_000);
  assert.equal(telemetry.primary_cost, 0.1);
  assert.equal(telemetry.hedge_cost, 0.2);
  assert.equal(telemetry.observed_completed_cost, null);
});

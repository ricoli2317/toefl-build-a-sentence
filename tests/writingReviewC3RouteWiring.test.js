import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = process.cwd();
const read = (path) => readFileSync(`${root}/${path}`, "utf8");
const fullRoutes = [
  "app/api/teacher/writing/reviews/[attemptId]/generate-ai/route.ts",
  "app/api/teacher/writing/reviews/[attemptId]/regenerate-ai/route.ts"
];

test("full-review routes keep C3 localization and legacy parsing isolated", () => {
  for (const path of fullRoutes) {
    const source = read(path);
    assert.match(source, /getWritingReviewPipeline\(\)/);
    assert.match(source, /pipeline === "c3"/);
    assert.match(source, /requestProductionC3WritingReview\(input, providerConfig\)/);
    assert.match(source, /c3AssembledReview = c3\.review/);
    assert.match(source, /aiPipeline === "c3" && c3AssembledReview/);
    assert.match(source, /export const maxDuration = 240/);
    assert.match(source, /writingReviewC3TelemetryDiagnostic/);
    assert.match(source, /writingReviewLogMetadata\(aiPipeline\)/);
    assert.match(source, /pipeline: logMetadata\.pipeline/);
    assert.match(source, /billing_completeness/);
    assert.match(source, /primary_cost_observability/);
    assert.match(source, /winner_cost_observability/);
    assert.match(source, /writingReviewC3FailureTelemetryDiagnostic/);
    assert.doesNotMatch(source, /primary_cost:\s*null/);
    assert.doesNotMatch(source, /observed_completed_cost:\s*null/);
  }
});

test("single-feedback route retains legacy selection and uses C3 anchored contract only when selected", () => {
  const route = read("app/api/teacher/writing/reviews/[attemptId]/feedback/[feedbackId]/regenerate/route.ts");
  const service = read("lib/writingReviewFeedbackRegeneration.ts");
  assert.match(route, /pipeline: \(aiPipeline = getWritingReviewPipeline\(\)\)/);
  assert.match(route, /pipeline: aiPipeline/);
  assert.match(service, /buildWritingFeedbackRegenerationC3Messages/);
  assert.match(service, /dependencies\.pipeline === "c3"/);
  assert.match(service, /suggestion: regenerated\.suggestion/);
  assert.match(service, /proposed_revision: regenerated\.proposed_revision/);
});

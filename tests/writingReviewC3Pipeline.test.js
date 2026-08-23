import test from "node:test";
import assert from "node:assert/strict";
import {
  getWritingReviewPipeline,
  WRITING_REVIEW_DEFAULT_PIPELINE,
  writingReviewPipelineTiming
} from "../lib/writingReviewPipeline.ts";

test("C3 is the default while legacy remains an explicit rollback with independent deadlines", () => {
  assert.equal(WRITING_REVIEW_DEFAULT_PIPELINE, "c3");
  assert.equal(getWritingReviewPipeline({}), "c3");
  assert.equal(getWritingReviewPipeline({ WRITING_REVIEW_PIPELINE: "c3" }), "c3");
  assert.equal(getWritingReviewPipeline({ WRITING_REVIEW_PIPELINE: "legacy_v22" }), "legacy_v22");
  assert.deepEqual(writingReviewPipelineTiming("legacy_v22", {}), { hedgeDelayMs: 60_000, deadlineMs: 240_000 });
  assert.deepEqual(writingReviewPipelineTiming("c3", {}), { hedgeDelayMs: 60_000, deadlineMs: 180_000 });
  assert.deepEqual(writingReviewPipelineTiming("c3", { WRITING_REVIEW_C3_DEADLINE_MS: "180000" }), { hedgeDelayMs: 60_000, deadlineMs: 180_000 });
});

test("invalid pipeline and invalid C3 deadline cannot silently change behavior", () => {
  assert.throws(() => getWritingReviewPipeline({ WRITING_REVIEW_PIPELINE: "automatic" }), (error) => error.code === "WRITING_REVIEW_PIPELINE_INVALID");
  assert.deepEqual(writingReviewPipelineTiming("c3", { WRITING_REVIEW_C3_DEADLINE_MS: "60000" }), { hedgeDelayMs: 60_000, deadlineMs: 180_000 });
  assert.deepEqual(writingReviewPipelineTiming("c3", { WRITING_REVIEW_C3_DEADLINE_MS: "120000" }), { hedgeDelayMs: 60_000, deadlineMs: 180_000 });
});

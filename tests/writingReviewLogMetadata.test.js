import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { writingReviewLogMetadata } from "../lib/writingReviewLogMetadata.ts";
import { WRITING_REVIEW_C3_PROMPT_VERSION } from "../lib/writingReviewSemanticPrompt.ts";
import { WRITING_REVIEW_C3_SCHEMA_VERSION } from "../lib/writingReviewSemanticSchema.ts";
import { WRITING_REVIEW_PROMPT_VERSION } from "../lib/openrouterWritingReview.ts";
import { AI_REVIEW_SCHEMA_VERSION_V22 } from "../lib/writingReviewSchemaV22.ts";

test("complete-review log metadata selects C3 versions and a full hedge request window", () => {
  assert.deepEqual(writingReviewLogMetadata("c3", {}), {
    pipeline: "c3", promptVersion: WRITING_REVIEW_C3_PROMPT_VERSION,
    schemaVersion: WRITING_REVIEW_C3_SCHEMA_VERSION, hedgeDelayMs: 60_000, deadlineMs: 180_000
  });
});

test("complete-review log metadata preserves legacy v2.2 versions and 60s/240s timing", () => {
  assert.deepEqual(writingReviewLogMetadata("legacy_v22", {}), {
    pipeline: "legacy_v22", promptVersion: WRITING_REVIEW_PROMPT_VERSION,
    schemaVersion: AI_REVIEW_SCHEMA_VERSION_V22, hedgeDelayMs: 60_000, deadlineMs: 240_000
  });
});

test("both complete-review routes share the log metadata helper", () => {
  for (const route of [
    "app/api/teacher/writing/reviews/[attemptId]/generate-ai/route.ts",
    "app/api/teacher/writing/reviews/[attemptId]/regenerate-ai/route.ts"
  ]) {
    const source = readFileSync(`${process.cwd()}/${route}`, "utf8");
    assert.match(source, /writingReviewLogMetadata\(aiPipeline\)/);
    assert.match(source, /hedge_delay_ms: logMetadata\.hedgeDelayMs/);
    assert.match(source, /deadline_ms: logMetadata\.deadlineMs/);
  }
});

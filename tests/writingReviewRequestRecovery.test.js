const test = require("node:test");
const assert = require("node:assert/strict");
const {
  recoverWritingReviewAfterUnknownOutcome
} = require("../lib/writingReviewRequestRecovery.ts");
const {
  buildManualWritingReviewDraft,
  buildWritingReviewPublishUpdate
} = require("../lib/writingReviewWorkspace.ts");

function draft() {
  const value = buildManualWritingReviewDraft("email");
  value.scores.official_score.teacher_score = 4;
  value.content_feedback.overall_feedback = "Ready to publish.";
  return value;
}

function review(overrides = {}) {
  return {
    review_id: "review-1",
    status: "reviewing",
    has_ai_review: true,
    ...structuredClone(draft()),
    published_language_edits: null,
    published_scores: null,
    published_content_feedback: null,
    published_teacher_comment: null,
    ...overrides
  };
}

test("unknown Publish outcome recovers when GET confirms the published snapshot", async () => {
  const submitted = draft();
  const published = buildWritingReviewPublishUpdate(
    submitted,
    "2026-08-18T08:00:00.000Z"
  );
  const recovered = await recoverWritingReviewAfterUnknownOutcome(
    "publish",
    submitted,
    async () => review(published)
  );
  assert.equal(recovered.status, "published");
});

test("unknown Publish outcome remains failed when GET still shows reviewing", async () => {
  const recovered = await recoverWritingReviewAfterUnknownOutcome(
    "publish",
    draft(),
    async () => review()
  );
  assert.equal(recovered, null);
});

test("unknown Save outcome recovers only when GET matches the submitted draft", async () => {
  const submitted = draft();
  assert.equal(
    await recoverWritingReviewAfterUnknownOutcome(
      "save",
      submitted,
      async () => review()
    ) instanceof Object,
    true
  );
  const different = review();
  different.content_feedback.overall_feedback = "Old value.";
  assert.equal(
    await recoverWritingReviewAfterUnknownOutcome(
      "save",
      submitted,
      async () => different
    ),
    null
  );
});

test("unknown initial generation outcome recovers only for a usable AI review", async () => {
  assert.equal(
    await recoverWritingReviewAfterUnknownOutcome(
      "generate",
      null,
      async () => review()
    ) instanceof Object,
    true
  );
  assert.equal(
    await recoverWritingReviewAfterUnknownOutcome(
      "generate",
      null,
      async () => review({ has_ai_review: false })
    ),
    null
  );
});

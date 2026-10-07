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

test("unknown Save / Publish outcomes also verify a hand-edited sample essay", async () => {
  const submitted = draft();

  // Save carried V2 and the reloaded row already holds V2.
  assert.equal(
    await recoverWritingReviewAfterUnknownOutcome(
      "save",
      submitted,
      async () => review({ sample_essay_draft: "V2 essay" }),
      "V2 essay"
    ) instanceof Object,
    true
  );
  // The row still holds V1 → the Save did not persist the textarea value.
  assert.equal(
    await recoverWritingReviewAfterUnknownOutcome(
      "save",
      submitted,
      async () => review({ sample_essay_draft: "V1 essay" }),
      "V2 essay"
    ),
    null
  );
  // Blank text is compared as "no draft", exactly like the server stores it.
  assert.equal(
    await recoverWritingReviewAfterUnknownOutcome(
      "save",
      submitted,
      async () => review({ sample_essay_draft: null }),
      "   "
    ) instanceof Object,
    true
  );

  const publishedV2 = review({
    ...buildWritingReviewPublishUpdate(
      submitted,
      "2026-08-18T08:00:00.000Z",
      "V2 essay"
    ),
    sample_essay_draft: "V2 essay"
  });
  assert.equal(
    await recoverWritingReviewAfterUnknownOutcome(
      "publish",
      submitted,
      async () => publishedV2,
      "V2 essay"
    ) instanceof Object,
    true
  );

  // Status published but the student would still see V1: not a recovery.
  const stalePublished = review({
    ...buildWritingReviewPublishUpdate(
      submitted,
      "2026-08-18T08:00:00.000Z",
      "V1 essay"
    ),
    sample_essay_draft: "V1 essay"
  });
  assert.equal(
    await recoverWritingReviewAfterUnknownOutcome(
      "publish",
      submitted,
      async () => stalePublished,
      "V2 essay"
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

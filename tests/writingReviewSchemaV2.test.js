const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ACADEMIC_DISCUSSION_DIMENSION_SCORE_KEYS,
  AI_REVIEW_RAW_RESULT_V2_JSON_SCHEMA,
  EMAIL_DIMENSION_SCORE_KEYS,
  parseAIReviewRawResultV2ForResponse,
  validateAIReviewRawResultV2
} = require("../lib/writingReviewSchemaV2.ts");
const {
  generateAndSaveWritingReview
} = require("../lib/writingReviewGeneration.ts");

const emailResponse =
  "I am write to request more time. This deadline would help me finish carefully.";
const discussionResponse =
  "Cities should invest in transit. Better buses can reduce traffic for everyone.";

function rawLanguageEdit() {
  return {
    edit_id: "edit-1",
    original_text: "am write",
    replacement_text: "am writing",
    category: "grammar",
    severity: "moderate",
    explanation: "Use the present progressive after am."
  };
}

function rawDimension(aiScore = 4, aiBasis = "The response shows this quality clearly.") {
  return { ai_score: aiScore, ai_basis: aiBasis };
}

function emailRawV2() {
  return {
    schema_version: "2.0",
    task_type: "email",
    language_edits: [rawLanguageEdit()],
    scores: {
      official_score: {
        ai_score: 4,
        rationale: "The message is generally successful and easy to understand."
      },
      dimension_scores: {
        communicative_purpose_and_elaboration: rawDimension(
          4,
          "The request and supporting reason are clear."
        ),
        syntactic_range_and_word_choice: rawDimension(
          3,
          "The language is adequate but has limited range."
        ),
        social_conventions: rawDimension(
          5,
          "The request uses a consistently appropriate tone."
        ),
        lexical_and_grammatical_control: rawDimension(
          3,
          "A noticeable verb-form error affects control."
        )
      }
    },
    content_feedback: [
      {
        feedback_id: "feedback-1",
        category: "elaboration",
        original_sentence: "This deadline would help me finish carefully.",
        issue: "The reason remains somewhat general.",
        suggestion: "Explain what work remains and why this deadline is realistic.",
        example: "This deadline would let me complete the research and revise carefully."
      }
    ],
    overall_feedback: "A clear and polite request with room for more specific development."
  };
}

function discussionRawV2() {
  return {
    schema_version: "2.0",
    task_type: "academic_discussion",
    language_edits: [],
    scores: {
      official_score: {
        ai_score: 4,
        rationale: "The contribution is relevant, developed, and generally well controlled."
      },
      dimension_scores: {
        relevance: rawDimension(5, "Both sentences directly address public transit."),
        elaboration: rawDimension(3, "The benefit is relevant but only briefly explained."),
        syntactic_range_and_word_choice: rawDimension(
          4,
          "The wording is appropriate and the sentences are clear."
        ),
        lexical_and_grammatical_control: rawDimension(
          4,
          "The response has few language errors."
        )
      }
    },
    content_feedback: [
      {
        feedback_id: "feedback-1",
        category: "elaboration",
        original_sentence: "Better buses can reduce traffic for everyone.",
        issue: "The claim needs a concrete mechanism or example.",
        suggestion: "Explain how better service would change commuter behavior.",
        example: "Frequent buses can persuade commuters to leave their cars at home."
      }
    ],
    overall_feedback: "A relevant contribution that would benefit from fuller evidence."
  };
}

function assertInvalid(review, pattern) {
  const validation = validateAIReviewRawResultV2(review);
  assert.equal(validation.success, false);
  assert.match(
    validation.issues.map((item) => `${item.path}: ${item.message}`).join("; "),
    pattern
  );
}

test("valid Email v2 has exactly the four Email dimensions", () => {
  const review = emailRawV2();
  assert.equal(validateAIReviewRawResultV2(review).success, true);
  assert.deepEqual(
    Object.keys(review.scores.dimension_scores),
    [...EMAIL_DIMENSION_SCORE_KEYS]
  );
  const result = parseAIReviewRawResultV2ForResponse(review, emailResponse);
  assert.equal(result.schema_version, "2.0");
  assert.equal(result.scores.official_score.teacher_score, 4);
});

test("valid Academic Discussion v2 keeps relevance and elaboration independent", () => {
  const review = discussionRawV2();
  review.content_feedback = [];
  assert.equal(validateAIReviewRawResultV2(review).success, true);
  assert.deepEqual(
    Object.keys(review.scores.dimension_scores),
    [...ACADEMIC_DISCUSSION_DIMENSION_SCORE_KEYS]
  );
  assert.equal(review.scores.dimension_scores.relevance.ai_score, 5);
  assert.equal(review.scores.dimension_scores.elaboration.ai_score, 3);
});

test("Email rejects Academic Discussion relevance dimension", () => {
  const review = emailRawV2();
  review.scores.dimension_scores.relevance = rawDimension();
  assertInvalid(review, /dimension_scores\.relevance: is not allowed/);
});

test("Academic Discussion rejects Email social_conventions dimension", () => {
  const review = discussionRawV2();
  review.scores.dimension_scores.social_conventions = rawDimension();
  assertInvalid(review, /dimension_scores\.social_conventions: is not allowed/);
});

test("official and dimension scores reject values above 5", () => {
  const officialInvalid = emailRawV2();
  officialInvalid.scores.official_score.ai_score = 6;
  assertInvalid(officialInvalid, /official_score\.ai_score/);

  const dimensionInvalid = emailRawV2();
  dimensionInvalid.scores.dimension_scores.social_conventions.ai_score = 6;
  assertInvalid(dimensionInvalid, /social_conventions\.ai_score/);
});

test("official score above 0 requires every dimension score from 1 through 5", () => {
  const review = emailRawV2();
  review.scores.dimension_scores.lexical_and_grammatical_control.ai_score = 0;
  assertInvalid(review, /must be from 1 through 5/);
});

test("official score 0 requires every dimension score to be 0", () => {
  const review = emailRawV2();
  review.scores.official_score.ai_score = 0;
  assertInvalid(review, /must be 0 when official_score/);

  for (const dimension of Object.values(review.scores.dimension_scores)) {
    dimension.ai_score = 0;
  }
  assert.equal(validateAIReviewRawResultV2(review).success, true);
});

test("Raw v2 strictly rejects teacher_score", () => {
  const review = emailRawV2();
  review.scores.official_score.teacher_score = 4;
  review.scores.dimension_scores.social_conventions.teacher_score = 5;
  assertInvalid(review, /teacher_score: is not allowed/);
});

test("raw conversion locates feedback sentence exactly and initializes work flags", () => {
  const raw = emailRawV2();
  const before = structuredClone(raw);
  const result = parseAIReviewRawResultV2ForResponse(raw, emailResponse);
  const sentence = raw.content_feedback[0].original_sentence;
  const expectedStart = emailResponse.indexOf(sentence);
  assert.equal(result.content_feedback[0].start, expectedStart);
  assert.equal(result.content_feedback[0].end, expectedStart + sentence.length);
  assert.equal(result.content_feedback[0].included, true);
  assert.equal(result.language_edits[0].restored, false);
  assert.deepEqual(raw, before, "conversion must not mutate ai_review_raw");
});

test("feedback sentence must exist exactly once", () => {
  const missing = emailRawV2();
  missing.content_feedback[0].original_sentence = "This sentence was never written.";
  assert.throws(
    () => parseAIReviewRawResultV2ForResponse(missing, emailResponse),
    /must occur exactly in response_text/
  );

  const repeated = emailRawV2();
  repeated.content_feedback[0].original_sentence = "Same sentence.";
  assert.throws(
    () =>
      parseAIReviewRawResultV2ForResponse(
        repeated,
        "Same sentence. Another thought. Same sentence."
      ),
    /must occur exactly once in response_text/
  );
});

test("content feedback category is task-specific", () => {
  const review = emailRawV2();
  review.content_feedback[0].category = "discussion_contribution";
  assertInvalid(review, /content_feedback\[0\]\.category/);
});

test("official score remains independent from dimension values", () => {
  const review = discussionRawV2();
  review.content_feedback = [];
  const result = parseAIReviewRawResultV2ForResponse(review, discussionResponse);
  assert.equal(result.scores.official_score.ai_score, 4);
  assert.deepEqual(
    Object.values(result.scores.dimension_scores).map((item) => item.ai_score),
    [5, 3, 4, 4]
  );
});

test("v2 JSON Schema uses strict task-specific raw branches", () => {
  assert.equal(AI_REVIEW_RAW_RESULT_V2_JSON_SCHEMA.oneOf.length, 2);
  for (const branch of AI_REVIEW_RAW_RESULT_V2_JSON_SCHEMA.oneOf) {
    assert.equal(branch.additionalProperties, false);
    assert.equal(branch.properties.schema_version.const, "2.0");
    assert.equal(
      branch.properties.scores.properties.official_score.properties.teacher_score,
      undefined
    );
    assert.equal(
      branch.properties.content_feedback.items.properties.start,
      undefined
    );
  }
});

test("v2 generation stores immutable raw and initialized teacher working data", async () => {
  const raw = emailRawV2();
  let inserted;
  const repository = {
    async findAttempt() {
      return {
        attempt_id: "attempt-v2",
        task_type: "email",
        question_id: "email-1",
        response_text: emailResponse,
        status: "submitted"
      };
    },
    async findExistingReview() { return null; },
    async findQuestion() { return { question_id: "email-1" }; },
    async insertReview(value) { inserted = value; return { review_id: "review-v2" }; }
  };
  await generateAndSaveWritingReview("attempt-v2", {
    repository,
    async requestAI() {
      return { content: JSON.stringify(raw), model: "moonshotai/kimi-k3" };
    },
    parseReview: parseAIReviewRawResultV2ForResponse,
    now: () => new Date("2026-08-13T12:00:00.000Z")
  });

  assert.deepEqual(inserted.ai_review_raw, raw);
  assert.equal("start" in inserted.ai_review_raw.language_edits[0], false);
  assert.equal("teacher_score" in inserted.ai_review_raw.scores.official_score, false);
  assert.equal(inserted.scores.official_score.teacher_score, 4);
  assert.equal(
    inserted.scores.dimension_scores.social_conventions.teacher_score,
    5
  );
  assert.equal(inserted.language_edits[0].restored, false);
  assert.equal(inserted.content_feedback.items[0].included, true);
});

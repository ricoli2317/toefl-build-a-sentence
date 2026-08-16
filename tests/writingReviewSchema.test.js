const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AI_REVIEW_RAW_RESULT_JSON_SCHEMA,
  AI_REVIEW_RESULT_JSON_SCHEMA,
  parseAIReviewRawResultForResponse,
  parseAIReviewResult,
  validateAIReviewRawResult,
  validateAIReviewResult,
  validateAIReviewResultForResponse
} = require("../lib/writingReviewSchema.ts");

const responseText = "I am write to request more time.";

function emailReview() {
  return {
    schema_version: "1.0",
    task_type: "email",
    language_edits: [
      {
        edit_id: "edit-1",
        start: 2,
        end: 10,
        original_text: "am write",
        replacement_text: "am writing",
        category: "grammar",
        severity: "moderate",
        explanation: "Use the present progressive after 'am'."
      }
    ],
    score: {
      rubric_score: 3,
      rationale: "The request is understandable but language errors reduce its effectiveness."
    },
    rubric_analysis: {
      communicative_purpose_and_elaboration: "The purpose is clear but minimally developed.",
      syntax_and_word_choice: "The response uses a limited but adequate range.",
      social_conventions: "The request is polite and appropriately direct.",
      lexical_and_grammatical_control: "A noticeable verb-form error affects fluency."
    },
    content_feedback: [
      {
        feedback_id: "feedback-1",
        category: "elaboration",
        issue: "The reason for the request is missing.",
        suggestion: "Briefly explain why more time is needed.",
        example: "I was ill for two days and could not finish the assignment."
      }
    ],
    overall_feedback: "A clear start that needs more detail and tighter language control."
  };
}

function discussionReview() {
  return {
    schema_version: "1.0",
    task_type: "academic_discussion",
    language_edits: [],
    score: {
      rubric_score: 5,
      rationale: "The contribution is relevant, well elaborated, and consistently clear."
    },
    rubric_analysis: {
      relevance_and_elaboration: "The position directly addresses and develops the discussion.",
      syntax_and_word_choice: "Varied structures and precise vocabulary express the ideas well.",
      lexical_and_grammatical_control: "The response has almost no language errors."
    },
    content_feedback: [
      {
        feedback_id: "feedback-1",
        category: "discussion_contribution",
        issue: "A counterpoint could make the contribution even richer.",
        suggestion: "Acknowledge one limitation before reinforcing the position.",
        example: "Although this approach costs more initially, its long-term benefits justify it."
      }
    ],
    overall_feedback: "A focused, convincing, and well-controlled contribution."
  };
}

function rawReview() {
  const review = emailReview();
  review.language_edits = review.language_edits.map(
    ({ start: _start, end: _end, ...edit }) => edit
  );
  return review;
}

function clone(value) {
  return structuredClone(value);
}

function assertInvalid(value, response = undefined) {
  const result =
    response === undefined
      ? validateAIReviewResult(value)
      : validateAIReviewResultForResponse(value, response);
  assert.equal(result.success, false);
  return result;
}

test("accepts a valid Email review and matching response offsets", () => {
  const result = validateAIReviewResultForResponse(emailReview(), responseText);
  assert.equal(result.success, true);
});

test("accepts a valid Academic Discussion review", () => {
  assert.equal(validateAIReviewResult(discussionReview()).success, true);
});

test("resolves one exact raw original_text occurrence into internal offsets", () => {
  const result = parseAIReviewRawResultForResponse(rawReview(), responseText);
  assert.equal(result.language_edits[0].start, 2);
  assert.equal(result.language_edits[0].end, 10);
  assert.equal(
    responseText.slice(result.language_edits[0].start, result.language_edits[0].end),
    result.language_edits[0].original_text
  );
});

test("rejects raw original_text that does not exist exactly", () => {
  const review = rawReview();
  review.language_edits[0].original_text = "Am write";
  assert.throws(
    () => parseAIReviewRawResultForResponse(review, responseText),
    /must occur exactly in response_text/
  );
});

test("rejects raw original_text that occurs more than once", () => {
  const review = rawReview();
  review.language_edits[0].original_text = "write";
  assert.throws(
    () => parseAIReviewRawResultForResponse(review, "write, then write again"),
    /must occur exactly once in response_text/
  );
});

test("strict raw validator rejects model-supplied start/end", () => {
  const review = rawReview();
  review.language_edits[0].start = 2;
  review.language_edits[0].end = 10;
  const validation = validateAIReviewRawResult(review);
  assert.equal(validation.success, false);
  assert.ok(
    validation.issues.some((issue) => issue.path === "$.language_edits[0].start")
  );
});

test("rejects rubric_score 6", () => {
  const review = emailReview();
  review.score.rubric_score = 6;
  assertInvalid(review);
});

test("rejects fractional rubric_score", () => {
  const review = emailReview();
  review.score.rubric_score = 3.5;
  assertInvalid(review);
});

test("rejects an unknown language edit category", () => {
  const review = emailReview();
  review.language_edits[0].category = "style";
  assertInvalid(review);
});

test("rejects an unknown language edit severity", () => {
  const review = emailReview();
  review.language_edits[0].severity = "critical";
  assertInvalid(review);
});

test("rejects a discussion-only feedback category for Email", () => {
  const review = emailReview();
  review.content_feedback[0].category = "discussion_contribution";
  assertInvalid(review);
});

test("rejects an Email-only feedback category for Academic Discussion", () => {
  const review = discussionReview();
  review.content_feedback[0].category = "social_conventions";
  assertInvalid(review);
});

test("rejects offsets whose original_text does not match response_text.slice", () => {
  const review = emailReview();
  review.language_edits[0].start = 3;
  assertInvalid(review, responseText);
});

test("rejects overlapping language edit offsets while allowing adjacent edits", () => {
  const overlapping = emailReview();
  overlapping.language_edits = [
    { ...overlapping.language_edits[0], edit_id: "edit-a", start: 2, end: 10 },
    {
      ...overlapping.language_edits[0],
      edit_id: "edit-b",
      start: 5,
      end: 10,
      original_text: responseText.slice(5, 10)
    }
  ];
  const invalid = assertInvalid(overlapping, responseText);
  assert.ok(invalid.issues.some((issue) => /overlap/.test(issue.message)));

  const adjacentText = "bad text";
  const adjacent = emailReview();
  adjacent.language_edits = [
    {
      ...adjacent.language_edits[0],
      edit_id: "edit-a",
      start: 0,
      end: 3,
      original_text: "bad"
    },
    {
      ...adjacent.language_edits[0],
      edit_id: "edit-b",
      start: 3,
      end: 4,
      original_text: " ",
      replacement_text: " "
    }
  ];
  assert.equal(validateAIReviewResultForResponse(adjacent, adjacentText).success, true);
});

test("rejects a missing required field", () => {
  const review = emailReview();
  delete review.overall_feedback;
  assertInvalid(review);
});

test("rejects task_type and rubric_analysis shape mismatch", () => {
  const review = emailReview();
  review.rubric_analysis = clone(discussionReview().rubric_analysis);
  assertInvalid(review);
});

test("rejects unknown fields at every strict object level", () => {
  const review = emailReview();
  review.score.grammar_score = 4;
  const result = assertInvalid(review);
  assert.ok(result.issues.some((issue) => issue.path === "$.score.grammar_score"));
});

test("rejects duplicate edit and feedback IDs", () => {
  const review = emailReview();
  review.language_edits.push(clone(review.language_edits[0]));
  review.content_feedback.push(clone(review.content_feedback[0]));
  assertInvalid(review);
});

test("throwing parser returns typed data or AIReviewValidationError", () => {
  assert.equal(parseAIReviewResult(emailReview()).task_type, "email");
  assert.throws(() => parseAIReviewResult({}), { name: "AIReviewValidationError" });
});

test("exports strict task-specific JSON Schema branches", () => {
  assert.equal(AI_REVIEW_RESULT_JSON_SCHEMA.oneOf.length, 2);
  for (const branch of AI_REVIEW_RESULT_JSON_SCHEMA.oneOf) {
    assert.equal(branch.additionalProperties, false);
    assert.equal(branch.properties.rubric_analysis.additionalProperties, false);
    assert.equal(branch.properties.content_feedback.items.additionalProperties, false);
  }
  assert.deepEqual(
    AI_REVIEW_RESULT_JSON_SCHEMA.oneOf[0].properties.content_feedback.items.properties
      .category.enum,
    [
      "communicative_purpose",
      "elaboration",
      "organization",
      "social_conventions",
      "logic",
      "other"
    ]
  );
});

test("exports a strict raw JSON Schema without model-supplied offsets", () => {
  assert.equal(AI_REVIEW_RAW_RESULT_JSON_SCHEMA.oneOf.length, 2);
  for (const branch of AI_REVIEW_RAW_RESULT_JSON_SCHEMA.oneOf) {
    const editSchema = branch.properties.language_edits.items;
    assert.equal(editSchema.additionalProperties, false);
    assert.equal(editSchema.required.includes("start"), false);
    assert.equal(editSchema.required.includes("end"), false);
    assert.equal("start" in editSchema.properties, false);
    assert.equal("end" in editSchema.properties, false);
  }
});

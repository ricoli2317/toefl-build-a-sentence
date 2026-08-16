const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AI_REVIEW_RAW_RESULT_V21_JSON_SCHEMA,
  parseAIReviewRawResultV21ForResponse,
  validateAIReviewRawResultV21
} = require("../lib/writingReviewSchemaV21.ts");
const { buildWritingReviewMessages } = require("../lib/openrouterWritingReview.ts");

const responseText = "I am write today. It gave me a directional goal.";

function dimension(ai_score = 4) {
  return { ai_score, ai_basis: "具体中文依据。" };
}

function raw(overrides = {}) {
  return {
    schema_version: "2.1",
    task_type: "email",
    language_edits: [
      {
        edit_id: "e1",
        original_text: "am write",
        replacement_text: "am writing",
        category: "grammar",
        severity: "moderate",
        explanation: "现在进行时需要 -ing 形式。"
      }
    ],
    scores: {
      official_score: { ai_score: 4, rationale: "整体完成度较好。" },
      dimension_scores: {
        communicative_purpose_and_elaboration: dimension(),
        syntactic_range_and_word_choice: dimension(3),
        social_conventions: dimension(),
        lexical_and_grammatical_control: dimension(3)
      }
    },
    content_feedback: [
      {
        feedback_id: "f1",
        category: "language_improvement",
        original_sentence: "It gave me a directional goal.",
        issue: "搭配不自然。",
        suggestion: "使用更准确自然的表达。",
        example: "It gave me a clearer career direction.",
        proposed_revision: "It gave me a clearer sense of my career direction."
      }
    ],
    overall_feedback: "内容清楚，但用词准确性仍可提升。",
    ...overrides
  };
}

test("valid v2.1 locates Email content revision and initializes server fields", () => {
  const result = parseAIReviewRawResultV21ForResponse(raw(), responseText);
  assert.equal(result.schema_version, "2.1");
  assert.equal(result.content_feedback[0].included, true);
  assert.equal(result.content_feedback[0].start, responseText.indexOf("It gave"));
  assert.equal(result.scores.official_score.teacher_score, 4);
  assert.equal(result.content_feedback[0].proposed_revision, "It gave me a clearer sense of my career direction.");
});

test("valid v2.1 Academic Discussion uses its four dimensions", () => {
  const value = raw({
    task_type: "academic_discussion",
    scores: {
      official_score: { ai_score: 4, rationale: "整体回应清楚。" },
      dimension_scores: {
        relevance: dimension(5),
        elaboration: dimension(3),
        syntactic_range_and_word_choice: dimension(4),
        lexical_and_grammatical_control: dimension(4)
      }
    },
    content_feedback: [
      {
        ...raw().content_feedback[0],
        category: "elaboration"
      }
    ]
  });
  assert.equal(validateAIReviewRawResultV21(value).success, true);
});

test("v2.1 requires non-empty proposed_revision and rejects internal fields", () => {
  const missing = raw();
  delete missing.content_feedback[0].proposed_revision;
  assert.equal(validateAIReviewRawResultV21(missing).success, false);
  const empty = raw();
  empty.content_feedback[0].proposed_revision = "";
  assert.equal(validateAIReviewRawResultV21(empty).success, false);
  const internal = raw();
  internal.content_feedback[0].included = true;
  internal.content_feedback[0].start = 0;
  internal.content_feedback[0].end = 1;
  assert.equal(validateAIReviewRawResultV21(internal).success, false);
});

test("v2.1 rejects overlapping content revisions and permits adjacent revisions", () => {
  const overlapping = raw();
  overlapping.content_feedback.push({
    ...overlapping.content_feedback[0],
    feedback_id: "f2"
  });
  assert.throws(
    () => parseAIReviewRawResultV21ForResponse(overlapping, responseText),
    /must not overlap/
  );

  const adjacentText = "First sentence.Second sentence.";
  const adjacent = raw({
    language_edits: [],
    content_feedback: [
      {
        ...raw().content_feedback[0],
        feedback_id: "f1",
        original_sentence: "First sentence.",
        proposed_revision: "First revised sentence."
      },
      {
        ...raw().content_feedback[0],
        feedback_id: "f2",
        original_sentence: "Second sentence.",
        proposed_revision: "Second revised sentence."
      }
    ]
  });
  assert.doesNotThrow(() => parseAIReviewRawResultV21ForResponse(adjacent, adjacentText));
});

test("v2.1 JSON Schema is strict and adds only raw proposed_revision", () => {
  for (const branch of AI_REVIEW_RAW_RESULT_V21_JSON_SCHEMA.oneOf) {
    assert.equal(branch.properties.schema_version.const, "2.1");
    const feedback = branch.properties.content_feedback.items;
    assert.equal(feedback.required.includes("proposed_revision"), true);
    assert.equal(feedback.properties.proposed_revision.minLength, 1);
    assert.equal(feedback.properties.included, undefined);
  }
});

test("current prompt keeps v2.1-era responsibility and rubric boundaries", () => {
  const prompt = buildWritingReviewMessages({
    taskType: "email",
    question: {},
    responseText
  })[0].content;
  assert.match(prompt, /smallest uniquely localizable contiguous source span/);
  assert.match(prompt, /poor collocation/);
  assert.match(prompt, /Do not stylistically polish/);
  assert.match(prompt, /insufficient why\/how.*elaboration weakness/);
  assert.match(prompt, /proposed_revision must contain only the final directly applicable English revision/);

  const adPrompt = buildWritingReviewMessages({
    taskType: "academic_discussion",
    question: {},
    responseText
  })[0].content;
  assert.match(adPrompt, /Do not lower relevance merely because evidence is weak or mismatched/);
  assert.match(adPrompt, /Missing links, weak evidence, claim\/example mismatch.*belong here/);
});

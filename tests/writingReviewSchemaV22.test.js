const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA,
  parseAIReviewRawResultV22ForResponse,
  validateAIReviewRawResultV22
} = require("../lib/writingReviewSchemaV22.ts");
const { buildWritingReviewMessages } = require("../lib/openrouterWritingReview.ts");

const responseText = "I am write today. It gave me a directional goal.";

function dimension(ai_score = 4) {
  return { ai_score, ai_basis: "表达基本清楚，但搭配准确性仍需提升。" };
}

function raw(overrides = {}) {
  return {
    schema_version: "2.2",
    task_type: "email",
    language_edits: [{
      edit_id: "e1",
      original_text: "am write",
      replacement_text: "am writing",
      category: "grammar",
      severity: "moderate",
      explanation: "现在进行时需使用 -ing 形式。"
    }],
    scores: {
      official_score: { ai_score: 4, rationale: "任务完成较好，表达整体清楚。个别搭配影响准确性。" },
      dimension_scores: {
        communicative_purpose_and_elaboration: dimension(),
        syntactic_range_and_word_choice: dimension(3),
        social_conventions: dimension(),
        lexical_and_grammatical_control: dimension(3)
      }
    },
    content_feedback: [{
      feedback_id: "f1",
      category: "language_improvement",
      original_sentence: "It gave me a directional goal.",
      issue: "搭配不自然。",
      suggestion: "使用更准确自然的职业目标表达。",
      proposed_revision: "It gave me a clearer sense of my career direction."
    }],
    overall_feedback: "任务回应清楚。应重点提高搭配准确性。",
    ...overrides
  };
}

test("valid v2.2 Email locates feedback without example", () => {
  const result = parseAIReviewRawResultV22ForResponse(raw(), responseText);
  assert.equal(result.schema_version, "2.2");
  assert.equal(result.content_feedback[0].included, true);
  assert.equal("example" in result.content_feedback[0], false);
  assert.equal(result.content_feedback[0].start, responseText.indexOf("It gave"));
});

test("valid v2.2 Academic Discussion uses its four dimensions", () => {
  const value = raw({
    task_type: "academic_discussion",
    scores: {
      official_score: { ai_score: 4, rationale: "观点相关且清楚。展开仍可更具体。" },
      dimension_scores: {
        relevance: dimension(5),
        elaboration: dimension(3),
        syntactic_range_and_word_choice: dimension(4),
        lexical_and_grammatical_control: dimension(4)
      }
    },
    content_feedback: [{ ...raw().content_feedback[0], category: "elaboration" }]
  });
  assert.equal(validateAIReviewRawResultV22(value).success, true);
});

test("v2.2 strict raw result rejects legacy example", () => {
  const value = raw();
  value.content_feedback[0].example = "Legacy duplicate.";
  const validation = validateAIReviewRawResultV22(value);
  assert.equal(validation.success, false);
  assert.match(JSON.stringify(validation), /example.*not allowed/);
});

test("v2.2 JSON Schema removes example without adding item limits", () => {
  for (const branch of AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA.oneOf) {
    assert.equal(branch.properties.schema_version.const, "2.2");
    const feedback = branch.properties.content_feedback;
    assert.equal(feedback.items.required.includes("example"), false);
    assert.equal(feedback.items.properties.example, undefined);
    assert.equal(feedback.maxItems, undefined);
    assert.equal(branch.properties.language_edits.maxItems, undefined);
  }
});

test("v2.2 prompt preserves audits and requires concise but exhaustive output", () => {
  const prompt = buildWritingReviewMessages({
    taskType: "email",
    question: {},
    responseText
  })[0].content;
  assert.match(prompt, /WORD CHOICE & COLLOCATION AUDIT/);
  assert.match(prompt, /introduction papers/);
  assert.match(prompt, /Set schema_version to "2\.2"/);
  assert.match(prompt, /exactly one concise Simplified Chinese sentence/);
  assert.match(prompt, /2–3 concise Simplified Chinese sentences/);
  assert.match(prompt, /ai_basis in 1–2 concise Simplified Chinese sentences/);
  assert.match(prompt, /issue identifies[\s\S]*one concise Simplified Chinese sentence/);
  assert.match(prompt, /suggestion gives[\s\S]*1–2 concise Simplified Chinese sentences/);
  assert.match(prompt, /overall_feedback to 2–3 concise Simplified Chinese sentences/);
  assert.match(prompt, /Conciseness applies[\s\S]*NOT to the number of genuine issues/);
  assert.match(prompt, /Never cap content_feedback/);
  assert.match(prompt, /Never cap the number of language_edits/);
  assert.match(prompt, /Do not omit a substantive issue merely to keep the response short/);
  assert.match(prompt, /proposed_revision must contain only the final directly applicable English revision/);
  assert.doesNotMatch(prompt, /content_feedback\[\]\.example/);
});

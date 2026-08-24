import test from "node:test";
import assert from "node:assert/strict";
import { requestProductionC3WritingReview } from "../lib/writingReviewC3Production.ts";
import { EMPTY_OPENROUTER_USAGE } from "../lib/openrouterWritingReview.ts";

const input = {
  taskType: "email",
  question: { scenario: "Write to a professor." },
  responseText: "Dear Professor Lee, I apologize. Could we meet tomorrow?"
};
const provider = { provider: "moonshot", model: "kimi-k3" };
const semantic = {
  official_score: 4,
  score_reason: "回答完成了主要任务。",
  overall_feedback: "建议再补充一个支持细节。",
  dimension_scores: Object.fromEntries([
    "communicative_purpose_and_elaboration",
    "syntactic_range_and_word_choice",
    "social_conventions",
    "lexical_and_grammatical_control"
  ].map((key) => [key, { score: 4, basis: "文中有明确依据。" }])),
  unit_revisions: [],
  content_feedback: [{ unit_id: "U01", category: "communicative_purpose", issue: "邮件缺少必要细节。", suggestion: "补充一个具体原因。", proposed_revision: "Add a specific reason." }]
};
function response(content = JSON.stringify(semantic)) {
  return { content, model: "kimi-k3", usage: EMPTY_OPENROUTER_USAGE, generationId: "safe-test-id" };
}
function requestWith(value, calls) {
  return async (actualProvider, messages, options) => {
    calls.push({ actualProvider, messages, options });
    if (value instanceof Error) throw value;
    return value;
  };
}

test("C3 service uses Moonshot structured output and returns only fully validated v2.2", async () => {
  const calls = [];
  const result = await requestProductionC3WritingReview(input, provider, {}, {
    requestStructuredOutput: requestWith(response(), calls)
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].actualProvider, provider);
  assert.equal(calls[0].options.reasoningEffort, "high");
  assert.equal(calls[0].options.schemaName, "tps_writing_review_c3_v5_email");
  assert.equal(result.telemetry.winner, "primary");
  assert.equal(result.review.schema_version, "2.2");
  assert.equal(JSON.parse(result.response.content).schema_version, "2.2");
  assert.equal(result.timing.hedgeDelayMs, 90_000);
  assert.equal(result.timing.deadlineMs, 210_000);
});

test("C3 service treats deterministic anchored deduplication as a successful winner", async () => {
  const calls = [];
  const overlapping = {
    ...semantic,
    unit_revisions: [
      {
        unit_id: "U01",
        original_text: "Dear Professor Lee",
        replacement_text: "Dear Professor",
        reason: "称呼中不需要保留姓名 Lee。",
        issue_type: "social_convention",
        severity: "moderate"
      },
      {
        unit_id: "U01",
        original_text: "Professor Lee",
        replacement_text: "Professor",
        reason: "删除不必要的姓名 Lee。",
        issue_type: "social_convention",
        severity: "minor"
      }
    ]
  };
  const result = await requestProductionC3WritingReview(input, provider, {}, {
    requestStructuredOutput: requestWith(
      response(JSON.stringify(overlapping)),
      calls
    )
  });
  assert.equal(calls.length, 1);
  assert.equal(result.telemetry.winner, "primary");
  assert.equal(result.review.language_edits.length, 1);
  assert.equal(result.normalizationDiagnostic, null);
});

for (const [name, body, code] of [
  ["invalid JSON", "{", "C3_INVALID_JSON"],
  ["semantic schema", JSON.stringify({ ...semantic, official_score: 9 }), "C3_SCHEMA_INVALID"],
  ["unknown unit", JSON.stringify({ ...semantic, content_feedback: [{ ...semantic.content_feedback[0], unit_id: "U99" }] }), "C3_UNIT_VALIDATION_FAILED"],
  ["anchor leakage", JSON.stringify({ ...semantic, overall_feedback: "⟦TPS_UNIT:U01⟧" }), "C3_ANCHOR_LEAKAGE"]
]) test(`C3 ${name} failure never becomes a successful review or fallback`, async () => {
  const calls = [];
  await assert.rejects(
    requestProductionC3WritingReview(input, provider, {}, {
      requestStructuredOutput: requestWith(response(body), calls)
    }),
    (error) => error.code === code
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].actualProvider.provider, "moonshot");
});

test("C3 provider failure does not retry another provider", async () => {
  const calls = [];
  const error = Object.assign(new Error("transport"), { code: "MOONSHOT_REQUEST_FAILED" });
  await assert.rejects(requestProductionC3WritingReview(input, provider, {}, {
    requestStructuredOutput: requestWith(error, calls)
  }), /transport/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].actualProvider.provider, "moonshot");
});

test("C3 selects the task-specific schema rather than sharing Email schema with AD", async () => {
  const calls = [];
  const adInput = { taskType: "academic_discussion", question: { professor_prompt: "Discuss." }, responseText: "I agree because practical skills matter." };
  const adSemantic = { ...semantic, dimension_scores: Object.fromEntries(["relevance", "elaboration", "syntactic_range_and_word_choice", "lexical_and_grammatical_control"].map((key) => [key, { score: 4, basis: "文中有明确依据。" }])), content_feedback: [{ unit_id: "U01", category: "relevance", issue: "论述缺少细节。", suggestion: "补充细节。", proposed_revision: "I agree because practical skills matter." }] };
  await requestProductionC3WritingReview(adInput, provider, {}, { requestStructuredOutput: requestWith(response(JSON.stringify(adSemantic)), calls) });
  assert.equal(calls[0].options.schemaName, "tps_writing_review_c3_v5_academic_discussion");
  assert.deepEqual(calls[0].options.jsonSchema.properties.dimension_scores.required, ["relevance", "elaboration", "syntactic_range_and_word_choice", "lexical_and_grammatical_control"]);
});

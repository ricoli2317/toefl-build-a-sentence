import test from "node:test";
import assert from "node:assert/strict";
import { buildWritingReviewTextUnits } from "../lib/writingReviewTextUnits.ts";
import { buildWritingReviewSemanticC3Messages } from "../lib/writingReviewSemanticPrompt.ts";
import { parseWritingReviewSemanticC3, writingReviewC3JsonSchema, WRITING_REVIEW_C3_CONTENT_CATEGORIES, WRITING_REVIEW_C3_DIMENSIONS } from "../lib/writingReviewSemanticSchema.ts";

const units = buildWritingReviewTextUnits("I agree because practical skills matter.");
function value(taskType = "academic_discussion") { const dimensions = WRITING_REVIEW_C3_DIMENSIONS[taskType]; return { official_score: 4, score_reason: "Clear.", overall_feedback: "Add detail.", dimension_scores: Object.fromEntries(dimensions.map((key) => [key, { score: 4, basis: "Evidence." }])), unit_revisions: [], content_feedback: [{ unit_id: units[0].unitId, category: WRITING_REVIEW_C3_CONTENT_CATEGORIES[taskType][0], issue: "Add detail.", suggestion: "补充细节。", proposed_revision: "I agree because practical skills matter." }] }; }
function rejects(mutator, code = "C3_SCHEMA_INVALID") { const item = value(); mutator(item); assert.throws(() => parseWritingReviewSemanticC3(JSON.stringify(item), "academic_discussion", units), (error) => error.code === code); }

test("task schemas require exactly their own dimensions and categories", () => {
  for (const taskType of ["email", "academic_discussion"]) { const schema = writingReviewC3JsonSchema(taskType); assert.deepEqual(schema.properties.dimension_scores.required, WRITING_REVIEW_C3_DIMENSIONS[taskType]); assert.deepEqual(schema.properties.content_feedback.items.properties.category.enum, WRITING_REVIEW_C3_CONTENT_CATEGORIES[taskType]); assert.equal(schema.properties.dimension_scores.additionalProperties, false); }
});
test("semantic parser accepts strict valid JSON and legal BOM/fences", () => {
  const json = JSON.stringify(value());
  for (const content of [json, `\uFEFF ${json} `, `\`\`\`json\n${json}\n\`\`\``, `\`\`\` ${json} \`\`\``]) assert.equal(parseWritingReviewSemanticC3(content, "academic_discussion", units).official_score, 4);
});
test("semantic parser rejects dimensions, category, scores, and top-level drift", () => {
  rejects((item) => delete item.dimension_scores.relevance);
  rejects((item) => item.dimension_scores.extra = { score: 4, basis: "x" });
  rejects((item) => item.dimension_scores.relevance.score = 6);
  rejects((item) => item.content_feedback[0].category = "social_conventions");
  rejects((item) => item.extra = true);
});
test("score contract is enforced before assembly for Email and AD", () => {
  for (const taskType of ["email", "academic_discussion"]) {
    const validZero = value(taskType); validZero.official_score = 0; for (const item of Object.values(validZero.dimension_scores)) item.score = 0;
    assert.equal(parseWritingReviewSemanticC3(JSON.stringify(validZero), taskType, units).official_score, 0);
    const invalidZero = structuredClone(validZero); invalidZero.dimension_scores[WRITING_REVIEW_C3_DIMENSIONS[taskType][0]].score = 1;
    assert.throws(() => parseWritingReviewSemanticC3(JSON.stringify(invalidZero), taskType, units), (error) => error.code === "C3_SCORE_CONTRACT_INVALID" && error.diagnostics[0].path.endsWith(".score"));
    const invalidPositive = value(taskType); invalidPositive.dimension_scores[WRITING_REVIEW_C3_DIMENSIONS[taskType][1]].score = 0;
    assert.throws(() => parseWritingReviewSemanticC3(JSON.stringify(invalidPositive), taskType, units), (error) => error.code === "C3_SCORE_CONTRACT_INVALID" && error.diagnostics[0].path === `$.dimension_scores.${WRITING_REVIEW_C3_DIMENSIONS[taskType][1]}.score`);
  }
});
test("semantic parser accepts only a whole JSON value or one complete fence", () => {
  const json = JSON.stringify(value());
  for (const content of [`note ${json}`, `\`\`\`json\n${json}\n\`\`\` trailing`, `\`\`\`\n${json}\n\`\`\`\n\`\`\`\n${json}\n\`\`\``, json.slice(0, -1)]) assert.throws(() => parseWritingReviewSemanticC3(content, "academic_discussion", units), (error) => error.code === "C3_INVALID_JSON");
});
test("prompt is generated from the same task constants and preserves anchor rules", () => {
  for (const taskType of ["email", "academic_discussion"]) { const prompt = buildWritingReviewSemanticC3Messages({ taskType, question: {}, anchoredResponse: "⟦TPS_UNIT:U01⟧Text" })[0].content; for (const key of WRITING_REVIEW_C3_DIMENSIONS[taskType]) assert.match(prompt, new RegExp(key)); for (const key of WRITING_REVIEW_C3_CONTENT_CATEGORIES[taskType]) assert.match(prompt, new RegExp(key)); assert.match(prompt, /Anchor handling rules/); assert.match(prompt, /no Markdown code fence/); }
});

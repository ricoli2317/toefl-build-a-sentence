import test from "node:test";
import assert from "node:assert/strict";
import { buildWritingReviewTextUnits } from "../lib/writingReviewTextUnits.ts";
import { assembleWritingReviewV22FromC3, writingReviewRawV22FromAssembled } from "../lib/writingReviewV22Assembler.ts";
import { parseAIReviewRawResultV22ForResponse } from "../lib/writingReviewSchemaV22.ts";
import { applyWritingReviewDiffs } from "../lib/writingReviewRevisionDiff.ts";
import { normalizeC3ContentFeedback } from "../lib/writingReviewV22Assembler.ts";

function insertionSemantic(text, revised) {
  const units = buildWritingReviewTextUnits(text);
  return { units, semantic: { official_score: 4, score_reason: "Clear.", overall_feedback: "Fine.", dimension_scores: { relevance: { score: 4, basis: "Clear." }, elaboration: { score: 4, basis: "Clear." }, syntactic_range_and_word_choice: { score: 4, basis: "Clear." }, lexical_and_grammatical_control: { score: 4, basis: "Clear." } }, unit_revisions: [{ unit_id: units[0].unitId, revised_text: revised, reason: "Insert.", issue_type: "clarity" }], content_feedback: [] } };
}

for (const [name, text, revised] of [["start", "agree", "I agree"], ["middle", "I agree", "I strongly agree"], ["end", "I agree", "I agree today"], ["emoji", "I agree 🙂", "I strongly agree 🙂"]]) test(`C3 insertion ${name} has a non-empty unique localized edit`, () => {
  const { units, semantic } = insertionSemantic(text, revised);
  const assembled = assembleWritingReviewV22FromC3({ taskType: "academic_discussion", responseText: text, units, semantic });
  const edit = assembled.language_edits[0];
  assert.ok(edit.original_text.length > 0);
  assert.equal(text.indexOf(edit.original_text), text.lastIndexOf(edit.original_text));
  assert.equal(text.slice(edit.start, edit.end), edit.original_text);
  assert.equal(applyWritingReviewDiffs(text, [{ start: edit.start, end: edit.end, originalText: edit.original_text, replacementText: edit.replacement_text }]), revised);
});

test("C3 insertion rejects a non-unique complete unit", () => {
  const text = "Go. Go.";
  const units = [{ unitId: "U01", startOffset: 0, endOffset: 2, text: "Go" }];
  const semantic = insertionSemantic("Go", "Go!").semantic;
  assert.throws(() => assembleWritingReviewV22FromC3({ taskType: "academic_discussion", responseText: text, units, semantic }), (error) => error.code === "C3_ASSEMBLY_INVALID");
});

test("C3 feedback normalization merges duplicate units, deduplicates text, and moves null feedback to overall", () => {
  const semantic = { official_score: 4, score_reason: "Clear.", overall_feedback: "Base.", dimension_scores: {}, unit_revisions: [], content_feedback: [
    { unit_id: "U01", category: "relevance", issue: "Issue A", suggestion: "Suggestion A", proposed_revision: "Revision A" },
    { unit_id: "U01", category: "elaboration", issue: "Issue B", suggestion: "Suggestion B", proposed_revision: "Revision B" },
    { unit_id: "U01", category: "elaboration", issue: "Issue A", suggestion: "Suggestion A", proposed_revision: "Revision A" },
    { unit_id: null, category: "discussion_contribution", issue: "Whole response", suggestion: "Add peer engagement." }
  ] };
  const normalized = normalizeC3ContentFeedback(semantic);
  assert.equal(normalized.content_feedback.length, 1);
  assert.equal(normalized.content_feedback[0].category, "relevance");
  assert.match(normalized.content_feedback[0].issue, /Issue A/);
  assert.match(normalized.content_feedback[0].issue, /Issue B/);
  assert.equal(normalized.content_feedback[0].proposed_revision, "Revision A");
  assert.doesNotMatch(normalized.overall_feedback, /U01/);
  assert.match(normalized.overall_feedback, /Whole response/);
});

test("C3 feedback normalization fails rather than inventing a missing proposed revision", () => {
  assert.throws(() => normalizeC3ContentFeedback({ official_score: 4, score_reason: "x", overall_feedback: "x", dimension_scores: {}, unit_revisions: [], content_feedback: [{ unit_id: "U01", category: "relevance", issue: "x", suggestion: "x" }] }), (error) => error.code === "C3_ASSEMBLY_INVALID");
});

const fixtures = [
  { name: "email strong", taskType: "email", text: "Dear Professor Lee, I apologize. Could we meet at 3:00 p.m.? Sincerely, Jordan", dimensions: ["communicative_purpose_and_elaboration", "syntactic_range_and_word_choice", "social_conventions", "lexical_and_grammatical_control"], category: "communicative_purpose" },
  { name: "email weak", taskType: "email", text: "Hello professor I need more time. My project is not finish.", dimensions: ["communicative_purpose_and_elaboration", "syntactic_range_and_word_choice", "social_conventions", "lexical_and_grammatical_control"], category: "language_improvement" },
  { name: "AD strong", taskType: "academic_discussion", text: "I agree because students need practical financial skills. It helps them avoid debt.", dimensions: ["relevance", "elaboration", "syntactic_range_and_word_choice", "lexical_and_grammatical_control"], category: "elaboration" },
  { name: "AD weak", taskType: "academic_discussion", text: "Money is important. Students need learn it.", dimensions: ["relevance", "elaboration", "syntactic_range_and_word_choice", "lexical_and_grammatical_control"], category: "language_improvement" }
];

for (const fixture of fixtures) test(`C3 ${fixture.name} assembles and round-trips strict v2.2`, () => {
  const units = buildWritingReviewTextUnits(fixture.text);
  const first = units[0];
  const revised = first.text.replace("I apologize", "I am sorry").replace("I agree", "I strongly agree");
  const semantic = { official_score: 4, score_reason: "Clear response.", overall_feedback: "Add one detail.", dimension_scores: Object.fromEntries(fixture.dimensions.map((key) => [key, { score: 4, basis: "Supported by the response." }])), unit_revisions: revised === first.text ? [] : [{ unit_id: first.unitId, revised_text: revised, reason: "Improve wording.", issue_type: "word_choice" }], content_feedback: [{ unit_id: first.unitId, category: fixture.category, issue: "Add detail.", suggestion: "Explain one example.", proposed_revision: "Add a specific example." }] };
  const assembled = assembleWritingReviewV22FromC3({ taskType: fixture.taskType, responseText: fixture.text, units, semantic });
  const raw = writingReviewRawV22FromAssembled(assembled);
  const reparsed = parseAIReviewRawResultV22ForResponse(raw, fixture.text);
  assert.equal(reparsed.scores.official_score.ai_score, semantic.official_score);
  assert.equal(reparsed.scores.official_score.rationale, semantic.score_reason);
  assert.deepEqual(reparsed.content_feedback.map(({ feedback_id, category, issue, suggestion, proposed_revision }) => ({ feedback_id, category, issue, suggestion, proposed_revision })), raw.content_feedback.map(({ feedback_id, category, issue, suggestion, proposed_revision }) => ({ feedback_id, category, issue, suggestion, proposed_revision })));
  const edits = reparsed.language_edits.map((edit) => ({ start: edit.start, end: edit.end, originalText: edit.original_text, replacementText: edit.replacement_text }));
  for (const edit of edits) assert.equal(fixture.text.slice(edit.start, edit.end), edit.originalText);
  assert.equal(applyWritingReviewDiffs(fixture.text, edits), fixture.text.slice(0, first.startOffset) + revised + fixture.text.slice(first.endOffset));
});

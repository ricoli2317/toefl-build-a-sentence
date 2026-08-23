const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  buildWritingReviewMessages
} = require("../lib/openrouterWritingReview.ts");
const {
  AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA
} = require("../lib/writingReviewSchemaV22.ts");

function systemPrompt(taskType) {
  return buildWritingReviewMessages({
    taskType,
    question: {},
    responseText: "A response."
  })[0].content;
}

test("prompt requires a sentence-by-sentence Word Choice and Collocation Audit", () => {
  const prompt = systemPrompt("email");
  assert.match(prompt, /WORD CHOICE & COLLOCATION AUDIT/);
  assert.match(prompt, /sentence-by-sentence audit/);
  assert.match(prompt, /verb–noun collocation problems/);
  assert.match(prompt, /adjective–noun collocation problems/);
  assert.match(prompt, /noun–noun combination problems/);
  assert.match(prompt, /unnatural noun phrases/);
  assert.match(prompt, /idiomaticity/);
  assert.match(prompt, /literal translation or Chinglish-like wording/);
  assert.match(prompt, /does not precisely express the intended meaning/);
});

test("prompt contains all required word-choice calibration examples", () => {
  const prompt = systemPrompt("email");
  assert.match(prompt, /make a directional goal/);
  assert.match(prompt, /set a clear career goal/);
  assert.match(prompt, /apply my dream career/);
  assert.match(prompt, /pursue my dream career/);
  assert.match(prompt, /introduction papers/);
  assert.match(prompt, /informational materials/);
  assert.match(prompt, /information sheets/);
  assert.match(prompt, /brochures/);
  assert.match(prompt, /career workshop organization/);
});

test("prompt keeps word-choice issues out of grammar language edits", () => {
  const prompt = systemPrompt("email");
  assert.match(prompt, /Do not place inaccurate word choice[\s\S]*in language_edits/);
  assert.match(prompt, /language_edits remain only for objectively identifiable normative errors/);
  assert.match(prompt, /grammar, spelling, capitalization, punctuation, tense, agreement, article, preposition, number, word form/);
});

test("prompt binds specific word-choice findings to scores and language improvement", () => {
  const prompt = systemPrompt("academic_discussion");
  assert.match(prompt, /must affect the task's syntactic_range_and_word_choice judgment/);
  assert.match(prompt, /ai_basis must cite the student's specific expression/);
  assert.match(prompt, /category "language_improvement"/);
  assert.match(prompt, /English proposed_revision/);
  assert.match(prompt, /one combined language_improvement feedback/);
  assert.match(prompt, /Do not create overlapping feedback items/);
});

test("prompt explicitly prohibits sophistication polishing of natural wording", () => {
  const prompt = systemPrompt("email");
  assert.match(prompt, /I think this would be helpful\./);
  assert.match(prompt, /already correct, clear, and natural/);
  assert.match(prompt, /I firmly believe this initiative would prove highly beneficial\./);
  assert.match(prompt, /Prohibit sophistication polishing/);
  assert.match(prompt, /vocabulary upgrading for its own sake/);
  assert.match(prompt, /rewriting already-natural sentences/);
});

test("proposed revisions are limited to material changes explained by feedback", () => {
  const prompt = systemPrompt("email");
  assert.match(prompt, /PROPOSED REVISION FIDELITY/);
  assert.match(prompt, /not a free-polishing or general rewrite/);
  assert.match(prompt, /Every material insertion, deletion, replacement, or structural change/);
  assert.match(prompt, /directly explained by that item's issue or suggestion/);
  assert.match(prompt, /feedback rationale for every material change/);
  assert.match(prompt, /Do not add unrelated stylistic polishing/);
  assert.match(prompt, /information expansion, new arguments, new facts/);
  assert.match(prompt, /leave the student's wording unchanged/);
  assert.match(prompt, /issue and\/or suggestion must explicitly cover why all of them are needed/);
  assert.match(prompt, /BAD pattern:[\s\S]*deletion of redundant X[\s\S]*unrelated earlier clause/);
  assert.match(prompt, /GOOD pattern:[\s\S]*deletes only X and preserves the rest/);
  assert.match(prompt, /All explanatory and evaluative prose must be written in Simplified Chinese/);
  assert.match(prompt, /CONTENT FEEDBACK CLASSIFICATION BOUNDARIES/);
  assert.match(prompt, /Official TOEFL/);
});

test("presentation change kinds do not alter the v2.2 AI Schema", () => {
  const serialized = JSON.stringify(AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA);
  assert.equal(serialized.includes("change_kind"), false);
  assert.equal(serialized.includes("insertions"), false);
  assert.equal(serialized.includes("deletions"), false);
  assert.equal(serialized.includes("revision_explanations"), false);
  assert.match(serialized, /proposed_revision/);
});

test("initial generation and full regeneration both use the shared fidelity prompt", () => {
  const root = process.cwd();
  const initial = fs.readFileSync(
    path.join(root, "app/api/teacher/writing/reviews/[attemptId]/generate-ai/route.ts"),
    "utf8"
  );
  const full = fs.readFileSync(
    path.join(root, "app/api/teacher/writing/reviews/[attemptId]/regenerate-ai/route.ts"),
    "utf8"
  );
  const openrouter = fs.readFileSync(
    path.join(root, "lib/openrouterWritingReview.ts"),
    "utf8"
  );
  for (const route of [initial, full]) {
    assert.match(route, /requestWritingReview/);
    assert.match(route, /AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA/);
  }
  assert.match(openrouter, /buildWritingReviewMessages\(input\)/);
  assert.match(openrouter, /PROPOSED_REVISION_FIDELITY_RULES/);
});

test("Email and Academic Discussion scoring boundaries remain in the prompt", () => {
  const email = systemPrompt("email");
  assert.match(email, /insufficient why\/how[\s\S]*elaboration weakness/);
  assert.match(email, /not a missing communicative purpose/);

  const discussion = systemPrompt("academic_discussion");
  assert.match(discussion, /Do not lower relevance merely because evidence is weak or mismatched/);
  assert.match(discussion, /claim\/example mismatch[\s\S]*belong here/);
});

test("Academic Discussion feedback category follows the primary problem", () => {
  const prompt = systemPrompt("academic_discussion");
  assert.match(prompt, /CONTENT FEEDBACK CLASSIFICATION BOUNDARIES/);
  assert.match(prompt, /identify the PRIMARY problem/);
  assert.match(prompt, /Do not use language_improvement as a catch-all/);
  assert.match(prompt, /evidence that does not support the claim[\s\S]*elaboration/);
  assert.match(prompt, /claim\/example mismatch[\s\S]*elaboration/);
  assert.match(prompt, /inconsistent claim\/evidence scope[\s\S]*elaboration/);
  assert.match(prompt, /relevance judges only[\s\S]*professor's prompt[\s\S]*discussion topic/);
  assert.match(prompt, /nonstandard or invented-looking lexical form[\s\S]*language_improvement/);
  assert.match(prompt, /same sentence also contains awkward wording/);
  assert.match(prompt, /single proposed_revision may also repair the secondary wording problem/);
  assert.match(prompt, /secondary word-choice issue in syntactic_range_and_word_choice\.ai_basis/);
  assert.match(prompt, /grammar errors in language_edits/);
});

test("classification changes preserve complete audits and unlimited issue reporting", () => {
  const prompt = systemPrompt("academic_discussion");
  assert.match(prompt, /verb–noun collocation problems/);
  assert.match(prompt, /adjective–noun collocation problems/);
  assert.match(prompt, /noun–noun combination problems/);
  assert.match(prompt, /introduction papers/);
  assert.match(prompt, /make a directional goal/);
  assert.match(prompt, /apply my dream career/);
  assert.match(prompt, /Never cap content_feedback/);
  assert.match(prompt, /Never cap the number of language_edits/);
});

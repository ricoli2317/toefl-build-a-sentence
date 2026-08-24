const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildWritingReviewMessages
} = require("../lib/openrouterWritingReview.ts");
const {
  parseAIReviewRawResultV22ForResponse
} = require("../lib/writingReviewSchemaV22.ts");

function rawReview(languageEdits) {
  const dimension = { ai_score: 3, ai_basis: "具体评分依据。" };
  return {
    schema_version: "2.2",
    task_type: "academic_discussion",
    language_edits: languageEdits,
    scores: {
      official_score: { ai_score: 3, rationale: "整体评分依据。" },
      dimension_scores: {
        relevance: dimension,
        elaboration: dimension,
        syntactic_range_and_word_choice: dimension,
        lexical_and_grammatical_control: dimension
      }
    },
    content_feedback: [],
    overall_feedback: "总体评价。"
  };
}

function edit(edit_id, original_text, replacement_text) {
  return {
    edit_id,
    original_text,
    replacement_text,
    category: "grammar",
    severity: "major",
    explanation: "需要修正语法形式。"
  };
}

function systemPrompt() {
  return buildWritingReviewMessages({
    taskType: "academic_discussion",
    question: {},
    responseText: "He is kind. The result is useful."
  })[0].content;
}

test("formal prompt requires the smallest uniquely localizable exact source span", () => {
  const prompt = systemPrompt();
  assert.match(prompt, /smallest uniquely localizable contiguous source span/i);
  assert.match(prompt, /occurs exactly once in the full response_text/i);
  assert.match(prompt, /extend[\s\S]*left and\/or right[\s\S]*then stop extending immediately/i);
  assert.match(prompt, /exact, case-sensitive, whitespace-sensitive, punctuation-preserving copy/i);
  assert.match(prompt, /Never normalize, respell, rewrite, change case, insert or remove spaces/i);
  assert.match(prompt, /only by extending the contiguous source span/i);
  assert.match(prompt, /change only what the correction requires/i);
  assert.match(prompt, /separate non-overlapping edits/i);
  assert.match(prompt, /all active language_edits[\s\S]*without creating any new grammatical error/i);
});

test("prompt contract distinguishes repeated and already-unique short spans", () => {
  const prompt = systemPrompt();
  assert.match(prompt, /multiple occurrences of "is"[\s\S]*BAD is "is" → "are"/i);
  assert.match(prompt, /shortest unique context such as "is crucial" → "are crucial"/i);
  assert.match(prompt, /If that exact original_text already occurs once[\s\S]*use it without extra context/i);
  assert.doesNotMatch(prompt, /minimum necessary continuous span/i);
});

test("strict server localization rejects repeated short text and accepts caller-supplied unique context", () => {
  const response = "He is kind. The result is useful.";
  assert.throws(
    () =>
      parseAIReviewRawResultV22ForResponse(
        rawReview([edit("edit-1", "is", "was")]),
        response
      ),
    /must occur exactly once in response_text/
  );
  const located = parseAIReviewRawResultV22ForResponse(
    rawReview([edit("edit-1", "result is", "result was")]),
    response
  );
  assert.equal(located.language_edits[0].original_text, "result is");
  assert.equal(response.slice(located.language_edits[0].start, located.language_edits[0].end), "result is");
});

test("a unique short misspelling remains valid without unnecessary expansion", () => {
  const response = "People should share their viepoints.";
  const located = parseAIReviewRawResultV22ForResponse(
    rawReview([edit("edit-1", "viepoints", "viewpoints")]),
    response
  );
  assert.equal(located.language_edits[0].original_text, "viepoints");
  assert.equal(located.language_edits[0].replacement_text, "viewpoints");
});

test("strict localization ignores embedded letters when a standalone word is unique", () => {
  const response = "hello teacher i miss meeting.";
  const located = parseAIReviewRawResultV22ForResponse(
    rawReview([edit("edit-1", "i", "I")]),
    response
  );
  assert.equal(located.language_edits[0].original_text, "i");
  assert.equal(located.language_edits[0].start, response.indexOf(" i ") + 1);
});

test("strict localization still rejects a source that starts inside a word", () => {
  assert.throws(
    () =>
      parseAIReviewRawResultV22ForResponse(
        rawReview([edit("edit-1", "d in", "")]),
        "I enjoyed in the gym."
      ),
    /must occur exactly in response_text/
  );
});

test("strict server localization still rejects model-normalized source text", () => {
  assert.throws(
    () =>
      parseAIReviewRawResultV22ForResponse(
        rawReview([edit("edit-1", "general y", "generally")]),
        "It is generaly useful."
      ),
    /must occur exactly in response_text/
  );
});

test("overlap normalization runs before the unchanged final validator", () => {
  const result = parseAIReviewRawResultV22ForResponse(
    rawReview([
      edit("edit-1", "help me", "helped me"),
      edit("edit-2", "me growed", "me grow")
    ]),
    "The event help me growed."
  );
  assert.equal(result.language_edits.length, 1);
  assert.equal(result.language_edits[0].original_text, "help me growed");
  assert.equal(result.language_edits[0].replacement_text, "helped me grow");
});

test("overlap normalization emits structured diagnostics through the observability callback", () => {
  const response = "some issue happens";
  const diagnostics = [];
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = parseAIReviewRawResultV22ForResponse(
      rawReview([
        edit("edit-1", "some issue", "some issues"),
        edit("edit-2", "issue", "issues")
      ]),
      response,
      {
        attemptId: "attempt-overlap",
        requestId: "request-overlap",
        onLanguageEditOverlapNormalization: (diagnostic) => diagnostics.push(diagnostic)
      }
    );
    assert.equal(result.language_edits.length, 1);
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0].normalization_applied, true);
  assert.equal(diagnostics[0].groups[0].action, "kept_minimal_equivalent");
});

test("normal requests do not emit overlap diagnostics", () => {
  const diagnostics = [];
  assert.doesNotThrow(() =>
    parseAIReviewRawResultV22ForResponse(
      rawReview([
        edit("edit-1", "First", "One"),
        edit("edit-2", "Second", "Two")
      ]),
      "First Second",
      { onLanguageEditOverlapNormalization: (diagnostic) => diagnostics.push(diagnostic) }
    )
  );
  assert.equal(diagnostics.length, 0);
});

test("prompt prevents duplicate, broad-contained, shared-source, and localization-context overlaps", () => {
  const prompt = systemPrompt();
  assert.match(prompt, /One error must produce exactly one language_edit/i);
  assert.match(prompt, /Never return both a broad edit and a contained sub-edit/i);
  assert.match(prompt, /modify any of the same source characters[\s\S]*one language_edit/i);
  assert.match(prompt, /extending source context for unique localization[\s\S]*one combined uniquely localizable edit/i);
  assert.match(prompt, /Continue to split unrelated errors/i);
});

test("prompt requires joint correctness and includes explicit bad and good examples", () => {
  const prompt = systemPrompt();
  assert.match(prompt, /BAD is original_text "general y"[\s\S]*must remain "generaly"/i);
  assert.match(prompt, /BAD is two edits "help" → "helped" and "growed" → "grew"/i);
  assert.match(prompt, /combined result is "event helped me grew"/i);
  assert.match(prompt, /GOOD is one tightly coupled edit "help me growed" → "helped me grow"/i);
  assert.match(prompt, /all edits applied together produce a grammatically correct result/i);
});

test("formal system prompt does not contain benchmark-specific answers", () => {
  const prompt = systemPrompt();
  assert.doesNotMatch(prompt, /teenage years/i);
  assert.doesNotMatch(prompt, /10-year-old|age 10/i);
  assert.doesNotMatch(prompt, /growth environments/i);
  assert.doesNotMatch(prompt, /kindful people/i);
});

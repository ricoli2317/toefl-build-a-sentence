const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildWritingRevisionComposition,
  contentFeedbackMarkedDetails,
  contentFeedbackRevisionDiff
} = require("../lib/writingReviewRevisionComposition.ts");

const text = "I am write today. This gives a directional goal.";
const firstEdit = {
  edit_id: "e1", start: 2, end: 10, original_text: "am write",
  replacement_text: "am writing", category: "grammar", severity: "moderate",
  explanation: "语法错误。", restored: false
};
const nestedEdit = {
  edit_id: "e2", start: text.indexOf("directional"),
  end: text.indexOf("directional") + "directional".length,
  original_text: "directional", replacement_text: "clear",
  category: "word_choice", severity: "moderate", explanation: "用词。", restored: false
};
const sentence = "This gives a directional goal.";
const revision = {
  feedback_id: "f1", start: text.indexOf(sentence), end: text.indexOf(sentence) + sentence.length,
  original_sentence: sentence, category: "language_improvement", issue: "搭配不自然。",
  suggestion: "改用自然表达。", example: "This gives me direction.",
  proposed_revision: "This gives me a clearer sense of direction.", included: true
};

test("without content revision active language edits produce clean revised text", () => {
  const result = buildWritingRevisionComposition(text, [firstEdit], []);
  assert.equal(result.cleanText, "I am writing today. This gives a directional goal.");
  assert.equal(result.activeLanguageEdits.length, 1);
});

test("included content revision wins and retains the nested suppressed edit", () => {
  const result = buildWritingRevisionComposition(text, [firstEdit, nestedEdit], [revision]);
  assert.equal(result.cleanText, "I am writing today. This gives me a clearer sense of direction.");
  assert.equal(result.suppressedLanguageEditIds.has("e2"), true);
  assert.equal(result.activeLanguageEdits.some((item) => item.edit_id === "e2"), false);
  assert.equal(result.trackedChangeSegments.some((item) => item.kind === "content_feedback_inline"), true);
  assert.equal(result.trackedChangeSegments.some((item) => item.kind === "language_edit" && item.edit.edit_id === "e2"), false);
  const workspaceSentence = result.workspaceSegments.find((item) => item.kind === "feedback_sentence");
  assert.equal(workspaceSentence.revisedText, "This gives a clear goal.");
  assert.equal(workspaceSentence.children.some((item) => item.kind === "language_edit" && item.edit.edit_id === "e2"), true);
  assert.equal(workspaceSentence.revisedText.includes("clearer sense of direction"), false);
});

test("teacher feedback without proposed revision remains feedback-only", () => {
  const teacherFeedback = {
    ...revision,
    feedback_id: "teacher-feedback-only",
    source: "teacher",
    proposed_revision: ""
  };
  const result = buildWritingRevisionComposition(
    text,
    [firstEdit, nestedEdit],
    [teacherFeedback]
  );
  assert.equal(result.activeContentRevisions.length, 0);
  assert.equal(result.cleanText, "I am writing today. This gives a clear goal.");
  const annotation = result.trackedChangeSegments.find(
    (item) => item.kind === "content_feedback"
  );
  assert.equal(annotation.feedback.feedback_id, "teacher-feedback-only");
  assert.deepEqual(contentFeedbackMarkedDetails(annotation.feedback), [
    { label: "问题", value: "搭配不自然。" },
    { label: "建议", value: "改用自然表达。" }
  ]);
});

test("feedback-only marked details include whichever fields are actually filled", () => {
  assert.deepEqual(contentFeedbackMarkedDetails({ ...revision, proposed_revision: "", suggestion: "" }), [
    { label: "问题", value: "搭配不自然。" }
  ]);
  assert.deepEqual(contentFeedbackMarkedDetails({ ...revision, proposed_revision: "", issue: "" }), [
    { label: "建议", value: "改用自然表达。" }
  ]);
});

test("proposed revision marked details exclude issue and suggestion", () => {
  assert.deepEqual(contentFeedbackMarkedDetails(revision), [
    { label: "建议改为", value: revision.proposed_revision }
  ]);
});

test("AI and teacher feedback use identical composition based only on their data", () => {
  const ai = buildWritingRevisionComposition(text, [], [{ ...revision, source: "ai" }]);
  const teacher = buildWritingRevisionComposition(text, [], [{ ...revision, source: "teacher" }]);
  assert.equal(ai.cleanText, teacher.cleanText);
  assert.deepEqual(
    ai.trackedChangeSegments.map((item) => item.kind),
    teacher.trackedChangeSegments.map((item) => item.kind)
  );
  assert.deepEqual(
    contentFeedbackMarkedDetails(ai.activeContentRevisions[0]),
    contentFeedbackMarkedDetails(teacher.activeContentRevisions[0])
  );
});

test("hidden marks applies teacher and AI proposed revisions identically", () => {
  const ai = buildWritingRevisionComposition(text, [], [{ ...revision, source: "ai" }]);
  const teacher = buildWritingRevisionComposition(text, [], [{ ...revision, source: "teacher" }]);
  assert.equal(ai.cleanText, "I am write today. This gives me a clearer sense of direction.");
  assert.equal(teacher.cleanText, ai.cleanText);
});

test("teacher proposed revision keeps content revision priority over language edit", () => {
  const result = buildWritingRevisionComposition(
    text,
    [nestedEdit],
    [{ ...revision, source: "teacher" }]
  );
  assert.equal(result.cleanText, "I am write today. This gives me a clearer sense of direction.");
  assert.equal(result.suppressedLanguageEditIds.has("e2"), true);
});

test("excluding content revision immediately restores nested language edits", () => {
  const result = buildWritingRevisionComposition(text, [nestedEdit], [{ ...revision, included: false }]);
  assert.equal(result.cleanText, "I am write today. This gives a clear goal.");
  assert.equal(result.suppressedLanguageEditIds.size, 0);
  const sentence = result.workspaceSegments.find((item) => item.kind === "feedback_sentence");
  assert.equal(sentence.feedback.feedback_id, "f1");
  assert.equal(sentence.children.some((item) => item.kind === "language_edit" && item.edit.edit_id === "e2"), true);
});

test("tracked language edits retain both original and replacement values", () => {
  const result = buildWritingRevisionComposition(text, [firstEdit], []);
  const segment = result.trackedChangeSegments.find((item) => item.kind === "language_edit");
  assert.equal(segment.originalText, "am write");
  assert.equal(segment.revisedText, "am writing");
});

test("a structurally unrelated tracked content revision retains the full rewrite", () => {
  const broadRevision = {
    ...revision,
    proposed_revision: "Modern schools should completely redesign their curricula around interdisciplinary projects."
  };
  const result = buildWritingRevisionComposition(text, [], [broadRevision]);
  const segment = result.trackedChangeSegments.find((item) => item.kind === "content_revision");
  assert.equal(segment.originalText, broadRevision.original_sentence);
  assert.equal(segment.revisedText, broadRevision.proposed_revision);
});

test("restored language edits are absent from both clean and tracked output", () => {
  const result = buildWritingRevisionComposition(text, [{ ...firstEdit, restored: true }], []);
  assert.equal(result.cleanText, text);
  assert.equal(result.trackedChangeSegments.some((item) => item.kind === "language_edit"), false);
  assert.equal(result.workspaceSegments.some((item) => item.kind === "language_edit" && item.edit.edit_id === "e1"), true);
});

test("a local Content Feedback revision becomes one inline marker", () => {
  const original = "I cannot agree more with Claire when she said that nurture has a greater impact on human development.";
  const proposed = "I couldn't agree more with Claire when she said that nurture has a greater impact on human development.";
  const feedback = {
    ...revision,
    feedback_id: "local-one",
    start: 0,
    end: original.length,
    original_sentence: original,
    proposed_revision: proposed
  };
  const result = buildWritingRevisionComposition(original, [], [feedback]);
  const markers = result.trackedChangeSegments.filter(
    (item) => item.kind === "content_feedback_inline"
  );
  assert.equal(markers.length, 1);
  assert.equal(markers[0].originalText, "cannot");
  assert.equal(markers[0].revisedText, "couldn't");
  assert.equal(markers[0].changeKind, "replace");
  assert.equal(markers[0].feedback.feedback_id, "local-one");
  assert.equal(result.trackedChangeSegments.some((item) => item.kind === "content_revision"), false);
  assert.equal(result.cleanText, proposed);
});

test("separated local changes create multiple markers for one feedback_id", () => {
  const original = "This argument is clear, practical, and useful for students today.";
  const proposed = "This argument was clear, persuasive, and useful for college students today.";
  const feedback = {
    ...revision,
    feedback_id: "local-many",
    start: 0,
    end: original.length,
    original_sentence: original,
    proposed_revision: proposed
  };
  const result = buildWritingRevisionComposition(original, [], [feedback]);
  const markers = result.trackedChangeSegments.filter(
    (item) => item.kind === "content_feedback_inline"
  );
  assert.equal(markers.length, 3);
  assert.deepEqual(
    markers.map((item) => item.feedback.feedback_id),
    ["local-many", "local-many", "local-many"]
  );
  assert.deepEqual(
    markers.map((item) => [item.originalText, item.revisedText]),
    [["is", "was"], ["practical", "persuasive"], ["", "college "]]
  );
});

test("local diff supports capitalization, punctuation, insertion, and deletion", () => {
  for (const [original, proposed] of [
    ["This option is useful for students.", "this option is useful for students."],
    ["Hello world.", "Hello, world!"],
    ["This is useful for students.", "This is extremely useful for students."],
    ["This is very useful for students.", "This is useful for students."]
  ]) {
    const diff = contentFeedbackRevisionDiff(original, proposed);
    assert.equal(diff.mode, "inline", `${original} -> ${proposed}`);
    assert.equal(diff.parts.some((part) => part.kind !== "equal"), true);
  }
});

test("a long career-goal phrase keeps stable anchors and remains inline", () => {
  const original = "make a directional goal to apply my dream career";
  const proposed = "set a clear career goal and learn how to pursue my dream career";
  const diff = contentFeedbackRevisionDiff(original, proposed);
  assert.equal(diff.mode, "inline");
  assert.deepEqual(
    diff.parts.filter((part) => part.kind !== "equal").map((part) => part.kind),
    ["replace", "replace", "insert", "replace"]
  );
});

test("a sentence with several aligned substitutions remains readable inline", () => {
  const original = "This event was held outside, so many visitors felt very hot and even didn't want to know more information of each career.";
  const proposed = "The event was held outdoors, so many attendees felt very hot and did not even want to learn more about each career.";
  const diff = contentFeedbackRevisionDiff(original, proposed);
  assert.equal(diff.mode, "inline");
  const changes = diff.parts.filter((part) => part.kind !== "equal");
  assert.deepEqual(
    changes.map((part) => [part.kind, part.originalText, part.revisedText]),
    [
      ["replace", "This", "The"],
      ["replace", "outside", "outdoors"],
      ["replace", "visitors", "attendees"],
      ["replace", "even didn't ", "did not even "],
      ["replace", "know", "learn"],
      ["replace", "information of", "about"]
    ]
  );
});

test("pure insertion keeps a zero-width source anchor and the same feedback id", () => {
  const original = "I'm so glad to attend this workshop.";
  const proposed = "I'm so glad that I had the chance to attend this workshop.";
  const feedback = {
    ...revision,
    feedback_id: "pure-insertion",
    start: 0,
    end: original.length,
    original_sentence: original,
    proposed_revision: proposed
  };
  const result = buildWritingRevisionComposition(original, [], [feedback]);
  const insertion = result.trackedChangeSegments.find(
    (item) => item.kind === "content_feedback_inline" && item.changeKind === "insert"
  );
  assert.equal(insertion.originalText, "");
  assert.equal(insertion.revisedText, "that I had the chance ");
  assert.equal(insertion.start, insertion.end);
  assert.equal(original.slice(insertion.start, insertion.end), "");
  assert.equal(insertion.feedback.feedback_id, "pure-insertion");
});

test("pure deletion and local replacement expose their explicit change kinds", () => {
  const deletion = contentFeedbackRevisionDiff(
    "This is very useful for students.",
    "This is useful for students."
  );
  assert.equal(deletion.mode, "inline");
  assert.deepEqual(
    deletion.parts.filter((part) => part.kind !== "equal").map((part) => part.kind),
    ["delete"]
  );

  const replacement = contentFeedbackRevisionDiff(
    "The event was held outside today.",
    "The event was held outdoors today."
  );
  assert.equal(replacement.mode, "inline");
  assert.deepEqual(
    replacement.parts.filter((part) => part.kind !== "equal").map((part) => part.kind),
    ["replace"]
  );
});

test("one feedback can contain insert, delete, and replace markers together", () => {
  const original = "We visit parks with old signs and read maps today.";
  const proposed = "We often visit parks with signs and study maps carefully today.";
  const feedback = {
    ...revision,
    feedback_id: "mixed-changes",
    start: 0,
    end: original.length,
    original_sentence: original,
    proposed_revision: proposed
  };
  const result = buildWritingRevisionComposition(original, [], [feedback]);
  const markers = result.trackedChangeSegments.filter(
    (item) => item.kind === "content_feedback_inline"
  );
  assert.deepEqual(new Set(markers.map((item) => item.changeKind)), new Set(["insert", "delete", "replace"]));
  assert.equal(markers.every((item) => item.feedback.feedback_id === "mixed-changes"), true);
});

test("a broad rewrite remains one inline full-sentence suggestion annotation", () => {
  const original = "Students learn many things from their families and schools.";
  const proposed = "Modern education systems should completely redesign curricula around lifelong interdisciplinary projects.";
  const feedback = {
    ...revision,
    feedback_id: "large-rewrite",
    start: 0,
    end: original.length,
    original_sentence: original,
    proposed_revision: proposed
  };
  assert.deepEqual(contentFeedbackRevisionDiff(original, proposed), { mode: "rewrite" });
  const result = buildWritingRevisionComposition(original, [], [feedback]);
  assert.equal(result.trackedChangeSegments.filter((item) => item.kind === "content_revision").length, 1);
  assert.equal(result.trackedChangeSegments.some((item) => item.kind === "content_feedback_inline"), false);
});

test("local Content Feedback still suppresses an overlapping Language Edit", () => {
  const original = "This idea is helpful for college students today.";
  const proposed = "This idea is highly beneficial for college students today.";
  const start = original.indexOf("helpful");
  const edit = {
    ...firstEdit,
    edit_id: "covered-edit",
    start,
    end: start + "helpful".length,
    original_text: "helpful",
    replacement_text: "useful"
  };
  const feedback = {
    ...revision,
    feedback_id: "local-priority",
    start: 0,
    end: original.length,
    original_sentence: original,
    proposed_revision: proposed
  };
  const result = buildWritingRevisionComposition(original, [edit], [feedback]);
  assert.equal(result.suppressedLanguageEditIds.has("covered-edit"), true);
  assert.equal(result.trackedChangeSegments.some((item) => item.kind === "language_edit"), false);
  assert.equal(result.trackedChangeSegments.some((item) => item.kind === "content_feedback_inline"), true);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  adjacentLanguageEditId,
  buildWorkspaceAnnotationSegments,
  calculateContainedScrollTop,
  countTeacherEditedLanguageEdits,
  createTeacherContentFeedback,
  createTeacherLanguageEdit,
  filterLanguageEdits,
  hasWritingReviewTeacherContent,
  isLocatedContentFeedback,
  languageEditDisplayRange,
  mergeRegeneratedDraftPreservingTeacherItems,
  mergeRegeneratedFeedback,
  overlapsLanguageEdit,
  selectionActionPosition,
  sourceTextSelection,
  updateDimensionScoreBasis,
  updateDimensionTeacherScore,
  updateOfficialScoreRationale,
  updateOfficialTeacherScore,
  writingDimensionDefinitions,
  writingFeedbackCategoryDefinitions,
  writingLanguageEditCategoryDefinitions
} = require("../lib/writingReviewWorkspaceUi.ts");

const responseText = "Cities should invests in transit. Better buses reduce traffic.";
const editStart = responseText.indexOf("invests");
const feedbackSentence = "Cities should invests in transit.";

function edit(overrides = {}) {
  return {
    edit_id: "edit-1",
    start: editStart,
    end: editStart + "invests".length,
    original_text: "invests",
    replacement_text: "invest",
    category: "grammar",
    severity: "major",
    explanation: "情态动词后应使用动词原形。",
    restored: false,
    ...overrides
  };
}

function locatedFeedback(overrides = {}) {
  return {
    feedback_id: "feedback-1",
    start: 0,
    end: feedbackSentence.length,
    original_sentence: feedbackSentence,
    category: "elaboration",
    issue: "这一观点需要进一步展开。",
    suggestion: "补充公共交通如何减少拥堵的具体机制。",
    example: "Reliable buses can encourage commuters to leave their cars at home.",
    proposed_revision: "Cities should invest in transit because reliable buses can reduce traffic.",
    included: true,
    ...overrides
  };
}

function draft() {
  return {
    language_edits: [edit()],
    scores: emailScores(),
    content_feedback: {
      items: [locatedFeedback(), locatedFeedback({ feedback_id: "feedback-2", included: false })],
      overall_feedback: "文章观点明确，但展开不足。",
      rubric_analysis: {}
    },
    teacher_comment: "保留这条未保存的教师评语。"
  };
}

function emailScores() {
  return {
    official_score: { ai_score: 4, teacher_score: 3, rationale: "文章整体达到较好水平。" },
    dimension_scores: {
      communicative_purpose_and_elaboration: { ai_score: 4, teacher_score: 4, ai_basis: "任务回应清楚。" },
      syntactic_range_and_word_choice: { ai_score: 3, teacher_score: 3, ai_basis: "句式范围一般。" },
      social_conventions: { ai_score: 4, teacher_score: 4, ai_basis: "语气得体。" },
      lexical_and_grammatical_control: { ai_score: 3, teacher_score: 3, ai_basis: "有少量语法问题。" }
    }
  };
}

function cleanAiDraft() {
  const current = draft();
  current.teacher_comment = "";
  current.scores.official_score.teacher_score =
    current.scores.official_score.ai_score;
  Object.values(current.scores.dimension_scores).forEach((dimension) => {
    dimension.teacher_score = dimension.ai_score;
  });
  current.content_feedback.items = current.content_feedback.items.map((item) => ({
    ...item,
    included: true
  }));
  return current;
}

function aiRawForDraft(current = cleanAiDraft()) {
  return {
    schema_version: "2.2",
    language_edits: current.language_edits.map((item) => ({
      edit_id: item.edit_id,
      replacement_text: item.replacement_text
    })),
    scores: {
      official_score: {
        ai_score: current.scores.official_score.ai_score,
        rationale: current.scores.official_score.rationale
      },
      dimension_scores: Object.fromEntries(
        Object.entries(current.scores.dimension_scores).map(([key, dimension]) => [
          key,
          { ai_score: dimension.ai_score, ai_basis: dimension.ai_basis }
        ])
      )
    },
    overall_feedback: current.content_feedback.overall_feedback
  };
}

test("Email v2 exposes exactly the four Email diagnostic dimensions", () => {
  assert.deepEqual(
    writingDimensionDefinitions("email").map((item) => item.key),
    [
      "communicative_purpose_and_elaboration",
      "syntactic_range_and_word_choice",
      "social_conventions",
      "lexical_and_grammatical_control"
    ]
  );
});

test("Academic Discussion v2 exposes exactly its four diagnostic dimensions", () => {
  assert.deepEqual(
    writingDimensionDefinitions("academic_discussion").map((item) => item.key),
    ["relevance", "elaboration", "syntactic_range_and_word_choice", "lexical_and_grammatical_control"]
  );
});

test("task-specific dimensions never leak into the other task", () => {
  assert.equal(writingDimensionDefinitions("email").some((item) => item.key === "relevance"), false);
  assert.equal(writingDimensionDefinitions("academic_discussion").some((item) => item.key === "social_conventions"), false);
});

test("dimension teacher score changes independently from official holistic score", () => {
  const before = emailScores();
  const after = updateDimensionTeacherScore(before, "social_conventions", 2);
  assert.equal(after.dimension_scores.social_conventions.teacher_score, 2);
  assert.equal(after.official_score.teacher_score, 3);
  assert.equal(after.dimension_scores.communicative_purpose_and_elaboration.teacher_score, 4);
});

test("official holistic teacher score changes without recalculating dimensions", () => {
  const before = emailScores();
  const after = updateOfficialTeacherScore(before, 5);
  assert.equal(after.official_score.teacher_score, 5);
  assert.deepEqual(after.dimension_scores, before.dimension_scores);
});

test("dimension basis and official reference update the existing final fields", () => {
  const before = emailScores();
  const dimensionUpdated = updateDimensionScoreBasis(
    before,
    "social_conventions",
    "教师最终单项依据"
  );
  assert.equal(
    dimensionUpdated.dimension_scores.social_conventions.ai_basis,
    "教师最终单项依据"
  );
  assert.equal(
    dimensionUpdated.dimension_scores.social_conventions.teacher_score,
    before.dimension_scores.social_conventions.teacher_score
  );
  const officialUpdated = updateOfficialScoreRationale(
    dimensionUpdated,
    "教师最终总分参考"
  );
  assert.equal(officialUpdated.official_score.rationale, "教师最终总分参考");
  assert.equal(
    officialUpdated.official_score.teacher_score,
    before.official_score.teacher_score
  );
});

test("teacher-content detection stays false for an untouched AI draft", () => {
  const current = cleanAiDraft();
  assert.equal(
    hasWritingReviewTeacherContent(current, aiRawForDraft(current), true),
    false
  );
});

test("teacher-content detection includes teacher-source edits and feedback", () => {
  const teacherEditDraft = cleanAiDraft();
  teacherEditDraft.language_edits.push(edit({
    edit_id: "teacher-edit",
    source: "teacher"
  }));
  assert.equal(
    hasWritingReviewTeacherContent(
      teacherEditDraft,
      aiRawForDraft(cleanAiDraft()),
      true
    ),
    true
  );

  const teacherFeedbackDraft = cleanAiDraft();
  teacherFeedbackDraft.content_feedback.items.push(
    locatedFeedback({ feedback_id: "teacher-feedback", source: "teacher" })
  );
  assert.equal(
    hasWritingReviewTeacherContent(
      teacherFeedbackDraft,
      aiRawForDraft(cleanAiDraft()),
      true
    ),
    true
  );
});

test("teacher-content detection includes scores, references, and overall evaluation", () => {
  const baseline = cleanAiDraft();
  const raw = aiRawForDraft(baseline);
  const variants = [
    (value) => { value.scores.official_score.teacher_score = 5; },
    (value) => { value.scores.dimension_scores.social_conventions.teacher_score = 2; },
    (value) => { value.scores.official_score.rationale = "教师总分参考"; },
    (value) => { value.scores.dimension_scores.social_conventions.ai_basis = "教师单项依据"; },
    (value) => { value.content_feedback.overall_feedback = "教师总体评价"; }
  ];
  variants.forEach((mutate) => {
    const current = structuredClone(baseline);
    mutate(current);
    assert.equal(hasWritingReviewTeacherContent(current, raw, true), true);
  });
});

test("manual drafts detect filled scoring and overall fields without AI raw data", () => {
  const current = cleanAiDraft();
  current.language_edits = [];
  current.content_feedback.items = [];
  current.scores.official_score.ai_score = 0;
  current.scores.official_score.teacher_score = 0;
  Object.values(current.scores.dimension_scores).forEach((dimension) => {
    dimension.ai_score = 0;
    dimension.teacher_score = 0;
    dimension.ai_basis = "";
  });
  current.scores.official_score.rationale = "";
  current.content_feedback.overall_feedback = "";
  assert.equal(hasWritingReviewTeacherContent(current, null, false), false);
  current.content_feedback.overall_feedback = "首次 AI 前的教师总体评价";
  assert.equal(hasWritingReviewTeacherContent(current, null, false), true);
});

test("major, moderate, and minor filters classify edits correctly", () => {
  const edits = [
    edit(),
    edit({ edit_id: "edit-2", severity: "moderate" }),
    edit({ edit_id: "edit-3", severity: "minor" })
  ];
  assert.equal(filterLanguageEdits(edits, "all").length, 3);
  assert.deepEqual(filterLanguageEdits(edits, "major").map((item) => item.edit_id), ["edit-1"]);
  assert.deepEqual(filterLanguageEdits(edits, "moderate").map((item) => item.edit_id), ["edit-2"]);
  assert.deepEqual(filterLanguageEdits(edits, "minor").map((item) => item.edit_id), ["edit-3"]);
});

test("workspace segments always display original text regardless of adoption", () => {
  const restored = buildWorkspaceAnnotationSegments(responseText, [edit({ restored: true })], []);
  const applied = buildWorkspaceAnnotationSegments(responseText, [edit({ restored: false })], []);
  assert.equal(restored.find((segment) => segment.edit).displayText, "invests");
  assert.equal(applied.find((segment) => segment.edit).displayText, "invests");
});

test("teacher replacement stays out of workspace text without changing original offsets", () => {
  const changed = edit({ replacement_text: "put more money" });
  const segment = buildWorkspaceAnnotationSegments(responseText, [changed], []).find((item) => item.edit);
  assert.equal(segment.displayText, "invests");
  assert.equal(segment.start, editStart);
  assert.equal(segment.end, editStart + "invests".length);
  assert.equal(responseText.slice(segment.start, segment.end), "invests");
});

test("previous and next edit navigation wraps within the filtered list", () => {
  const edits = [edit(), edit({ edit_id: "edit-2" }), edit({ edit_id: "edit-3" })];
  assert.equal(adjacentLanguageEditId(edits, "edit-1", 1), "edit-2");
  assert.equal(adjacentLanguageEditId(edits, "edit-1", -1), "edit-3");
  assert.equal(adjacentLanguageEditId(edits, "edit-3", 1), "edit-1");
});

test("edited count compares current replacement text with immutable ai_review_raw", () => {
  const raw = {
    schema_version: "2.0",
    language_edits: [{ edit_id: "edit-1", replacement_text: "invest" }]
  };
  assert.equal(countTeacherEditedLanguageEdits(raw, [edit()]), 0);
  assert.equal(countTeacherEditedLanguageEdits(raw, [edit({ replacement_text: "put money" })]), 1);
  assert.equal(countTeacherEditedLanguageEdits({}, [edit()]), null);
});

test("sentence feedback is located against exact response_text", () => {
  assert.equal(isLocatedContentFeedback(locatedFeedback()), true);
  const segments = buildWorkspaceAnnotationSegments(responseText, [], [locatedFeedback()]);
  assert.equal(segments.some((segment) => segment.feedbackIds.includes("feedback-1")), true);
  assert.equal(segments.flatMap((segment) => segment.feedbackStarts).includes("feedback-1"), true);
});

test("feedback and nested language edit annotations coexist on original coordinates", () => {
  const segments = buildWorkspaceAnnotationSegments(responseText, [edit()], [locatedFeedback()]);
  const editedSegment = segments.find((segment) => segment.edit?.edit_id === "edit-1");
  assert.equal(editedSegment.displayText, "invests");
  assert.deepEqual(editedSegment.feedbackIds, ["feedback-1"]);
  assert.equal(responseText.slice(editedSegment.start, editedSegment.end), "invests");
});

test("one feedback marker range can contain multiple independent language edit segments", () => {
  const original = "In my opinion, teenage years is crucial as it may decided how people will being.";
  const edits = [
    ["is", "are"],
    ["decided", "decide"],
    ["people will being", "people will be"]
  ].map(([originalText, replacementText], index) => {
    const start = original.indexOf(originalText);
    return {
      edit_id: `edit-${index + 1}`,
      start,
      end: start + originalText.length,
      original_text: originalText,
      replacement_text: replacementText,
      category: "grammar",
      severity: "moderate",
      explanation: "测试修改。",
      restored: false
    };
  });
  const feedback = locatedFeedback({
    start: 0,
    end: original.length,
    original_sentence: original
  });
  const segments = buildWorkspaceAnnotationSegments(original, edits, [feedback]);
  assert.deepEqual(
    segments.filter((segment) => segment.edit).map((segment) => segment.edit.edit_id),
    ["edit-1", "edit-2", "edit-3"]
  );
  assert.equal(segments.flatMap((segment) => segment.feedbackStarts).filter((id) => id === "feedback-1").length, 1);
  assert.equal(segments.filter((segment) => segment.edit).every(
    (segment) => segment.feedbackIds.includes("feedback-1")
  ), true);
});

test("invalid feedback location is rejected instead of guessed", () => {
  assert.throws(
    () => buildWorkspaceAnnotationSegments(responseText, [], [locatedFeedback({ start: 1 })]),
    /内容反馈 offset 无效/
  );
});

test("included=false remains a working-draft flag and feedback is not deleted", () => {
  const current = draft();
  assert.equal(current.content_feedback.items.length, 2);
  assert.equal(current.content_feedback.items[1].included, false);
});

test("feedback regeneration merges only suggestion and proposed revision", () => {
  const before = draft();
  const after = mergeRegeneratedFeedback(before, {
    feedback_id: "feedback-1",
    suggestion: "新的中文建议。",
    proposed_revision: "A directly revised sentence."
  });
  const oldTarget = before.content_feedback.items[0];
  const target = after.content_feedback.items[0];
  assert.equal(target.suggestion, "新的中文建议。");
  assert.equal(target.example, oldTarget.example);
  assert.equal(target.proposed_revision, "A directly revised sentence.");
  for (const key of ["feedback_id", "start", "end", "original_sentence", "category", "issue", "included"]) {
    assert.deepEqual(target[key], oldTarget[key]);
  }
});

test("feedback regeneration preserves every other local unsaved change", () => {
  const before = draft();
  before.language_edits[0].replacement_text = "fund";
  before.scores.official_score.teacher_score = 5;
  const after = mergeRegeneratedFeedback(before, {
    feedback_id: "feedback-1",
    suggestion: "新建议。",
    proposed_revision: "A revised sentence."
  });
  assert.equal(after.teacher_comment, "保留这条未保存的教师评语。");
  assert.equal(after.language_edits[0].replacement_text, "fund");
  assert.equal(after.scores.official_score.teacher_score, 5);
  assert.deepEqual(after.content_feedback.items[1], before.content_feedback.items[1]);
});

test("feedback category tabs are task-specific", () => {
  assert.deepEqual(writingFeedbackCategoryDefinitions("email").map((item) => item.key), [
    "communicative_purpose", "elaboration", "social_conventions", "organization", "language_improvement"
  ]);
  assert.deepEqual(writingFeedbackCategoryDefinitions("academic_discussion").map((item) => item.key), [
    "relevance", "elaboration", "discussion_contribution", "organization", "language_improvement"
  ]);
});

test("teacher language categories exclude social conventions while content categories stay task-specific", () => {
  assert.deepEqual(writingLanguageEditCategoryDefinitions().map((item) => item.key), [
    "grammar", "spelling", "capitalization", "punctuation", "word_choice",
    "word_form", "syntax", "usage", "other"
  ]);
  assert.equal(
    writingFeedbackCategoryDefinitions("email").some((item) => item.key === "social_conventions"),
    true
  );
  assert.equal(
    writingFeedbackCategoryDefinitions("academic_discussion").some((item) => item.key === "social_conventions"),
    false
  );
});

for (const [original_text, replacement_text, expected] of [
  ["some issue", "some issues", { changedOriginal: "issue", localStart: 5, localEnd: 10 }],
  ["I avoided conversations", "I avoid conversations", { changedOriginal: "avoided", localStart: 2, localEnd: 9 }],
  ["air conditionar", "air conditioner", { changedOriginal: "conditionar", localStart: 4, localEnd: 15 }],
  ["Hello!", "Hello.", { changedOriginal: "!", localStart: 5, localEnd: 6 }],
  ["Email", "email", { changedOriginal: "Email", localStart: 0, localEnd: 5 }],
  ["go home", "go straight home", { changedOriginal: "", localStart: 3, localEnd: 3 }],
  ["very useful", "useful", { changedOriginal: "very ", localStart: 0, localEnd: 5 }]
]) {
  test(`language edit display range isolates ${JSON.stringify(original_text)} -> ${JSON.stringify(replacement_text)}`, () => {
    const result = languageEditDisplayRange({ start: 20, original_text, replacement_text });
    assert.equal(result.changedOriginal, expected.changedOriginal);
    assert.equal(result.localStart, expected.localStart);
    assert.equal(result.localEnd, expected.localEnd);
    assert.equal(result.sourceStart, 20 + expected.localStart);
    assert.equal(result.sourceEnd, 20 + expected.localEnd);
  });
}

test("selection action is centered above the range, falls below, and stays in viewport", () => {
  assert.deepEqual(
    selectionActionPosition(
      { left: 300, right: 380, top: 200, bottom: 220, width: 80 },
      800,
      600
    ),
    { left: 276, top: 158 }
  );
  assert.deepEqual(
    selectionActionPosition(
      { left: 2, right: 42, top: 10, bottom: 30, width: 40 },
      320,
      200
    ),
    { left: 12, top: 38 }
  );
});

test("source selection maps exact offsets across annotation boundaries", () => {
  const start = responseText.indexOf("should");
  const end = responseText.indexOf(" transit") + " transit".length;
  assert.deepEqual(sourceTextSelection(responseText, end, start), {
    start,
    end,
    originalText: responseText.slice(start, end)
  });
  assert.equal(sourceTextSelection(responseText, start, start), null);
  assert.equal(sourceTextSelection(responseText, -1, end), null);
});

test("teacher language edit uses existing category definitions and working defaults", () => {
  assert.equal(
    writingLanguageEditCategoryDefinitions().some(
      (category) => category.key === "word_choice" && category.label === "用词"
    ),
    true
  );
  const selection = sourceTextSelection(responseText, editStart, editStart + 7);
  const teacherEdit = createTeacherLanguageEdit(
    {
      ...selection,
      category: "grammar",
      replacementText: "invest",
      explanation: "教师说明"
    },
    () => "teacher-edit-fixed"
  );
  assert.deepEqual(teacherEdit, {
    edit_id: "teacher-edit-fixed",
    source: "teacher",
    start: editStart,
    end: editStart + 7,
    original_text: "invests",
    replacement_text: "invest",
    category: "grammar",
    severity: "moderate",
    explanation: "教师说明",
    restored: false
  });
});

test("teacher feedback accepts a non-sentence selection and optional empty revision", () => {
  const start = responseText.indexOf("reduce traffic");
  const selection = sourceTextSelection(responseText, start, start + "reduce traffic".length);
  const teacherFeedback = createTeacherContentFeedback(
    {
      ...selection,
      category: "elaboration",
      issue: "需要解释机制。",
      suggestion: "",
      proposedRevision: ""
    },
    () => "teacher-feedback-fixed"
  );
  assert.equal(teacherFeedback.source, "teacher");
  assert.equal(teacherFeedback.original_sentence, "reduce traffic");
  assert.equal(teacherFeedback.proposed_revision, "");
  assert.equal(teacherFeedback.included, true);
});

test("language overlap detects partial, contained, and containing selections", () => {
  const existing = [edit()];
  assert.equal(overlapsLanguageEdit({ start: editStart - 1, end: editStart + 1 }, existing), true);
  assert.equal(overlapsLanguageEdit({ start: editStart + 1, end: editStart + 2 }, existing), true);
  assert.equal(overlapsLanguageEdit({ start: editStart - 2, end: editStart + 9 }, existing), true);
  assert.equal(overlapsLanguageEdit({ start: 0, end: editStart }, existing), false);
});

test("client regenerate keeps unsaved teacher items and removes conflicting AI edit", () => {
  const teacher = createTeacherLanguageEdit(
    {
      start: editStart,
      end: editStart + 7,
      originalText: "invests",
      category: "grammar",
      replacementText: "invest",
      explanation: "教师修改"
    },
    () => "teacher-edit"
  );
  const manualFeedback = createTeacherContentFeedback(
    {
      start: 0,
      end: 6,
      originalText: "Cities",
      category: "elaboration",
      issue: "教师反馈",
      suggestion: "",
      proposedRevision: ""
    },
    () => "teacher-feedback"
  );
  const current = draft();
  current.language_edits = [teacher];
  current.content_feedback.items.push(manualFeedback);
  const regenerated = draft();
  regenerated.language_edits = [edit({ source: "ai", edit_id: "new-ai" })];
  regenerated.content_feedback.items = [locatedFeedback({ source: "ai", feedback_id: "new-ai-feedback" })];
  const merged = mergeRegeneratedDraftPreservingTeacherItems(
    responseText,
    regenerated,
    current
  );
  assert.deepEqual(merged.language_edits.map((item) => item.edit_id), ["teacher-edit"]);
  assert.deepEqual(
    merged.content_feedback.items.map((item) => item.feedback_id),
    ["new-ai-feedback", "teacher-feedback"]
  );
});

test("contained feedback scrolling uses the right container coordinate system", () => {
  assert.equal(
    calculateContainedScrollTop({
      containerScrollTop: 640,
      containerTop: 100,
      targetTop: 360,
      offset: 18
    }),
    882
  );
  assert.equal(
    calculateContainedScrollTop({
      containerScrollTop: 0,
      containerTop: 100,
      targetTop: 80,
      offset: 18
    }),
    0
  );
});

test("workspace defaults to three-column mode and keeps Save, Publish, and legacy guard", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/teacher/TeacherWritingReviewWorkspace.tsx"),
    "utf8"
  );
  assert.match(source, /useState<WorkspaceMode>\("workspace"\)/);
  assert.match(source, /type WorkspaceMode = "workspace" \| "original" \| "revised"/);
  assert.match(source, /data\.attempt\.response_text/);
  assert.match(source, /method: publish \? "POST" : "PATCH"/);
  assert.match(source, /旧版反馈不支持句子定位/);
  assert.match(source, /located \? \(/);
});

test("Email compact question excludes closing instruction, To, and Subject", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/teacher/TeacherWritingReviewWorkspace.tsx"),
    "utf8"
  );
  const compact = source.slice(source.indexOf("function CompactEmailQuestion"), source.indexOf("function AcademicQuestionContent"));
  assert.match(compact, /question\.scenario/);
  assert.match(compact, /question\.task_instruction/);
  assert.match(compact, /question\.requirement_1/);
  assert.equal(/closing_instruction|recipient|subject|To:|Subject:/.test(compact), false);
});

test("Academic Discussion compact question keeps names and content without role labels", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/teacher/TeacherWritingReviewWorkspace.tsx"),
    "utf8"
  );
  const compact = source.slice(source.indexOf("function AcademicQuestionContent"), source.indexOf("function AnnotatedText"));
  assert.match(compact, /professor_name/);
  assert.match(compact, /professor_prompt/);
  assert.match(compact, /student_1_name/);
  assert.match(compact, /student_2_response/);
  assert.doesNotMatch(compact, /label="Professor"|label="Student 1"|label="Student 2"/);
  assert.doesNotMatch(compact, /uppercase tracking-wide/);
  assert.equal(/task instruction|Express and support|effective response/i.test(compact), false);
});

test("middle article has inline annotation and no permanent detail column", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/teacher/TeacherWritingReviewWorkspace.tsx"),
    "utf8"
  );
  assert.doesNotMatch(source, /xl:grid-cols-\[minmax\(0,65fr\)/);
  assert.match(source, /data-floating-inspector/);
  assert.match(source, /function WorkspaceEditMarker/);
  assert.match(source, /data-source-text/);
  assert.match(source, /languageEditDisplayRange\(edit\)/);
  assert.match(source, /displayRange\.changedOriginal/);
  assert.doesNotMatch(source, /outline outline-2|border-red-500|border-emerald-500/);
  assert.match(source, /languageEditSeverityMarkerClass/);
  const ui = fs.readFileSync(
    path.join(process.cwd(), "lib/writingReviewWorkspaceUi.ts"),
    "utf8"
  );
  assert.match(ui, /bg-red-50/);
  assert.match(ui, /bg-amber-50/);
  assert.match(ui, /bg-emerald-50/);
  assert.doesNotMatch(source, /opacity-35/);
});

test("original and revised are independent full-width modes with teacher-style marker-only presentation", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/teacher/TeacherWritingReviewWorkspace.tsx"),
    "utf8"
  );
  const renderer = fs.readFileSync(
    path.join(process.cwd(), "components/writing/WritingRevisionMarkedText.tsx"),
    "utf8"
  );
  assert.match(source, /mode === "original"/);
  assert.match(source, /mode === "revised"/);
  assert.match(source, /showRevisionMarks/);
  assert.match(source, /<WritingRevisionMarkedText/);
  assert.match(source, /composition=\{revisionComposition\}/);
  assert.match(source, /markerSegments=\{annotationSegments\}/);
  assert.match(renderer, /feedbackStarts\.map/);
  assert.match(renderer, /languageEditDisplayRange\(edit\)/);
  assert.match(renderer, /marksVisible\) \{/);
  assert.doesNotMatch(renderer, /<del|<ins|contentFeedbackMarkedDetails|content_feedback_inline|【建议改为/);
  assert.match(source, /返回工作台/);
  assert.match(source, /w-\[min\(1400px,calc\(100vw-100px\)\)\]/);
});

test("workspace middle column always renders annotated response_text instead of revised composition", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/teacher/TeacherWritingReviewWorkspace.tsx"),
    "utf8"
  );
  const workspace = source.slice(
    source.indexOf('<section className="writing-review-column min-w-0 bg-white">'),
    source.indexOf('<aside className="writing-review-column')
  );
  assert.match(workspace, /<AnnotatedText/);
  assert.match(workspace, /segments=\{annotationSegments\}/);
  assert.doesNotMatch(workspace, /WorkspaceRevisionText|revisionComposition/);
  assert.match(workspace, /学生原文（批改标记）/);
});

test("selection UI uses explicit source anchors and offers shared category groups", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/teacher/TeacherWritingReviewWorkspace.tsx"),
    "utf8"
  );
  assert.match(source, /data-source-start/);
  assert.match(source, /data-source-end/);
  assert.match(source, /mapBrowserSelectionToSource/);
  assert.match(source, /range\.getBoundingClientRect\(\)/);
  assert.match(source, /range\.getClientRects\(\)/);
  assert.match(source, /addEventListener\("scroll", refreshSelectionPosition, true\)/);
  assert.match(source, /addEventListener\("resize", refreshSelectionPosition\)/);
  assert.match(source, /addEventListener\("selectionchange", refreshSelectionPosition\)/);
  assert.match(source, /article\.contains\(range\.startContainer\)/);
  assert.match(source, /article\.contains\(range\.endContainer\)/);
  assert.match(source, /添加批改/);
  assert.match(source, /<optgroup label="语言修改">/);
  assert.match(source, /<optgroup label="内容与结构反馈">/);
  assert.match(source, /writingLanguageEditCategoryDefinitions/);
  assert.match(source, /writingFeedbackCategoryDefinitions\(taskType\)/);
  assert.match(source, /LANGUAGE_EDIT_OVERLAP_MESSAGE/);
});

test("teacher forms use at-least-one-content validation for create and edit", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/teacher/TeacherWritingReviewWorkspace.tsx"),
    "utf8"
  );
  assert.match(source, /TEACHER_REVIEW_CONTENT_REQUIRED_MESSAGE/);
  assert.match(source, /hasTeacherLanguageEditContent/);
  assert.match(source, /hasTeacherContentFeedbackContent/);
  assert.doesNotMatch(source, /请填写修改后的文本|请填写问题或修改意见/);
  assert.doesNotMatch(source, /disabled=\{!teacherIssue\.trim\(\)\}/);
});

test("feedback cards hide example but keep issue suggestion revision and actions", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/teacher/TeacherWritingReviewWorkspace.tsx"),
    "utf8"
  );
  const card = source.slice(source.indexOf("function FeedbackCard"), source.indexOf("function CompactSection"));
  assert.doesNotMatch(card, /label="示例"|item\.example/);
  assert.match(card, /label="问题"/);
  assert.match(card, /label="建议"/);
  assert.match(card, /label="建议改写"/);
  assert.match(card, /不采用|恢复采用/);
  assert.match(card, /重新生成/);
  assert.match(card, /workingReviewItemSource\(item\) === "teacher"/);
  assert.match(card, /hasApplicableContentRevision\(item\) && !teacherSource/);
  assert.match(card, /删除/);
  assert.match(card, /SourceBadge/);
});

test("full-width original and revised modes share compressed typography", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/teacher/TeacherWritingReviewWorkspace.tsx"),
    "utf8"
  );
  const article = source.slice(source.indexOf("function FullscreenArticle"), source.indexOf("function QuestionColumn"));
  assert.match(article, /p-3 lg:p-5/);
  assert.match(article, /p-5 text-\[16px\] leading-7/);
  assert.match(article, /mb-3/);
});

test("feedback localization scrolls the real essay container to 25 percent and highlights one sentence wrapper", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/teacher/TeacherWritingReviewWorkspace.tsx"),
    "utf8"
  );
  assert.match(source, /articleScrollRef\.current\?\.clientHeight[\s\S]*0\.25/);
  assert.match(source, /highlightedEssayFeedbackId/);
  assert.match(source, /setTimeout\([\s\S]*1100/);
  assert.match(source, /data-feedback-id=\{segment\.feedback\.feedback_id\}/);
});

test("score bases and official reference use compact editable final fields", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/teacher/TeacherWritingReviewWorkspace.tsx"),
    "utf8"
  );
  const scorePanel = source.slice(
    source.indexOf("function ScorePanel"),
    source.indexOf("function FeedbackPanel")
  );
  assert.match(scorePanel, /<span>依据<\/span>/);
  assert.match(scorePanel, /value=\{dimension\.ai_basis\}/);
  assert.match(scorePanel, /updateDimensionScoreBasis/);
  assert.match(scorePanel, />\s*参考\s*<textarea/);
  assert.match(scorePanel, /value=\{scores\.official_score\.rationale\}/);
  assert.match(scorePanel, /updateOfficialScoreRationale/);
  assert.doesNotMatch(scorePanel, /AI 依据|AI 参考|AI 整体评分依据/);
  assert.match(scorePanel, /h-14[\s\S]*resize-none/);
  assert.match(scorePanel, /h-16[\s\S]*resize-none/);
});

test("official score restores read-only AI total beside editable teacher total", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/teacher/TeacherWritingReviewWorkspace.tsx"),
    "utf8"
  );
  const scorePanel = source.slice(
    source.indexOf("function ScorePanel"),
    source.indexOf("function FeedbackPanel")
  );
  assert.match(
    scorePanel,
    /AI：\{hasAiReview \? scores\.official_score\.ai_score : "—"\}/
  );
  assert.match(scorePanel, /教师最终[\s\S]*<ScoreSelect/);
  assert.match(scorePanel, /value=\{scores\.official_score\.teacher_score\}/);
});

test("workspace uses one editable overall evaluation field", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/teacher/TeacherWritingReviewWorkspace.tsx"),
    "utf8"
  );
  assert.equal((source.match(/title="总体评价"/g) ?? []).length, 1);
  assert.doesNotMatch(source, /title="AI 总体评价"|title="总体反馈"/);
  assert.match(source, /overall_feedback: event\.target\.value/);
  assert.match(source, /value=\{draft\.content_feedback\.overall_feedback\}/);
  assert.doesNotMatch(source, /value=\{draft\.teacher_comment\}/);
});

test("AI generation asks only when current or dirty teacher content exists", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/teacher/TeacherWritingReviewWorkspace.tsx"),
    "utf8"
  );
  assert.match(source, /dirty \|\|[\s\S]*hasWritingReviewTeacherContent/);
  assert.match(source, /void regenerateAll\("preserve"\)/);
  assert.match(source, /当前批改中已有教师输入内容。生成 AI 初批时如何处理？/);
  assert.match(source, /保留教师内容并生成/);
  assert.match(source, /覆盖教师内容并生成/);
  assert.match(source, />\s*取消\s*</);
  assert.match(source, /onCancel=\{\(\) => setTeacherContentConfirmOpen\(false\)\}/);
  assert.match(source, /mergeRegeneratedDraftPreservingTeacherItems/);
  assert.match(source, /setSelectedEditId\(null\)/);
  assert.match(source, /setSelectedFeedbackId\(null\)/);
  assert.match(source, /setFilter\("all"\)/);
});

test("review list only opens the workspace and the workspace owns initial AI generation", () => {
  const list = fs.readFileSync(
    path.join(process.cwd(), "components/teacher/TeacherWritingReviewList.tsx"),
    "utf8"
  );
  const page = fs.readFileSync(
    path.join(process.cwd(), "app/teacher/writing/reviews/page.tsx"),
    "utf8"
  );
  const workspace = fs.readFileSync(
    path.join(process.cwd(), "components/teacher/TeacherWritingReviewWorkspace.tsx"),
    "utf8"
  );
  assert.match(page, /action=\{[\s\S]*AI 调用日志/);
  assert.doesNotMatch(list, /generate-ai|generateAI|AI 初批失败/);
  assert.match(list, /href=\{teacherWritingReviewWorkspaceHref\([\s\S]*attempt\.attemptId,[\s\S]*"\/teacher\/writing\/reviews"/);
  assert.match(list, />\s*查看\s*</);
  assert.match(workspace, /data\.review\.has_ai_review[\s\S]*重新生成 AI 初批[\s\S]*AI 初批/);
  assert.match(workspace, /generateInitialReview[\s\S]*\/generate-ai/);
});

test("workspace mutations use a synchronous click lock and confirm unknown outcomes", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/teacher/TeacherWritingReviewWorkspace.tsx"),
    "utf8"
  );
  assert.match(source, /operationRef\.current = "regenerate";[\s\S]*setOperation\("regenerate"\)/);
  assert.match(source, /operationRef\.current = nextOperation;[\s\S]*setOperation\(nextOperation\)/);
  assert.match(source, /disabled=\{operation !== null\}[\s\S]*onClick=\{onRegenerate\}[\s\S]*type="button"/);
  assert.match(source, /confirmUnknownWritingReviewOutcome\([\s\S]*"generate"/);
  assert.match(source, /publish \? "publish" : "save"/);
  assert.match(source, /WritingReviewNetworkOutcomeUnknownError/);
});

test("preserve saves dirty work first while overwrite discards local merge", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/teacher/TeacherWritingReviewWorkspace.tsx"),
    "utf8"
  );
  const regenerate = source.slice(
    source.indexOf("async function regenerateAll"),
    source.indexOf("async function persist")
  );
  assert.match(regenerate, /teacherContentMode === "preserve" && dirty[\s\S]*mutateWorkspace\(attemptId, draft, false\)/);
  assert.match(regenerate, /teacherContentMode === "preserve"[\s\S]*mergeRegeneratedDraftPreservingTeacherItems[\s\S]*: regeneratedDraft/);
  assert.match(regenerate, /regenerateFullReview\(attemptId, teacherContentMode\)/);
  assert.match(regenerate, /generateInitialReview\(attemptId, teacherContentMode\)/);
  assert.match(regenerate, /catch \(regenerationError\)[\s\S]*setRequestError/);
  assert.doesNotMatch(regenerate, /setDraft\(null\)|cache\.invalidate\(cacheKey\)/);
  assert.match(source, /data\.review\.status === "pending"[\s\S]*"待批改"/);
  assert.match(source, /data\.review\.status === "pending"[\s\S]*"尚未保存"/);
  assert.match(source, /value=\{scores\.official_score\.rationale\}/);
  assert.match(source, /regenerate-ai\?teacher_content=\$\{teacherContentMode\}/);
  assert.match(source, /generate-ai\?teacher_content=\$\{teacherContentMode\}/);
});

test("feedback tabs explicitly scroll the right column and synchronize selection", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/teacher/TeacherWritingReviewWorkspace.tsx"),
    "utf8"
  );
  assert.match(source, /scrollTargetWithinContainer\(rightColumnRef\.current/);
  assert.match(source, /onSelectFeedbackId\(first\.feedback_id\)/);
  assert.match(source, /calculateContainedScrollTop/);
});

test("immersive shell uses fixed hover overlays without reserving layout space", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/teacher/TeacherAppShell.tsx"),
    "utf8"
  );
  assert.match(source, /data-immersive-trigger="header"/);
  assert.match(source, /data-immersive-trigger="sidebar"/);
  assert.match(source, /fixed inset-x-0 top-0/);
  assert.match(source, /-translate-y-full/);
  assert.match(source, /-translate-x-full/);
  assert.match(source, /setTimeout\(\(\) => setHeaderOverlayOpen\(false\), 450\)/);
  assert.match(source, /setTimeout\(\(\) => setSidebarOverlayOpen\(false\), 450\)/);
  assert.match(source, /data-immersive-trigger="header"[\s\S]*onMouseLeave=\{hideHeaderOverlaySoon\}/);
  assert.match(source, /data-immersive-trigger="sidebar"[\s\S]*onMouseLeave=\{hideSidebarOverlaySoon\}/);
});

test("desktop workspace CSS defines a three-column independently clipped layout", () => {
  const css = fs.readFileSync(path.join(process.cwd(), "app/globals.css"), "utf8");
  assert.match(css, /grid-template-columns: minmax\(240px, 280px\) minmax\(600px, 1\.4fr\) minmax\(420px, 0\.9fr\)/);
  assert.match(css, /\.writing-review-column[\s\S]*min-height: 0[\s\S]*overflow: hidden/);
  assert.match(css, /@media \(max-width: 1099px\)[\s\S]*flex-direction: column/);
});

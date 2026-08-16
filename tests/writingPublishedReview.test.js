const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const ts = require("typescript");
const {
  hydratePublishedWritingReviewSnapshot,
  orderedPublishedReviewItems,
  publishedReviewItemsForTab
} = require("../lib/writingPublishedReview.ts");
const {
  loadStudentPublishedWritingReview
} = require("../lib/writingPublishedReviewServer.ts");
const {
  buildWritingRevisionComposition
} = require("../lib/writingReviewRevisionComposition.ts");
const {
  buildWorkspaceAnnotationSegments,
  languageEditDisplayRange,
  writingDimensionDefinitions
} = require("../lib/writingReviewWorkspaceUi.ts");

const responseText = "I am write today. This is useful.";
const sentence = "This is useful.";

function publishedScores(taskType = "email", score = 4) {
  const dimension = { ai_score: 4, teacher_score: score, ai_basis: "已发布评分理由。" };
  return {
    official_score: {
      ai_score: 4,
      teacher_score: score,
      rationale: "已发布总分理由。"
    },
    dimension_scores: taskType === "email"
      ? {
          communicative_purpose_and_elaboration: dimension,
          syntactic_range_and_word_choice: dimension,
          social_conventions: dimension,
          lexical_and_grammatical_control: dimension
        }
      : {
          relevance: dimension,
          elaboration: dimension,
          syntactic_range_and_word_choice: dimension,
          lexical_and_grammatical_control: dimension
        }
  };
}

function languageEdit(id = "edit-1", overrides = {}) {
  return {
    edit_id: id,
    start: 2,
    end: 10,
    original_text: "am write",
    replacement_text: "am writing",
    category: "grammar",
    severity: "moderate",
    explanation: "已发布修改说明。",
    ...overrides
  };
}

function contentFeedback(id = "feedback-1", overrides = {}) {
  const start = responseText.indexOf(sentence);
  return {
    feedback_id: id,
    start,
    end: start + sentence.length,
    original_sentence: sentence,
    category: "elaboration",
    issue: "已发布问题。",
    suggestion: "已发布建议。",
    proposed_revision: "This is useful because it saves time.",
    ...overrides
  };
}

function snapshot(overrides = {}) {
  return {
    published_language_edits: [languageEdit()],
    published_scores: publishedScores(),
    published_content_feedback: {
      items: [contentFeedback()],
      overall_feedback: "已发布总体评价。"
    },
    published_teacher_comment: "教师最终总体评价。",
    published_at: "2026-08-15T08:00:00.000Z",
    ...overrides
  };
}

function attempt(id = "attempt-1", userId = "student-1", overrides = {}) {
  return {
    attempt_id: id,
    user_id: userId,
    task_type: "email",
    question_id: "email-1",
    set_id: "set-1",
    response_text: responseText,
    word_count: 8,
    status: "submitted",
    submitted_at: "2026-08-15T07:00:00.000Z",
    ...overrides
  };
}

function review(id = "attempt-1", overrides = {}) {
  return {
    attempt_id: id,
    status: "published",
    language_edits: [languageEdit("working-edit", { replacement_text: "am drafting" })],
    scores: publishedScores("email", 1),
    content_feedback: { items: [], overall_feedback: "未发布 working 内容。" },
    teacher_comment: "未发布 working 评语。",
    ...snapshot(),
    ...overrides
  };
}

function question() {
  return {
    question_id: "email-1",
    set_id: "set-1",
    set_title: "8.15 Email",
    year_month: "202608",
    source_labels: "official",
    scenario: "Scenario",
    task_instruction: "Write an email.",
    requirement_1: "One",
    requirement_2: "Two",
    requirement_3: "Three",
    closing_instruction: "Close it.",
    recipient: "Professor Lee",
    subject: "Extension"
  };
}

test("student can read only an owned submitted attempt with a published snapshot", async () => {
  const db = fakeSupabase({
    writing_attempts: [attempt()],
    writing_reviews: [review()],
    email_questions: [question()]
  });
  const payload = await loadStudentPublishedWritingReview(db, "student-1", "attempt-1");
  assert.equal(payload.attempt.attempt_id, "attempt-1");
  assert.equal(payload.review.scores.official_score.score, 4);
  assert.equal(payload.review.overall_evaluation, "教师最终总体评价。");
  assert.equal(payload.question.scenario, "Scenario");
  assert.equal(payload.question.requirement_3, "Three");
  assert.deepEqual(db.filters.writing_attempts.user_id, ["student-1"]);
  assert.deepEqual(db.filters.writing_attempts.attempt_id, ["attempt-1"]);
});

test("another student's attempt is indistinguishable from a missing attempt", async () => {
  const db = fakeSupabase({
    writing_attempts: [attempt("attempt-1", "student-2")],
    writing_reviews: [review()],
    email_questions: [question()]
  });
  await assert.rejects(
    loadStudentPublishedWritingReview(db, "student-1", "attempt-1"),
    (error) => error.code === "ATTEMPT_NOT_FOUND" && error.status === 404
  );
});

test("a saved but unpublished review cannot be read", async () => {
  const db = fakeSupabase({
    writing_attempts: [attempt()],
    writing_reviews: [review("attempt-1", { status: "reviewing" })],
    email_questions: [question()]
  });
  await assert.rejects(
    loadStudentPublishedWritingReview(db, "student-1", "attempt-1"),
    (error) => error.code === "REVIEW_NOT_PUBLISHED" && error.status === 404
  );
});

test("later working changes do not affect the published snapshot", async () => {
  const db = fakeSupabase({
    writing_attempts: [attempt()],
    writing_reviews: [review()],
    email_questions: [question()]
  });
  const payload = await loadStudentPublishedWritingReview(db, "student-1", "attempt-1");
  assert.equal(payload.review.language_edits[0].edit_id, "edit-1");
  assert.equal(payload.review.language_edits[0].replacement_text, "am writing");
  assert.equal(payload.review.overall_evaluation, "教师最终总体评价。");
  assert.equal(JSON.stringify(payload).includes("working-edit"), false);
  assert.equal(JSON.stringify(payload).includes("未发布 working"), false);
});

test("retakes of the same question remain isolated by attempt_id", async () => {
  const secondSnapshot = snapshot({
    published_language_edits: [languageEdit("edit-retake", { replacement_text: "am emailing" })],
    published_teacher_comment: "第二次提交评价。"
  });
  const db = fakeSupabase({
    writing_attempts: [attempt("attempt-1"), attempt("attempt-2")],
    writing_reviews: [review("attempt-1"), review("attempt-2", secondSnapshot)],
    email_questions: [question()]
  });
  const first = await loadStudentPublishedWritingReview(db, "student-1", "attempt-1");
  const second = await loadStudentPublishedWritingReview(db, "student-1", "attempt-2");
  assert.equal(first.review.language_edits[0].edit_id, "edit-1");
  assert.equal(second.review.language_edits[0].edit_id, "edit-retake");
  assert.equal(second.review.overall_evaluation, "第二次提交评价。");
});

test("student composition uses published markers and content revision priority", () => {
  const nestedStart = responseText.indexOf("useful");
  const hydrated = hydratePublishedWritingReviewSnapshot({
    taskType: "email",
    responseText,
    publishedLanguageEdits: [
      languageEdit(),
      languageEdit("nested", {
        start: nestedStart,
        end: nestedStart + "useful".length,
        original_text: "useful",
        replacement_text: "helpful"
      })
    ],
    publishedScores: publishedScores(),
    publishedContentFeedback: snapshot().published_content_feedback,
    publishedTeacherComment: "",
    publishedAt: snapshot().published_at
  });
  const composition = buildWritingRevisionComposition(
    responseText,
    hydrated.language_edits,
    hydrated.content_feedback.items
  );
  assert.equal(composition.suppressedLanguageEditIds.has("nested"), true);
  assert.equal(composition.activeLanguageEdits[0].edit_id, "edit-1");
  assert.deepEqual(
    orderedPublishedReviewItems({
      language_edits: hydrated.language_edits,
      content_feedback: hydrated.content_feedback
    }).map((item) => [item.kind, item.id]),
    [["language_edit", "edit-1"], ["content_feedback", "feedback-1"], ["language_edit", "nested"]]
  );
});

test("detail collection independently includes language-only and feedback-only annotations", () => {
  const editOnly = orderedPublishedReviewItems({
    language_edits: [languageEdit()],
    content_feedback: { items: [] }
  });
  assert.deepEqual(editOnly.map((item) => [item.kind, item.id]), [
    ["language_edit", "edit-1"]
  ]);

  const feedbackOnly = orderedPublishedReviewItems({
    language_edits: [],
    content_feedback: { items: [contentFeedback()] }
  });
  assert.deepEqual(feedbackOnly.map((item) => [item.kind, item.id]), [
    ["content_feedback", "feedback-1"]
  ]);
});

test("overlap edits remain selectable while clean composition keeps content revision priority", () => {
  const original = "In my opinion, people's teenage years is crucial as it may decided how people will being.";
  const edits = [
    ["is", "are"],
    ["decided", "decide"],
    ["people will being", "people will be"]
  ].map(([originalText, replacementText], index) => {
    const start = original.indexOf(originalText);
    return languageEdit(`e${index + 1}`, {
      start,
      end: start + originalText.length,
      original_text: originalText,
      replacement_text: replacementText
    });
  });
  const feedback = contentFeedback("f2", {
    included: true,
    start: 0,
    end: original.length,
    original_sentence: original,
    proposed_revision: "Teenage years are crucial because they may determine how people will develop."
  });

  const items = orderedPublishedReviewItems({
    language_edits: edits,
    content_feedback: { items: [feedback] }
  });
  const languageItems = publishedReviewItemsForTab(items, "language_edit");
  const feedbackItems = publishedReviewItemsForTab(items, "content_feedback");
  assert.equal(items.length, 4);
  assert.deepEqual(languageItems.map((item) => item.id), ["e1", "e2", "e3"]);
  assert.deepEqual(feedbackItems.map((item) => item.id), ["f2"]);
  assert.deepEqual(["f2", "e1", "e2", "e3"].map(
    (id) => items.find((item) => item.id === id)?.id
  ), ["f2", "e1", "e2", "e3"]);

  const composition = buildWritingRevisionComposition(original, edits, [feedback]);
  assert.deepEqual(
    Array.from(composition.suppressedLanguageEditIds).sort(),
    ["e1", "e2", "e3"]
  );
  assert.equal(composition.activeLanguageEdits.length, 0);
  assert.equal(composition.cleanText, feedback.proposed_revision);
});

test("detail tabs select the first matching marker without creating a feedback list", () => {
  const hydrated = hydratePublishedWritingReviewSnapshot({
    taskType: "email",
    responseText,
    publishedLanguageEdits: [languageEdit()],
    publishedScores: publishedScores(),
    publishedContentFeedback: snapshot().published_content_feedback,
    publishedTeacherComment: "",
    publishedAt: snapshot().published_at
  });
  const items = orderedPublishedReviewItems({
    language_edits: hydrated.language_edits,
    content_feedback: hydrated.content_feedback
  });
  assert.equal(publishedReviewItemsForTab(items, "all")[0].id, "edit-1");
  assert.equal(publishedReviewItemsForTab(items, "language_edit")[0].id, "edit-1");
  assert.equal(publishedReviewItemsForTab(items, "content_feedback")[0].id, "feedback-1");
});

test("detail counts deduplicate multiple inline markers from the same feedback item", () => {
  const original = "This argument is clear, practical, and useful for students today.";
  const proposed = "This argument was clear, persuasive, and useful for college students today.";
  const feedback = contentFeedback("feedback-many", {
    start: 0,
    end: original.length,
    included: true,
    original_sentence: original,
    proposed_revision: proposed
  });
  const composition = buildWritingRevisionComposition(original, [], [feedback]);
  assert.equal(
    composition.trackedChangeSegments.filter((item) => item.kind === "content_feedback_inline").length,
    3
  );
  const items = orderedPublishedReviewItems({
    language_edits: [],
    content_feedback: { items: [feedback] }
  });
  assert.equal(items.length, 1);
  assert.equal(publishedReviewItemsForTab(items, "content_feedback").length, 1);
  assert.equal(items[0].id, "feedback-many");
});

test("marker-only annotation uses the original essay, minimum language range, and one F marker per feedback", () => {
  const original = "Some issue needs a clearer explanation.";
  const issueStart = original.indexOf("issue");
  const feedbackStart = original.indexOf("clearer");
  const edits = [{
    edit_id: "edit-range",
    start: original.indexOf("Some issue"),
    end: original.indexOf("Some issue") + "Some issue".length,
    original_text: "Some issue",
    replacement_text: "Some issues",
    category: "grammar",
    severity: "moderate",
    explanation: "单数名词应改为复数。",
    restored: false
  }];
  const feedback = [
    contentFeedback("feedback-later", {
      start: feedbackStart,
      end: original.length - 1,
      original_sentence: original.slice(feedbackStart, -1),
      proposed_revision: "a much clearer explanation"
    }),
    contentFeedback("feedback-first", {
      start: 0,
      end: original.indexOf(" needs"),
      original_sentence: original.slice(0, original.indexOf(" needs")),
      proposed_revision: "This issue"
    })
  ];
  const segments = buildWorkspaceAnnotationSegments(original, edits, feedback);
  assert.equal(segments.map((segment) => segment.originalText).join(""), original);
  assert.deepEqual(
    Array.from(new Set(segments.flatMap((segment) => segment.feedbackStarts))),
    ["feedback-first", "feedback-later"]
  );
  assert.equal(segments.flatMap((segment) => segment.feedbackStarts).filter((id) => id === "feedback-first").length, 1);
  const display = languageEditDisplayRange(edits[0]);
  assert.equal(original.slice(display.sourceStart, display.sourceEnd), "issue");
  assert.equal(issueStart, display.sourceStart);
});

test("student scoring uses the same task-specific four dimensions as the teacher workspace", () => {
  assert.deepEqual(
    writingDimensionDefinitions("email").map((item) => item.key),
    [
      "communicative_purpose_and_elaboration",
      "syntactic_range_and_word_choice",
      "social_conventions",
      "lexical_and_grammatical_control"
    ]
  );
  assert.deepEqual(
    writingDimensionDefinitions("academic_discussion").map((item) => item.key),
    [
      "relevance",
      "elaboration",
      "syntactic_range_and_word_choice",
      "lexical_and_grammatical_control"
    ]
  );
});

test("student result UI remains read-only and contains no list, sorting, source, or score scale controls", () => {
  const source = read("components/student/StudentWritingReview.tsx");
  const route = read("app/student/writing-reviews/[attemptId]/page.tsx");
  const shell = read("components/student/StudentShell.tsx");
  assert.match(source, />批改稿</);
  assert.match(source, />原文</);
  assert.match(source, />题目</);
  assert.match(source, /\? "修改稿"/);
  assert.equal(source.includes("修改稿（带修改标记）"), false);
  assert.match(source, /当前批改详情/);
  assert.match(source, /全部批改/);
  assert.match(source, /语言错误修改/);
  assert.match(source, /内容反馈/);
  assert.match(source, /评分维度/);
  assert.match(source, /总体评价/);
  for (const forbidden of [
    "隐藏修改标记",
    "按位置排序",
    "Accept",
    "Reject",
    "AI 总评",
    "教师总评",
    "progress bar",
    "included toggle"
  ]) {
    assert.equal(source.includes(forbidden), false, `must not render ${forbidden}`);
  }
  assert.equal(source.includes("items.map((item) => ("), false, "detail area must not render every feedback item");
  assert.equal(route.includes("StudentPage"), false, "immersive route must not use StudentPage");
  assert.match(shell, /pathname\.startsWith\("\/student\/writing-reviews\/"\)/);
  assert.match(source, /attempt\.response_text/);
  assert.match(source, /WritingQuestionReview/);
});

test("student review desktop workspace gives primary panels the remaining height", () => {
  const source = read("components/student/StudentWritingReview.tsx");
  assert.match(source, /lg:h-\[100dvh\]/);
  assert.match(source, /lg:overflow-hidden/);
  assert.match(source, /lg:grid-cols-\[minmax\(0,2fr\)_minmax\(340px,1fr\)\]/);
  assert.equal(
    (source.match(/lg:grid-rows-\[minmax\(0,1fr\)_auto\]/g) ?? []).length,
    2
  );
  assert.doesNotMatch(source, /lg:grid-rows-\[minmax\(0,1\.[0-9]+fr\)/);
  assert.match(source, /grid-cols-\[25%_12%_minmax\(0,1fr\)\]/);
  assert.match(source, /definitions\.map\(\(definition\) =>/);
  assert.match(source, />总分</);
  assert.match(source, /overflow-y-auto/);
});

test("student score panel renders all four task dimensions plus overall with shared collapsed reasons", () => {
  const student = read("components/student/StudentWritingReview.tsx");
  const teacher = read("components/teacher/TeacherWritingReviewWorkspace.tsx");
  const collapsible = read("components/writing/CollapsibleText.tsx");
  assert.equal(writingDimensionDefinitions("email").length, 4);
  assert.equal(writingDimensionDefinitions("academic_discussion").length, 4);
  assert.match(student, /definitions\.map\(\(definition\) =>/);
  assert.match(student, />总分</);
  assert.match(student, /<CollapsibleText[\s\S]*lines=\{2\}/);
  assert.match(teacher, /import \{ CollapsibleText \}/);
  assert.match(student, /import \{ CollapsibleText \}/);
  assert.match(collapsible, /WebkitLineClamp: lines/);
  assert.match(collapsible, /scrollHeight > paragraph\.clientHeight/);
  assert.match(collapsible, /setExpanded\(\(current\) => !current\)/);
  assert.match(collapsible, /expanded \? "收起" : "展开"/);
  assert.doesNotMatch(student, /rounded-full[\s\S]{0,80}\{score\}|progress bar/);
});

test("student detail tabs use deduplicated real counts and underlined active state", () => {
  const source = read("components/student/StudentWritingReview.tsx");
  assert.match(source, /all: items\.length/);
  assert.match(source, /item\.kind === "language_edit"/);
  assert.match(source, /item\.kind === "content_feedback"/);
  assert.match(source, /全部批改（\{reviewCounts\.all\}）/);
  assert.match(source, /语言错误修改（\{reviewCounts\.language_edit\}）/);
  assert.match(source, /内容反馈（\{reviewCounts\.content_feedback\}）/);
  const tab = source.slice(source.indexOf("function ReviewTabButton"), source.indexOf("function formatDateTime"));
  assert.match(tab, /border-b-2/);
  assert.match(tab, /border-student-primary/);
  assert.doesNotMatch(tab, /bg-student-primary text-white|rounded-md|rounded-full/);
  assert.match(source, /publishedReviewItemsForTab\(items, nextTab\)\[0\]/);
});

test("student Content Feedback detail shows type, issue, suggestion, and a non-empty revision example", () => {
  const source = read("components/student/StudentWritingReview.tsx");
  const detail = source.slice(source.indexOf("function PublishedReviewDetail"), source.indexOf("function PublishedScorePanel"));
  const content = detail.slice(detail.indexOf("const feedback = item.feedback"));
  assert.match(content, /label="反馈类型"/);
  assert.match(content, /label="问题" value=\{feedback\.issue\}/);
  assert.match(content, /label="建议" value=\{feedback\.suggestion\}/);
  assert.match(content, /label="改写示例"/);
  assert.match(content, /"proposed_revision" in feedback/);
  assert.doesNotMatch(content, /对应原句|建议改写|original_sentence/);
  assert.match(detail, /typeof value !== "string" \|\| !value\.trim\(\)/);
});

test("student Language Edit detail shows source, revision, category, and explanation without severity", () => {
  const source = read("components/student/StudentWritingReview.tsx");
  const detail = source.slice(source.indexOf("function PublishedReviewDetail"), source.indexOf("function PublishedScorePanel"));
  const language = detail.slice(detail.indexOf('if (item.kind === "language_edit")'), detail.indexOf("const feedback = item.feedback"));
  assert.match(language, /label="原文" value=\{edit\.original_text\}/);
  assert.match(language, /label="修改后" value=\{edit\.replacement_text\}/);
  assert.match(language, /label="错误类型"/);
  assert.match(language, /label="修改说明" value=\{edit\.explanation\}/);
  assert.doesNotMatch(language, /严重程度|severity/);
  assert.doesNotMatch(language, /暂无|默认|自动生成/);
});

test("student detail uses a compact borderless two-column definition list", () => {
  const source = read("components/student/StudentWritingReview.tsx");
  const detail = source.slice(source.indexOf("function PublishedReviewDetail"), source.indexOf("function PublishedScorePanel"));
  assert.match(detail, /<dl className="mt-1\.5 grid gap-y-1">/);
  assert.match(detail, /grid-cols-\[72px_minmax\(0,1fr\)\]/);
  assert.match(detail, /gap-x-3 py-0\.5/);
  assert.match(detail, /text-\[13px\] leading-5/);
  assert.doesNotMatch(detail, /<table|<tr|<td|<th|\bborder\b|border-|divide-|rounded|bg-student-bg/);
});

test("overall evaluation is content-sized while score takes the right-column remainder", () => {
  const source = read("components/student/StudentWritingReview.tsx");
  const aside = source.slice(source.indexOf("<aside"), source.indexOf("</aside>"));
  assert.match(aside, /lg:grid-rows-\[minmax\(0,1fr\)_auto\]/);
  assert.match(aside, /<PublishedScorePanel/);
  assert.doesNotMatch(aside, /min-h-\[190px\]|overflow-y-auto[\s\S]*总体评价|1\.8fr|1\.65fr/);
  assert.match(source, /flex min-h-\[390px\][\s\S]*lg:min-h-0/);
});

test("Email and Academic Discussion review questions reuse their complete stored fields", () => {
  const source = read("components/writing/WritingQuestionPrompt.tsx");
  assert.match(source, /return <EmailPrompt/);
  assert.match(source, /academicQuestion\.professor_prompt|question\.professor_prompt/);
  assert.match(source, /academicQuestion\.student_1_response/);
  assert.match(source, /academicQuestion\.student_2_response/);
  assert.match(source, /AcademicStudentPost/);
});

test("teacher and student use the shared marker-only renderer", () => {
  const teacher = read("components/teacher/TeacherWritingReviewWorkspace.tsx");
  const student = read("components/student/StudentWritingReview.tsx");
  const renderer = read("components/writing/WritingRevisionMarkedText.tsx");
  assert.match(teacher, /WritingRevisionMarkedText/);
  assert.match(student, /WritingRevisionMarkedText/);
  assert.match(renderer, /markerSegments/);
  assert.match(renderer, /feedbackStarts\.map/);
  assert.match(renderer, /F\{feedbackOrdinals\.get\(feedbackId\)\}/);
  assert.match(renderer, /data-feedback-id=\{feedbackId\}/);
  assert.match(teacher, /markerSegments=\{annotationSegments\}/);
  assert.match(student, /markerSegments=\{markerSegments\}/);
  assert.doesNotMatch(renderer, /content_feedback_inline|contentFeedbackMarkedDetails|<del|<ins|【建议改为/);
});

test("shared marker-only presentation preserves typography and avoids inline revisions", () => {
  const renderer = read("components/writing/WritingRevisionMarkedText.tsx");
  const teacher = read("components/teacher/TeacherWritingReviewWorkspace.tsx");
  const student = read("components/student/StudentWritingReview.tsx");
  assert.match(renderer, /\[font:inherit\]/);
  assert.match(renderer, /\[line-height:inherit\]/);
  assert.match(renderer, /align-baseline/);
  assert.match(renderer, /p-0/);
  assert.match(renderer, /languageEditDisplayRange\(edit\)/);
  assert.match(renderer, /languageEditSeverityMarkerClass/);
  assert.match(renderer, /CONTENT_FEEDBACK_MARKER_CLASS/);
  assert.match(renderer, /selectedId === feedbackId && "bg-violet-200"/);
  assert.doesNotMatch(renderer, /<del|<ins|data-change-kind|建议改为|replacementChanged/);
  assert.doesNotMatch(renderer, /\bring-|\boutline|\bshadow-/);
  assert.match(teacher, /WritingRevisionMarkedText/);
  assert.match(student, /WritingRevisionMarkedText/);
});

test("student has distinct marked, clean revised, original, and question tabs with a compact marker legend", () => {
  const source = read("components/student/StudentWritingReview.tsx");
  assert.match(source, /useState<ReviewView>\("marked"\)/);
  assert.match(source, />批改稿<\/ReviewViewTab>/);
  assert.match(source, />修改稿<\/ReviewViewTab>/);
  assert.match(source, />原文<\/ReviewViewTab>/);
  assert.match(source, />题目<\/ReviewViewTab>/);
  assert.match(source, /view === "marked"/);
  assert.match(source, /<WritingRevisionMarkedText[\s\S]*markerSegments=\{markerSegments\}/);
  assert.match(source, /<WritingRevisionMarkedText composition=\{composition\} marksVisible=\{false\} \/>/);
  assert.match(source, /<ReviewMarkerLegend \/>/);
  assert.match(source, /languageEditSeverityMarkerClass/);
  assert.match(source, /CONTENT_FEEDBACK_MARKER_CLASS/);
});

test("shared marker renderer gives feedback and language edits independent click ownership", () => {
  const renderer = read("components/writing/WritingRevisionMarkedText.tsx");
  const teacher = read("components/teacher/TeacherWritingReviewWorkspace.tsx");
  assert.match(renderer, /data-feedback-range=/);
  assert.match(renderer, /data-feedback-marker=\{feedbackId\}/);
  assert.match(renderer, /data-edit-id=\{edit\.edit_id\}/);
  assert.match(renderer, /<Fragment key=\{`\$\{segment\.start\}-\$\{segment\.end\}-\$\{index\}`\}>/);
  assert.match(renderer, /<FeedbackRangeAnchor feedbackIds=\{segment\.feedbackIds\} \/>[\s\S]*<LanguageEditMarker/);
  assert.doesNotMatch(renderer, /data-feedback-range=[\s\S]{0,500}<LanguageEditMarker/);
  assert.match(renderer, /onClick=\{\(event\) => \{[\s\S]*event\.stopPropagation\(\);\s*onSelectContentFeedback/s);
  assert.match(renderer, /onClick=\{\(event\) => \{[\s\S]*event\.stopPropagation\(\);\s*onSelect\?\./s);
  const feedbackButton = renderer.slice(
    renderer.indexOf("{segment.feedbackStarts.map"),
    renderer.indexOf("</button>", renderer.indexOf("{segment.feedbackStarts.map")) + "</button>".length
  );
  assert.doesNotMatch(feedbackButton, /LanguageEditMarker|<button[\s\S]*<button/);
  assert.match(teacher, /data-feedback-range=/);
  assert.match(teacher, /\[data-feedback-range~=/);
  assert.match(teacher, /event\.stopPropagation\(\);\s*onSelectFeedback/s);
  assert.match(teacher, /event\.stopPropagation\(\);\s*onSelectEdit/s);
});

test("shared renderer keeps every language edit interactive when one feedback covers the sentence", () => {
  const response = "In my opinion, teenage years is crucial as it may decided how people will being.";
  const edits = [
    ["is", "are"],
    ["decided", "decide"],
    ["people will being", "people will be"]
  ].map(([originalText, replacementText], index) => {
    const start = response.indexOf(originalText);
    return {
      edit_id: `overlap-edit-${index + 1}`,
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
  const feedback = [{
    feedback_id: "overlap-feedback",
    category: "language_improvement",
    issue: "测试反馈。",
    suggestion: "测试建议。",
    example: "",
    proposed_revision: "",
    start: 0,
    end: response.length,
    original_sentence: response
  }];
  const markerSegments = buildWorkspaceAnnotationSegments(response, edits, feedback);
  const selected = [];
  const Renderer = loadMarkedTextRenderer();

  const languageOnlyTree = Renderer({
    composition: { cleanText: response, workspaceSegments: [] },
    markerSegments: buildWorkspaceAnnotationSegments(response, edits, []),
    onSelectLanguageEdit: (edit) => selected.push(`edit:${edit.edit_id}`)
  });
  const languageOnlyMarkup = renderToStaticMarkup(languageOnlyTree);
  assert.doesNotMatch(languageOnlyMarkup, /data-feedback-id=/);
  for (const edit of edits) {
    assert.match(languageOnlyMarkup, new RegExp(`data-edit-id="${edit.edit_id}"`));
  }
  clickRenderedElement(
    renderedHostElements(languageOnlyTree).find(
      (element) => element.type === "button" && element.props["data-edit-id"] === "overlap-edit-1"
    )
  );

  const singleEditTree = Renderer({
    composition: { cleanText: response, workspaceSegments: [] },
    markerSegments: buildWorkspaceAnnotationSegments(response, [edits[0]], feedback),
    onSelectContentFeedback: (id) => selected.push(`feedback:${id}`),
    onSelectLanguageEdit: (edit) => selected.push(`edit:${edit.edit_id}`)
  });
  const singleEditButtons = renderedHostElements(singleEditTree).filter((element) => element.type === "button");
  clickRenderedElement(singleEditButtons.find((element) => element.props["data-feedback-id"] === "overlap-feedback"));
  clickRenderedElement(singleEditButtons.find((element) => element.props["data-edit-id"] === "overlap-edit-1"));

  for (const selectedId of [null, "overlap-feedback", "overlap-edit-2"]) {
    const tree = Renderer({
      composition: { cleanText: response, workspaceSegments: [] },
      markerSegments,
      selectedId,
      onSelectContentFeedback: (id) => selected.push(`feedback:${id}`),
      onSelectLanguageEdit: (edit) => selected.push(`edit:${edit.edit_id}`)
    });
    const markup = renderToStaticMarkup(tree);
    assert.match(markup, /data-feedback-id="overlap-feedback"/);
    for (const edit of edits) {
      assert.match(markup, new RegExp(`data-edit-id="${edit.edit_id}"`));
    }

    const buttons = renderedHostElements(tree).filter((element) => element.type === "button");
    const feedbackButton = buttons.find((element) => element.props["data-feedback-id"] === "overlap-feedback");
    assert.ok(feedbackButton);
    clickRenderedElement(feedbackButton);
    for (const edit of edits) {
      const editButton = buttons.find((element) => element.props["data-edit-id"] === edit.edit_id);
      assert.ok(editButton);
      clickRenderedElement(editButton);
    }
  }

  assert.deepEqual(selected, [
    "edit:overlap-edit-1", "feedback:overlap-feedback", "edit:overlap-edit-1",
    "feedback:overlap-feedback", "edit:overlap-edit-1", "edit:overlap-edit-2", "edit:overlap-edit-3",
    "feedback:overlap-feedback", "edit:overlap-edit-1", "edit:overlap-edit-2", "edit:overlap-edit-3",
    "feedback:overlap-feedback", "edit:overlap-edit-1", "edit:overlap-edit-2", "edit:overlap-edit-3"
  ]);
});

test("home, readonly submission, and catalog each link a concrete published attempt", () => {
  const dashboard = read("components/student/StudentDashboard.tsx");
  const practice = read("components/writing/WritingPractice.tsx");
  const catalog = read("components/writing/WritingCatalog.tsx");
  assert.match(dashboard, /href=\{STUDENT_ROUTES\.writingReviews\}/);
  assert.match(practice, /has_published_review/);
  assert.match(practice, /attempt\.attempt_id/);
  assert.match(practice, /查看批改/);
  assert.match(catalog, /published_review_attempt_id/);
  assert.match(catalog, /查看批改/);
});

function fakeSupabase(tables) {
  const filters = {};
  return {
    filters,
    from(table) {
      const queryFilters = [];
      const query = {
        select() { return query; },
        eq(column, value) {
          queryFilters.push([column, value]);
          filters[table] ??= {};
          filters[table][column] ??= [];
          filters[table][column].push(value);
          return query;
        },
        async maybeSingle() {
          const rows = tables[table] ?? [];
          const data = rows.find((row) =>
            queryFilters.every(([column, value]) => row[column] === value)
          ) ?? null;
          return { data: data ? structuredClone(data) : null, error: null };
        }
      };
      return query;
    }
  };
}

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

function loadMarkedTextRenderer(nodeEnv = "development") {
  const sourcePath = path.join(__dirname, "..", "components/writing/WritingRevisionMarkedText.tsx");
  const compiled = ts.transpileModule(fs.readFileSync(sourcePath, "utf8"), {
    compilerOptions: {
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022
    },
    fileName: sourcePath
  }).outputText;
  const originalLoad = Module._load;
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = nodeEnv;
  Module._load = function mockMarkerRendererImports(request, parent, isMain) {
    if (request === "react") {
      const reactWithoutEffects = Object.create(React);
      reactWithoutEffects.useEffect = () => {};
      return reactWithoutEffects;
    }
    if (request === "@/lib/writingReviewWorkspaceUi") {
      return {
        CONTENT_FEEDBACK_MARKER_CLASS: "feedback-marker",
        languageEditDisplayRange(edit) {
          return {
            prefix: "",
            changedOriginal: edit.original_text,
            suffix: "",
            insertion: false
          };
        },
        languageEditSeverityMarkerClass() {
          return "language-marker";
        }
      };
    }
    if (request === "@/components/writing/WritingOvertimeText") {
      return { WritingOvertimeText: ({ text }) => text };
    }
    if (request === "@/lib/writing") return {};
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    const rendererModule = new Module(sourcePath, module);
    rendererModule.filename = sourcePath;
    rendererModule.paths = Module._nodeModulePaths(path.join(__dirname, ".."));
    rendererModule._compile(compiled, sourcePath);
    return rendererModule.exports.WritingRevisionMarkedText;
  } finally {
    Module._load = originalLoad;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  }
}

function renderedHostElements(node) {
  if (node === null || node === undefined || typeof node === "string" || typeof node === "number") return [];
  if (Array.isArray(node)) return node.flatMap(renderedHostElements);
  if (!React.isValidElement(node)) return [];
  if (typeof node.type === "function") return renderedHostElements(node.type(node.props));
  return [node, ...renderedHostElements(node.props.children)];
}

function clickRenderedElement(element) {
  let propagationStopped = false;
  element.props.onClick({
    currentTarget: { getBoundingClientRect: () => ({}) },
    stopPropagation() { propagationStopped = true; }
  });
  assert.equal(propagationStopped, true);
}

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  CORRECTION_ISSUE_WEIGHT,
  assertPublishedSnapshot,
  correctionStateFromPublishedSnapshot,
  CORRECTION_STATUS_FACTOR,
  assertCorrectionReviewMatchesSource,
  buildCorrectionPublishedSnapshot,
  correctionCompletion,
  correctionReviewState,
  correctionSourceIssues,
  parseCorrectionTeacherOverrides,
  recomputeCorrectionState
} = require("../lib/writingCorrectionReview.ts");
const {
  validateWritingCorrectionReview
} = require("../lib/writingCorrectionReviewSchema.ts");

const le = (id, severity = "minor") => ({ weight: 1, status: null, id, severity });
const content = (id) => ({ weight: 3, status: null, id });

function completion(entries) {
  return correctionCompletion(entries.map(({ weight, status }) => ({ weight, status })));
}

test("one content issue always weighs exactly three language edits", () => {
  assert.equal(CORRECTION_ISSUE_WEIGHT.language_edit, 1);
  assert.equal(CORRECTION_ISSUE_WEIGHT.content_feedback, 3);
  const threeLe = completion([
    { weight: 1, status: "resolved" },
    { weight: 1, status: "resolved" },
    { weight: 1, status: "resolved" }
  ]);
  const oneContent = completion([{ weight: 3, status: "resolved" }]);
  assert.equal(threeLe.rate, oneContent.rate);
  assert.equal(threeLe.total_weight, oneContent.total_weight);
});

test("language edit severity never changes the weight", () => {
  const minor = completion([{ weight: 1, status: "unresolved" }, { weight: 1, status: "resolved" }]);
  const major = completion([{ weight: 1, status: "unresolved" }, { weight: 1, status: "resolved" }]);
  assert.equal(minor.rate, major.rate);
  assert.equal(minor.total_weight, 2);
});

test("only language edits", () => {
  const result = completion([
    { weight: 1, status: "resolved" },
    { weight: 1, status: "unresolved" }
  ]);
  assert.equal(result.total_weight, 2);
  assert.equal(result.completed_weight, 1);
  assert.equal(result.rate, 0.5);
});

test("only content feedback", () => {
  const result = completion([
    { weight: 3, status: "resolved" },
    { weight: 3, status: "partially_resolved" }
  ]);
  assert.equal(result.total_weight, 6);
  assert.equal(result.completed_weight, 4.5);
  assert.equal(result.rate, 0.75);
});

test("all resolved is 100 percent", () => {
  assert.equal(completion([
    { weight: 1, status: "resolved" },
    { weight: 3, status: "resolved" }
  ]).rate, 1);
});

test("all partially resolved is 50 percent regardless of weights", () => {
  assert.equal(completion([
    { weight: 1, status: "partially_resolved" },
    { weight: 3, status: "partially_resolved" }
  ]).rate, 0.5);
  assert.equal(completion([{ weight: 3, status: "partially_resolved" }]).rate, 0.5);
});

test("mixed resolved and partially resolved", () => {
  // 1 resolved LE + 1 partial content = 1 + 1.5 = 2.5 of 4
  const result = completion([
    { weight: 1, status: "resolved" },
    { weight: 3, status: "partially_resolved" }
  ]);
  assert.equal(result.completed_weight, 2.5);
  assert.equal(result.total_weight, 4);
  assert.equal(result.rate, 0.625);
});

test("unresolved contributes zero but stays in the denominator", () => {
  const result = completion([
    { weight: 1, status: "unresolved" },
    { weight: 3, status: "resolved" }
  ]);
  assert.equal(result.completed_weight, 3);
  assert.equal(result.total_weight, 4);
  assert.equal(result.counts.unresolved, 1);
});

test("uncertain contributes zero and is never excluded to inflate completion", () => {
  const result = completion([
    { weight: 3, status: "uncertain" },
    { weight: 1, status: "resolved" }
  ]);
  assert.equal(result.total_weight, 4);
  assert.equal(result.completed_weight, 1);
  assert.equal(result.rate, 0.25);
  assert.equal(result.counts.uncertain, 1);
});

test("a missing judgement is treated as undetermined with zero credit", () => {
  const result = completion([{ weight: 3, status: null }, { weight: 1, status: "resolved" }]);
  assert.equal(result.total_weight, 4);
  assert.equal(result.completed_weight, 1);
  assert.equal(result.counts.undetermined, 1);
});

test("zero original issues is not 100 percent", () => {
  const result = completion([]);
  assert.equal(result.applicable, false);
  assert.equal(result.rate, null);
  assert.equal(result.total_weight, 0);
});

test("status factors are the confirmed ones", () => {
  assert.deepEqual(CORRECTION_STATUS_FACTOR, {
    resolved: 1,
    partially_resolved: 0.5,
    unresolved: 0,
    uncertain: 0
  });
});

/* ------------------------------------------------------------------ */

const snapshot = {
  schema_version: 1,
  original_response_text: "Original text, one sentence.",
  original_context: { task_type: "email", question_id: "q", set_id: "s" },
  question_source: "question_bank",
  question: { question_id: "q", set_id: "s", set_title: "T", year_month: "202601",
    source_labels: "x", scenario: "s", task_instruction: "t", requirement_1: "1",
    requirement_2: "2", requirement_3: "3", closing_instruction: "c",
    recipient: "R", subject: "S" },
  published_review: {
    review_id: "r1",
    published_at: "2026-10-01T00:00:00Z",
    language_edits: [
      { edit_id: "le-1", original_text: "Original", replacement_text: "Revised",
        category: "grammar", severity: "major", explanation: "x" },
      { edit_id: "le-2", original_text: "text", replacement_text: "wording",
        category: "spelling", severity: "minor", explanation: "y" }
    ],
    content_feedback: {
      overall_feedback: "",
      items: [{ feedback_id: "f-1", category: "elaboration",
        original_sentence: "one sentence.", issue: "i", suggestion: "s",
        proposed_revision: "p" }]
    },
    scores: { official_score: { teacher_score: 3, ai_score: 3, rationale: "" } },
    teacher_comment: ""
  }
};

test("source issues keep published order and confirmed weights", () => {
  const issues = correctionSourceIssues(snapshot);
  assert.deepEqual(issues.map((issue) => issue.issue_id), ["le-1", "le-2", "f-1"]);
  assert.deepEqual(issues.map((issue) => issue.weight), [1, 1, 3]);
  assert.deepEqual(issues.map((issue) => issue.issue_type),
    ["language_edit", "language_edit", "content_feedback"]);
});

test("teacher overrides replace AI status without deleting it", () => {
  const issues = correctionSourceIssues(snapshot);
  const ai = {
    task_type: "email",
    issue_resolutions: [
      { issue_id: "le-1", issue_type: "language_edit", status: "resolved",
        deletion_based: false, evidence: "", explanation: "a" },
      { issue_id: "le-2", issue_type: "language_edit", status: "unresolved",
        deletion_based: false, evidence: "", explanation: "b" },
      { issue_id: "f-1", issue_type: "content_feedback", status: "unresolved",
        deletion_based: false, evidence: "", explanation: "c" }
    ],
    new_issues: [],
    correction_score: 4,
    score_rationale: "r",
    resolution_summary: "s",
    score_change_explanation: "e"
  };
  const state = correctionReviewState({
    issues,
    originalScore: 3,
    ai,
    teacher: {
      issue_statuses: { "le-2": "resolved" },
      correction_score: 5,
      score_rationale: "teacher",
      new_issue_reviews: {}
    }
  });
  assert.equal(state.issues[1].ai_status, "unresolved");
  assert.equal(state.issues[1].teacher_status, "resolved");
  assert.equal(state.issues[1].effective_status, "resolved");
  assert.equal(state.completion.total_weight, 5);
  // le-1 and le-2 resolved, f-1 still unresolved: 1 + 1 of 5.
  assert.equal(state.completion.completed_weight, 2);
  assert.equal(state.completion.rate, 0.4);
  assert.equal(state.effective_score, 5);
  assert.equal(state.score_delta, 2);
  assert.equal(state.effective_rationale, "teacher");

  const recomputed = recomputeCorrectionState(state, {
    issue_statuses: {},
    correction_score: null,
    score_rationale: null,
    new_issue_reviews: {}
  });
  assert.equal(recomputed.issues[1].effective_status, "unresolved");
  assert.equal(recomputed.effective_score, 4);
  assert.equal(recomputed.score_delta, 1);
});

test("new issues never change the completion denominator", () => {
  const issues = correctionSourceIssues(snapshot);
  const state = correctionReviewState({
    issues,
    originalScore: 3,
    ai: {
      task_type: "email",
      issue_resolutions: issues.map((issue) => ({
        issue_id: issue.issue_id,
        issue_type: issue.issue_type,
        status: "resolved",
        deletion_based: false,
        evidence: "",
        explanation: ""
      })),
      new_issues: [
        { type: "grammar", severity: "major", evidence: "x", explanation: "y", score_impact: "small" }
      ],
      correction_score: 4,
      score_rationale: "",
      resolution_summary: "",
      score_change_explanation: ""
    },
    teacher: null
  });
  assert.equal(state.completion.total_weight, 5);
  assert.equal(state.completion.rate, 1);
  assert.equal(state.new_issues.length, 1);
  assert.equal(state.new_issues[0].review_status, "accepted");
});

test("teacher overrides are validated strictly", () => {
  const issues = correctionSourceIssues(snapshot);
  assert.throws(() => parseCorrectionTeacherOverrides(
    { issue_statuses: { "unknown-id": "resolved" } }, issues, 0
  ), /未知的原始问题/);
  assert.throws(() => parseCorrectionTeacherOverrides(
    { issue_statuses: { "le-1": "done" } }, issues, 0
  ), /状态无效/);
  assert.throws(() => parseCorrectionTeacherOverrides(
    { correction_score: 6 }, issues, 0
  ), /0–5/);
  assert.throws(() => parseCorrectionTeacherOverrides(
    { new_issue_reviews: { "3": { status: "accepted", note: "" } } }, issues, 1
  ), /未知的新问题序号/);
  const ok = parseCorrectionTeacherOverrides(
    { issue_statuses: { "le-1": "partially_resolved" }, correction_score: 4,
      score_rationale: "  ", new_issue_reviews: { "0": { status: "dismissed", note: "n" } } },
    issues,
    1
  );
  assert.deepEqual(ok.issue_statuses, { "le-1": "partially_resolved" });
  assert.equal(ok.correction_score, 4);
  assert.equal(ok.score_rationale, "");
  assert.deepEqual(ok.new_issue_reviews["0"], { status: "dismissed", note: "n" });
});

const aiReview = (overrides = {}) => ({
  task_type: "email",
  issue_resolutions: [
    { issue_id: "le-1", issue_type: "language_edit", status: "resolved",
      deletion_based: false, evidence: "", explanation: "" },
    { issue_id: "le-2", issue_type: "language_edit", status: "unresolved",
      deletion_based: false, evidence: "", explanation: "" },
    { issue_id: "f-1", issue_type: "content_feedback", status: "unresolved",
      deletion_based: false, evidence: "", explanation: "" }
  ],
  new_issues: [],
  correction_score: 4,
  score_rationale: "",
  resolution_summary: "",
  score_change_explanation: "",
  ...overrides
});

test("coverage rejects missing, unknown, duplicate and mistyped issues", () => {
  const issues = correctionSourceIssues(snapshot);
  assert.doesNotThrow(() => assertCorrectionReviewMatchesSource(aiReview(), issues, "email"));
  assert.throws(() => assertCorrectionReviewMatchesSource(
    aiReview({ issue_resolutions: aiReview().issue_resolutions.slice(0, 2) }), issues, "email"
  ), /遗漏/);
  assert.throws(() => assertCorrectionReviewMatchesSource(
    aiReview({ issue_resolutions: [...aiReview().issue_resolutions,
      { issue_id: "ghost", issue_type: "language_edit", status: "resolved",
        deletion_based: false, evidence: "", explanation: "" }] }), issues, "email"
  ), /未知/);
  assert.throws(() => assertCorrectionReviewMatchesSource(
    aiReview({ issue_resolutions: [aiReview().issue_resolutions[0],
      aiReview().issue_resolutions[0], aiReview().issue_resolutions[2]] }), issues, "email"
  ), /重复/);
  assert.throws(() => assertCorrectionReviewMatchesSource(
    aiReview({ issue_resolutions: [
      { ...aiReview().issue_resolutions[0], issue_type: "content_feedback" },
      aiReview().issue_resolutions[1], aiReview().issue_resolutions[2]
    ] }), issues, "email"
  ), /类型不匹配/);
  assert.throws(() => assertCorrectionReviewMatchesSource(aiReview(), issues, "academic_discussion"),
    /题型/);
});

test("publish snapshot freezes the effective values and the computed delta", () => {
  const issues = correctionSourceIssues(snapshot);
  const state = correctionReviewState({
    issues,
    originalScore: 3,
    ai: aiReview(),
    teacher: { issue_statuses: {}, correction_score: 5, score_rationale: "t", new_issue_reviews: {} }
  });
  const published = buildCorrectionPublishedSnapshot({
    state,
    aiModel: "deepseek-v4-flash",
    aiGeneratedAt: "2026-11-03T00:00:00Z",
    publishedAt: "2026-11-03T01:00:00Z"
  });
  assert.equal(published.correction_score, 5);
  assert.equal(published.score_delta, 2);
  assert.equal(published.original_score, 3);
  assert.equal(published.completion.total_weight, 5);
  assert.equal(published.issues.length, 3);
});

test("publishing without any score is refused", () => {
  const issues = correctionSourceIssues(snapshot);
  const state = correctionReviewState({ issues, originalScore: 3, ai: null, teacher: null });
  assert.throws(() => buildCorrectionPublishedSnapshot({
    state, aiModel: null, aiGeneratedAt: null, publishedAt: "2026-11-03T00:00:00Z"
  }), /评分/);
});

test("semantic schema rejects an out-of-range score and an unknown status", () => {
  const base = {
    task_type: "email",
    issue_resolutions: [],
    new_issues: [],
    correction_score: 4,
    score_rationale: "r",
    resolution_summary: "s",
    score_change_explanation: "e"
  };
  assert.equal(validateWritingCorrectionReview(base, []).ok, true);
  assert.equal(validateWritingCorrectionReview({ ...base, correction_score: 6 }, []).ok, false);
  assert.equal(validateWritingCorrectionReview({
    ...base,
    issue_resolutions: [{ issue_id: "le-1", issue_type: "language_edit", status: "done",
      deletion_based: false, evidence: "", explanation: "x" }]
  }, ["le-1"]).ok, false);
});

test("a published review renders the frozen snapshot, not recomputed rows", () => {
  const issues = correctionSourceIssues(snapshot);
  const state = correctionReviewState({
    issues,
    originalScore: 3,
    ai: aiReview(),
    teacher: { issue_statuses: {}, correction_score: 5, score_rationale: "frozen teacher", new_issue_reviews: {} }
  });
  const published = buildCorrectionPublishedSnapshot({
    state,
    aiModel: "m",
    aiGeneratedAt: "2026-11-03T00:00:00Z",
    publishedAt: "2026-11-03T01:00:00Z"
  });
  assert.doesNotThrow(() => assertPublishedSnapshot(published));

  // Simulate live rows drifting after publication: the frozen snapshot must win.
  const frozen = correctionStateFromPublishedSnapshot(published, aiReview());
  assert.equal(frozen.effective_score, 5);
  assert.equal(frozen.score_delta, 2);
  assert.equal(frozen.ai_score, 4);
  assert.equal(frozen.teacher_score, 5);
  assert.equal(frozen.effective_rationale, "frozen teacher");
  assert.equal(frozen.completion.total_weight, 5);
  assert.equal(frozen.issues.every((issue) => issue.effective_status !== undefined), true);
});

test("published snapshot validation rejects malformed payloads", () => {
  assert.throws(() => assertPublishedSnapshot(null), /格式无效/);
  assert.throws(() => assertPublishedSnapshot({ issues: [], new_issues: [] }), /完成度/);
  assert.throws(() => assertPublishedSnapshot({
    issues: [], new_issues: [],
    completion: { applicable: true, total_weight: 1, completed_weight: 0, rate: 0, counts: {} },
    original_score: 3, correction_score: 9, score_delta: 6
  }), /评分无效/);
  assert.throws(() => assertPublishedSnapshot({
    issues: [], new_issues: [],
    completion: { applicable: true, total_weight: 1, completed_weight: 0, rate: 0, counts: {} },
    original_score: 3, correction_score: 4
  }), /分差/);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { createMockSupabase } = require("./fixtures/mockSupabase.js");
const {
  loadCorrectionReviewWorkspace,
  saveCorrectionReview,
  generateCorrectionReview
} = require("../lib/writingCorrectionReview.server.ts");
const {
  correctionCompletion
} = require("../lib/writingCorrectionReview.ts");
const { loadStudentCorrectionReview } = require("../lib/writingCorrectionPublished.server.ts");

/**
 * Phase 4 integration: real server module against an in-memory PostgREST mock
 * and an injected Provider stub. No database, no network, no real student data.
 */

const STUDENT = "11111111-1111-4111-8111-111111111111";
const ADMIN = "99999999-9999-4999-8999-999999999999";
const ATTEMPT = "77777777-7777-4777-8777-777777777777";
const ORIGINAL = "22222222-2222-4222-8222-222222222222";

const QUESTION = {
  question_id: "q-1",
  set_id: "s-1",
  set_title: "Fixture question",
  year_month: "202611",
  source_labels: "fixture",
  scenario: "Library",
  task_instruction: "Write an email.",
  requirement_1: "Suggest an activity.",
  requirement_2: "Explain the benefit.",
  requirement_3: "Offer to help.",
  closing_instruction: "Write enough.",
  recipient: "Library Team",
  subject: "Suggestion"
};

const SNAPSHOT = {
  schema_version: 1,
  original_response_text:
    "Dear Library Team,\n\nI is writing to suggest a workshop. Students need more opportunity to learn.\n\nThank you for your time.",
  original_context: { task_type: "email", question_id: "q-1", set_id: "s-1" },
  question_source: "question_bank",
  question: QUESTION,
  published_review: {
    review_id: "review-1",
    published_at: "2026-11-02T12:00:00Z",
    language_edits: [
      {
        edit_id: "le-1",
        original_text: "I is",
        replacement_text: "I am",
        category: "grammar",
        severity: "major",
        explanation: "主谓一致。"
      },
      {
        edit_id: "le-2",
        original_text: "opportunity",
        replacement_text: "opportunities",
        category: "grammar",
        severity: "minor",
        explanation: "复数。"
      }
    ],
    content_feedback: {
      overall_feedback: "",
      items: [
        {
          feedback_id: "f-1",
          category: "elaboration",
          original_sentence: "Students need more opportunity to learn.",
          issue: "缺少具体说明。",
          suggestion: "补充活动细节。",
          proposed_revision: "A workshop would give students a chance to practise together."
        }
      ]
    },
    scores: { official_score: { teacher_score: 3, ai_score: 3, rationale: "" } },
    teacher_comment: ""
  }
};

const CORRECTED_TEXT =
  "Dear Library Team,\n\nI am writing to suggest a workshop. Students need more opportunities to learn.\n\nThank you for your time.";

function correctionAttempt(overrides = {}) {
  return {
    attempt_id: ATTEMPT,
    attempt_kind: "correction",
    original_attempt_id: ORIGINAL,
    correction_source_snapshot: SNAPSHOT,
    draft_version: 2,
    assignment_id: null,
    user_id: STUDENT,
    task_type: "email",
    question_id: "q-1",
    set_id: "s-1",
    response_text: CORRECTED_TEXT,
    word_count: 22,
    writing_mode: null,
    elapsed_seconds: 0,
    overtime_ranges: [],
    status: "submitted",
    submitted_at: "2026-11-03T09:00:00Z",
    ...overrides
  };
}

function tables(overrides = {}) {
  return {
    writing_attempts: [correctionAttempt()],
    profiles: [
      {
        id: STUDENT,
        role: "student",
        is_active: true,
        email: "student@example.invalid",
        full_name: "Mock Student"
      },
      { id: ADMIN, role: "admin", is_active: true, email: "admin@example.invalid" }
    ],
    writing_correction_reviews: [],
    ...overrides
  };
}

const actor = { userId: ADMIN, role: "admin" };

const aiReview = (overrides = {}) => ({
  task_type: "email",
  issue_resolutions: [
    {
      issue_id: "le-1",
      issue_type: "language_edit",
      status: "resolved",
      deletion_based: false,
      evidence: "I am writing",
      explanation: "已改为正确形式。"
    },
    {
      issue_id: "le-2",
      issue_type: "language_edit",
      status: "partially_resolved",
      deletion_based: false,
      evidence: "more opportunities",
      explanation: "名词已改对，但搭配仍可改进。"
    },
    {
      issue_id: "f-1",
      issue_type: "content_feedback",
      status: "unresolved",
      deletion_based: false,
      evidence: "",
      explanation: "仍未补充具体说明。"
    }
  ],
  new_issues: [
    {
      type: "organization",
      severity: "minor",
      evidence: "Dear Library Team,",
      explanation: "段落合并。",
      score_impact: "small"
    }
  ],
  correction_score: 3,
  score_rationale: "语言改善但内容未补。",
  resolution_summary: "两处语言问题改善，一处内容未解决。",
  score_change_explanation: "改善与不足相互抵消，分数持平。",
  ...overrides
});

function providerReturning(payload, model = "mock-model") {
  const calls = [];
  const fn = async (_config, messages) => {
    calls.push(messages);
    return {
      content: typeof payload === "string" ? payload : JSON.stringify(payload),
      model,
      usage: { prompt_tokens: 100, completion_tokens: 50, reasoning_tokens: 10, cost: null },
      generationId: "mock-generation"
    };
  };
  fn.calls = calls;
  return fn;
}

/* ------------------------------------------------------------------ */

test("empty review loads as a reviewing draft with the frozen source only", async () => {
  const db = createMockSupabase(tables());
  const workspace = await loadCorrectionReviewWorkspace(db, actor, ATTEMPT);

  assert.equal(workspace.attempt.attempt_id, ATTEMPT);
  assert.equal(workspace.attempt.original_attempt_id, ORIGINAL);
  assert.equal(workspace.attempt.student_name, "Mock Student");
  assert.equal(workspace.source.original_response_text, SNAPSHOT.original_response_text);
  assert.equal(workspace.source.original_score, 3);
  assert.equal(workspace.corrected_response_text, CORRECTED_TEXT);
  assert.equal(workspace.review.status, "reviewing");
  assert.equal(workspace.review.review_id, null);
  assert.equal(workspace.review.ai, null);
  assert.equal(workspace.review.published, null);
  assert.deepEqual(workspace.review.teacher.issue_statuses, {});

  assert.deepEqual(
    workspace.review.state.issues.map((issue) => [issue.issue_id, issue.weight]),
    [["le-1", 1], ["le-2", 1], ["f-1", 3]]
  );
  assert.equal(workspace.review.state.completion.applicable, true);
  assert.equal(workspace.review.state.completion.total_weight, 5);
  assert.equal(workspace.review.state.completion.rate, 0);
  assert.equal(workspace.review.state.completion.counts.undetermined, 3);
  assert.equal(workspace.review.state.effective_score, null);
});

test("non-correction attempts are rejected as not found", async () => {
  const db = createMockSupabase(
    tables({ writing_attempts: [correctionAttempt({ attempt_kind: "original" })] })
  );
  await assert.rejects(
    () => loadCorrectionReviewWorkspace(db, actor, ATTEMPT),
    (error) => error.code === "CORRECTION_NOT_FOUND" && error.status === 404
  );
});

test("a snapshot task_type mismatch is rejected before scoring", async () => {
  const db = createMockSupabase(
    tables({
      writing_attempts: [
        correctionAttempt({
          correction_source_snapshot: {
            ...SNAPSHOT,
            original_context: { ...SNAPSHOT.original_context, task_type: "academic_discussion" }
          }
        })
      ]
    })
  );
  await assert.rejects(
    () => loadCorrectionReviewWorkspace(db, actor, ATTEMPT),
    (error) => error.code === "CORRECTION_REVIEW_INVALID" && error.status === 500
  );
});

test("a stored review row with a different task_type is rejected", async () => {
  const db = createMockSupabase(
    tables({
      writing_correction_reviews: [
        {
          review_id: "r-1",
          attempt_id: ATTEMPT,
          task_type: "academic_discussion",
          status: "reviewing",
          prompt_version: "writing_correction_prompt_v1",
          schema_version: "writing_correction_review_v1",
          ai_model: null,
          ai_generated_at: null,
          ai_review: null,
          teacher_overrides: {},
          published_review: null,
          published_at: null,
          created_at: "2026-11-03T00:00:00Z",
          updated_at: "2026-11-03T00:00:00Z"
        }
      ]
    })
  );
  await assert.rejects(
    () => loadCorrectionReviewWorkspace(db, actor, ATTEMPT),
    (error) => error.code === "CORRECTION_REVIEW_INVALID"
  );
});

test("AI generation saves an independent reviewing draft and preserves teacher overrides", async () => {
  const db = createMockSupabase(tables());
  const provider = providerReturning(aiReview());

  const first = await generateCorrectionReview(db, actor, ATTEMPT, {
    requestStructuredOutput: provider,
    now: () => new Date("2026-11-03T10:00:00Z")
  });
  assert.equal(provider.calls.length, 1);
  assert.equal(first.workspace.review.status, "reviewing");
  assert.equal(first.workspace.review.ai_model, "mock-model");
  assert.equal(first.workspace.review.ai_generated_at, "2026-11-03T10:00:00.000Z");
  assert.equal(first.workspace.review.published, null);
  assert.equal(first.workspace.review.state.ai_score, 3);
  assert.equal(first.teacher_overrides_preserved, false);
  assert.equal(db.tables.writing_correction_ai_logs.length, 1);
  assert.equal(db.tables.writing_correction_ai_logs[0].status, "success");
  assert.equal(db.tables.writing_correction_ai_logs[0].model, "mock-model");
  assert.equal(db.tables.writing_correction_ai_logs[0].generation_id, "mock-generation");
  assert.equal(db.tables.writing_review_ai_logs?.length ?? 0, 0);

  const row = db.tables.writing_correction_reviews[0];
  assert.equal(row.status, "reviewing");
  assert.equal(row.ai_review.issue_resolutions.length, 3);
  assert.equal(row.ai_review.new_issues.length, 1);
  assert.deepEqual(row.teacher_overrides ?? {}, {});
  assert.equal(row.published_review ?? null, null);
  assert.equal(row.published_at ?? null, null);

  // Teacher edits, then AI regenerates: the overrides must survive untouched.
  const saved = await saveCorrectionReview(
    db,
    actor,
    ATTEMPT,
    {
      action: "save",
      teacher: {
        issue_statuses: { "f-1": "resolved" },
        correction_score: 4,
        score_rationale: "教师复核。",
        new_issue_reviews: { "0": { status: "dismissed", note: "" } }
      }
    }
  );
  const before = db.tables.writing_correction_reviews[0].teacher_overrides;
  assert.deepEqual(before.issue_statuses, { "f-1": "resolved" });

  const regenerated = await generateCorrectionReview(db, actor, ATTEMPT, {
    requestStructuredOutput: providerReturning(aiReview({ correction_score: 5 })),
    now: () => new Date("2026-11-03T11:00:00Z")
  });
  assert.equal(regenerated.teacher_overrides_preserved, true);
  const after = db.tables.writing_correction_reviews[0];
  assert.deepEqual(after.teacher_overrides, before);
  assert.equal(after.ai_review.correction_score, 5);
  // Teacher score still wins in the effective state.
  assert.equal(regenerated.workspace.review.state.effective_score, 4);
  // le-1 resolved (1) + le-2 partial (0.5) + f-1 resolved by teacher (3) = 4.5 / 5
  assert.equal(saved.review.state.completion.rate, 0.9);
  assert.equal(regenerated.workspace.review.state.completion.rate, 0.9);
});

test("teacher edits are saved, reloaded and never overwrite the AI payload", async () => {
  const db = createMockSupabase(tables());
  await generateCorrectionReview(db, actor, ATTEMPT, {
    requestStructuredOutput: providerReturning(aiReview())
  });
  const aiBefore = JSON.stringify(db.tables.writing_correction_reviews[0].ai_review);

  const saved = await saveCorrectionReview(db, actor, ATTEMPT, {
    action: "save",
    teacher: {
      issue_statuses: { "le-1": "partially_resolved", "le-2": "resolved" },
      correction_score: 4,
      score_rationale: "教师评分解释。",
      new_issue_reviews: { "0": { status: "accepted", note: "确实存在" } }
    }
  });
  assert.equal(JSON.stringify(db.tables.writing_correction_reviews[0].ai_review), aiBefore);
  assert.equal(saved.review.status, "reviewing");
  assert.equal(saved.review.state.issues[0].ai_status, "resolved");
  assert.equal(saved.review.state.issues[0].teacher_status, "partially_resolved");
  assert.equal(saved.review.state.issues[0].effective_status, "partially_resolved");
  assert.equal(saved.review.state.new_issues[0].review_status, "accepted");
  assert.equal(saved.review.state.effective_score, 4);
  assert.equal(saved.review.state.score_delta, 1);
  // le-1 partial 0.5 + le-2 resolved 1 + f-1 unresolved 0 = 1.5 of 5
  assert.equal(saved.review.state.completion.completed_weight, 1.5);
  assert.equal(saved.review.state.completion.rate, 0.3);

  const reloaded = await loadCorrectionReviewWorkspace(db, actor, ATTEMPT);
  assert.deepEqual(reloaded.review.teacher.issue_statuses, {
    "le-1": "partially_resolved",
    "le-2": "resolved"
  });
  assert.equal(reloaded.review.teacher.correction_score, 4);
  assert.equal(reloaded.review.teacher.score_rationale, "教师评分解释。");
  assert.equal(reloaded.review.state.effective_score, 4);
  assert.equal(reloaded.review.state.completion.rate, 0.3);
});

test("publish, save working changes, and republish use one row and isolate the student's snapshot", async () => {
  const db = createMockSupabase(tables());
  await generateCorrectionReview(db, actor, ATTEMPT, {
    requestStructuredOutput: providerReturning(aiReview())
  });
  const published = await saveCorrectionReview(
    db,
    actor,
    ATTEMPT,
    {
      action: "publish",
      teacher: {
        issue_statuses: { "le-2": "resolved", "f-1": "resolved" },
        correction_score: 5,
        score_rationale: "教师最终评分。",
        new_issue_reviews: { "0": { status: "dismissed", note: "" } }
      }
    },
    { publish: true, now: () => new Date("2026-11-03T12:00:00Z") }
  );

  assert.equal(published.review.status, "published");
  assert.equal(published.review.published_at, "2026-11-03T12:00:00.000Z");
  assert.ok(published.review.published);
  assert.equal(published.review.published.correction_score, 5);
  assert.equal(published.review.published.original_score, 3);
  assert.equal(published.review.published.score_delta, 2);
  assert.equal(published.review.published.completion.rate, 1);
  assert.equal(published.review.published.issues.length, 3);
  assert.equal(published.review.published.new_issues.length, 0);
  assert.equal(published.review.state.new_issues[0].review_status, "dismissed");

  const row = db.tables.writing_correction_reviews[0];
  assert.equal(row.status, "published");
  assert.ok(row.published_review);
  assert.equal(row.published_at, "2026-11-03T12:00:00.000Z");

  const frozenAttempt = structuredClone(db.tables.writing_attempts);
  const frozenAI = structuredClone(row.ai_review);
  const edits = { issue_statuses: { "f-1": "unresolved" }, correction_score: 4,
    score_rationale: "教师重新编辑解释", score_change_explanation: "教师分差原因", new_issue_reviews: {} };
  const saved = await saveCorrectionReview(db, actor, ATTEMPT, { teacher: edits });
  assert.equal(saved.review.state.effective_score, 4);
  assert.equal(saved.review.published.correction_score, 5);
  const oldStudent = await loadStudentCorrectionReview(db, STUDENT, ATTEMPT);
  assert.equal(oldStudent.review.correction_score, 5);
  assert.equal(oldStudent.review.new_issues.length, 0);
  assert.equal(oldStudent.review.score_rationale, "教师最终评分。");
  const republished = await saveCorrectionReview(db, actor, ATTEMPT, { teacher: edits },
    { publish: true, now: () => new Date("2026-11-04T12:00:00Z") });
  assert.equal(republished.review.review_id, published.review.review_id);
  const latest = await loadStudentCorrectionReview(db, STUDENT, ATTEMPT);
  assert.equal(latest.review.correction_score, 4);
  assert.equal(latest.review.score_rationale, edits.score_rationale);
  assert.equal(latest.review.score_change_explanation, edits.score_change_explanation);
  assert.equal(latest.review.new_issues.length, 1);
  assert.equal(latest.review.published_at, "2026-11-04T12:00:00.000Z");
  const retried = await saveCorrectionReview(db, actor, ATTEMPT, { teacher: edits },
    { publish: true, now: () => new Date("2026-11-04T13:00:00Z") });
  assert.equal(retried.review.published_at, "2026-11-04T12:00:00.000Z", "unchanged republish retries are idempotent");
  assert.deepEqual(db.tables.writing_attempts, frozenAttempt);
  assert.deepEqual(row.ai_review, frozenAI);
  assert.equal("teacher_overrides" in latest.review, false);
  assert.equal("ai_review" in latest.review, false);
  for (const issue of latest.review.issues) {
    assert.equal("ai_status" in issue, false);
    assert.equal("ai_evidence" in issue, false);
    assert.equal("ai_explanation" in issue, false);
    assert.equal("teacher_status" in issue, false);
    assert.equal("weight" in issue, false);
  }
  await assert.rejects(() => loadStudentCorrectionReview(db, ADMIN, ATTEMPT), error => error.status === 404);
  let called = 0;
  await assert.rejects(
    () => generateCorrectionReview(db, actor, ATTEMPT, {
      requestStructuredOutput: async () => {
        called += 1;
        throw new Error("must not be called");
      }
    }),
    (error) => error.code === "CORRECTION_REVIEW_LOCKED" && error.status === 409
  );
  assert.equal(called, 0, "published reviews must be rejected before any AI call");

  assert.equal(db.tables.writing_correction_reviews.length, 1);
});

test("teachers read working edits while students read only the published snapshot", async () => {
  const db = createMockSupabase(tables());
  await generateCorrectionReview(db, actor, ATTEMPT, {
    requestStructuredOutput: providerReturning(aiReview())
  });
  await saveCorrectionReview(
    db,
    actor,
    ATTEMPT,
    {
      action: "publish",
      teacher: { issue_statuses: {}, correction_score: 5, score_rationale: "frozen", new_issue_reviews: {} }
    },
    { publish: true }
  );

  // Simulate out-of-band drift in the live columns after publication.
  const row = db.tables.writing_correction_reviews[0];
  row.ai_review = aiReview({ correction_score: 1 });
  row.teacher_overrides = { issue_statuses: {}, correction_score: 1, score_rationale: "drift", new_issue_reviews: {} };

  const workspace = await loadCorrectionReviewWorkspace(db, actor, ATTEMPT);
  assert.equal(workspace.review.status, "published");
  assert.equal(workspace.review.state.effective_score, 1);
  assert.equal(workspace.review.state.score_delta, -2);
  assert.equal(workspace.review.state.effective_rationale, "drift");
  const student = await loadStudentCorrectionReview(db, STUDENT, ATTEMPT);
  assert.equal(student.review.correction_score, 5);
  assert.equal(student.review.score_rationale, "frozen");
  // Frozen at publish time: le-1 resolved + le-2 partially resolved = 1.5 / 5.
  assert.equal(workspace.review.state.completion.rate, 0.3);
});

test("a published row without a usable snapshot is rejected", async () => {
  const db = createMockSupabase(
    tables({
      writing_correction_reviews: [
        {
          review_id: "r-1",
          attempt_id: ATTEMPT,
          task_type: "email",
          status: "published",
          prompt_version: "writing_correction_prompt_v1",
          schema_version: "writing_correction_review_v1",
          ai_model: null,
          ai_generated_at: null,
          ai_review: null,
          teacher_overrides: {},
          published_review: { broken: true },
          published_at: "2026-11-03T12:00:00Z",
          created_at: "2026-11-03T00:00:00Z",
          updated_at: "2026-11-03T00:00:00Z"
        }
      ]
    })
  );
  await assert.rejects(
    () => loadCorrectionReviewWorkspace(db, actor, ATTEMPT),
    (error) => error.code === "CORRECTION_REVIEW_INVALID"
  );
});

/* ------------------------------------------------------------------ */
/* Failure paths: nothing may be saved unless the AI output is complete. */

const failureCases = [
  ["invalid JSON", "not json at all"],
  ["missing issue", aiReview({
    issue_resolutions: aiReview().issue_resolutions.filter((item) => item.issue_id !== "f-1")
  })],
  ["unknown issue", aiReview({
    issue_resolutions: [
      ...aiReview().issue_resolutions,
      { issue_id: "ghost", issue_type: "language_edit", status: "resolved",
        deletion_based: false, evidence: "", explanation: "" }
    ]
  })],
  ["duplicate issue", aiReview({
    issue_resolutions: [
      aiReview().issue_resolutions[0],
      aiReview().issue_resolutions[0],
      aiReview().issue_resolutions[2]
    ]
  })],
  ["invalid status", aiReview({
    issue_resolutions: [
      { ...aiReview().issue_resolutions[0], status: "done" },
      aiReview().issue_resolutions[1],
      aiReview().issue_resolutions[2]
    ]
  })],
  ["type mismatch", aiReview({
    issue_resolutions: [
      { ...aiReview().issue_resolutions[0], issue_type: "content_feedback" },
      aiReview().issue_resolutions[1],
      aiReview().issue_resolutions[2]
    ]
  })],
  ["unknown new issue type", aiReview({
    new_issues: [
      { type: "typo", severity: "minor", evidence: "anther",
        explanation: "未知类别。", score_impact: "small" }
    ]
  })],
  ["non-boolean deletion_based", aiReview({
    issue_resolutions: [
      { ...aiReview().issue_resolutions[0], deletion_based: "false" },
      aiReview().issue_resolutions[1],
      aiReview().issue_resolutions[2]
    ]
  })],
  ["non-boolean deletion_based null", aiReview({
    issue_resolutions: [
      aiReview().issue_resolutions[0],
      { ...aiReview().issue_resolutions[1], deletion_based: null },
      aiReview().issue_resolutions[2]
    ]
  })],
  ["score out of range", aiReview({ correction_score: 9 })]
];

for (const [label, payload] of failureCases) {
  test(`AI failure (${label}) saves nothing`, async () => {
    const db = createMockSupabase(tables());
    await assert.rejects(
      () => generateCorrectionReview(db, actor, ATTEMPT, {
        requestStructuredOutput: providerReturning(payload)
      }),
      (error) => error.code === "CORRECTION_AI_FAILED"
    );
    assert.equal(db.tables.writing_correction_reviews.length, 0);
  });
}

test("new spelling, word-form, usage and other issues are saved, never dropped", async () => {
  const db = createMockSupabase(tables());
  const result = await generateCorrectionReview(db, actor, ATTEMPT, {
    requestStructuredOutput: providerReturning(aiReview({
      new_issues: [
        { type: "spelling", severity: "minor", evidence: "anther",
          explanation: "拼写错误。", score_impact: "small" },
        { type: "word_form", severity: "minor", evidence: "disrupteded",
          explanation: "词形错误。", score_impact: "small" },
        { type: "usage", severity: "minor", evidence: "in the same time",
          explanation: "固定搭配错误。", score_impact: "small" },
        { type: "other", severity: "minor", evidence: "flight.Could",
          explanation: "其他格式问题。", score_impact: "none" }
      ]
    }))
  });
  assert.deepEqual(
    result.workspace.review.ai.new_issues.map((issue) => issue.type),
    ["spelling", "word_form", "usage", "other"]
  );
  assert.deepEqual(
    db.tables.writing_correction_reviews[0].ai_review.new_issues.map((issue) => issue.type),
    ["spelling", "word_form", "usage", "other"]
  );
  assert.equal(db.tables.writing_correction_ai_logs[0].status, "success");
});

test("a schema failure keeps the existing teacher draft and logs the received value", async () => {
  const db = createMockSupabase(tables());
  await generateCorrectionReview(db, actor, ATTEMPT, {
    requestStructuredOutput: providerReturning(aiReview())
  });
  await saveCorrectionReview(db, actor, ATTEMPT, {
    action: "save",
    teacher: {
      issue_statuses: { "f-1": "resolved" },
      correction_score: 4,
      score_rationale: "教师工作稿。",
      new_issue_reviews: { "0": { status: "accepted", note: "保留" } }
    }
  });
  const before = JSON.stringify(db.tables.writing_correction_reviews[0]);

  await assert.rejects(
    () => generateCorrectionReview(db, actor, ATTEMPT, {
      requestStructuredOutput: providerReturning(aiReview({
        new_issues: [
          { type: "typo", severity: "minor", evidence: "anther",
            explanation: "未知类别。", score_impact: "small" }
        ]
      }))
    }),
    (error) => error.code === "CORRECTION_AI_FAILED"
  );

  assert.equal(JSON.stringify(db.tables.writing_correction_reviews[0]), before);
  const failedLog = db.tables.writing_correction_ai_logs[
    db.tables.writing_correction_ai_logs.length - 1
  ];
  assert.equal(failedLog.status, "failed");
  assert.equal(failedLog.error_type, "schema_validation_error");
  assert.equal(failedLog.error_code, "INVALID_AI_RESPONSE_SCHEMA");
  assert.match(failedLog.error_message, /new_issues\[0\]\.type: invalid \(received string "typo"\)/);
  assert.match(
    failedLog.validation_issues[0].message,
    /new_issues\[0\]\.type: invalid \(received string "typo"\)/
  );
});

test("AI provider failure saves nothing and keeps the previous draft intact", async () => {
  const db = createMockSupabase(tables());
  await generateCorrectionReview(db, actor, ATTEMPT, {
    requestStructuredOutput: providerReturning(aiReview())
  });
  const before = JSON.stringify(db.tables.writing_correction_reviews[0]);

  await assert.rejects(
    () => generateCorrectionReview(db, actor, ATTEMPT, {
      requestStructuredOutput: async () => {
        throw Object.assign(new Error("provider down"), { code: "AI_REQUEST_TIMEOUT" });
      }
    }),
    (error) => error.code === "CORRECTION_AI_FAILED" || error.code === "CORRECTION_AI_TIMEOUT"
  );
  assert.equal(JSON.stringify(db.tables.writing_correction_reviews[0]), before);
});

test("completion weights hold end to end: three LE equal one content", async () => {
  const threeLe = correctionCompletion([
    { weight: 1, status: "resolved" },
    { weight: 1, status: "resolved" },
    { weight: 1, status: "resolved" }
  ]);
  const oneContent = correctionCompletion([{ weight: 3, status: "resolved" }]);
  assert.equal(threeLe.rate, oneContent.rate);
  assert.equal(threeLe.total_weight, oneContent.total_weight);
});

test("the AI request uses the locked v1 prompt and the frozen snapshot", async () => {
  const db = createMockSupabase(tables());
  const provider = providerReturning(aiReview());
  await generateCorrectionReview(db, actor, ATTEMPT, { requestStructuredOutput: provider });

  const messages = provider.calls[0];
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.equal(
    createHash("sha256").update(messages[0].content).digest("hex"),
    "51cfd9fda67db533ade38654f41e53cc90e22adeb4e9d7bdb8b80e0d023359e8"
  );
  const payload = JSON.parse(messages[1].content);
  assert.equal(payload.original_response_text, SNAPSHOT.original_response_text);
  assert.equal(payload.corrected_response_text, CORRECTED_TEXT);
  assert.equal(payload.original_score, 3);
  assert.deepEqual(
    payload.original_language_edits.map((edit) => edit.issue_id),
    ["le-1", "le-2"]
  );
  assert.deepEqual(
    payload.original_content_feedback.map((item) => item.issue_id),
    ["f-1"]
  );
  // The question comes from the frozen snapshot, not from a live lookup.
  assert.equal(payload.question.set_title, "Fixture question");
});

test("persisted revision ledger changes neither final AI text nor either message hash", async () => {
  const { initializeWritingRevision } = require('../lib/writingRevisionState.ts');
  const state = initializeWritingRevision(SNAPSHOT.original_response_text, CORRECTED_TEXT);
  assert.ok(state.ledger.deletions.length > 0);
  const baseline = providerReturning(aiReview()), integrated = providerReturning(aiReview());
  await generateCorrectionReview(createMockSupabase(tables()), actor, ATTEMPT, { requestStructuredOutput: baseline });
  const db = createMockSupabase(tables({ writing_correction_revision_states: [{ attempt_id: ATTEMPT, saved_draft_version: 1, revision_state: state }] }));
  const result = await generateCorrectionReview(db, actor, ATTEMPT, { requestStructuredOutput: integrated });
  assert.deepEqual(result.workspace.revision_state, state);
  assert.deepEqual(integrated.calls[0], baseline.calls[0]);
  for (let i=0;i<2;i++) assert.equal(createHash('sha256').update(integrated.calls[0][i].content).digest('hex'), createHash('sha256').update(baseline.calls[0][i].content).digest('hex'));
  const payload = JSON.parse(integrated.calls[0][1].content);
  assert.equal(payload.corrected_response_text, CORRECTED_TEXT);
  for (const field of ['ledger','revision_state','sources','deletions','doc']) assert.equal(field in payload,false);
});

test("AD uses the AD prompt hash and the AD task type", async () => {
  const adSnapshot = {
    ...SNAPSHOT,
    original_context: { ...SNAPSHOT.original_context, task_type: "academic_discussion" },
    question: {
      question_id: "q-1",
      set_id: "s-1",
      set_title: "AD fixture",
      year_month: "202611",
      source_labels: "fixture",
      professor_name: "Professor Lee",
      professor_prompt: "Should schools spend more on practical skills?",
      student_1_name: "Andrew",
      student_1_response: "Practical skills help.",
      student_2_name: "Kelly",
      student_2_response: "The arts matter."
    },
    published_review: {
      ...SNAPSHOT.published_review,
      language_edits: [SNAPSHOT.published_review.language_edits[0]],
      content_feedback: { overall_feedback: "", items: [] }
    }
  };
  const db = createMockSupabase(
    tables({
      writing_attempts: [
        correctionAttempt({
          task_type: "academic_discussion",
          correction_source_snapshot: adSnapshot
        })
      ]
    })
  );
  const provider = providerReturning({
    task_type: "academic_discussion",
    issue_resolutions: [
      { issue_id: "le-1", issue_type: "language_edit", status: "resolved",
        deletion_based: false, evidence: "", explanation: "已改正。" }
    ],
    new_issues: [],
    correction_score: 4,
    score_rationale: "AD 评分理由。",
    resolution_summary: "AD 总结。",
    score_change_explanation: "AD 分差解释。"
  });
  await generateCorrectionReview(db, actor, ATTEMPT, { requestStructuredOutput: provider });
  assert.equal(
    createHash("sha256").update(provider.calls[0][0].content).digest("hex"),
    "57bae6625eef82fb8dd728c001930cc06ebae0d5039822f88ce37c48a30da6fb"
  );
});

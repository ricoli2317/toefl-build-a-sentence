const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  mergeRegeneratedWritingReviewItems,
  mergeRegeneratedWritingReviewTeacherState,
  regenerateFullWritingReview
} = require("../lib/writingReviewFullRegeneration.ts");
const {
  parseAIReviewRawResultV22ForResponse
} = require("../lib/writingReviewSchemaV22.ts");
const { OpenRouterWritingReviewError } = require("../lib/openrouterWritingReview.ts");

const responseText = "I am write today.";

function raw() {
  const dim = { ai_score: 3, ai_basis: "中文依据。" };
  return {
    schema_version: "2.2",
    task_type: "email",
    language_edits: [{
      edit_id: "new-edit", original_text: "am write", replacement_text: "am writing",
      category: "grammar", severity: "moderate", explanation: "语法错误。"
    }],
    scores: {
      official_score: { ai_score: 3, rationale: "中文整体依据。" },
      dimension_scores: {
        communicative_purpose_and_elaboration: dim,
        syntactic_range_and_word_choice: dim,
        social_conventions: dim,
        lexical_and_grammatical_control: dim
      }
    },
    content_feedback: [{
      feedback_id: "new-feedback", category: "elaboration",
      original_sentence: responseText, issue: "展开不足。", suggestion: "增加细节。",
      proposed_revision: "I am writing today to explain my request."
    }],
    overall_feedback: "中文总体评价。"
  };
}

function harness({
  status = "reviewing",
  aiError,
  updateError,
  existingLanguageEdits = [{ edit_id: "old" }],
  existingFeedback = { items: [{ feedback_id: "old" }] },
  existingScores,
  aiReviewRaw,
  teacherComment = "教师旧评语"
} = {}) {
  const old = {
    ai_review_raw: { schema_version: "2.0" },
    language_edits: [{ edit_id: "old" }],
    scores: { old: true },
    content_feedback: { items: [{ feedback_id: "old" }] },
    teacher_comment: "教师旧评语",
    published_language_edits: [{ edit_id: "published" }],
    published_scores: { published: true },
    published_content_feedback: { items: [{ feedback_id: "published" }] },
    published_teacher_comment: "已发布评语",
    published_at: "2026-08-13T08:00:00.000Z"
  };
  let update = null;
  const repository = {
    async findAttempt() {
      return { attempt_id: "a1", task_type: "email", question_id: "q1", response_text: responseText, status: "submitted" };
    },
    async findReview() {
      return {
        review_id: "r1",
        status,
        ai_review_raw: structuredClone(aiReviewRaw),
        language_edits: structuredClone(existingLanguageEdits),
        scores: structuredClone(existingScores),
        content_feedback: structuredClone(existingFeedback),
        teacher_comment: teacherComment
      };
    },
    async findQuestion() { return { question_id: "q1" }; },
    async updateWorkingReview(_attemptId, value) {
      if (updateError) throw updateError;
      update = structuredClone(value);
      return { review_id: "r1" };
    }
  };
  return {
    old,
    getUpdate: () => update,
    dependencies: {
      repository,
      async requestAI() {
        if (aiError) throw aiError;
        return { content: JSON.stringify(raw()), model: "moonshotai/kimi-k3" };
      },
      parseReview: parseAIReviewRawResultV22ForResponse,
      now: () => new Date("2026-08-13T10:00:00.000Z")
    }
  };
}

for (const status of ["reviewing", "published"]) {
  test(`${status} review regenerates into v2.2 while preserving status`, async () => {
    const testHarness = harness({ status });
    const result = await regenerateFullWritingReview("a1", testHarness.dependencies);
    assert.equal(result.status, status);
    assert.equal(result.update.ai_review_raw.schema_version, "2.2");
    assert.equal(result.update.language_edits[0].edit_id, "new-edit");
    assert.equal(result.update.language_edits[0].source, "ai");
    assert.equal(result.update.content_feedback.items[0].proposed_revision.length > 0, true);
    assert.equal(result.update.content_feedback.items[0].source, "ai");
    assert.equal(result.update.content_feedback.overall_feedback, "教师旧评语");
    assert.equal(result.update.teacher_comment, "");
    assert.equal(result.update.ai_model, "moonshotai/kimi-k3");
  });
}

test("full regeneration update contains no status or published snapshot fields", async () => {
  const testHarness = harness({ status: "published" });
  await regenerateFullWritingReview("a1", testHarness.dependencies);
  const update = testHarness.getUpdate();
  assert.equal("status" in update, false);
  for (const key of Object.keys(testHarness.old).filter((key) => key.startsWith("published"))) {
    assert.equal(key in update, false, `${key} must remain untouched`);
  }
});

test("full regeneration keeps teacher scores and final feedback while refreshing AI fields", async () => {
  const existingScores = {
    official_score: { ai_score: 1, teacher_score: 5, rationale: "旧依据" },
    dimension_scores: {
      communicative_purpose_and_elaboration: { ai_score: 1, teacher_score: 4, ai_basis: "旧依据" },
      syntactic_range_and_word_choice: { ai_score: 1, teacher_score: 2, ai_basis: "旧依据" },
      social_conventions: { ai_score: 1, teacher_score: 5, ai_basis: "旧依据" },
      lexical_and_grammatical_control: { ai_score: 1, teacher_score: 3, ai_basis: "旧依据" }
    }
  };
  const testHarness = harness({ existingScores, teacherComment: "保留最终反馈" });
  const result = await regenerateFullWritingReview("a1", testHarness.dependencies);
  assert.equal(result.update.scores.official_score.ai_score, 3);
  assert.equal(result.update.scores.official_score.teacher_score, 5);
  assert.equal(
    result.update.scores.dimension_scores.syntactic_range_and_word_choice.teacher_score,
    2
  );
  assert.equal(result.update.content_feedback.overall_feedback, "保留最终反馈");
  assert.equal(result.update.teacher_comment, "");
});

test("overwrite regeneration starts from only the new AI working review", async () => {
  const originalRaw = raw();
  originalRaw.overall_feedback = "旧 AI 总体评价。";
  const existingScores = parseAIReviewRawResultV22ForResponse(
    originalRaw,
    responseText
  ).scores;
  existingScores.official_score.teacher_score = 5;
  existingScores.official_score.rationale = "教师总分参考";
  existingScores.dimension_scores.social_conventions.teacher_score = 5;
  existingScores.dimension_scores.social_conventions.ai_basis = "教师单项依据";
  const testHarness = harness({
    aiReviewRaw: originalRaw,
    existingScores,
    existingLanguageEdits: [{
      edit_id: "teacher-edit",
      source: "teacher",
      start: 0,
      end: 1,
      original_text: "I",
      replacement_text: "We",
      category: "word_choice",
      severity: "moderate",
      explanation: "教师修改。",
      restored: false
    }],
    existingFeedback: {
      items: [{ feedback_id: "teacher-feedback", source: "teacher" }],
      overall_feedback: "教师总体评价。"
    },
    teacherComment: "历史教师总体评价。"
  });
  const result = await regenerateFullWritingReview(
    "a1",
    testHarness.dependencies,
    { preserveTeacherContent: false }
  );
  assert.deepEqual(
    result.update.language_edits.map((item) => [item.edit_id, item.source]),
    [["new-edit", "ai"]]
  );
  assert.deepEqual(
    result.update.content_feedback.items.map((item) => [item.feedback_id, item.source]),
    [["new-feedback", "ai"]]
  );
  assert.equal(result.update.scores.official_score.teacher_score, 3);
  assert.equal(result.update.scores.official_score.rationale, "中文整体依据。");
  assert.equal(
    result.update.scores.dimension_scores.social_conventions.teacher_score,
    3
  );
  assert.equal(
    result.update.scores.dimension_scores.social_conventions.ai_basis,
    "中文依据。"
  );
  assert.equal(result.update.content_feedback.overall_feedback, "中文总体评价。");
  assert.equal(result.update.teacher_comment, "");
});

test("both AI routes expose the same explicit preserve or overwrite mode", () => {
  const generate = fs.readFileSync(
    path.join(process.cwd(), "app/api/teacher/writing/reviews/[attemptId]/generate-ai/route.ts"),
    "utf8"
  );
  const regenerate = fs.readFileSync(
    path.join(process.cwd(), "app/api/teacher/writing/reviews/[attemptId]/regenerate-ai/route.ts"),
    "utf8"
  );
  for (const source of [generate, regenerate]) {
    assert.match(source, /teacher_content/);
    assert.match(source, /=== "overwrite"/);
  }
  assert.match(generate, /overwriteTeacherContent[\s\S]*language_edits: input\.language_edits/);
  assert.match(generate, /overall_feedback: input\.content_feedback\.overall_feedback/);
  assert.match(regenerate, /preserveTeacherContent: !overwriteTeacherContent/);
});

test("full regeneration preserves edited final references but refreshes untouched AI references", () => {
  const originalRaw = raw();
  originalRaw.scores.official_score.rationale = "原 AI 总分依据";
  Object.values(originalRaw.scores.dimension_scores).forEach((dimension) => {
    dimension.ai_basis = "原 AI 单项依据";
  });
  const existingScores = {
    official_score: {
      ai_score: 3,
      teacher_score: 4,
      rationale: "教师修改后的总分参考"
    },
    dimension_scores: Object.fromEntries(
      Object.keys(originalRaw.scores.dimension_scores).map((key) => [
        key,
        {
          ai_score: 3,
          teacher_score: 4,
          ai_basis:
            key === "social_conventions"
              ? ""
              : "原 AI 单项依据"
        }
      ])
    )
  };
  const regenerated = parseAIReviewRawResultV22ForResponse(raw(), responseText);
  const merged = mergeRegeneratedWritingReviewTeacherState(
    regenerated.scores,
    {
      ai_review_raw: originalRaw,
      scores: existingScores,
      content_feedback: { overall_feedback: originalRaw.overall_feedback },
      teacher_comment: ""
    },
    regenerated.overall_feedback
  );
  assert.equal(
    merged.scores.official_score.rationale,
    "教师修改后的总分参考"
  );
  assert.equal(merged.scores.dimension_scores.social_conventions.ai_basis, "");
  assert.equal(
    merged.scores.dimension_scores.syntactic_range_and_word_choice.ai_basis,
    "中文依据。"
  );
});

test("first AI generation preserves filled manual references and initializes blank ones", () => {
  const regenerated = parseAIReviewRawResultV22ForResponse(raw(), responseText);
  const manualScores = structuredClone(regenerated.scores);
  manualScores.official_score.rationale = "教师手动总分参考";
  manualScores.dimension_scores.social_conventions.ai_basis = "教师手动单项依据";
  manualScores.dimension_scores.syntactic_range_and_word_choice.ai_basis = "";
  const merged = mergeRegeneratedWritingReviewTeacherState(
    regenerated.scores,
    {
      ai_review_raw: null,
      scores: manualScores,
      content_feedback: { overall_feedback: "" },
      teacher_comment: ""
    },
    regenerated.overall_feedback
  );
  assert.equal(merged.scores.official_score.rationale, "教师手动总分参考");
  assert.equal(
    merged.scores.dimension_scores.social_conventions.ai_basis,
    "教师手动单项依据"
  );
  assert.equal(
    merged.scores.dimension_scores.syntactic_range_and_word_choice.ai_basis,
    "中文依据。"
  );
});

test("full regeneration updates untouched AI overall feedback", () => {
  const originalRaw = raw();
  originalRaw.overall_feedback = "原 AI 总体评价。";
  const regenerated = parseAIReviewRawResultV22ForResponse(raw(), responseText);
  const merged = mergeRegeneratedWritingReviewTeacherState(
    regenerated.scores,
    {
      ai_review_raw: originalRaw,
      scores: regenerated.scores,
      content_feedback: { overall_feedback: "原 AI 总体评价。" },
      teacher_comment: ""
    },
    "新 AI 总体评价。"
  );
  assert.equal(merged.overall_feedback, "新 AI 总体评价。");
});

for (const teacherOverall of ["教师修改后的总体评价。", ""]) {
  test(`full regeneration preserves teacher overall feedback ${JSON.stringify(teacherOverall)}`, () => {
    const originalRaw = raw();
    originalRaw.overall_feedback = "原 AI 总体评价。";
    const regenerated = parseAIReviewRawResultV22ForResponse(raw(), responseText);
    const merged = mergeRegeneratedWritingReviewTeacherState(
      regenerated.scores,
      {
        ai_review_raw: originalRaw,
        scores: regenerated.scores,
        content_feedback: { overall_feedback: teacherOverall },
        teacher_comment: ""
      },
      "新 AI 总体评价。"
    );
    assert.equal(merged.overall_feedback, teacherOverall);
  });
}

test("first AI generation preserves manual overall feedback and initializes a blank one", () => {
  const regenerated = parseAIReviewRawResultV22ForResponse(raw(), responseText);
  for (const [current, expected] of [
    ["首次 AI 前的教师总体评价。", "首次 AI 前的教师总体评价。"],
    ["", regenerated.overall_feedback]
  ]) {
    const merged = mergeRegeneratedWritingReviewTeacherState(
      regenerated.scores,
      {
        ai_review_raw: null,
        scores: regenerated.scores,
        content_feedback: { overall_feedback: current },
        teacher_comment: ""
      },
      regenerated.overall_feedback
    );
    assert.equal(merged.overall_feedback, expected);
  }
});

test("full regeneration replaces legacy and AI-source items but preserves teacher items", async () => {
  const teacherEdit = {
    edit_id: "teacher-edit",
    source: "teacher",
    start: 0,
    end: 1,
    original_text: "I",
    replacement_text: "We",
    category: "word_choice",
    severity: "moderate",
    explanation: "教师修改。",
    restored: false
  };
  const teacherFeedback = {
    feedback_id: "teacher-feedback",
    source: "teacher",
    start: 0,
    end: 1,
    original_sentence: "I",
    category: "elaboration",
    issue: "教师反馈。",
    suggestion: "",
    proposed_revision: "",
    included: true
  };
  const testHarness = harness({
    existingLanguageEdits: [
      { edit_id: "legacy-ai" },
      { edit_id: "explicit-ai", source: "ai" },
      teacherEdit
    ],
    existingFeedback: {
      items: [
        { feedback_id: "legacy-feedback" },
        { feedback_id: "explicit-ai-feedback", source: "ai" },
        teacherFeedback
      ]
    }
  });
  const result = await regenerateFullWritingReview("a1", testHarness.dependencies);
  assert.deepEqual(
    result.update.language_edits.map((item) => item.edit_id),
    ["teacher-edit", "new-edit"]
  );
  assert.deepEqual(
    result.update.content_feedback.items.map((item) => item.feedback_id),
    ["new-feedback", "teacher-feedback"]
  );
});

test("teacher language edit wins when regenerated AI edit overlaps it", () => {
  const teacherEdit = {
    edit_id: "teacher-overlap",
    source: "teacher",
    start: 5,
    end: 10,
    original_text: "write",
    replacement_text: "writing",
    category: "grammar",
    severity: "moderate",
    explanation: "教师修改。",
    restored: false
  };
  const parsed = parseAIReviewRawResultV22ForResponse(raw(), responseText);
  const merged = mergeRegeneratedWritingReviewItems(
    responseText,
    parsed.language_edits,
    parsed.content_feedback,
    { language_edits: [teacherEdit], content_feedback: { items: [] } }
  );
  assert.deepEqual(merged.language_edits, [teacherEdit]);
});

test("AI or validation failure never starts a database update", async () => {
  const aiFailure = harness({ aiError: new Error("provider down") });
  await assert.rejects(
    regenerateFullWritingReview("a1", aiFailure.dependencies),
    /provider down/
  );
  assert.equal(aiFailure.getUpdate(), null);

  const invalid = harness();
  invalid.dependencies.requestAI = async () => ({
    content: JSON.stringify({ ...raw(), schema_version: "2.0" }),
    model: "moonshotai/kimi-k3"
  });
  await assert.rejects(
    regenerateFullWritingReview("a1", invalid.dependencies),
    (error) => error.code === "AI_RESPONSE_INVALID"
  );
  assert.equal(invalid.getUpdate(), null);
});

test("regenerate timeout leaves reviewing or published review entirely untouched", async () => {
  for (const status of ["reviewing", "published"]) {
    const timeout = new OpenRouterWritingReviewError(
      "AI_REQUEST_TIMEOUT",
      "AI 初批生成超时，请稍后重试。",
      504
    );
    const testHarness = harness({ status, aiError: timeout });
    await assert.rejects(
      regenerateFullWritingReview("a1", testHarness.dependencies),
      (error) => error.code === "AI_REQUEST_TIMEOUT" && error.status === 504
    );
    assert.equal(testHarness.getUpdate(), null);
    assert.equal(status === "published" ? testHarness.old.published_at : true, status === "published" ? "2026-08-13T08:00:00.000Z" : true);
  }
});

test("database failure occurs after one atomic full working update payload", async () => {
  const testHarness = harness({ updateError: new Error("db down") });
  await assert.rejects(
    regenerateFullWritingReview("a1", testHarness.dependencies),
    (error) => error.code === "REVIEW_UPDATE_FAILED"
  );
});

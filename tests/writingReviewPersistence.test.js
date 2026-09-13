const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  prepareWritingReviewForPersistence,
  WritingReviewDatabaseError,
  writingReviewDatabaseDiagnostic
} = require("../lib/writingReviewPersistence.ts");

test("persistence payload normalizes PostgreSQL-incompatible JSON text only", () => {
  const input = {
    ai_review_raw: {
      overall_feedback: "保留普通文本和 emoji 😀，移除\u0000空字符",
      content_feedback: [{ issue: `替换未配对代理项 ${String.fromCharCode(0xd800)}` }]
    },
    language_edits: [{ source: "ai", explanation: "正常" }],
    content_feedback: { items: [{ source: "teacher" }] }
  };

  const result = prepareWritingReviewForPersistence(input);

  assert.notEqual(result, input);
  assert.equal(input.ai_review_raw.overall_feedback.includes("\u0000"), true);
  assert.equal(
    result.ai_review_raw.overall_feedback,
    "保留普通文本和 emoji 😀，移除空字符"
  );
  assert.equal(result.ai_review_raw.content_feedback[0].issue, "替换未配对代理项 �");
  assert.equal(result.language_edits[0].source, "ai");
  assert.equal(result.content_feedback.items[0].source, "teacher");
});

test("persistence error retains the raw Supabase diagnostic behind the public wrapper", () => {
  const supabaseError = {
    code: "22P05",
    message: "unsupported Unicode escape sequence",
    details: "\\u0000 cannot be converted to text.",
    hint: null
  };
  const error = new WritingReviewDatabaseError(
    "REVIEW_SAVE_FAILED",
    "The validated AI writing review could not be saved.",
    "insert",
    supabaseError
  );

  assert.equal(error.message, "The validated AI writing review could not be saved.");
  assert.deepEqual(writingReviewDatabaseDiagnostic(error), {
    operation: "insert",
    code: "22P05",
    message: "unsupported Unicode escape sequence",
    details: "\\u0000 cannot be converted to text.",
    hint: null
  });
});

test("generate-ai keeps insert/update semantics and records Supabase causes", () => {
  const route = fs.readFileSync(
    path.join(
      process.cwd(),
      "app/api/teacher/writing/reviews/[attemptId]/generate-ai/route.ts"
    ),
    "utf8"
  );

  assert.match(route, /if \(manualReview\)[\s\S]*?\.update\(/);
  assert.match(route, /\.insert\(persistenceInput\)/);
  assert.doesNotMatch(route, /\.upsert\(/);
  assert.match(
    route,
    /"REVIEW_SAVE_FAILED",[\s\S]*?"update",[\s\S]*?error/
  );
  assert.match(
    route,
    /"REVIEW_SAVE_FAILED",[\s\S]*?"insert",[\s\S]*?error \?\?/
  );
  assert.match(route, /error\?\.code === "23505"/);
  assert.match(route, /database_error: databaseDiagnostic/);
});

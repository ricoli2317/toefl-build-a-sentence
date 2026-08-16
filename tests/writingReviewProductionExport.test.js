const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  WRITING_REVIEW_CURRENT_EXPORT_CASES,
  WRITING_REVIEW_CURRENT_EXPORT_OUTPUT_DIR,
  WRITING_REVIEW_CURRENT_EXPORT_SUMMARY_FILE,
  buildWritingReviewCurrentExport,
  buildWritingReviewCurrentSummary,
  writeWritingReviewCurrentExportFiles
} = require("../lib/writingReviewProductionExport.ts");

function rows(exportCase) {
  const dimensions =
    exportCase.task_type === "email"
      ? {
          communicative_purpose_and_elaboration: {
            ai_score: 3,
            teacher_score: 3,
            ai_basis: "Email dimension"
          },
          syntactic_range_and_word_choice: {
            ai_score: 2,
            teacher_score: 2,
            ai_basis: "Syntax dimension"
          }
        }
      : {
          relevance: {
            ai_score: 3,
            teacher_score: 3,
            ai_basis: "Relevance dimension"
          },
          elaboration: {
            ai_score: 2,
            teacher_score: 2,
            ai_basis: "Elaboration dimension"
          }
        };
  return {
    attempt: {
      attempt_id: exportCase.attempt_id,
      task_type: exportCase.task_type,
      response_text: `Full ${exportCase.case_label} response text.`
    },
    review: {
      attempt_id: exportCase.attempt_id,
      task_type: exportCase.task_type,
      ai_model: "moonshotai/kimi-k3",
      ai_generated_at: "2026-08-14T10:00:00.000Z",
      ai_review_raw: {
        schema_version: "2.2",
        overall_feedback: `Overall feedback for ${exportCase.case_label}.`,
        secret_provider_field: "must not be exported"
      },
      scores: {
        official_score: {
          ai_score: 3,
          teacher_score: 3,
          rationale: "Official rationale"
        },
        dimension_scores: dimensions
      },
      language_edits: [
        {
          edit_id: "edit-1",
          original_text: "original phrase",
          replacement_text: "replacement phrase",
          category: "grammar",
          severity: "major",
          explanation: "Full explanation",
          start: 5,
          end: 20,
          restored: false
        }
      ],
      content_feedback: {
        items: [
          {
            feedback_id: "feedback-1",
            category: "elaboration",
            original_sentence: "Full source sentence.",
            issue: "Full issue",
            suggestion: "Full suggestion",
            proposed_revision: "Full proposed revision.",
            included: true
          },
          {
            feedback_id: "feedback-2",
            category: "elaboration",
            original_sentence: "Another source sentence.",
            issue: "Another issue",
            suggestion: "Another suggestion",
            proposed_revision: "Another proposed revision.",
            included: true
          }
        ],
        overall_feedback: "Current working overall feedback"
      },
      teacher_comment: "Current teacher comment",
      published_language_edits: [{ edit_id: "published-edit" }],
      published_scores: { private: true },
      published_content_feedback: { items: [] },
      published_teacher_comment: "Published comment",
      published_at: "2026-08-14T09:00:00.000Z"
    }
  };
}

function currentExports() {
  return WRITING_REVIEW_CURRENT_EXPORT_CASES.map((exportCase) => {
    const { attempt, review } = rows(exportCase);
    return buildWritingReviewCurrentExport(exportCase, attempt, review);
  });
}

test("current export fixes the two requested attempts, order, and filenames", () => {
  assert.deepEqual(
    WRITING_REVIEW_CURRENT_EXPORT_CASES.map((item) => ({
      attempt_id: item.attempt_id,
      task_type: item.task_type,
      file_name: item.file_name
    })),
    [
      {
        attempt_id: "cde72af6-e6d0-439b-b3ac-91fb2ab117b1",
        task_type: "email",
        file_name: "email-weak-current.json"
      },
      {
        attempt_id: "a7ad7e9f-b4ef-4ee0-9b39-43f1d7020cdc",
        task_type: "academic_discussion",
        file_name: "ad-weak-current.json"
      }
    ]
  );
  assert.equal(
    WRITING_REVIEW_CURRENT_EXPORT_OUTPUT_DIR,
    "tmp/writing-review-production-export"
  );
  assert.equal(
    WRITING_REVIEW_CURRENT_EXPORT_SUMMARY_FILE,
    "current-reviews-summary.json"
  );
});

test("detail export preserves full working content and only safe raw overall feedback", () => {
  const exported = currentExports()[0];
  assert.equal(exported.response_text, "Full email_weak response text.");
  assert.deepEqual(exported.language_edits[0], {
    edit_id: "edit-1",
    original_text: "original phrase",
    replacement_text: "replacement phrase",
    category: "grammar",
    severity: "major",
    explanation: "Full explanation",
    start: 5,
    end: 20,
    restored: false
  });
  assert.equal(
    exported.content_feedback.items[0].proposed_revision,
    "Full proposed revision."
  );
  assert.equal(exported.teacher_comment, "Current teacher comment");
  assert.equal(exported.overall_feedback, "Overall feedback for email_weak.");
  const serialized = JSON.stringify(exported);
  assert.doesNotMatch(serialized, /published_|secret_provider_field/);
  assert.doesNotMatch(serialized, /API[_ -]?key|Authorization/i);
});

test("summary contains only requested metadata, scores, counts, and categories", () => {
  const summary = buildWritingReviewCurrentSummary(currentExports());
  assert.equal(summary.length, 2);
  assert.deepEqual(summary[0], {
    attempt_id: "cde72af6-e6d0-439b-b3ac-91fb2ab117b1",
    task_type: "email",
    ai_model: "moonshotai/kimi-k3",
    ai_generated_at: "2026-08-14T10:00:00.000Z",
    official_score: 3,
    dimension_scores: {
      communicative_purpose_and_elaboration: 3,
      syntactic_range_and_word_choice: 2
    },
    language_edit_count: 1,
    content_feedback_count: 2,
    content_feedback_categories: { elaboration: 2 }
  });
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(
    serialized,
    /response_text|original_text|replacement_text|issue|suggestion|teacher_comment|published_/
  );
});

test("writer creates exactly two details and one summary", () => {
  const files = new Map();
  const directories = [];
  writeWritingReviewCurrentExportFiles("/safe/output", currentExports(), {
    mkdirSync(directory, options) {
      directories.push([directory, options]);
    },
    writeFileSync(file, content, encoding) {
      files.set(file, { content: String(content), encoding });
    }
  });
  assert.deepEqual(directories, [["/safe/output", { recursive: true }]]);
  assert.deepEqual([...files.keys()].sort(), [
    "/safe/output/ad-weak-current.json",
    "/safe/output/current-reviews-summary.json",
    "/safe/output/email-weak-current.json"
  ]);
  assert.equal(files.get("/safe/output/email-weak-current.json").encoding, "utf8");
  assert.equal(
    JSON.parse(files.get("/safe/output/email-weak-current.json").content)
      .language_edits[0].explanation,
    "Full explanation"
  );
});

test("CLI is database-read-only, has no OpenRouter path, and logs no content", () => {
  const root = process.cwd();
  const script = fs.readFileSync(
    path.join(root, "scripts/export-writing-current-reviews.ts"),
    "utf8"
  );
  const packageJson = fs.readFileSync(path.join(root, "package.json"), "utf8");
  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.match(script, /\.from\("writing_attempts"\)/);
  assert.match(script, /\.from\("writing_reviews"\)/);
  assert.doesNotMatch(
    script,
    /OpenRouter|OPENROUTER|requestAI|\.insert\(|\.update\(|\.upsert\(|\.delete\(/
  );
  assert.doesNotMatch(script, /published_/);
  assert.doesNotMatch(script, /API[_ -]?key|Authorization|SUPABASE_SERVICE_ROLE_KEY.*console/i);
  assert.match(packageJson, /"export:writing-current-reviews"/);
  assert.match(gitignore, /\/tmp\/writing-review-production-export\//);
});

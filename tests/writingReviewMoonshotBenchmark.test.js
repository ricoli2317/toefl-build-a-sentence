const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  EMPTY_OPENROUTER_USAGE,
  WRITING_REVIEW_FULL_REQUEST_TIMEOUT_MS
} = require("../lib/openrouterWritingReview.ts");
const {
  MOONSHOT_WRITING_REVIEW_MODEL,
  MoonshotWritingReviewError
} = require("../lib/moonshotWritingReview.ts");
const {
  DEFAULT_WRITING_REVIEW_MOONSHOT_BENCHMARK_ATTEMPT_ID,
  WRITING_REVIEW_MOONSHOT_BENCHMARK_EFFORTS,
  WRITING_REVIEW_MOONSHOT_BENCHMARK_OUTPUT_DIR,
  WRITING_REVIEW_MOONSHOT_BENCHMARK_TIMEOUT_MS,
  benchmarkWritingReviewMoonshot,
  writeWritingReviewMoonshotBenchmarkFiles
} = require("../lib/writingReviewMoonshotBenchmark.ts");
const {
  parseAIReviewRawResultV22ForResponse
} = require("../lib/writingReviewSchemaV22.ts");

const responseText = "I am write today. This is helpful.";

function raw(overrides = {}) {
  const dimension = (ai_score) => ({ ai_score, ai_basis: "具体评分依据。" });
  return {
    schema_version: "2.2",
    task_type: "email",
    language_edits: [{
      edit_id: "edit-1",
      original_text: "am write",
      replacement_text: "am writing",
      category: "grammar",
      severity: "moderate",
      explanation: "现在进行时应使用 -ing 形式。"
    }],
    scores: {
      official_score: { ai_score: 4, rationale: "任务完成较好。" },
      dimension_scores: {
        communicative_purpose_and_elaboration: dimension(4),
        syntactic_range_and_word_choice: dimension(3),
        social_conventions: dimension(4),
        lexical_and_grammatical_control: dimension(3)
      }
    },
    content_feedback: [{
      feedback_id: "feedback-1",
      category: "elaboration",
      original_sentence: "This is helpful.",
      issue: "支持细节不足。",
      suggestion: "补充具体原因。",
      proposed_revision: "This is helpful because it gives clearer direction."
    }],
    overall_feedback: "回应清楚，应补充细节。",
    ...overrides
  };
}

function usage(overrides = {}) {
  return {
    ...EMPTY_OPENROUTER_USAGE,
    prompt_tokens: 5000,
    cached_tokens: 50,
    completion_tokens: 8000,
    reasoning_tokens: 6500,
    accepted_prediction_tokens: 3,
    rejected_prediction_tokens: 1,
    total_tokens: 13000,
    cost: 0.123456789,
    ...overrides
  };
}

function input() {
  return {
    attemptId: DEFAULT_WRITING_REVIEW_MOONSHOT_BENCHMARK_ATTEMPT_ID,
    taskType: "email",
    question: { question_id: "email-1" },
    responseText
  };
}

function immediateTimeout(request, options) {
  assert.equal(options.timeoutMs, 240_000);
  return request(new AbortController().signal);
}

test("Moonshot benchmark runs max then high sequentially exactly once", async () => {
  const order = [];
  const calls = { max: 0, high: 0 };
  let active = false;
  const results = await benchmarkWritingReviewMoonshot(input(), {
    requestWithTimeout: immediateTimeout,
    async requestAI(_input, effort) {
      assert.equal(active, false);
      active = true;
      order.push(effort);
      calls[effort] += 1;
      active = false;
      return {
        content: JSON.stringify(raw()),
        model: MOONSHOT_WRITING_REVIEW_MODEL,
        usage: usage({ reasoning_tokens: effort === "max" ? 6500 : 4000 })
      };
    },
    parseReview: parseAIReviewRawResultV22ForResponse
  });

  assert.deepEqual(WRITING_REVIEW_MOONSHOT_BENCHMARK_EFFORTS, ["max", "high"]);
  assert.deepEqual(order, ["max", "high"]);
  assert.deepEqual(calls, { max: 1, high: 1 });
  assert.deepEqual(results.map((result) => result.result), ["success", "success"]);
  assert.ok(results.every((result) => result.provider === "moonshot-direct"));
});

test("max timeout and provider errors are isolated, not retried, and high continues", async () => {
  const calls = { max: 0, high: 0 };
  const timeoutResults = await benchmarkWritingReviewMoonshot(input(), {
    requestWithTimeout: immediateTimeout,
    async requestAI(_input, effort) {
      calls[effort] += 1;
      if (effort === "max") {
        throw new MoonshotWritingReviewError(
          "AI_REQUEST_TIMEOUT",
          "Moonshot max benchmark timed out.",
          504
        );
      }
      return {
        content: JSON.stringify(raw()),
        model: MOONSHOT_WRITING_REVIEW_MODEL,
        usage: usage()
      };
    },
    parseReview: parseAIReviewRawResultV22ForResponse
  });
  assert.deepEqual(calls, { max: 1, high: 1 });
  assert.deepEqual(timeoutResults.map((result) => result.result), ["timeout", "success"]);
  assert.equal(timeoutResults[0].error_code, "AI_REQUEST_TIMEOUT");
  assert.equal(timeoutResults[0].cost, null);

  const providerResults = await benchmarkWritingReviewMoonshot(input(), {
    requestWithTimeout: immediateTimeout,
    async requestAI(_input, effort) {
      if (effort === "max") throw new Error("provider unavailable");
      return {
        content: JSON.stringify(raw()),
        model: MOONSHOT_WRITING_REVIEW_MODEL,
        usage: usage()
      };
    },
    parseReview: parseAIReviewRawResultV22ForResponse
  });
  assert.deepEqual(providerResults.map((result) => result.result), [
    "provider_error",
    "success"
  ]);
});

test("validation failure retains usage and high still runs", async () => {
  const invalid = raw();
  invalid.language_edits[0].original_text = "not in the response";
  const results = await benchmarkWritingReviewMoonshot(input(), {
    requestWithTimeout: immediateTimeout,
    async requestAI(_input, effort) {
      return {
        content: JSON.stringify(effort === "max" ? invalid : raw()),
        model: MOONSHOT_WRITING_REVIEW_MODEL,
        usage: usage()
      };
    },
    parseReview: parseAIReviewRawResultV22ForResponse
  });
  assert.equal(results[0].result, "validation_error");
  assert.equal(results[0].schema_valid, false);
  assert.equal(results[0].reasoning_tokens, 6500);
  assert.equal(results[0].cost, 0.123456789);
  assert.equal(results[1].result, "success");
});

test("benchmark records performance, quality summaries, and null missing cost", async () => {
  const results = await benchmarkWritingReviewMoonshot(input(), {
    requestWithTimeout: immediateTimeout,
    async requestAI(_input, effort) {
      return {
        content: JSON.stringify(raw()),
        model: MOONSHOT_WRITING_REVIEW_MODEL,
        usage: effort === "max" ? usage() : { ...EMPTY_OPENROUTER_USAGE }
      };
    },
    parseReview: parseAIReviewRawResultV22ForResponse
  });
  const result = results[0];
  assert.equal(result.schema_valid, true);
  assert.equal(result.official_score, 4);
  assert.deepEqual(result.dimension_scores, {
    communicative_purpose_and_elaboration: 4,
    syntactic_range_and_word_choice: 3,
    social_conventions: 4,
    lexical_and_grammatical_control: 3
  });
  assert.equal(result.language_edit_count, 1);
  assert.equal(result.content_feedback_count, 1);
  assert.deepEqual(result.content_feedback_categories, { elaboration: 1 });
  assert.equal(result.cost, 0.123456789);
  assert.equal(results[1].cost, null);
  assert.equal(results[1].reasoning_tokens, null);
});

test("benchmark writes two full detail files and one compact summary", () => {
  const files = new Map();
  const result = {
    provider: "moonshot-direct",
    reasoning_effort: "max",
    operation: "moonshot_direct_benchmark",
    attempt_id: "attempt-1",
    task_type: "email",
    model: MOONSHOT_WRITING_REVIEW_MODEL,
    elapsed_ms: 123,
    ...usage(),
    result: "success",
    error_code: null,
    error: null,
    schema_valid: true,
    official_score: 4,
    dimension_scores: { syntactic_range_and_word_choice: 3 },
    language_edit_count: 1,
    content_feedback_count: 1,
    content_feedback_categories: { elaboration: 1 },
    validated_result: {
      overall_feedback: "完整结果",
      content_feedback: [{ proposed_revision: "Revision." }]
    }
  };
  const results = [result, { ...result, reasoning_effort: "high" }];
  const summary = writeWritingReviewMoonshotBenchmarkFiles(
    "/safe/benchmark",
    results,
    {
      mkdirSync() {},
      writeFileSync(file, content) { files.set(file, String(content)); }
    }
  );

  for (const effort of ["max", "high"]) {
    const detail = JSON.parse(
      files.get(path.join("/safe/benchmark", `moonshot-${effort}.json`))
    );
    assert.equal(detail.validated_result.overall_feedback, "完整结果");
    assert.equal(detail.validated_result.content_feedback[0].proposed_revision, "Revision.");
  }
  const summaryFile = JSON.parse(
    files.get(path.join("/safe/benchmark", "moonshot-summary.json"))
  );
  assert.deepEqual(summaryFile, summary);
  assert.equal("validated_result" in summaryFile.results[0], false);
});

test("Moonshot benchmark wiring is read-only and isolated from production routes", () => {
  const root = process.cwd();
  const script = fs.readFileSync(
    path.join(root, "scripts/benchmark-writing-review-moonshot.ts"),
    "utf8"
  );
  const client = fs.readFileSync(path.join(root, "lib/moonshotWritingReview.ts"), "utf8");
  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  const productionRoutes = [
    "app/api/teacher/writing/reviews/[attemptId]/generate-ai/route.ts",
    "app/api/teacher/writing/reviews/[attemptId]/regenerate-ai/route.ts"
  ].map((file) => fs.readFileSync(path.join(root, file), "utf8")).join("\n");

  assert.match(script, /loadWritingReviewComparisonSource/);
  assert.match(script, /requestMoonshotWritingReview/);
  assert.match(script, /AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA/);
  assert.match(script, /parseAIReviewRawResultV22ForResponse/);
  assert.doesNotMatch(script, /\.from\("writing_reviews"\)|\.insert\(|\.update\(|\.delete\(/);
  assert.doesNotMatch(script, /console\.(?:log|table)\([^\n]*(?:response_text|responseText|prompt)/);
  assert.doesNotMatch(client, /openrouter\.ai|OPENROUTER_API_KEY|provider\s*:/);
  assert.doesNotMatch(productionRoutes, /moonshotWritingReview|reasoning_effort/);
  assert.match(gitignore, /writing-review-provider-benchmark/);
  assert.equal(WRITING_REVIEW_MOONSHOT_BENCHMARK_TIMEOUT_MS, 240_000);
  assert.equal(
    WRITING_REVIEW_MOONSHOT_BENCHMARK_TIMEOUT_MS,
    WRITING_REVIEW_FULL_REQUEST_TIMEOUT_MS
  );
  assert.equal(
    WRITING_REVIEW_MOONSHOT_BENCHMARK_OUTPUT_DIR,
    "tmp/writing-review-provider-benchmark"
  );
});

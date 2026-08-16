const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  EMPTY_OPENROUTER_USAGE,
  OpenRouterWritingReviewError,
  WRITING_REVIEW_FULL_REQUEST_TIMEOUT_MS
} = require("../lib/openrouterWritingReview.ts");
const {
  DEFAULT_WRITING_REVIEW_REASONING_BENCHMARK_ATTEMPT_ID,
  WRITING_REVIEW_REASONING_BENCHMARK_MODEL,
  WRITING_REVIEW_REASONING_BENCHMARK_OUTPUT_DIR,
  WRITING_REVIEW_REASONING_BENCHMARK_TIMEOUT_MS,
  benchmarkWritingReviewReasoning,
  writeWritingReviewReasoningBenchmarkFiles
} = require("../lib/writingReviewReasoningBenchmark.ts");
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
      official_score: { ai_score: 4, rationale: "任务完成较好。语言仍有少量问题。" },
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
      proposed_revision: "This is helpful because it gives students clearer direction."
    }, {
      feedback_id: "feedback-2",
      category: "language_improvement",
      original_sentence: "I am write today.",
      issue: "表达不自然。",
      suggestion: "使用更自然的表达。",
      proposed_revision: "I am writing today."
    }],
    overall_feedback: "回应清楚。应补充细节并提高表达准确性。",
    ...overrides
  };
}

function usage(overrides = {}) {
  return {
    ...EMPTY_OPENROUTER_USAGE,
    prompt_tokens: 5365,
    cached_tokens: 64,
    completion_tokens: 9181,
    reasoning_tokens: 7449,
    total_tokens: 14546,
    cost: 0.1536372,
    ...overrides
  };
}

function input() {
  return {
    attemptId: DEFAULT_WRITING_REVIEW_REASONING_BENCHMARK_ATTEMPT_ID,
    taskType: "email",
    question: { question_id: "email-1" },
    responseText
  };
}

function immediateTimeout(request, options) {
  assert.equal(options.timeoutMs, 240_000);
  return request(new AbortController().signal);
}

test("reasoning benchmark runs max, high, low sequentially with one request each", async () => {
  const order = [];
  const calls = { max: 0, high: 0, low: 0 };
  let active = false;
  const results = await benchmarkWritingReviewReasoning(input(), {
    requestWithTimeout: immediateTimeout,
    async requestAI(_input, effort) {
      assert.equal(active, false);
      active = true;
      order.push(effort);
      calls[effort] += 1;
      active = false;
      return {
        content: JSON.stringify(raw()),
        model: WRITING_REVIEW_REASONING_BENCHMARK_MODEL,
        usage: usage({ reasoning_tokens: { max: 7449, high: 5000, low: 1200 }[effort] })
      };
    },
    parseReview: parseAIReviewRawResultV22ForResponse
  });

  assert.deepEqual(order, ["max", "high", "low"]);
  assert.deepEqual(calls, { max: 1, high: 1, low: 1 });
  assert.deepEqual(results.map((result) => result.result), ["success", "success", "success"]);
  assert.ok(results.every((result) => result.schema_valid));
});

test("benchmark records usage, cost, score dimensions, and feedback quality summary", async () => {
  const [result] = await benchmarkWritingReviewReasoning(input(), {
    requestWithTimeout: immediateTimeout,
    async requestAI() {
      return {
        content: JSON.stringify(raw()),
        model: WRITING_REVIEW_REASONING_BENCHMARK_MODEL,
        usage: usage()
      };
    },
    parseReview: parseAIReviewRawResultV22ForResponse
  });

  assert.equal(result.prompt_tokens, 5365);
  assert.equal(result.cached_tokens, 64);
  assert.equal(result.completion_tokens, 9181);
  assert.equal(result.reasoning_tokens, 7449);
  assert.equal(result.total_tokens, 14546);
  assert.equal(result.cost, 0.1536372);
  assert.equal(result.official_score, 4);
  assert.deepEqual(result.dimension_scores, {
    communicative_purpose_and_elaboration: 4,
    syntactic_range_and_word_choice: 3,
    social_conventions: 4,
    lexical_and_grammatical_control: 3
  });
  assert.equal(result.language_edit_count, 1);
  assert.equal(result.content_feedback_count, 2);
  assert.deepEqual(result.content_feedback_categories, {
    elaboration: 1,
    language_improvement: 1
  });
  assert.equal(result.validated_result.overall_feedback, raw().overall_feedback);
  assert.equal(
    result.validated_result.content_feedback[0].proposed_revision,
    raw().content_feedback[0].proposed_revision
  );
});

test("timeout and provider failure are isolated and never retried", async () => {
  const calls = { max: 0, high: 0, low: 0 };
  const results = await benchmarkWritingReviewReasoning(input(), {
    requestWithTimeout: immediateTimeout,
    async requestAI(_input, effort) {
      calls[effort] += 1;
      if (effort === "max") {
        throw new OpenRouterWritingReviewError(
          "AI_REQUEST_TIMEOUT",
          "benchmark timeout",
          504
        );
      }
      if (effort === "high") throw new Error("provider unavailable");
      return {
        content: JSON.stringify(raw()),
        model: WRITING_REVIEW_REASONING_BENCHMARK_MODEL,
        usage: usage()
      };
    },
    parseReview: parseAIReviewRawResultV22ForResponse
  });

  assert.deepEqual(calls, { max: 1, high: 1, low: 1 });
  assert.deepEqual(results.map((result) => result.result), [
    "timeout",
    "provider_error",
    "success"
  ]);
  assert.equal(results[0].error_code, "AI_REQUEST_TIMEOUT");
  assert.deepEqual(
    {
      prompt_tokens: results[0].prompt_tokens,
      reasoning_tokens: results[0].reasoning_tokens,
      cost: results[0].cost
    },
    { prompt_tokens: null, reasoning_tokens: null, cost: null }
  );
});

test("validation failure retains usage and continues to later efforts", async () => {
  const invalid = raw();
  invalid.language_edits[0].original_text = "missing text";
  const results = await benchmarkWritingReviewReasoning(input(), {
    requestWithTimeout: immediateTimeout,
    async requestAI(_input, effort) {
      return {
        content: JSON.stringify(effort === "max" ? invalid : raw()),
        model: WRITING_REVIEW_REASONING_BENCHMARK_MODEL,
        usage: usage()
      };
    },
    parseReview: parseAIReviewRawResultV22ForResponse
  });

  assert.equal(results[0].result, "validation_error");
  assert.equal(results[0].schema_valid, false);
  assert.equal(results[0].reasoning_tokens, 7449);
  assert.equal(results[0].cost, 0.1536372);
  assert.deepEqual(results.slice(1).map((result) => result.result), ["success", "success"]);
});

test("missing usage and cost fields do not break successful benchmark output", async () => {
  const results = await benchmarkWritingReviewReasoning(input(), {
    requestWithTimeout: immediateTimeout,
    async requestAI() {
      return {
        content: JSON.stringify(raw()),
        model: WRITING_REVIEW_REASONING_BENCHMARK_MODEL,
        usage: { ...EMPTY_OPENROUTER_USAGE }
      };
    },
    parseReview: parseAIReviewRawResultV22ForResponse
  });
  assert.ok(results.every((result) => result.result === "success"));
  assert.ok(results.every((result) => result.reasoning_tokens === null));
  assert.ok(results.every((result) => result.cost === null));
});

test("benchmark writes full effort files and a compact summary", () => {
  const files = new Map();
  const mkdirCalls = [];
  const result = {
    reasoning_effort: "max",
    operation: "reasoning_benchmark",
    attempt_id: "attempt-1",
    task_type: "email",
    model: WRITING_REVIEW_REASONING_BENCHMARK_MODEL,
    elapsed_ms: 123,
    ...usage(),
    result: "success",
    error_code: null,
    error: null,
    schema_valid: true,
    official_score: 4,
    dimension_scores: { syntactic_range_and_word_choice: 3 },
    language_edit_count: 1,
    content_feedback_count: 2,
    content_feedback_categories: { elaboration: 1, language_improvement: 1 },
    validated_result: { overall_feedback: "完整结果", content_feedback: [{ proposed_revision: "Revision." }] }
  };
  const results = [
    result,
    { ...result, reasoning_effort: "high" },
    { ...result, reasoning_effort: "low" }
  ];
  const summary = writeWritingReviewReasoningBenchmarkFiles(
    "/safe/benchmark",
    results,
    {
      mkdirSync(directory, options) { mkdirCalls.push([directory, options]); },
      writeFileSync(file, content) { files.set(file, String(content)); }
    }
  );

  assert.deepEqual(mkdirCalls, [["/safe/benchmark", { recursive: true }]]);
  for (const effort of ["max", "high", "low"]) {
    const detail = JSON.parse(files.get(path.join("/safe/benchmark", `${effort}.json`)));
    assert.equal(detail.validated_result.overall_feedback, "完整结果");
    assert.equal(detail.validated_result.content_feedback[0].proposed_revision, "Revision.");
  }
  const summaryFile = JSON.parse(files.get(path.join("/safe/benchmark", "summary.json")));
  assert.deepEqual(summaryFile, summary);
  assert.equal("validated_result" in summaryFile.results[0], false);
});

test("benchmark wiring is read-only and reuses production source, prompt, and v2.2 schema", () => {
  const root = process.cwd();
  const script = fs.readFileSync(
    path.join(root, "scripts/benchmark-writing-review-reasoning.ts"),
    "utf8"
  );
  const prompt = fs.readFileSync(path.join(root, "lib/openrouterWritingReview.ts"), "utf8");
  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.match(script, /loadWritingReviewComparisonSource/);
  assert.match(script, /requestOpenRouterWritingReview/);
  assert.match(script, /AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA/);
  assert.match(script, /parseAIReviewRawResultV22ForResponse/);
  assert.doesNotMatch(script, /\.from\("writing_reviews"\)|\.insert\(|\.update\(|\.delete\(/);
  assert.doesNotMatch(script, /console\.(?:log|table)\([^\n]*(?:response_text|responseText|prompt)/);
  assert.match(prompt, /WORD CHOICE & COLLOCATION AUDIT/);
  assert.match(prompt, /smallest uniquely localizable contiguous source span/);
  assert.match(prompt, /all edits applied together produce a grammatically correct result/);
  assert.match(gitignore, /writing-review-reasoning-benchmark/);
  assert.equal(WRITING_REVIEW_REASONING_BENCHMARK_TIMEOUT_MS, 240_000);
  assert.equal(WRITING_REVIEW_REASONING_BENCHMARK_TIMEOUT_MS, WRITING_REVIEW_FULL_REQUEST_TIMEOUT_MS);
  assert.equal(WRITING_REVIEW_REASONING_BENCHMARK_OUTPUT_DIR, "tmp/writing-review-reasoning-benchmark");
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  EMPTY_OPENROUTER_USAGE,
  OpenRouterWritingReviewError,
  WRITING_REVIEW_FULL_REQUEST_TIMEOUT_MS,
  requestOpenRouterWritingReview
} = require("../lib/openrouterWritingReview.ts");
const {
  WRITING_REVIEW_REASONING_STABILITY_CASES,
  WRITING_REVIEW_REASONING_STABILITY_EFFORTS,
  WRITING_REVIEW_REASONING_STABILITY_MODEL,
  WRITING_REVIEW_REASONING_STABILITY_OUTPUT_DIR,
  WRITING_REVIEW_REASONING_STABILITY_TIMEOUT_MS,
  benchmarkWritingReviewReasoningStability,
  buildWritingReviewReasoningStabilityMarkdown,
  buildWritingReviewReasoningStabilitySummary,
  writeWritingReviewReasoningStabilityFiles
} = require("../lib/writingReviewReasoningStabilityBenchmark.ts");
const {
  parseAIReviewRawResultV22ForResponse
} = require("../lib/writingReviewSchemaV22.ts");

const responseText =
  "I am write today. This is helpful. We make a directional goal. Growth environments matter.";

function inputs() {
  return WRITING_REVIEW_REASONING_STABILITY_CASES.map((benchmarkCase) => ({
    attemptId: benchmarkCase.attempt_id,
    caseLabel: benchmarkCase.case_label,
    qualityLabel: benchmarkCase.quality_label,
    taskType: benchmarkCase.task_type,
    question: { question_id: `${benchmarkCase.case_label}-question` },
    responseText
  }));
}

function raw(taskType, effort, overrides = {}) {
  const dimension = (ai_score) => ({ ai_score, ai_basis: "具体评分依据。" });
  const score = effort === "max" ? 4 : 3;
  const dimensions = taskType === "email"
    ? {
        communicative_purpose_and_elaboration: dimension(score),
        syntactic_range_and_word_choice: dimension(score),
        social_conventions: dimension(score),
        lexical_and_grammatical_control: dimension(score)
      }
    : {
        relevance: dimension(score),
        elaboration: dimension(score),
        syntactic_range_and_word_choice: dimension(score),
        lexical_and_grammatical_control: dimension(score)
      };
  const shared = {
    edit_id: "shared-edit",
    original_text: "am write",
    replacement_text: "am writing",
    category: "grammar",
    severity: "moderate",
    explanation: "现在进行时应使用 -ing 形式。"
  };
  const effortOnly = effort === "max"
    ? {
        edit_id: "max-edit",
        original_text: "make a directional goal",
        replacement_text: "set a clear goal",
        category: "word_choice",
        severity: "moderate",
        explanation: "该搭配不自然。"
      }
    : {
        edit_id: "high-edit",
        original_text: "Growth environments",
        replacement_text: "Developmental environments",
        category: "word_choice",
        severity: "minor",
        explanation: "词语选择可以更准确。"
      };
  const firstCategory = "elaboration";
  const secondCategory = "language_improvement";
  const feedback = [{
    feedback_id: "feedback-1",
    category: firstCategory,
    original_sentence: "This is helpful.",
    issue: "支持细节不足。",
    suggestion: "补充具体原因。",
    proposed_revision: "This is helpful because it gives clearer direction."
  }];
  if (effort === "max") {
    feedback.push({
      feedback_id: "feedback-2",
      category: secondCategory,
      original_sentence: "Growth environments matter.",
      issue: "搭配不够自然。",
      suggestion: "使用更精确的名词短语。",
      proposed_revision: "Developmental environments matter."
    });
  }
  return {
    schema_version: "2.2",
    task_type: taskType,
    language_edits: [shared, effortOnly],
    scores: {
      official_score: { ai_score: score, rationale: "整体评分依据。" },
      dimension_scores: dimensions
    },
    content_feedback: feedback,
    overall_feedback: `${effort} 总体评价。`,
    ...overrides
  };
}

function usage(index, overrides = {}) {
  return {
    ...EMPTY_OPENROUTER_USAGE,
    prompt_tokens: 5000 + index,
    cached_tokens: 50,
    completion_tokens: 1000 + index * 100,
    reasoning_tokens: 500 + index * 50,
    accepted_prediction_tokens: 3,
    rejected_prediction_tokens: 1,
    total_tokens: 6000 + index * 100,
    cost: 0.1 + index * 0.01,
    upstream_inference_cost: 0.09 + index * 0.01,
    upstream_inference_prompt_cost: 0.02,
    upstream_inference_completions_cost: 0.07 + index * 0.01,
    ...overrides
  };
}

function immediateTimeout(request, options) {
  assert.equal(options.timeoutMs, 240_000);
  return request(new AbortController().signal);
}

test("stability benchmark fixes the four requested attempts and only max/high", () => {
  assert.deepEqual(WRITING_REVIEW_REASONING_STABILITY_CASES, [
    {
      attempt_id: "a20ed773-23cc-4a10-83e0-4493c4f619de",
      case_label: "email_good",
      quality_label: "good",
      task_type: "email"
    },
    {
      attempt_id: "cde72af6-e6d0-439b-b3ac-91fb2ab117b1",
      case_label: "email_weak",
      quality_label: "weak",
      task_type: "email"
    },
    {
      attempt_id: "a292bcdb-6a86-4ab8-a00a-4c4e6c707c9c",
      case_label: "ad_good",
      quality_label: "good",
      task_type: "academic_discussion"
    },
    {
      attempt_id: "a7ad7e9f-b4ef-4ee0-9b39-43f1d7020cdc",
      case_label: "ad_weak",
      quality_label: "weak",
      task_type: "academic_discussion"
    }
  ]);
  assert.deepEqual(WRITING_REVIEW_REASONING_STABILITY_EFFORTS, ["max", "high"]);
  assert.equal(WRITING_REVIEW_REASONING_STABILITY_MODEL, "moonshotai/kimi-k3");
});

test("four cases run max then high sequentially, never low, with exactly eight calls", async () => {
  const order = [];
  let active = false;
  let callCount = 0;
  const results = await benchmarkWritingReviewReasoningStability(inputs(), {
    requestWithTimeout: immediateTimeout,
    async requestAI(input, effort) {
      assert.equal(active, false);
      active = true;
      callCount += 1;
      order.push(`${input.caseLabel}/${effort}`);
      const result = {
        content: JSON.stringify(raw(input.taskType, effort)),
        model: WRITING_REVIEW_REASONING_STABILITY_MODEL,
        usage: usage(callCount)
      };
      active = false;
      return result;
    },
    parseReview: parseAIReviewRawResultV22ForResponse
  });

  assert.equal(callCount, 8);
  assert.deepEqual(order, [
    "email_good/max",
    "email_good/high",
    "email_weak/max",
    "email_weak/high",
    "ad_good/max",
    "ad_good/high",
    "ad_weak/max",
    "ad_weak/high"
  ]);
  assert.equal(results.length, 8);
  assert.ok(results.every((result) => result.reasoning_effort !== "low"));
  assert.ok(results.every((result) => result.result === "success"));
});

test("fixed-case guard prevents any run from exceeding eight requests", async () => {
  let callCount = 0;
  await assert.rejects(
    benchmarkWritingReviewReasoningStability([...inputs(), inputs()[0]], {
      async requestAI() {
        callCount += 1;
        throw new Error("should not run");
      },
      parseReview: parseAIReviewRawResultV22ForResponse
    }),
    /exactly four fixed cases/
  );
  assert.equal(callCount, 0);
});

test("timeout and validation failures continue without retry", async () => {
  const calls = new Map();
  const results = await benchmarkWritingReviewReasoningStability(inputs(), {
    requestWithTimeout: immediateTimeout,
    async requestAI(input, effort) {
      const key = `${input.caseLabel}/${effort}`;
      calls.set(key, (calls.get(key) ?? 0) + 1);
      if (key === "email_good/max") {
        throw new OpenRouterWritingReviewError(
          "AI_REQUEST_TIMEOUT",
          "stability timeout",
          504
        );
      }
      const review = raw(input.taskType, effort);
      if (key === "email_good/high") {
        review.language_edits[0].original_text = "not in response";
      }
      return {
        content: JSON.stringify(review),
        model: WRITING_REVIEW_REASONING_STABILITY_MODEL,
        usage: usage(1)
      };
    },
    parseReview: parseAIReviewRawResultV22ForResponse
  });

  assert.equal(results.length, 8);
  assert.deepEqual(results.slice(0, 3).map((result) => result.result), [
    "timeout",
    "validation_error",
    "success"
  ]);
  assert.ok(Array.from(calls.values()).every((count) => count === 1));
  assert.equal(calls.size, 8);
});

test("each result preserves all performance and quality summary fields", async () => {
  let index = 0;
  const results = await benchmarkWritingReviewReasoningStability(inputs(), {
    requestWithTimeout: immediateTimeout,
    async requestAI(input, effort) {
      index += 1;
      return {
        content: JSON.stringify(raw(input.taskType, effort)),
        model: WRITING_REVIEW_REASONING_STABILITY_MODEL,
        usage: usage(index)
      };
    },
    parseReview: parseAIReviewRawResultV22ForResponse
  });
  const first = results[0];
  assert.equal(first.provider, "openrouter");
  assert.equal(first.operation, "reasoning_stability_benchmark");
  assert.equal(first.schema_valid, true);
  assert.equal(first.prompt_tokens, 5001);
  assert.equal(first.cached_tokens, 50);
  assert.equal(first.completion_tokens, 1100);
  assert.equal(first.reasoning_tokens, 550);
  assert.equal(first.accepted_prediction_tokens, 3);
  assert.equal(first.rejected_prediction_tokens, 1);
  assert.equal(first.total_tokens, 6100);
  assert.equal(first.cost, 0.11);
  assert.equal(first.upstream_inference_cost, 0.09999999999999999);
  assert.equal(first.official_score, 4);
  assert.equal(first.dimension_scores.social_conventions, 4);
  assert.equal(first.language_edit_count, 2);
  assert.equal(first.content_feedback_count, 2);
  assert.deepEqual(first.content_feedback_categories, {
    elaboration: 1,
    language_improvement: 1
  });
  assert.equal(first.overall_feedback, "max 总体评价。");
  assert.equal(first.validated_result.language_edits.length, 2);
  assert.equal(first.validated_result.content_feedback.length, 2);
});

test("missing usage and cost remain null without breaking successful results", async () => {
  const results = await benchmarkWritingReviewReasoningStability(inputs(), {
    requestWithTimeout: immediateTimeout,
    async requestAI(input, effort) {
      return {
        content: JSON.stringify(raw(input.taskType, effort)),
        model: WRITING_REVIEW_REASONING_STABILITY_MODEL,
        usage: { ...EMPTY_OPENROUTER_USAGE }
      };
    },
    parseReview: parseAIReviewRawResultV22ForResponse
  });
  assert.ok(results.every((result) => result.result === "success"));
  assert.ok(results.every((result) => result.reasoning_tokens === null));
  assert.ok(results.every((result) => result.cost === null));
});

test("summary calculates score deltas, exact edits, category deltas, averages, and medians", async () => {
  const times = [
    0, 100, 1000, 1080,
    2000, 2200, 3000, 3120,
    4000, 4300, 5000, 5160,
    6000, 6400, 7000, 7200
  ];
  let index = 0;
  const results = await benchmarkWritingReviewReasoningStability(inputs(), {
    now: () => times.shift(),
    requestWithTimeout: immediateTimeout,
    async requestAI(input, effort) {
      const result = {
        content: JSON.stringify(raw(input.taskType, effort)),
        model: WRITING_REVIEW_REASONING_STABILITY_MODEL,
        usage: usage(index)
      };
      index += 1;
      return result;
    },
    parseReview: parseAIReviewRawResultV22ForResponse
  });
  const summary = buildWritingReviewReasoningStabilitySummary(results);
  const comparison = summary.comparisons[0];
  assert.equal(comparison.official_score_delta, -1);
  assert.ok(Object.values(comparison.dimension_score_deltas).every((delta) => delta === -1));
  assert.equal(comparison.max_language_edit_count, 2);
  assert.equal(comparison.high_language_edit_count, 2);
  assert.equal(comparison.language_edit_count_delta, 0);
  assert.deepEqual(comparison.shared_edits, [{
    original_text: "am write",
    replacement_text: "am writing"
  }]);
  assert.deepEqual(comparison.max_only_edits, [{
    original_text: "make a directional goal",
    replacement_text: "set a clear goal"
  }]);
  assert.deepEqual(comparison.high_only_edits, [{
    original_text: "Growth environments",
    replacement_text: "Developmental environments"
  }]);
  assert.deepEqual(comparison.feedback_category_counts, {
    max: { elaboration: 1, language_improvement: 1 },
    high: { elaboration: 1 },
    delta: { elaboration: 0, language_improvement: -1 }
  });
  assert.deepEqual(summary.aggregate.max, {
    success_count: 4,
    failure_count: 0,
    avg_elapsed_ms: 250,
    median_elapsed_ms: 250,
    avg_reasoning_tokens: 650,
    median_reasoning_tokens: 650,
    avg_completion_tokens: 1300,
    avg_total_tokens: 6300,
    avg_cost: 0.13
  });
  assert.deepEqual(summary.aggregate.high, {
    success_count: 4,
    failure_count: 0,
    avg_elapsed_ms: 140,
    median_elapsed_ms: 140,
    avg_reasoning_tokens: 700,
    median_reasoning_tokens: 700,
    avg_completion_tokens: 1400,
    avg_total_tokens: 6400,
    avg_cost: 0.14
  });
});

test("aggregate ignores failed and missing numeric values", async () => {
  let call = 0;
  const results = await benchmarkWritingReviewReasoningStability(inputs(), {
    requestWithTimeout: immediateTimeout,
    async requestAI(input, effort) {
      call += 1;
      if (call === 1) throw new Error("provider unavailable");
      return {
        content: JSON.stringify(raw(input.taskType, effort)),
        model: WRITING_REVIEW_REASONING_STABILITY_MODEL,
        usage: { ...EMPTY_OPENROUTER_USAGE }
      };
    },
    parseReview: parseAIReviewRawResultV22ForResponse
  });
  const aggregate = buildWritingReviewReasoningStabilitySummary(results).aggregate;
  assert.equal(aggregate.max.success_count, 3);
  assert.equal(aggregate.max.failure_count, 1);
  assert.equal(aggregate.max.avg_reasoning_tokens, null);
  assert.equal(aggregate.high.success_count, 4);
  assert.equal(aggregate.high.avg_cost, null);
});

test("writer produces eight details, summary.json, and a reviewable comparison.md", async () => {
  const results = await benchmarkWritingReviewReasoningStability(inputs(), {
    requestWithTimeout: immediateTimeout,
    async requestAI(input, effort) {
      return {
        content: JSON.stringify(raw(input.taskType, effort)),
        model: WRITING_REVIEW_REASONING_STABILITY_MODEL,
        usage: usage(0)
      };
    },
    parseReview: parseAIReviewRawResultV22ForResponse
  });
  const files = new Map();
  const summary = writeWritingReviewReasoningStabilityFiles(
    "/safe/stability",
    results,
    {
      mkdirSync() {},
      writeFileSync(file, content) { files.set(file, String(content)); }
    }
  );
  assert.equal(files.size, 10);
  for (const benchmarkCase of WRITING_REVIEW_REASONING_STABILITY_CASES) {
    for (const effort of ["max", "high"]) {
      const detail = JSON.parse(
        files.get(
          path.join(
            "/safe/stability",
            `${benchmarkCase.case_label}-${effort}.json`
          )
        )
      );
      assert.equal(detail.validated_result.schema_version, "2.2");
      assert.equal(detail.validated_result.language_edits.length, 2);
      assert.ok(detail.validated_result.content_feedback[0].proposed_revision);
    }
  }
  const summaryFile = JSON.parse(
    files.get(path.join("/safe/stability", "summary.json"))
  );
  assert.deepEqual(summaryFile, summary);
  assert.equal(summaryFile.results.length, 8);
  assert.equal("validated_result" in summaryFile.results[0], false);
  const markdown = files.get(path.join("/safe/stability", "comparison.md"));
  for (const label of ["email_good", "email_weak", "ad_good", "ad_weak"]) {
    assert.match(markdown, new RegExp(`## ${label}`));
  }
  assert.match(markdown, /### Scores/);
  assert.match(markdown, /### Language edits/);
  assert.match(markdown, /Shared \(1\)/);
  assert.match(markdown, /### Content feedback/);
  assert.match(markdown, /This is helpful\./);
  assert.match(markdown, /### Performance/);
  assert.doesNotMatch(markdown, new RegExp(responseText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("stability wiring reuses production OpenRouter prompt/schema and stays read-only", () => {
  const root = process.cwd();
  const script = fs.readFileSync(
    path.join(root, "scripts/benchmark-writing-review-reasoning-stability.ts"),
    "utf8"
  );
  const prompt = fs.readFileSync(path.join(root, "lib/openrouterWritingReview.ts"), "utf8");
  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  const moonshotScript = fs.readFileSync(
    path.join(root, "scripts/benchmark-writing-review-moonshot.ts"),
    "utf8"
  );
  assert.match(script, /loadWritingReviewComparisonSource/);
  assert.match(script, /requestOpenRouterWritingReview/);
  assert.match(script, /AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA/);
  assert.match(script, /parseAIReviewRawResultV22ForResponse/);
  assert.match(script, /reasoningEffort: effort/);
  assert.doesNotMatch(script, /moonshotWritingReview|\blow\b/);
  assert.doesNotMatch(script, /\.from\("writing_reviews"\)|\.insert\(|\.update\(|\.delete\(/);
  assert.doesNotMatch(script, /console\.(?:log|table)\([^\n]*(?:response_text|responseText|prompt)/);
  assert.match(prompt, /WORD CHOICE & COLLOCATION AUDIT/);
  assert.match(prompt, /make a directional goal/);
  assert.match(prompt, /apply my dream career/);
  assert.match(prompt, /introduction papers/);
  assert.match(prompt, /smallest uniquely localizable contiguous source span/);
  assert.match(prompt, /original_text must be an exact/);
  assert.match(gitignore, /writing-review-reasoning-stability/);
  assert.match(moonshotScript, /requestMoonshotWritingReview/);
  assert.equal(WRITING_REVIEW_REASONING_STABILITY_TIMEOUT_MS, 240_000);
  assert.equal(
    WRITING_REVIEW_REASONING_STABILITY_TIMEOUT_MS,
    WRITING_REVIEW_FULL_REQUEST_TIMEOUT_MS
  );
  assert.equal(
    WRITING_REVIEW_REASONING_STABILITY_OUTPUT_DIR,
    "tmp/writing-review-reasoning-stability"
  );
});

test("OpenRouter request body receives max/high while the production default remains absent", async () => {
  const bodies = [];
  for (const reasoningEffort of [undefined, "max", "high"]) {
    await requestOpenRouterWritingReview(
      {
        taskType: "email",
        question: { question_id: "email-1" },
        responseText: "Test response."
      },
      {
        env: {
          OPENROUTER_API_KEY: "test-key",
          OPENROUTER_WRITING_MODEL: WRITING_REVIEW_REASONING_STABILITY_MODEL
        },
        jsonSchema: {},
        ...(reasoningEffort ? { reasoningEffort } : {}),
        async fetchImpl(_url, init) {
          bodies.push(JSON.parse(init.body));
          return new Response(
            JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
      }
    );
  }
  assert.equal("reasoning" in bodies[0], false);
  assert.deepEqual(bodies[1].reasoning, { effort: "max" });
  assert.deepEqual(bodies[2].reasoning, { effort: "high" });
  assert.deepEqual(bodies[1].messages, bodies[2].messages);
  assert.deepEqual(bodies[1].response_format, bodies[2].response_format);
});

test("comparison report outputs objective data without an automatic verdict", async () => {
  const results = await benchmarkWritingReviewReasoningStability(inputs(), {
    requestWithTimeout: immediateTimeout,
    async requestAI(input, effort) {
      return {
        content: JSON.stringify(raw(input.taskType, effort)),
        model: WRITING_REVIEW_REASONING_STABILITY_MODEL,
        usage: usage(0)
      };
    },
    parseReview: parseAIReviewRawResultV22ForResponse
  });
  const markdown = buildWritingReviewReasoningStabilityMarkdown(results);
  assert.doesNotMatch(markdown, /high passed|high failed|use high|use max/i);
});

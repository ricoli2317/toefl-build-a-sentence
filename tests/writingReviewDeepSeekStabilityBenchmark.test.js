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
  AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA,
  parseAIReviewRawResultV22,
  parseAIReviewRawResultV22ForResponse
} = require("../lib/writingReviewSchemaV22.ts");
const {
  WRITING_REVIEW_DEEPSEEK_STABILITY_ALL_CASES,
  WRITING_REVIEW_DEEPSEEK_STABILITY_EFFORT,
  WRITING_REVIEW_DEEPSEEK_STABILITY_EXISTING_CASE,
  WRITING_REVIEW_DEEPSEEK_STABILITY_EXISTING_PRO_PATH,
  WRITING_REVIEW_DEEPSEEK_STABILITY_KIMI_DIR,
  WRITING_REVIEW_DEEPSEEK_STABILITY_MODEL,
  WRITING_REVIEW_DEEPSEEK_STABILITY_NEW_CASES,
  WRITING_REVIEW_DEEPSEEK_STABILITY_OUTPUT_DIR,
  WRITING_REVIEW_DEEPSEEK_STABILITY_TIMEOUT_MS,
  benchmarkWritingReviewDeepSeekStability,
  buildWritingReviewDeepSeekStabilityMarkdown,
  buildWritingReviewDeepSeekStabilitySummary,
  readWritingReviewDeepSeekExistingAdWeak,
  readWritingReviewDeepSeekKimiBaseline,
  writeWritingReviewDeepSeekStabilityFiles
} = require("../lib/writingReviewDeepSeekStabilityBenchmark.ts");

const responses = {
  email_good: "I am write to thank you.",
  email_weak: "I want ask help.",
  ad_good: "Public transit reduce traffic.",
  ad_weak:
    "Teenage years is important. Growth environments matter. Kindful people help. It is necessary."
};

function dimensions(taskType, score) {
  const item = (ai_score) => ({ ai_score, ai_basis: "具体评分依据。" });
  return taskType === "email"
    ? {
        communicative_purpose_and_elaboration: item(score),
        syntactic_range_and_word_choice: item(score),
        social_conventions: item(score),
        lexical_and_grammatical_control: item(score)
      }
    : {
        relevance: item(score),
        elaboration: item(score),
        syntactic_range_and_word_choice: item(score),
        lexical_and_grammatical_control: item(score)
      };
}

function rawReview(caseLabel, overrides = {}) {
  const benchmarkCase = WRITING_REVIEW_DEEPSEEK_STABILITY_ALL_CASES.find(
    (item) => item.case_label === caseLabel
  );
  const editByCase = {
    email_good: ["am write", "am writing"],
    email_weak: ["want ask", "want to ask"],
    ad_good: ["transit reduce", "transit reduces"],
    ad_weak: ["years is", "years are"]
  };
  const feedbackCategory =
    benchmarkCase.task_type === "email" ? "elaboration" : "elaboration";
  const score = benchmarkCase.quality_label === "good" ? 5 : 2;
  return {
    schema_version: "2.2",
    task_type: benchmarkCase.task_type,
    language_edits: [
      {
        edit_id: `${caseLabel}-edit`,
        original_text: editByCase[caseLabel][0],
        replacement_text: editByCase[caseLabel][1],
        category: "grammar",
        severity: "major",
        explanation: "需要修正语法形式。"
      }
    ],
    scores: {
      official_score: { ai_score: score, rationale: "整体评分依据。" },
      dimension_scores: dimensions(benchmarkCase.task_type, score)
    },
    content_feedback: [
      {
        feedback_id: `${caseLabel}-feedback`,
        category: feedbackCategory,
        original_sentence: responses[caseLabel],
        issue: "论述可以更充分。",
        suggestion: "补充具体说明。",
        proposed_revision: `${responses[caseLabel]} More detail would clarify the point.`
      }
    ],
    overall_feedback: `${caseLabel} 总体评价。`,
    ...overrides
  };
}

function inputs(overrides = {}) {
  return WRITING_REVIEW_DEEPSEEK_STABILITY_NEW_CASES.map((benchmarkCase) => ({
    attemptId: benchmarkCase.attempt_id,
    caseLabel: benchmarkCase.case_label,
    qualityLabel: benchmarkCase.quality_label,
    taskType: benchmarkCase.task_type,
    question: { question_id: benchmarkCase.case_label },
    responseText: responses[benchmarkCase.case_label],
    ...overrides[benchmarkCase.case_label]
  }));
}

function usage(index = 0, overrides = {}) {
  return {
    ...EMPTY_OPENROUTER_USAGE,
    prompt_tokens: 4000 + index,
    cached_tokens: 100,
    completion_tokens: 2000 + index,
    reasoning_tokens: 1000 + index,
    accepted_prediction_tokens: 2,
    rejected_prediction_tokens: 1,
    total_tokens: 6000 + index,
    cost: 0.02 + index * 0.01,
    upstream_inference_cost: 0.018 + index * 0.01,
    upstream_inference_prompt_cost: 0.004,
    upstream_inference_completions_cost: 0.014 + index * 0.01,
    ...overrides
  };
}

function immediateTimeout(request, options) {
  assert.equal(options.timeoutMs, 240_000);
  return request(new AbortController().signal);
}

function dependencies(overrides = {}) {
  return {
    requestWithTimeout: immediateTimeout,
    async requestAI(input) {
      const caseLabel = input.question.question_id;
      return {
        content: JSON.stringify(rawReview(caseLabel)),
        model: WRITING_REVIEW_DEEPSEEK_STABILITY_MODEL,
        usage: usage()
      };
    },
    parseRawReview: parseAIReviewRawResultV22,
    parseReview: parseAIReviewRawResultV22ForResponse,
    ...overrides
  };
}

function storedAdWeak(overrides = {}) {
  const validated = parseAIReviewRawResultV22ForResponse(
    rawReview("ad_weak"),
    responses.ad_weak
  );
  return {
    label: "deepseek_pro_high",
    provider: "openrouter",
    model: WRITING_REVIEW_DEEPSEEK_STABILITY_MODEL,
    reasoning_effort: "high",
    operation: "deepseek_model_benchmark",
    attempt_id: WRITING_REVIEW_DEEPSEEK_STABILITY_EXISTING_CASE.attempt_id,
    task_type: "academic_discussion",
    elapsed_ms: 96121,
    ...usage(9),
    result: "success",
    error_code: null,
    error: null,
    http_status: null,
    provider_error_type: null,
    provider_error_code: null,
    provider_name: null,
    schema_valid: true,
    official_score: 3,
    dimension_scores: {
      relevance: 4,
      elaboration: 3,
      syntactic_range_and_word_choice: 3,
      lexical_and_grammatical_control: 2
    },
    language_edit_count: 1,
    content_feedback_count: 1,
    content_feedback_categories: { elaboration: 1 },
    overall_feedback: "已有 Pro 结果。",
    raw_official_score: null,
    raw_dimension_scores: null,
    raw_language_edit_count: null,
    raw_content_feedback_count: null,
    raw_content_feedback_categories: {},
    localization_issue_count: 0,
    localization_issues: [],
    validated_result: validated,
    validated_raw_result: null,
    ...overrides
  };
}

function existingResult(overrides = {}) {
  return readWritingReviewDeepSeekExistingAdWeak(
    "/safe/deepseek-pro-high.json",
    () => JSON.stringify(storedAdWeak(overrides))
  );
}

function kimiBaseline(caseLabel, overrides = {}) {
  const benchmarkCase = WRITING_REVIEW_DEEPSEEK_STABILITY_ALL_CASES.find(
    (item) => item.case_label === caseLabel
  );
  const validated = parseAIReviewRawResultV22ForResponse(
    rawReview(caseLabel),
    responses[caseLabel]
  );
  return {
    attempt_id: benchmarkCase.attempt_id,
    case_label: caseLabel,
    task_type: benchmarkCase.task_type,
    quality_label: benchmarkCase.quality_label,
    provider: "openrouter",
    model: "moonshotai/kimi-k3",
    reasoning_effort: "high",
    operation: "reasoning_stability_benchmark",
    elapsed_ms: 50000,
    ...usage(4),
    result: "success",
    error_code: null,
    error: null,
    schema_valid: true,
    official_score: benchmarkCase.quality_label === "good" ? 5 : 2,
    dimension_scores: Object.fromEntries(
      Object.entries(validated.scores.dimension_scores).map(([key, value]) => [
        key,
        value.ai_score
      ])
    ),
    language_edit_count: 1,
    content_feedback_count: 1,
    content_feedback_categories: { elaboration: 1 },
    overall_feedback: "Kimi baseline。",
    validated_result: validated,
    ...overrides
  };
}

function loadedBaselines(overrides = {}) {
  return WRITING_REVIEW_DEEPSEEK_STABILITY_ALL_CASES.map((benchmarkCase) =>
    readWritingReviewDeepSeekKimiBaseline(
      benchmarkCase,
      `/safe/${benchmarkCase.case_label}-high.json`,
      () => JSON.stringify(kimiBaseline(benchmarkCase.case_label, overrides[benchmarkCase.case_label]))
    )
  );
}

async function allSuccessfulResults() {
  const fresh = await benchmarkWritingReviewDeepSeekStability(inputs(), dependencies());
  return [...fresh, existingResult()];
}

test("DeepSeek stability fixes three new attempts, existing weak AD, model, effort, and timeout", () => {
  assert.deepEqual(
    WRITING_REVIEW_DEEPSEEK_STABILITY_NEW_CASES.map((item) => ({
      case_label: item.case_label,
      attempt_id: item.attempt_id,
      task_type: item.task_type
    })),
    [
      {
        case_label: "email_good",
        attempt_id: "a20ed773-23cc-4a10-83e0-4493c4f619de",
        task_type: "email"
      },
      {
        case_label: "email_weak",
        attempt_id: "cde72af6-e6d0-439b-b3ac-91fb2ab117b1",
        task_type: "email"
      },
      {
        case_label: "ad_good",
        attempt_id: "a292bcdb-6a86-4ab8-a00a-4c4e6c707c9c",
        task_type: "academic_discussion"
      }
    ]
  );
  assert.equal(
    WRITING_REVIEW_DEEPSEEK_STABILITY_EXISTING_CASE.attempt_id,
    "a7ad7e9f-b4ef-4ee0-9b39-43f1d7020cdc"
  );
  assert.equal(WRITING_REVIEW_DEEPSEEK_STABILITY_MODEL, "deepseek/deepseek-v4-pro");
  assert.equal(WRITING_REVIEW_DEEPSEEK_STABILITY_EFFORT, "high");
  assert.equal(WRITING_REVIEW_DEEPSEEK_STABILITY_TIMEOUT_MS, 240_000);
  assert.equal(WRITING_REVIEW_DEEPSEEK_STABILITY_TIMEOUT_MS, WRITING_REVIEW_FULL_REQUEST_TIMEOUT_MS);
});

test("three new cases run sequentially once in fixed order without ad_weak or Kimi API", async () => {
  const calls = [];
  let active = false;
  const results = await benchmarkWritingReviewDeepSeekStability(
    inputs(),
    dependencies({
      async requestAI(input) {
        assert.equal(active, false);
        active = true;
        const caseLabel = input.question.question_id;
        calls.push(caseLabel);
        const response = {
          content: JSON.stringify(rawReview(caseLabel)),
          model: WRITING_REVIEW_DEEPSEEK_STABILITY_MODEL,
          usage: usage(calls.length)
        };
        active = false;
        return response;
      }
    })
  );
  assert.deepEqual(calls, ["email_good", "email_weak", "ad_good"]);
  assert.equal(results.length, 3);
  assert.ok(calls.every((item) => item !== "ad_weak" && !item.includes("kimi")));
  assert.ok(results.every((result) => result.source === "new"));
});

test("fixed-case guard prevents omitted, reordered, or extra requests", async () => {
  let calls = 0;
  const deps = dependencies({ async requestAI() { calls += 1; throw new Error("no"); } });
  await assert.rejects(
    benchmarkWritingReviewDeepSeekStability(inputs().slice(0, 2), deps),
    /exactly three new cases/
  );
  const reordered = inputs();
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  await assert.rejects(
    benchmarkWritingReviewDeepSeekStability(reordered, deps),
    /Unexpected DeepSeek stability case/
  );
  assert.equal(calls, 0);
});

test("one timeout continues to later cases without retry", async () => {
  const calls = new Map();
  const results = await benchmarkWritingReviewDeepSeekStability(
    inputs(),
    dependencies({
      async requestAI(input) {
        const caseLabel = input.question.question_id;
        calls.set(caseLabel, (calls.get(caseLabel) ?? 0) + 1);
        if (caseLabel === "email_good") {
          throw new OpenRouterWritingReviewError(
            "AI_REQUEST_TIMEOUT",
            "timeout",
            504
          );
        }
        return {
          content: JSON.stringify(rawReview(caseLabel)),
          model: WRITING_REVIEW_DEEPSEEK_STABILITY_MODEL,
          usage: usage()
        };
      }
    })
  );
  assert.deepEqual(results.map((result) => result.result), [
    "timeout",
    "success",
    "success"
  ]);
  assert.deepEqual(Array.from(calls.values()), [1, 1, 1]);
  assert.equal(results[0].cost, null);
});

test("invalid JSON, Schema failure, and localization failure stay distinct", async () => {
  const results = await benchmarkWritingReviewDeepSeekStability(
    inputs(),
    dependencies({
      async requestAI(input) {
        const caseLabel = input.question.question_id;
        if (caseLabel === "email_good") {
          return { content: "not-json-secret", model: WRITING_REVIEW_DEEPSEEK_STABILITY_MODEL, usage: usage() };
        }
        const raw = rawReview(caseLabel);
        if (caseLabel === "email_weak") delete raw.overall_feedback;
        if (caseLabel === "ad_good") raw.language_edits[0].original_text = "not in source";
        return {
          content: JSON.stringify(raw),
          model: WRITING_REVIEW_DEEPSEEK_STABILITY_MODEL,
          usage: usage()
        };
      }
    })
  );
  assert.deepEqual(results.map((result) => result.result), [
    "invalid_json",
    "validation_error",
    "localization_error"
  ]);
  assert.deepEqual(results.map((result) => result.schema_valid), [false, false, true]);
  assert.equal(results[0].validated_raw_result, null);
  assert.equal(JSON.stringify(results[0]).includes("not-json-secret"), false);
  assert.equal(results[1].validated_raw_result, null);
  assert.equal(results[2].validated_result, null);
  assert.equal(results[2].validated_raw_result.schema_version, "2.2");
  assert.equal(results[2].raw_language_edit_count, 1);
  assert.equal(results[2].raw_content_feedback_count, 1);
  assert.ok(results[2].localization_issue_count > 0);
});

test("success preserves full final quality content, dimensions, usage, and cost", async () => {
  const results = await benchmarkWritingReviewDeepSeekStability(
    inputs(),
    dependencies({
      async requestAI(input) {
        const caseLabel = input.question.question_id;
        return {
          content: JSON.stringify(rawReview(caseLabel)),
          model: WRITING_REVIEW_DEEPSEEK_STABILITY_MODEL,
          usage: usage(2)
        };
      }
    })
  );
  const email = results[0];
  const ad = results[2];
  assert.deepEqual(Object.keys(email.dimension_scores).sort(), [
    "communicative_purpose_and_elaboration",
    "lexical_and_grammatical_control",
    "social_conventions",
    "syntactic_range_and_word_choice"
  ]);
  assert.deepEqual(Object.keys(ad.dimension_scores).sort(), [
    "elaboration",
    "lexical_and_grammatical_control",
    "relevance",
    "syntactic_range_and_word_choice"
  ]);
  assert.equal(email.validated_result.language_edits[0].start, 2);
  assert.equal(email.validated_result.language_edits[0].end, 10);
  assert.ok(email.validated_result.content_feedback[0].proposed_revision);
  assert.equal(email.overall_feedback, "email_good 总体评价。");
  assert.equal(email.reasoning_tokens, 1002);
  assert.equal(email.total_tokens, 6002);
  assert.equal(email.cost, 0.04);
});

test("provider diagnostics are whitelisted and later cases continue", async () => {
  const results = await benchmarkWritingReviewDeepSeekStability(
    inputs(),
    dependencies({
      async requestAI(input, signal) {
        const caseLabel = input.question.question_id;
        if (caseLabel === "email_good") {
          return requestOpenRouterWritingReview(input, {
            env: { OPENROUTER_API_KEY: "secret", OPENROUTER_WRITING_MODEL: "unused" },
            jsonSchema: AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA,
            modelOverride: WRITING_REVIEW_DEEPSEEK_STABILITY_MODEL,
            reasoningEffort: "high",
            signal,
            async fetchImpl() {
              return Response.json({
                error: {
                  code: 429,
                  message: "capacity",
                  metadata: {
                    error_type: "rate_limit",
                    provider_code: "busy",
                    provider_name: "DeepSeek",
                    raw: "must-not-save"
                  }
                }
              }, { status: 429 });
            }
          });
        }
        return {
          content: JSON.stringify(rawReview(caseLabel)),
          model: WRITING_REVIEW_DEEPSEEK_STABILITY_MODEL,
          usage: usage()
        };
      }
    })
  );
  assert.equal(results[0].result, "provider_error");
  assert.equal(results[0].http_status, 429);
  assert.equal(results[0].provider_error_type, "rate_limit");
  assert.equal(results[0].provider_error_code, "busy");
  assert.equal(results[0].provider_name, "DeepSeek");
  assert.equal(JSON.stringify(results[0]).includes("must-not-save"), false);
  assert.deepEqual(results.slice(1).map((result) => result.result), ["success", "success"]);
});

test("existing ad_weak reader standardizes the saved Pro detail and safely handles absence", () => {
  const loaded = existingResult();
  assert.equal(
    WRITING_REVIEW_DEEPSEEK_STABILITY_EXISTING_PRO_PATH,
    "tmp/writing-review-deepseek-comparison/deepseek-pro-high.json"
  );
  assert.equal(loaded.case_label, "ad_weak");
  assert.equal(loaded.source, "existing");
  assert.equal(loaded.model, "deepseek/deepseek-v4-pro");
  assert.equal(loaded.reasoning_effort, "high");
  assert.equal(loaded.result, "success");
  assert.equal(loaded.validated_result.language_edits.length, 1);
  assert.equal(
    readWritingReviewDeepSeekExistingAdWeak("/missing", () => {
      throw new Error("ENOENT");
    }),
    null
  );
  assert.equal(
    readWritingReviewDeepSeekExistingAdWeak("/wrong", () =>
      JSON.stringify(storedAdWeak({ model: "another-model" }))
    ),
    null
  );
});

test("Kimi baselines are read per case from high files and missing baseline is null", () => {
  assert.equal(
    WRITING_REVIEW_DEEPSEEK_STABILITY_KIMI_DIR,
    "tmp/writing-review-reasoning-stability"
  );
  const baseline = loadedBaselines()[0];
  assert.equal(baseline.case_label, "email_good");
  assert.equal(baseline.model, "moonshotai/kimi-k3");
  assert.equal(baseline.reasoning_effort, "high");
  assert.equal(baseline.validated_result.language_edits.length, 1);
  assert.equal(
    readWritingReviewDeepSeekKimiBaseline(
      WRITING_REVIEW_DEEPSEEK_STABILITY_ALL_CASES[0],
      "/missing",
      () => { throw new Error("ENOENT"); }
    ),
    null
  );
});

test("summary counts all four statuses and aggregates only successes", async () => {
  const fresh = await benchmarkWritingReviewDeepSeekStability(
    inputs(),
    dependencies({
      now: (() => {
        const values = [0, 100, 200, 400, 500, 800];
        return () => values.shift();
      })(),
      async requestAI(input) {
        const caseLabel = input.question.question_id;
        if (caseLabel === "email_weak") {
          throw new OpenRouterWritingReviewError("AI_REQUEST_TIMEOUT", "timeout", 504);
        }
        return {
          content: JSON.stringify(rawReview(caseLabel)),
          model: WRITING_REVIEW_DEEPSEEK_STABILITY_MODEL,
          usage: usage(caseLabel === "email_good" ? 0 : 2)
        };
      }
    })
  );
  const existing = existingResult({ elapsed_ms: 500, reasoning_tokens: 3000, total_tokens: 9000, cost: 0.08 });
  const summary = buildWritingReviewDeepSeekStabilitySummary(
    [...fresh, existing],
    loadedBaselines()
  );
  assert.deepEqual(summary.statistics, {
    total_cases: 4,
    success_rate: 0.75,
    result_counts: {
      success: 3,
      timeout: 1,
      provider_error: 0,
      invalid_json: 0,
      validation_error: 0,
      localization_error: 0
    },
    schema_success_count: 3,
    localization_success_count: 3
  });
  assert.equal(summary.aggregate.successful_cases, 3);
  assert.equal(summary.aggregate.avg_elapsed_ms, (100 + 300 + 500) / 3);
  assert.equal(summary.aggregate.median_elapsed_ms, 300);
  assert.equal(summary.aggregate.avg_reasoning_tokens, (1000 + 1002 + 3000) / 3);
  assert.equal(summary.aggregate.avg_total_tokens, (6000 + 6002 + 9000) / 3);
  assert.equal(summary.aggregate.avg_cost, (0.02 + 0.04 + 0.08) / 3);
});

test("raw-valid localization failure counts as Schema success but not localization success", async () => {
  const fresh = await benchmarkWritingReviewDeepSeekStability(
    inputs(),
    dependencies({
      async requestAI(input) {
        const caseLabel = input.question.question_id;
        const raw = rawReview(caseLabel);
        if (caseLabel === "ad_good") raw.language_edits[0].original_text = "missing";
        return {
          content: JSON.stringify(raw),
          model: WRITING_REVIEW_DEEPSEEK_STABILITY_MODEL,
          usage: usage()
        };
      }
    })
  );
  const summary = buildWritingReviewDeepSeekStabilitySummary(
    [...fresh, existingResult()],
    loadedBaselines()
  );
  assert.equal(summary.statistics.result_counts.localization_error, 1);
  assert.equal(summary.statistics.result_counts.success, 3);
  assert.equal(summary.statistics.success_rate, 0.75);
  assert.equal(summary.statistics.schema_success_count, 4);
  assert.equal(summary.statistics.localization_success_count, 3);
  assert.equal(summary.aggregate.successful_cases, 3);
});

test("each case comparison reports exact edits, objective score, count, and category deltas", async () => {
  const results = await allSuccessfulResults();
  const baselines = loadedBaselines();
  const summary = buildWritingReviewDeepSeekStabilitySummary(results, baselines);
  assert.equal(summary.comparisons.length, 4);
  for (const comparison of summary.comparisons) {
    assert.equal(comparison.baseline_available, true);
    assert.equal(comparison.shared_edits.length, 1);
    assert.equal(comparison.kimi_only_edits.length, 0);
    assert.equal(comparison.deepseek_only_edits.length, 0);
    assert.equal(comparison.language_edit_count_delta, 0);
    assert.equal(comparison.content_feedback_count_delta, 0);
    assert.deepEqual(comparison.feedback_category_deltas, { elaboration: 0 });
  }
  assert.equal(summary.comparisons[0].official_score_delta, 0);
  assert.equal(summary.comparisons[3].official_score_delta, 1);
});

test("writer creates four details, compact summary, and objective Kimi-vs-Pro report", async () => {
  const results = await allSuccessfulResults();
  const baselines = loadedBaselines();
  const files = new Map();
  const summary = writeWritingReviewDeepSeekStabilityFiles(
    "/safe/stability",
    results,
    baselines,
    {
      mkdirSync(directory, options) {
        assert.equal(directory, "/safe/stability");
        assert.deepEqual(options, { recursive: true });
      },
      writeFileSync(file, content, options) {
        assert.equal(options.mode, 0o600);
        files.set(file, String(content));
      }
    }
  );
  assert.equal(WRITING_REVIEW_DEEPSEEK_STABILITY_OUTPUT_DIR, "tmp/writing-review-deepseek-stability");
  assert.deepEqual(Array.from(files.keys()).sort(), [
    path.join("/safe/stability", "ad-good.json"),
    path.join("/safe/stability", "ad-weak.json"),
    path.join("/safe/stability", "comparison.md"),
    path.join("/safe/stability", "email-good.json"),
    path.join("/safe/stability", "email-weak.json"),
    path.join("/safe/stability", "summary.json")
  ]);
  assert.equal(summary.results.length, 4);
  assert.equal("validated_result" in summary.results[0], false);
  assert.equal("validated_result" in summary.baselines[0], false);
  const detail = JSON.parse(files.get(path.join("/safe/stability", "email-good.json")));
  assert.ok(detail.validated_result.language_edits[0].start >= 0);
  assert.ok(detail.validated_result.content_feedback[0].proposed_revision);
  const markdown = files.get(path.join("/safe/stability", "comparison.md"));
  assert.match(markdown, /^# DeepSeek V4 Pro High Stability Benchmark/m);
  assert.equal((markdown.match(/\| email_good \|/g) ?? []).length, 2);
  assert.match(markdown, /DeepSeek Pro high \(existing\)/);
  assert.match(markdown, /Source: existing \(no API request\)/);
  assert.match(markdown, /Different spans may represent the same error/);
  assert.match(markdown, /Manual QA — email_good/);
  assert.match(markdown, /required communicative actions 是否识别/);
  assert.match(markdown, /是否给高质量作文制造多余问题/);
  assert.match(markdown, /teenage years vs age 10/);
  assert.match(markdown, /schema_success_count/);
  assert.match(markdown, /success_rate/);
  assert.match(markdown, /median_elapsed_ms/);
  assert.match(markdown, /Language edit count delta/);
  assert.match(markdown, /Content feedback count delta/);
  assert.doesNotMatch(markdown, /winner|获胜|推荐模型/iu);
});

test("actual mock requests use production prompt, strict v2.2 schema, Pro high, and no fallback", async () => {
  const bodies = [];
  const results = await benchmarkWritingReviewDeepSeekStability(
    inputs(),
    dependencies({
      async requestAI(input, signal) {
        const caseLabel = input.question.question_id;
        return requestOpenRouterWritingReview(input, {
          env: { OPENROUTER_API_KEY: "test-key", OPENROUTER_WRITING_MODEL: "unused" },
          jsonSchema: AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA,
          modelOverride: WRITING_REVIEW_DEEPSEEK_STABILITY_MODEL,
          reasoningEffort: WRITING_REVIEW_DEEPSEEK_STABILITY_EFFORT,
          signal,
          async fetchImpl(_url, init) {
            bodies.push(JSON.parse(init.body));
            return Response.json({
              choices: [{ message: { content: JSON.stringify(rawReview(caseLabel)) } }],
              usage: {}
            });
          }
        });
      }
    })
  );
  assert.ok(results.every((result) => result.result === "success"));
  assert.equal(bodies.length, 3);
  assert.ok(bodies.every((body) => body.model === "deepseek/deepseek-v4-pro"));
  assert.ok(bodies.every((body) => body.reasoning.effort === "high"));
  assert.ok(bodies.every((body) => body.response_format.json_schema.strict === true));
  assert.ok(bodies.every((body) => body.response_format.json_schema.schema.oneOf));
  assert.ok(bodies.every((body) => body.provider.require_parameters === true));
  assert.ok(bodies.every((body) => body.stream === false));
  assert.ok(bodies.every((body) => body.messages[0].content.includes("smallest uniquely localizable contiguous source span")));
  assert.equal(JSON.stringify(bodies).includes("unused"), false);
});

test("CLI is local-only, read-only, three-request wired, ignored, and does not leak inputs", () => {
  const root = path.resolve(__dirname, "..");
  const script = fs.readFileSync(
    path.join(root, "scripts/benchmark-writing-review-deepseek-stability.ts"),
    "utf8"
  );
  const moduleSource = fs.readFileSync(
    path.join(root, "lib/writingReviewDeepSeekStabilityBenchmark.ts"),
    "utf8"
  );
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.equal(
    packageJson.scripts["benchmark:writing-deepseek-stability"],
    "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --env-file-if-exists=.env.local --experimental-strip-types scripts/benchmark-writing-review-deepseek-stability.ts"
  );
  assert.match(gitignore, /\/tmp\/writing-review-deepseek-stability\//);
  assert.match(script, /readWritingReviewDeepSeekExistingAdWeak/);
  assert.match(script, /WRITING_REVIEW_DEEPSEEK_STABILITY_NEW_CASES/);
  assert.match(script, /loadWritingReviewComparisonSource/);
  assert.match(script, /requestOpenRouterWritingReview/);
  assert.match(script, /AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA/);
  assert.match(script, /parseAIReviewRawResultV22ForResponse/);
  assert.match(script, /reasoningEffort: benchmark\.WRITING_REVIEW_DEEPSEEK_STABILITY_EFFORT/);
  assert.doesNotMatch(script, /requestMoonshot|kimi-k3|grok|gemini|v4-flash/i);
  assert.doesNotMatch(`${script}\n${moduleSource}`, /\.from\("writing_reviews"\)|\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
  assert.doesNotMatch(script, /console\.(?:log|table)\([^\n]*(?:response_text|responseText|question|messages|OPENROUTER_API_KEY)/);
  assert.doesNotMatch(moduleSource, /fuzzy|automatic repair|retry|fallback/i);
});

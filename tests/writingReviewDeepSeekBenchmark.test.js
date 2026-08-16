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
  WRITING_REVIEW_DEEPSEEK_ATTEMPT_ID,
  WRITING_REVIEW_DEEPSEEK_CONFIGS,
  WRITING_REVIEW_DEEPSEEK_KIMI_BASELINE_PATH,
  WRITING_REVIEW_DEEPSEEK_OUTPUT_DIR,
  WRITING_REVIEW_DEEPSEEK_TIMEOUT_MS,
  benchmarkWritingReviewDeepSeekModels,
  buildWritingReviewDeepSeekMarkdown,
  buildWritingReviewDeepSeekSummary,
  parseWritingReviewDeepSeekArguments,
  readWritingReviewDeepSeekKimiBaseline,
  selectWritingReviewDeepSeekConfigs,
  writeWritingReviewDeepSeekFiles
} = require("../lib/writingReviewDeepSeekBenchmark.ts");
const {
  AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA,
  parseAIReviewRawResultV22,
  parseAIReviewRawResultV22ForResponse
} = require("../lib/writingReviewSchemaV22.ts");

const responseText =
  "Teenage years is important. Growth environments matter. Kindful people help. It is necessary.";

function benchmarkInput(overrides = {}) {
  return {
    attemptId: WRITING_REVIEW_DEEPSEEK_ATTEMPT_ID,
    taskType: "academic_discussion",
    question: { question_id: "AD-WEAK" },
    responseText,
    ...overrides
  };
}

function rawResult(config, overrides = {}) {
  const pro = config.label === "deepseek_pro_high";
  const dimension = (ai_score) => ({ ai_score, ai_basis: "具体评分依据。" });
  return {
    schema_version: "2.2",
    task_type: "academic_discussion",
    language_edits: [
      {
        edit_id: "shared-edit",
        original_text: "years is",
        replacement_text: "years are",
        category: "grammar",
        severity: "major",
        explanation: "复数主语需要复数谓语。"
      },
      {
        edit_id: "deepseek-edit",
        original_text: "Kindful",
        replacement_text: "Kind",
        category: "word_choice",
        severity: "moderate",
        explanation: "该词不是自然的英语表达。"
      }
    ],
    scores: {
      official_score: {
        ai_score: pro ? 4 : 3,
        rationale: "整体评分依据。"
      },
      dimension_scores: {
        relevance: dimension(pro ? 5 : 4),
        elaboration: dimension(pro ? 4 : 3),
        syntactic_range_and_word_choice: dimension(3),
        lexical_and_grammatical_control: dimension(pro ? 3 : 2)
      }
    },
    content_feedback: [
      {
        feedback_id: "feedback-1",
        category: "elaboration",
        original_sentence: "It is necessary.",
        issue: "论证没有完成题目要求的比较。",
        suggestion: "明确比较结论并补充理由。",
        proposed_revision:
          "It is necessary to compare which factor has the stronger influence."
      },
      {
        feedback_id: "feedback-2",
        category: "language_improvement",
        original_sentence: "Growth environments matter.",
        issue: "名词搭配不自然。",
        suggestion: "使用更自然准确的名词短语。",
        proposed_revision: "Developmental environments matter."
      }
    ],
    overall_feedback: `${config.label} 总体评价。`,
    ...overrides
  };
}

function usage(index = 0, overrides = {}) {
  return {
    ...EMPTY_OPENROUTER_USAGE,
    prompt_tokens: 4800 + index,
    cached_tokens: 20,
    completion_tokens: 2100 + index,
    reasoning_tokens: 1300 + index,
    accepted_prediction_tokens: 3,
    rejected_prediction_tokens: 1,
    total_tokens: 6900 + index,
    cost: 0.012345 + index * 0.01,
    upstream_inference_cost: 0.01 + index * 0.01,
    upstream_inference_prompt_cost: 0.003,
    upstream_inference_completions_cost: 0.007 + index * 0.01,
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
    async requestAI(_input, config) {
      return {
        content: JSON.stringify(rawResult(config)),
        model: config.model,
        usage: usage()
      };
    },
    parseRawReview: parseAIReviewRawResultV22,
    parseReview: parseAIReviewRawResultV22ForResponse,
    ...overrides
  };
}

function kimiBaseline() {
  const raw = rawResult(WRITING_REVIEW_DEEPSEEK_CONFIGS[0], {
    language_edits: [
      {
        edit_id: "shared-edit",
        original_text: "years is",
        replacement_text: "years are",
        category: "grammar",
        severity: "major",
        explanation: "复数主语需要复数谓语。"
      },
      {
        edit_id: "kimi-edit",
        original_text: "Growth environments",
        replacement_text: "Developmental environments",
        category: "word_choice",
        severity: "moderate",
        explanation: "该搭配不自然。"
      }
    ],
    content_feedback: [
      {
        feedback_id: "kimi-feedback",
        category: "elaboration",
        original_sentence: "It is necessary.",
        issue: "论证不足。",
        suggestion: "补充比较。",
        proposed_revision: "It is necessary to compare the two influences."
      }
    ]
  });
  return {
    label: "kimi_high_baseline",
    provider: "openrouter",
    model: "moonshotai/kimi-k3",
    reasoning_effort: "high",
    attempt_id: WRITING_REVIEW_DEEPSEEK_ATTEMPT_ID,
    task_type: "academic_discussion",
    elapsed_ms: 66934,
    ...usage(9),
    result: "success",
    schema_valid: true,
    official_score: 3,
    dimension_scores: {
      relevance: 5,
      elaboration: 3,
      syntactic_range_and_word_choice: 3,
      lexical_and_grammatical_control: 2
    },
    language_edit_count: 2,
    content_feedback_count: 1,
    content_feedback_categories: { elaboration: 1 },
    overall_feedback: "Kimi 总体评价。",
    validated_result: parseAIReviewRawResultV22ForResponse(raw, responseText)
  };
}

test("DeepSeek benchmark fixes attempt, exact model IDs, high effort, order, and timeout", () => {
  assert.equal(
    WRITING_REVIEW_DEEPSEEK_ATTEMPT_ID,
    "a7ad7e9f-b4ef-4ee0-9b39-43f1d7020cdc"
  );
  assert.deepEqual(WRITING_REVIEW_DEEPSEEK_CONFIGS, [
    {
      label: "deepseek_flash_high",
      display_name: "DeepSeek V4 Flash High",
      model: "deepseek/deepseek-v4-flash",
      reasoning_effort: "high"
    },
    {
      label: "deepseek_pro_high",
      display_name: "DeepSeek V4 Pro High",
      model: "deepseek/deepseek-v4-pro",
      reasoning_effort: "high"
    }
  ]);
  assert.equal(WRITING_REVIEW_DEEPSEEK_TIMEOUT_MS, 240_000);
  assert.equal(WRITING_REVIEW_DEEPSEEK_TIMEOUT_MS, WRITING_REVIEW_FULL_REQUEST_TIMEOUT_MS);
  assert.ok(WRITING_REVIEW_DEEPSEEK_CONFIGS.every((item) => item.reasoning_effort === "high"));
  assert.ok(WRITING_REVIEW_DEEPSEEK_CONFIGS.every((item) => !["low", "xhigh"].includes(item.reasoning_effort)));
});

test("DeepSeek CLI defaults to all and validates all, flash, and pro filters", () => {
  assert.deepEqual(parseWritingReviewDeepSeekArguments([]), {
    selection: "all",
    error: null
  });
  assert.deepEqual(parseWritingReviewDeepSeekArguments(["--", "--only", "pro"]), {
    selection: "pro",
    error: null
  });
  assert.deepEqual(parseWritingReviewDeepSeekArguments(["--only", "flash"]), {
    selection: "flash",
    error: null
  });
  assert.match(parseWritingReviewDeepSeekArguments(["--only", "other"]).error, /Invalid/);
  assert.match(parseWritingReviewDeepSeekArguments(["--only"]).error, /requires/);
  assert.match(parseWritingReviewDeepSeekArguments(["--unknown"]).error, /Unknown/);
  assert.deepEqual(
    selectWritingReviewDeepSeekConfigs("pro").map((config) => config.label),
    ["deepseek_pro_high"]
  );
  assert.deepEqual(
    selectWritingReviewDeepSeekConfigs("flash").map((config) => config.label),
    ["deepseek_flash_high"]
  );
  assert.equal(selectWritingReviewDeepSeekConfigs("all").length, 2);
});

test("Pro-only runs Pro high once with 240-second timeout and no Flash or Kimi request", async () => {
  const calls = [];
  const results = await benchmarkWritingReviewDeepSeekModels(
    benchmarkInput(),
    dependencies({
      configs: selectWritingReviewDeepSeekConfigs("pro"),
      async requestAI(_input, config) {
        calls.push(`${config.model}/${config.reasoning_effort}`);
        return {
          content: JSON.stringify(rawResult(config)),
          model: config.model,
          usage: usage()
        };
      }
    })
  );
  assert.deepEqual(calls, ["deepseek/deepseek-v4-pro/high"]);
  assert.equal(results.length, 1);
  assert.equal(results[0].label, "deepseek_pro_high");
  assert.ok(calls.every((call) => !call.includes("flash") && !call.includes("kimi")));
});

test("Pro-only timeout is recorded after one request without retry", async () => {
  let calls = 0;
  const results = await benchmarkWritingReviewDeepSeekModels(
    benchmarkInput(),
    dependencies({
      configs: selectWritingReviewDeepSeekConfigs("pro"),
      async requestAI() {
        calls += 1;
        throw new OpenRouterWritingReviewError(
          "AI_REQUEST_TIMEOUT",
          "Pro timeout",
          504
        );
      }
    })
  );
  assert.equal(calls, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].label, "deepseek_pro_high");
  assert.equal(results[0].result, "timeout");
  assert.equal(results[0].cost, null);
});

test("Flash then Pro run sequentially exactly once without Kimi", async () => {
  const calls = [];
  let active = false;
  const results = await benchmarkWritingReviewDeepSeekModels(
    benchmarkInput(),
    dependencies({
      async requestAI(_input, config) {
        assert.equal(active, false);
        active = true;
        calls.push(config.model);
        const response = {
          content: JSON.stringify(rawResult(config)),
          model: config.model,
          usage: usage(calls.length)
        };
        active = false;
        return response;
      }
    })
  );
  assert.deepEqual(calls, [
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4-pro"
  ]);
  assert.equal(results.length, 2);
  assert.ok(calls.every((model) => !model.includes("kimi")));
  assert.ok(results.every((result) => result.result === "success"));
});

test("another attempt is rejected before any request", async () => {
  let calls = 0;
  await assert.rejects(
    benchmarkWritingReviewDeepSeekModels(
      benchmarkInput({ attemptId: "another-attempt" }),
      dependencies({
        async requestAI() {
          calls += 1;
          throw new Error("must not run");
        }
      })
    ),
    /fixed weak AD attempt/
  );
  assert.equal(calls, 0);
});

test("Flash timeout continues to Pro and neither model retries", async () => {
  const calls = new Map();
  const results = await benchmarkWritingReviewDeepSeekModels(
    benchmarkInput(),
    dependencies({
      async requestAI(_input, config) {
        calls.set(config.label, (calls.get(config.label) ?? 0) + 1);
        if (config.label === "deepseek_flash_high") {
          throw new OpenRouterWritingReviewError(
            "AI_REQUEST_TIMEOUT",
            "Flash timeout",
            504
          );
        }
        return {
          content: JSON.stringify(rawResult(config)),
          model: config.model,
          usage: usage()
        };
      }
    })
  );
  assert.deepEqual(results.map((result) => result.result), ["timeout", "success"]);
  assert.equal(results[0].cost, null);
  assert.deepEqual(Array.from(calls.values()), [1, 1]);
});

test("invalid JSON and Schema errors remain safe and never retain provider output", async () => {
  const results = await benchmarkWritingReviewDeepSeekModels(
    benchmarkInput(),
    dependencies({
      async requestAI(_input, config) {
        if (config.label === "deepseek_flash_high") {
          return { content: "```not-json```", model: config.model, usage: usage() };
        }
        const invalid = rawResult(config);
        delete invalid.overall_feedback;
        return {
          content: JSON.stringify(invalid),
          model: config.model,
          usage: usage()
        };
      }
    })
  );
  assert.deepEqual(results.map((result) => result.result), [
    "invalid_json",
    "validation_error"
  ]);
  for (const result of results) {
    assert.equal(result.schema_valid, false);
    assert.equal(result.validated_result, null);
    assert.equal(result.validated_raw_result, null);
    assert.equal(JSON.stringify(result).includes("```not-json```"), false);
  }
});

test("localization failure retains only validated raw v2.2 result and safe issues", async () => {
  const results = await benchmarkWritingReviewDeepSeekModels(
    benchmarkInput(),
    dependencies({
      async requestAI(_input, config) {
        const raw = rawResult(config);
        raw.language_edits[0].original_text = "not present in response";
        return {
          content: JSON.stringify(raw),
          model: config.model,
          usage: usage()
        };
      }
    })
  );
  for (const result of results) {
    assert.equal(result.result, "localization_error");
    assert.equal(result.schema_valid, true);
    assert.equal(result.validated_result, null);
    assert.equal(result.validated_raw_result.schema_version, "2.2");
    assert.equal(result.raw_language_edit_count, 2);
    assert.equal(result.raw_content_feedback_count, 2);
    assert.deepEqual(result.raw_content_feedback_categories, {
      elaboration: 1,
      language_improvement: 1
    });
    assert.ok(result.raw_official_score !== null);
    assert.ok(result.raw_dimension_scores.relevance >= 4);
    assert.ok(result.localization_issue_count >= 1);
    assert.match(result.localization_issues[0].path, /language_edits/);
    assert.match(result.localization_issues[0].message, /response_text/);
  }
  const summary = buildWritingReviewDeepSeekSummary(results, null);
  assert.equal(summary.results[0].raw_language_edit_count, 2);
  assert.equal(summary.results[0].localization_issue_count, 1);
  assert.equal("validated_raw_result" in summary.results[0], false);
  assert.equal("localization_issues" in summary.results[0], false);
});

test("success records full validated result, quality summary, usage, and actual cost", async () => {
  const results = await benchmarkWritingReviewDeepSeekModels(
    benchmarkInput(),
    dependencies({
      async requestAI(_input, config) {
        return {
          content: JSON.stringify(rawResult(config)),
          model: config.model,
          usage: usage(2)
        };
      }
    })
  );
  const flash = results[0];
  assert.equal(flash.schema_valid, true);
  assert.equal(flash.official_score, 3);
  assert.equal(flash.language_edit_count, 2);
  assert.equal(flash.content_feedback_count, 2);
  assert.deepEqual(flash.content_feedback_categories, {
    elaboration: 1,
    language_improvement: 1
  });
  assert.equal(flash.prompt_tokens, 4802);
  assert.equal(flash.reasoning_tokens, 1302);
  assert.equal(flash.total_tokens, 6902);
  assert.equal(flash.cost, 0.032345);
  assert.equal(flash.upstream_inference_cost, 0.03);
  assert.equal(flash.validated_result.language_edits[0].start, 8);
  assert.equal(flash.validated_raw_result, null);
});

test("missing usage and cost stay null without affecting successful validation", async () => {
  const results = await benchmarkWritingReviewDeepSeekModels(
    benchmarkInput(),
    dependencies({
      async requestAI(_input, config) {
        return {
          content: JSON.stringify(rawResult(config)),
          model: config.model,
          usage: { ...EMPTY_OPENROUTER_USAGE }
        };
      }
    })
  );
  assert.ok(results.every((result) => result.result === "success"));
  assert.ok(results.every((result) => result.reasoning_tokens === null));
  assert.ok(results.every((result) => result.cost === null));
});

test("provider error diagnostics are whitelisted and Pro still runs", async () => {
  const results = await benchmarkWritingReviewDeepSeekModels(
    benchmarkInput(),
    dependencies({
      async requestAI(input, config, signal) {
        if (config.label === "deepseek_flash_high") {
          return requestOpenRouterWritingReview(input, {
            env: {
              OPENROUTER_API_KEY: "test-secret",
              OPENROUTER_WRITING_MODEL: "production-model"
            },
            jsonSchema: AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA,
            modelOverride: config.model,
            reasoningEffort: "high",
            signal,
            async fetchImpl() {
              return Response.json(
                {
                  error: {
                    code: 429,
                    message: "Rate limited",
                    metadata: {
                      error_type: "rate_limit",
                      provider_code: "capacity",
                      provider_name: "DeepSeek",
                      raw_debug: "must-not-be-saved"
                    }
                  }
                },
                { status: 429 }
              );
            }
          });
        }
        return {
          content: JSON.stringify(rawResult(config)),
          model: config.model,
          usage: usage()
        };
      }
    })
  );
  const flash = results[0];
  assert.equal(flash.result, "provider_error");
  assert.equal(flash.http_status, 429);
  assert.equal(flash.provider_error_type, "rate_limit");
  assert.equal(flash.provider_error_code, "capacity");
  assert.equal(flash.provider_name, "DeepSeek");
  assert.equal(JSON.stringify(flash).includes("raw_debug"), false);
  assert.equal(JSON.stringify(flash).includes("test-secret"), false);
  assert.equal(results[1].result, "success");
});

test("Kimi baseline is read from the existing detail file and absence remains null", () => {
  const baseline = kimiBaseline();
  const loaded = readWritingReviewDeepSeekKimiBaseline(
    "/safe/ad_weak-high.json",
    () => JSON.stringify(baseline)
  );
  assert.equal(
    WRITING_REVIEW_DEEPSEEK_KIMI_BASELINE_PATH,
    "tmp/writing-review-reasoning-stability/ad_weak-high.json"
  );
  assert.equal(loaded.model, "moonshotai/kimi-k3");
  assert.equal(loaded.official_score, 3);
  assert.equal(loaded.validated_result.language_edits.length, 2);
  assert.equal(
    readWritingReviewDeepSeekKimiBaseline("/missing", () => {
      throw new Error("ENOENT");
    }),
    null
  );
});

test("summary compares each candidate to Kimi and Flash directly to Pro by exact edit pair", async () => {
  const results = await benchmarkWritingReviewDeepSeekModels(
    benchmarkInput(),
    dependencies({
      async requestAI(_input, config) {
        const raw = rawResult(config);
        if (config.label === "deepseek_pro_high") {
          raw.language_edits.push({
            edit_id: "pro-only",
            original_text: "is important",
            replacement_text: "are important",
            category: "grammar",
            severity: "major",
            explanation: "谓语形式需与复数主语一致。"
          });
        }
        return {
          content: JSON.stringify(raw),
          model: config.model,
          usage: usage(config.label === "deepseek_pro_high" ? 1 : 0)
        };
      }
    })
  );
  const summary = buildWritingReviewDeepSeekSummary(results, kimiBaseline());
  const flashKimi = summary.kimi_edit_comparisons.deepseek_flash_high;
  assert.deepEqual(flashKimi.shared_edits, [
    { original_text: "years is", replacement_text: "years are" }
  ]);
  assert.deepEqual(flashKimi.kimi_only_edits, [
    {
      original_text: "Growth environments",
      replacement_text: "Developmental environments"
    }
  ]);
  assert.deepEqual(flashKimi.candidate_only_edits, [
    { original_text: "Kindful", replacement_text: "Kind" }
  ]);
  assert.equal(summary.flash_vs_pro.official_score_delta, 1);
  assert.equal(summary.flash_vs_pro.dimension_score_deltas.relevance, 1);
  assert.equal(summary.flash_vs_pro.shared_edits.length, 2);
  assert.deepEqual(summary.flash_vs_pro.pro_only_edits, []);
  assert.equal(summary.flash_vs_pro.cost_delta, 0.01);
  assert.equal("validated_result" in summary.results[0], false);
  assert.equal("validated_result" in summary.baseline, false);
});

test("localization raw edits remain available for direct and Kimi comparisons", async () => {
  const localizedResults = await benchmarkWritingReviewDeepSeekModels(
    benchmarkInput(),
    dependencies({
      async requestAI(_input, config) {
        return {
          content: JSON.stringify(rawResult(config)),
          model: config.model,
          usage: usage()
        };
      },
      parseReview(value, text) {
        const parsed = parseAIReviewRawResultV22(value);
        if (parsed.overall_feedback.startsWith("deepseek_flash")) {
          const error = new Error("strict localization failed");
          error.issues = [{ path: "$.language_edits[1].original_text", message: "must occur exactly once in response_text" }];
          throw error;
        }
        return parseAIReviewRawResultV22ForResponse(value, text);
      }
    })
  );
  const summary = buildWritingReviewDeepSeekSummary(localizedResults, kimiBaseline());
  assert.equal(summary.flash_vs_pro.flash_source, "raw");
  assert.equal(summary.flash_vs_pro.pro_source, "final");
  assert.equal(summary.flash_vs_pro.shared_edits.length, 2);
  assert.equal(summary.kimi_edit_comparisons.deepseek_flash_high.source, "raw");
});

test("writer creates four isolated files and Markdown has objective sections and full QA checklist", async () => {
  const results = await benchmarkWritingReviewDeepSeekModels(
    benchmarkInput(),
    dependencies()
  );
  const files = new Map();
  const summary = writeWritingReviewDeepSeekFiles(
    "/safe/deepseek",
    results,
    kimiBaseline(),
    {
      mkdirSync(directory, options) {
        assert.equal(directory, "/safe/deepseek");
        assert.deepEqual(options, { recursive: true });
      },
      writeFileSync(file, content, options) {
        assert.equal(options.mode, 0o600);
        files.set(file, String(content));
      }
    }
  );
  assert.equal(WRITING_REVIEW_DEEPSEEK_OUTPUT_DIR, "tmp/writing-review-deepseek-comparison");
  assert.deepEqual(Array.from(files.keys()).sort(), [
    path.join("/safe/deepseek", "comparison.md"),
    path.join("/safe/deepseek", "deepseek-flash-high.json"),
    path.join("/safe/deepseek", "deepseek-pro-high.json"),
    path.join("/safe/deepseek", "summary.json")
  ]);
  assert.equal(summary.results.length, 2);
  const markdown = files.get(path.join("/safe/deepseek", "comparison.md"));
  assert.match(markdown, /^# DeepSeek V4 Flash vs V4 Pro/m);
  assert.match(markdown, /Kimi K3 high baseline/);
  assert.match(markdown, /## DeepSeek V4 Flash High/);
  assert.match(markdown, /## DeepSeek V4 Pro High/);
  assert.match(markdown, /### Status/);
  assert.match(markdown, /### Scores/);
  assert.match(markdown, /### Language Edits/);
  assert.match(markdown, /### Content Feedback/);
  assert.match(markdown, /### Localization Issues/);
  assert.match(markdown, /### Performance/);
  assert.match(markdown, /## Flash vs Pro/);
  assert.match(markdown, /## Manual QA Checklist/);
  assert.match(markdown, /teenage years vs age 10 是否进入 Elaboration/);
  assert.match(markdown, /Language Edit span 是否严格忠于原文/);
  assert.doesNotMatch(markdown, /winner|获胜|推荐模型/iu);
});

test("Pro-only updates only Pro detail plus summary and comparison while preserving raw diagnostics", async () => {
  const results = await benchmarkWritingReviewDeepSeekModels(
    benchmarkInput(),
    dependencies({
      configs: selectWritingReviewDeepSeekConfigs("pro"),
      async requestAI(_input, config) {
        const raw = rawResult(config);
        raw.language_edits[0].original_text = "not copied from response";
        return {
          content: JSON.stringify(raw),
          model: config.model,
          usage: usage()
        };
      }
    })
  );
  const files = new Map([
    [path.join("/safe/deepseek", "deepseek-flash-high.json"), "old Flash detail"]
  ]);
  const summary = writeWritingReviewDeepSeekFiles(
    "/safe/deepseek",
    results,
    kimiBaseline(),
    {
      mkdirSync() {},
      writeFileSync(file, content) {
        files.set(file, String(content));
      }
    }
  );
  assert.equal(files.get(path.join("/safe/deepseek", "deepseek-flash-high.json")), "old Flash detail");
  assert.ok(files.has(path.join("/safe/deepseek", "deepseek-pro-high.json")));
  assert.equal(summary.results.length, 1);
  assert.equal(summary.results[0].label, "deepseek_pro_high");
  assert.equal(summary.results[0].schema_valid, true);
  assert.equal(summary.results[0].result, "localization_error");
  assert.equal(summary.results[0].raw_language_edit_count, 2);
  assert.ok(summary.results[0].localization_issue_count > 0);
  assert.equal(summary.flash_vs_pro, null);
  const markdown = files.get(path.join("/safe/deepseek", "comparison.md"));
  assert.match(markdown, /^# DeepSeek V4 Pro High Retest/m);
  assert.match(markdown, /Kimi K3 high baseline/);
  assert.match(markdown, /## DeepSeek V4 Pro High/);
  assert.doesNotMatch(markdown, /## DeepSeek V4 Flash High/);
  assert.doesNotMatch(markdown, /## Flash vs Pro/);
  assert.match(markdown, /not copied from response/);
  assert.match(markdown, /是否仍有 non-unique original_text/);
  assert.match(markdown, /多个 edits 同时应用后是否仍正确/);
});

test("localization Markdown exposes validated raw edits and marks the failure", async () => {
  const results = await benchmarkWritingReviewDeepSeekModels(
    benchmarkInput(),
    dependencies({
      parseReview(value, text) {
        const raw = parseAIReviewRawResultV22(value);
        if (raw.overall_feedback.startsWith("deepseek_flash")) {
          const error = new Error("exact localization failed");
          error.issues = [{ path: "$.language_edits[0].original_text", message: "must occur exactly once in response_text" }];
          throw error;
        }
        return parseAIReviewRawResultV22ForResponse(value, text);
      }
    })
  );
  const markdown = buildWritingReviewDeepSeekMarkdown(results, null);
  assert.match(markdown, /### Raw Language Edits Before Localization/);
  assert.match(markdown, /\*\*Localization failed\.\*\*/);
  assert.match(markdown, /`years is` → `years are`/);
  assert.match(markdown, /must occur exactly once in response_text/);
});

test("both requests use formal message builder, strict v2.2 schema, high reasoning, and no fallback", async () => {
  const bodies = [];
  const results = await benchmarkWritingReviewDeepSeekModels(
    benchmarkInput(),
    dependencies({
      async requestAI(input, config, signal) {
        return requestOpenRouterWritingReview(input, {
          env: {
            OPENROUTER_API_KEY: "test-key",
            OPENROUTER_WRITING_MODEL: "production-model-must-not-be-used"
          },
          jsonSchema: AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA,
          modelOverride: config.model,
          reasoningEffort: config.reasoning_effort,
          signal,
          async fetchImpl(_url, init) {
            bodies.push(JSON.parse(init.body));
            return Response.json({
              choices: [{ message: { content: JSON.stringify(rawResult(config)) } }],
              usage: {}
            });
          }
        });
      }
    })
  );
  assert.ok(results.every((result) => result.result === "success"));
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies.map((body) => body.model), [
    "deepseek/deepseek-v4-flash",
    "deepseek/deepseek-v4-pro"
  ]);
  assert.deepEqual(bodies.map((body) => body.reasoning), [
    { effort: "high" },
    { effort: "high" }
  ]);
  assert.deepEqual(bodies[0].messages, bodies[1].messages);
  assert.deepEqual(
    bodies[0].response_format.json_schema.schema,
    AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA
  );
  assert.equal(bodies[0].response_format.json_schema.strict, true);
  assert.equal(bodies[0].provider.require_parameters, true);
  assert.equal(bodies[0].stream, false);
  assert.equal(JSON.stringify(bodies).includes("production-model-must-not-be-used"), false);
});

test("CLI and module remain local-only, ignored, filtered, and do not contain repair or database writes", () => {
  const root = path.resolve(__dirname, "..");
  const script = fs.readFileSync(
    path.join(root, "scripts/benchmark-writing-review-deepseek.ts"),
    "utf8"
  );
  const moduleSource = fs.readFileSync(
    path.join(root, "lib/writingReviewDeepSeekBenchmark.ts"),
    "utf8"
  );
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.equal(
    packageJson.scripts["benchmark:writing-deepseek"],
    "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --env-file-if-exists=.env.local --experimental-strip-types scripts/benchmark-writing-review-deepseek.ts"
  );
  assert.match(gitignore, /\/tmp\/writing-review-deepseek-comparison\//);
  assert.match(script, /AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA/);
  assert.match(script, /parseAIReviewRawResultV22ForResponse/);
  assert.match(script, /requestOpenRouterWritingReview/);
  assert.match(script, /parseWritingReviewDeepSeekArguments/);
  assert.match(script, /selectWritingReviewDeepSeekConfigs/);
  assert.match(script, /--only all\|flash\|pro/);
  assert.doesNotMatch(script, /writing_reviews|\.insert\(|\.update\(|\.upsert\(/);
  assert.doesNotMatch(moduleSource, /fuzzy|repair|retry|fallback/i);
  assert.doesNotMatch(`${script}\n${moduleSource}`, /response_text\s*\)|console\.log\([^\n]*(question|responseText|messages)/);
});

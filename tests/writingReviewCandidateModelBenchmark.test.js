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
  WRITING_REVIEW_CANDIDATE_ATTEMPT_ID,
  WRITING_REVIEW_CANDIDATE_CONFIGS,
  WRITING_REVIEW_CANDIDATE_KIMI_BASELINE_PATH,
  WRITING_REVIEW_CANDIDATE_OUTPUT_DIR,
  WRITING_REVIEW_CANDIDATE_TIMEOUT_MS,
  benchmarkWritingReviewCandidateModels,
  buildWritingReviewCandidateMarkdown,
  buildWritingReviewCandidateSummary,
  parseWritingReviewCandidateArguments,
  readWritingReviewCandidateKimiBaseline,
  selectWritingReviewCandidateConfigs,
  writeWritingReviewCandidateFiles
} = require("../lib/writingReviewCandidateModelBenchmark.ts");
const {
  parseAIReviewRawResultV22,
  parseAIReviewRawResultV22ForResponse
} = require("../lib/writingReviewSchemaV22.ts");

const responseText =
  "Teenage years is important. Growth environments matter. Kindful people help. It is necessary.";

function input(overrides = {}) {
  return {
    attemptId: WRITING_REVIEW_CANDIDATE_ATTEMPT_ID,
    taskType: "academic_discussion",
    question: { question_id: "ad-weak" },
    responseText,
    ...overrides
  };
}

function raw(config, overrides = {}) {
  const dimension = (ai_score) => ({ ai_score, ai_basis: "具体评分依据。" });
  const score = config.reasoning_effort === "high" ? 3 : 2;
  return {
    schema_version: "2.2",
    task_type: "academic_discussion",
    language_edits: [{
      edit_id: "shared-edit",
      original_text: "years is",
      replacement_text: "years are",
      category: "grammar",
      severity: "major",
      explanation: "复数主语需要复数谓语。"
    }, {
      edit_id: "candidate-edit",
      original_text: "Kindful",
      replacement_text: "Kind",
      category: "word_choice",
      severity: "moderate",
      explanation: "Kindful 不是自然的英语表达。"
    }],
    scores: {
      official_score: { ai_score: score, rationale: "整体评分依据。" },
      dimension_scores: {
        relevance: dimension(score + 1),
        elaboration: dimension(score),
        syntactic_range_and_word_choice: dimension(score),
        lexical_and_grammatical_control: dimension(score)
      }
    },
    content_feedback: [{
      feedback_id: "feedback-1",
      category: "elaboration",
      original_sentence: "It is necessary.",
      issue: "没有完成哪个因素影响更大的比较。",
      suggestion: "明确比较结论并补充理由。",
      proposed_revision: "It is necessary to compare which factor has the stronger influence."
    }, {
      feedback_id: "feedback-2",
      category: "language_improvement",
      original_sentence: "Growth environments matter.",
      issue: "搭配不够自然。",
      suggestion: "使用更自然的名词短语。",
      proposed_revision: "Developmental environments matter."
    }],
    overall_feedback: `${config.label} 总体评价。`,
    ...overrides
  };
}

function usage(index = 0, overrides = {}) {
  return {
    ...EMPTY_OPENROUTER_USAGE,
    prompt_tokens: 5000 + index,
    cached_tokens: 40,
    completion_tokens: 2000 + index,
    reasoning_tokens: 1200 + index,
    accepted_prediction_tokens: 2,
    rejected_prediction_tokens: 1,
    total_tokens: 7000 + index,
    cost: 0.05 + index * 0.01,
    upstream_inference_cost: 0.04 + index * 0.01,
    upstream_inference_prompt_cost: 0.01,
    upstream_inference_completions_cost: 0.03 + index * 0.01,
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
        content: JSON.stringify(raw(config)),
        model: config.model,
        usage: usage()
      };
    },
    parseRawReview: parseAIReviewRawResultV22,
    parseReview: parseAIReviewRawResultV22ForResponse,
    ...overrides
  };
}

function baseline() {
  const config = WRITING_REVIEW_CANDIDATE_CONFIGS[1];
  const rawResult = raw(config, {
    language_edits: [{
      edit_id: "shared-edit",
      original_text: "years is",
      replacement_text: "years are",
      category: "grammar",
      severity: "major",
      explanation: "复数主语需要复数谓语。"
    }, {
      edit_id: "kimi-edit",
      original_text: "Growth environments",
      replacement_text: "Developmental environments",
      category: "word_choice",
      severity: "moderate",
      explanation: "该名词短语不自然。"
    }],
    content_feedback: [{
      feedback_id: "kimi-feedback-1",
      category: "elaboration",
      original_sentence: "It is necessary.",
      issue: "论证不足。",
      suggestion: "补充比较。",
      proposed_revision: "It is necessary to compare the two influences."
    }]
  });
  const validated = parseAIReviewRawResultV22ForResponse(rawResult, responseText);
  return {
    label: "kimi_high_baseline",
    provider: "openrouter",
    model: "moonshotai/kimi-k3",
    reasoning_effort: "high",
    attempt_id: WRITING_REVIEW_CANDIDATE_ATTEMPT_ID,
    task_type: "academic_discussion",
    elapsed_ms: 66934,
    ...usage(9),
    result: "success",
    schema_valid: true,
    official_score: 3,
    dimension_scores: {
      relevance: 4,
      elaboration: 3,
      syntactic_range_and_word_choice: 3,
      lexical_and_grammatical_control: 3
    },
    language_edit_count: 2,
    content_feedback_count: 1,
    content_feedback_categories: { elaboration: 1 },
    overall_feedback: "Kimi 总体评价。",
    validated_result: validated
  };
}

test("candidate benchmark fixes the attempt, models, efforts, and order", () => {
  assert.equal(
    WRITING_REVIEW_CANDIDATE_ATTEMPT_ID,
    "a7ad7e9f-b4ef-4ee0-9b39-43f1d7020cdc"
  );
  assert.deepEqual(WRITING_REVIEW_CANDIDATE_CONFIGS, [
    {
      label: "grok_medium",
      display_name: "Grok 4.6 Medium",
      model: "x-ai/grok-4.6",
      reasoning_effort: "medium"
    },
    {
      label: "grok_high",
      display_name: "Grok 4.6 High",
      model: "x-ai/grok-4.6",
      reasoning_effort: "high"
    },
    {
      label: "gemini_medium",
      display_name: "Gemini 3.7 Flash Medium",
      model: "google/gemini-3.7-flash",
      reasoning_effort: "medium"
    },
    {
      label: "gemini_high",
      display_name: "Gemini 3.7 Flash High",
      model: "google/gemini-3.7-flash",
      reasoning_effort: "high"
    }
  ]);
});

test("candidate CLI defaults to all and validates all/gemini/grok filters", () => {
  assert.deepEqual(parseWritingReviewCandidateArguments([]), {
    selection: "all",
    error: null
  });
  assert.deepEqual(parseWritingReviewCandidateArguments(["--", "--only", "gemini"]), {
    selection: "gemini",
    error: null
  });
  assert.deepEqual(parseWritingReviewCandidateArguments(["--only", "grok"]), {
    selection: "grok",
    error: null
  });
  assert.match(parseWritingReviewCandidateArguments(["--only", "other"]).error, /Invalid/);
  assert.match(parseWritingReviewCandidateArguments(["--only"]).error, /requires/);
  assert.match(parseWritingReviewCandidateArguments(["--unknown"]).error, /Unknown/);
  assert.equal(selectWritingReviewCandidateConfigs("all").length, 4);
  assert.deepEqual(
    selectWritingReviewCandidateConfigs("gemini").map((config) => config.label),
    ["gemini_medium", "gemini_high"]
  );
  assert.deepEqual(
    selectWritingReviewCandidateConfigs("grok").map((config) => config.label),
    ["grok_medium", "grok_high"]
  );
});

test("Gemini-only runs medium then high with two calls and no Grok or Kimi API", async () => {
  const calls = [];
  let active = false;
  const results = await benchmarkWritingReviewCandidateModels(
    input(),
    dependencies({
      configs: selectWritingReviewCandidateConfigs("gemini"),
      async requestAI(_input, config) {
        assert.equal(active, false);
        active = true;
        calls.push(config.label);
        const response = {
          content: JSON.stringify(raw(config)),
          model: config.model,
          usage: usage()
        };
        active = false;
        return response;
      }
    })
  );
  assert.deepEqual(calls, ["gemini_medium", "gemini_high"]);
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.model === "google/gemini-3.7-flash"));
  assert.ok(calls.every((label) => !label.includes("grok") && !label.includes("kimi")));

  const summary = buildWritingReviewCandidateSummary(results, baseline());
  assert.equal(summary.results.length, 2);
  assert.equal(summary.baseline.model, "moonshotai/kimi-k3");
  const files = new Map();
  writeWritingReviewCandidateFiles("/safe/gemini", results, baseline(), {
    mkdirSync() {},
    writeFileSync(file, content) { files.set(file, String(content)); }
  });
  assert.equal(files.size, 4);
  assert.ok(files.has(path.join("/safe/gemini", "gemini-medium.json")));
  assert.ok(files.has(path.join("/safe/gemini", "gemini-high.json")));
  assert.ok(Array.from(files.keys()).every((file) => !file.includes("grok")));
});

test("four candidate configurations execute sequentially once without Kimi", async () => {
  const order = [];
  let active = false;
  let calls = 0;
  const results = await benchmarkWritingReviewCandidateModels(
    input(),
    dependencies({
      async requestAI(_input, config) {
        assert.equal(active, false);
        active = true;
        calls += 1;
        order.push(`${config.model}/${config.reasoning_effort}`);
        const response = {
          content: JSON.stringify(raw(config)),
          model: config.model,
          usage: usage(calls)
        };
        active = false;
        return response;
      }
    })
  );
  assert.equal(calls, 4);
  assert.deepEqual(order, [
    "x-ai/grok-4.6/medium",
    "x-ai/grok-4.6/high",
    "google/gemini-3.7-flash/medium",
    "google/gemini-3.7-flash/high"
  ]);
  assert.ok(order.every((entry) => !entry.includes("kimi")));
  assert.ok(results.every((result) => result.result === "success"));
});

test("fixed input guard prevents any candidate API request for another attempt", async () => {
  let calls = 0;
  await assert.rejects(
    benchmarkWritingReviewCandidateModels(
      input({ attemptId: "another-attempt" }),
      dependencies({
        async requestAI() {
          calls += 1;
          throw new Error("should not run");
        }
      })
    ),
    /fixed weak AD attempt/
  );
  assert.equal(calls, 0);
});

test("timeout continues to all later candidates without retry", async () => {
  const calls = new Map();
  const results = await benchmarkWritingReviewCandidateModels(
    input(),
    dependencies({
      async requestAI(_input, config) {
        calls.set(config.label, (calls.get(config.label) ?? 0) + 1);
        if (config.label === "grok_medium") {
          throw new OpenRouterWritingReviewError(
            "AI_REQUEST_TIMEOUT",
            "candidate timeout",
            504
          );
        }
        return {
          content: JSON.stringify(raw(config)),
          model: config.model,
          usage: usage()
        };
      }
    })
  );
  assert.deepEqual(results.map((result) => result.result), [
    "timeout",
    "success",
    "success",
    "success"
  ]);
  assert.equal(calls.size, 4);
  assert.ok(Array.from(calls.values()).every((count) => count === 1));
});

test("invalid JSON, Schema validation, and localization failures stay distinct", async () => {
  const results = await benchmarkWritingReviewCandidateModels(
    input(),
    dependencies({
      async requestAI(_input, config) {
        if (config.label === "grok_medium") {
          return {
            content: `\`\`\`json\n${JSON.stringify(raw(config))}\n\`\`\``,
            model: config.model,
            usage: usage()
          };
        }
        if (config.label === "grok_high") {
          const invalid = raw(config);
          delete invalid.overall_feedback;
          return {
            content: JSON.stringify(invalid),
            model: config.model,
            usage: usage()
          };
        }
        if (config.label === "gemini_medium") {
          const unlocatable = raw(config);
          unlocatable.language_edits[0].original_text = "not in the essay";
          return {
            content: JSON.stringify(unlocatable),
            model: config.model,
            usage: usage()
          };
        }
        return {
          content: JSON.stringify(raw(config)),
          model: config.model,
          usage: usage()
        };
      }
    })
  );
  assert.deepEqual(results.map((result) => result.result), [
    "invalid_json",
    "validation_error",
    "localization_error",
    "success"
  ]);
  assert.equal(results[0].error_code, "AI_RESPONSE_INVALID_JSON");
  assert.equal(results[1].error_code, "AI_RESPONSE_SCHEMA_INVALID");
  assert.equal(results[2].error_code, "AI_RESPONSE_LOCALIZATION_FAILED");
  assert.deepEqual(results.slice(0, 3).map((result) => result.schema_valid), [
    false,
    false,
    true
  ]);
  assert.equal(results[0].reasoning_tokens, 1200);
});

test("candidate result records full performance, cost, quality, and validated output", async () => {
  const results = await benchmarkWritingReviewCandidateModels(
    input(),
    dependencies({
      async requestAI(_input, config) {
        return {
          content: JSON.stringify(raw(config)),
          model: config.model,
          usage: usage(3)
        };
      }
    })
  );
  const result = results[0];
  assert.equal(result.provider, "openrouter");
  assert.equal(result.prompt_tokens, 5003);
  assert.equal(result.cached_tokens, 40);
  assert.equal(result.completion_tokens, 2003);
  assert.equal(result.reasoning_tokens, 1203);
  assert.equal(result.accepted_prediction_tokens, 2);
  assert.equal(result.rejected_prediction_tokens, 1);
  assert.equal(result.total_tokens, 7003);
  assert.equal(result.cost, 0.08);
  assert.equal(result.upstream_inference_cost, 0.07);
  assert.equal(result.schema_valid, true);
  assert.equal(result.official_score, 2);
  assert.deepEqual(result.dimension_scores, {
    relevance: 3,
    elaboration: 2,
    syntactic_range_and_word_choice: 2,
    lexical_and_grammatical_control: 2
  });
  assert.equal(result.language_edit_count, 2);
  assert.equal(result.content_feedback_count, 2);
  assert.deepEqual(result.content_feedback_categories, {
    elaboration: 1,
    language_improvement: 1
  });
  assert.equal(result.validated_result.language_edits[0].explanation, "复数主语需要复数谓语。");
  assert.ok(result.validated_result.content_feedback[0].proposed_revision);
});

test("missing usage and cost fields remain null without failing validation", async () => {
  const results = await benchmarkWritingReviewCandidateModels(
    input(),
    dependencies({
      async requestAI(_input, config) {
        return {
          content: JSON.stringify(raw(config)),
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

test("Kimi baseline reader loads the existing detail format and safely handles absence", () => {
  const source = baseline();
  const loaded = readWritingReviewCandidateKimiBaseline(
    "/safe/ad_weak-high.json",
    () => JSON.stringify(source)
  );
  assert.equal(loaded.model, "moonshotai/kimi-k3");
  assert.equal(loaded.reasoning_effort, "high");
  assert.equal(loaded.cost, source.cost);
  assert.equal(loaded.validated_result.language_edits.length, 2);
  assert.equal(
    readWritingReviewCandidateKimiBaseline("/missing", () => {
      throw new Error("ENOENT");
    }),
    null
  );
  assert.equal(
    readWritingReviewCandidateKimiBaseline("/invalid", () => "not json"),
    null
  );
});

test("summary compares exact edits and feedback categories to loaded Kimi only", async () => {
  const results = await benchmarkWritingReviewCandidateModels(input(), dependencies());
  const summary = buildWritingReviewCandidateSummary(results, baseline());
  const comparison = summary.comparisons[0];
  assert.equal(summary.baseline.model, "moonshotai/kimi-k3");
  assert.equal("validated_result" in summary.baseline, false);
  assert.equal("validated_result" in summary.results[0], false);
  assert.equal(comparison.baseline_available, true);
  assert.deepEqual(comparison.shared_edits, [{
    original_text: "years is",
    replacement_text: "years are"
  }]);
  assert.deepEqual(comparison.kimi_only_edits, [{
    original_text: "Growth environments",
    replacement_text: "Developmental environments"
  }]);
  assert.deepEqual(comparison.candidate_only_edits, [{
    original_text: "Kindful",
    replacement_text: "Kind"
  }]);
  assert.deepEqual(comparison.feedback_category_delta, {
    elaboration: 0,
    language_improvement: 1
  });
  assert.equal(comparison.official_score_delta, -1);

  const withoutBaseline = buildWritingReviewCandidateSummary(results, null);
  assert.equal(withoutBaseline.baseline, null);
  assert.equal(withoutBaseline.comparisons[0].baseline_available, false);
  assert.deepEqual(withoutBaseline.comparisons[0].candidate_only_edits, []);
});

test("provider diagnostics flow into candidate summary and comparison Markdown", async () => {
  const geminiConfigs = selectWritingReviewCandidateConfigs("gemini");
  const results = await benchmarkWritingReviewCandidateModels(
    input(),
    dependencies({
      configs: geminiConfigs,
      async requestAI(requestInput, config, signal) {
        return requestOpenRouterWritingReview(requestInput, {
          env: {
            OPENROUTER_API_KEY: "test-key",
            OPENROUTER_WRITING_MODEL: "production-model"
          },
          jsonSchema: {},
          modelOverride: config.model,
          reasoningEffort: config.reasoning_effort,
          signal,
          async fetchImpl() {
            return Response.json(
              {
                error: {
                  code: 403,
                  message: "Forbidden for this workspace",
                  metadata: {
                    error_type: "permission_denied",
                    provider_code: config.reasoning_effort === "medium" ? 40301 : "policy_block",
                    provider_name: "Google",
                    raw_debug: "must not appear"
                  }
                }
              },
              { status: 403 }
            );
          }
        });
      }
    })
  );
  assert.deepEqual(results.map((result) => result.result), [
    "provider_error",
    "provider_error"
  ]);
  assert.deepEqual(
    results.map((result) => ({
      error_code: result.error_code,
      http_status: result.http_status,
      provider_error_type: result.provider_error_type,
      provider_error_code: result.provider_error_code,
      provider_name: result.provider_name
    })),
    [{
      error_code: "OPENROUTER_REQUEST_FAILED",
      http_status: 403,
      provider_error_type: "permission_denied",
      provider_error_code: 40301,
      provider_name: "Google"
    }, {
      error_code: "OPENROUTER_REQUEST_FAILED",
      http_status: 403,
      provider_error_type: "permission_denied",
      provider_error_code: "policy_block",
      provider_name: "Google"
    }]
  );
  const summary = buildWritingReviewCandidateSummary(results, baseline());
  assert.equal(summary.results[0].http_status, 403);
  assert.equal(summary.results[0].provider_error_type, "permission_denied");
  assert.equal(summary.results[0].provider_error_code, 40301);
  assert.equal(summary.results[0].provider_name, "Google");
  const markdown = buildWritingReviewCandidateMarkdown(results, baseline());
  assert.match(markdown, /HTTP status: 403/);
  assert.match(markdown, /Error type: permission_denied/);
  assert.match(markdown, /Provider code: 40301/);
  assert.match(markdown, /Provider: Google/);
  assert.match(markdown, /OpenRouter HTTP 403 \[permission_denied\]: Forbidden for this workspace/);
  assert.doesNotMatch(markdown, /raw_debug|must not appear/);
});

test("writer creates four full details, summary, and objective comparison Markdown", async () => {
  const results = await benchmarkWritingReviewCandidateModels(input(), dependencies());
  const files = new Map();
  const summary = writeWritingReviewCandidateFiles(
    "/safe/candidates",
    results,
    baseline(),
    {
      mkdirSync() {},
      writeFileSync(file, content) { files.set(file, String(content)); }
    }
  );
  assert.equal(files.size, 6);
  for (const name of [
    "grok-medium.json",
    "grok-high.json",
    "gemini-medium.json",
    "gemini-high.json"
  ]) {
    const detail = JSON.parse(files.get(path.join("/safe/candidates", name)));
    assert.equal(detail.validated_result.schema_version, "2.2");
    assert.equal(detail.validated_result.language_edits.length, 2);
    assert.equal(detail.validated_result.content_feedback.length, 2);
  }
  const summaryFile = JSON.parse(
    files.get(path.join("/safe/candidates", "summary.json"))
  );
  assert.deepEqual(summaryFile, summary);
  assert.equal(summaryFile.results.length, 4);
  const markdown = files.get(path.join("/safe/candidates", "comparison.md"));
  assert.match(markdown, /Candidate Model Benchmark/);
  assert.match(markdown, /moonshotai\/kimi-k3/);
  assert.match(markdown, /Grok 4\.6 Medium/);
  assert.match(markdown, /Gemini 3\.7 Flash High/);
  assert.match(markdown, /Kindful/);
  assert.match(markdown, /Proposed:/);
  assert.match(markdown, /Exact matching is only an aid/);
  assert.match(markdown, /Manual QA Checklist/);
  assert.match(markdown, /teenage years \/ age 10/);
  assert.match(markdown, /Schema 是否一次成功/);
  assert.doesNotMatch(markdown, /use grok|use gemini|passed|failed/i);
  assert.doesNotMatch(markdown, new RegExp(responseText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("candidate wiring is read-only and reuses production prompt, v2.2, and parser", () => {
  const root = process.cwd();
  const script = fs.readFileSync(
    path.join(root, "scripts/benchmark-writing-review-candidate-models.ts"),
    "utf8"
  );
  const moduleSource = fs.readFileSync(
    path.join(root, "lib/writingReviewCandidateModelBenchmark.ts"),
    "utf8"
  );
  const prompt = fs.readFileSync(path.join(root, "lib/openrouterWritingReview.ts"), "utf8");
  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.match(script, /loadWritingReviewComparisonSource/);
  assert.match(script, /requestOpenRouterWritingReview/);
  assert.match(script, /AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA/);
  assert.match(script, /parseAIReviewRawResultV22/);
  assert.match(script, /parseAIReviewRawResultV22ForResponse/);
  assert.match(script, /modelOverride: config\.model/);
  assert.match(script, /reasoningEffort: config\.reasoning_effort/);
  assert.doesNotMatch(script, /requestMoonshot|XAI_API_KEY|GEMINI_API_KEY/);
  assert.doesNotMatch(script, /\.from\("writing_reviews"\)|\.insert\(|\.update\(|\.delete\(/);
  assert.doesNotMatch(script, /console\.(?:log|table)\([^\n]*(?:response_text|responseText|prompt)/);
  assert.match(moduleSource, /JSON\.parse\(response\.content\)/);
  assert.doesNotMatch(moduleSource, /response\.content\.replace|strip.*fence|```json/i);
  assert.match(prompt, /WORD CHOICE & COLLOCATION AUDIT/);
  assert.match(prompt, /verb.?noun collocation/i);
  assert.match(prompt, /adjective.?noun collocation/i);
  assert.match(prompt, /noun.?noun (?:combination|collocation)/i);
  assert.match(prompt, /literal translation/i);
  assert.match(prompt, /smallest uniquely localizable contiguous source span/);
  assert.match(prompt, /nonstandard or invented-looking lexical form/);
  assert.match(gitignore, /writing-review-candidate-models/);
  assert.equal(WRITING_REVIEW_CANDIDATE_TIMEOUT_MS, 240_000);
  assert.equal(WRITING_REVIEW_CANDIDATE_TIMEOUT_MS, WRITING_REVIEW_FULL_REQUEST_TIMEOUT_MS);
  assert.equal(
    WRITING_REVIEW_CANDIDATE_OUTPUT_DIR,
    "tmp/writing-review-candidate-models"
  );
  assert.equal(
    WRITING_REVIEW_CANDIDATE_KIMI_BASELINE_PATH,
    "tmp/writing-review-reasoning-stability/ad_weak-high.json"
  );
});

test("real OpenRouter request body receives each candidate model and effort", async () => {
  const bodies = [];
  for (const config of WRITING_REVIEW_CANDIDATE_CONFIGS) {
    await requestOpenRouterWritingReview(
      {
        taskType: "academic_discussion",
        question: { question_id: "ad-weak" },
        responseText: "Test response."
      },
      {
        env: {
          OPENROUTER_API_KEY: "test-key",
          OPENROUTER_WRITING_MODEL: "production-model"
        },
        jsonSchema: { type: "object", properties: { schema_version: { const: "2.2" } } },
        modelOverride: config.model,
        reasoningEffort: config.reasoning_effort,
        async fetchImpl(_url, init) {
          bodies.push(JSON.parse(init.body));
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: "{}" } }],
              usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, cost: 0 }
            }),
            { status: 200, headers: { "Content-Type": "application/json" } }
          );
        }
      }
    );
  }
  assert.deepEqual(
    bodies.map((body) => [body.model, body.reasoning]),
    [
      ["x-ai/grok-4.6", { effort: "medium" }],
      ["x-ai/grok-4.6", { effort: "high" }],
      ["google/gemini-3.7-flash", { effort: "medium" }],
      ["google/gemini-3.7-flash", { effort: "high" }]
    ]
  );
  assert.ok(bodies.every((body) => body.response_format.json_schema.strict === true));
  assert.ok(bodies.every((body) => body.provider.require_parameters === true));
  assert.deepEqual(bodies[0].messages, bodies[3].messages);
  assert.deepEqual(bodies[0].response_format, bodies[3].response_format);
});

test("production OpenRouter defaults still omit reasoning and keep the configured model", async () => {
  let body;
  await requestOpenRouterWritingReview(
    {
      taskType: "email",
      question: { question_id: "email-1" },
      responseText: "Test response."
    },
    {
      env: {
        OPENROUTER_API_KEY: "test-key",
        OPENROUTER_WRITING_MODEL: "moonshotai/kimi-k3"
      },
      jsonSchema: {},
      async fetchImpl(_url, init) {
        body = JSON.parse(init.body);
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "{}" } }] }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
    }
  );
  assert.equal(body.model, "moonshotai/kimi-k3");
  assert.equal("reasoning" in body, false);
});

test("comparison Markdown remains available when the Kimi file is absent", async () => {
  const results = await benchmarkWritingReviewCandidateModels(input(), dependencies());
  const markdown = buildWritingReviewCandidateMarkdown(results, null);
  assert.match(markdown, /Grok 4\.6 Medium/);
  assert.doesNotMatch(markdown, /moonshotai\/kimi-k3/);
});

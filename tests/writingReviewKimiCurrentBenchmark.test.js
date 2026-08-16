const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  EMPTY_OPENROUTER_USAGE,
  OpenRouterWritingReviewError,
  requestOpenRouterWritingReview
} = require("../lib/openrouterWritingReview.ts");
const {
  AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA,
  parseAIReviewRawResultV22,
  parseAIReviewRawResultV22ForResponse
} = require("../lib/writingReviewSchemaV22.ts");
const {
  WRITING_REVIEW_KIMI_CURRENT_CASES,
  WRITING_REVIEW_KIMI_CURRENT_EFFORT,
  WRITING_REVIEW_KIMI_CURRENT_HISTORICAL_DIR,
  WRITING_REVIEW_KIMI_CURRENT_MODEL,
  WRITING_REVIEW_KIMI_CURRENT_OUTPUT_DIR,
  WRITING_REVIEW_KIMI_CURRENT_TIMEOUT_MS,
  benchmarkWritingReviewKimiCurrent,
  buildWritingReviewKimiCurrentMarkdown,
  buildWritingReviewKimiCurrentSummary,
  readWritingReviewKimiHistoricalBaseline,
  writeWritingReviewKimiCurrentFiles
} = require("../lib/writingReviewKimiCurrentBenchmark.ts");

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
  const benchmarkCase = WRITING_REVIEW_KIMI_CURRENT_CASES.find(
    (item) => item.case_label === caseLabel
  );
  const editByCase = {
    email_good: ["am write", "am writing"],
    email_weak: ["want ask", "want to ask"],
    ad_good: ["transit reduce", "transit reduces"],
    ad_weak: ["years is", "years are"]
  };
  const score = benchmarkCase.quality_label === "good" ? 5 : 3;
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
        category: "elaboration",
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
  return WRITING_REVIEW_KIMI_CURRENT_CASES.map((benchmarkCase) => ({
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
        model: WRITING_REVIEW_KIMI_CURRENT_MODEL,
        usage: usage()
      };
    },
    parseRawReview: parseAIReviewRawResultV22,
    parseReview: parseAIReviewRawResultV22ForResponse,
    ...overrides
  };
}

function historical(caseLabel, overrides = {}) {
  const benchmarkCase = WRITING_REVIEW_KIMI_CURRENT_CASES.find(
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
    provider: "openrouter",
    model: "moonshotai/kimi-k3",
    reasoning_effort: "high",
    elapsed_ms: 50000,
    ...usage(4),
    result: "success",
    schema_valid: true,
    official_score: benchmarkCase.quality_label === "good" ? 5 : 3,
    dimension_scores: Object.fromEntries(
      Object.entries(validated.scores.dimension_scores).map(([key, value]) => [
        key,
        value.ai_score
      ])
    ),
    language_edit_count: 1,
    content_feedback_count: 1,
    content_feedback_categories: { elaboration: 1 },
    overall_feedback: "Historical Kimi baseline。",
    validated_result: validated,
    ...overrides
  };
}

function historicalBaselines(overrides = {}) {
  return WRITING_REVIEW_KIMI_CURRENT_CASES.map((benchmarkCase) =>
    readWritingReviewKimiHistoricalBaseline(
      benchmarkCase,
      `/safe/${benchmarkCase.case_label}-high.json`,
      () =>
        JSON.stringify(
          historical(
            benchmarkCase.case_label,
            overrides[benchmarkCase.case_label]
          )
        )
    )
  );
}

test("Kimi current benchmark fixes four attempts, model, high reasoning, and timeout", () => {
  assert.deepEqual(
    WRITING_REVIEW_KIMI_CURRENT_CASES.map((item) => ({
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
      },
      {
        case_label: "ad_weak",
        attempt_id: "a7ad7e9f-b4ef-4ee0-9b39-43f1d7020cdc",
        task_type: "academic_discussion"
      }
    ]
  );
  assert.equal(WRITING_REVIEW_KIMI_CURRENT_MODEL, "moonshotai/kimi-k3");
  assert.equal(WRITING_REVIEW_KIMI_CURRENT_EFFORT, "high");
  assert.equal(WRITING_REVIEW_KIMI_CURRENT_TIMEOUT_MS, 240_000);
});

test("all four cases run sequentially once in the fixed order", async () => {
  const calls = [];
  let active = false;
  const results = await benchmarkWritingReviewKimiCurrent(
    inputs(),
    dependencies({
      async requestAI(input) {
        assert.equal(active, false);
        active = true;
        const caseLabel = input.question.question_id;
        calls.push(caseLabel);
        await Promise.resolve();
        const response = {
          content: JSON.stringify(rawReview(caseLabel)),
          model: WRITING_REVIEW_KIMI_CURRENT_MODEL,
          usage: usage(calls.length)
        };
        active = false;
        return response;
      }
    })
  );
  assert.deepEqual(calls, ["email_good", "email_weak", "ad_good", "ad_weak"]);
  assert.equal(results.length, 4);
  assert.ok(results.every((result) => result.result === "success"));
});

test("fixed-case guard blocks missing, reordered, and extra inputs before requests", async () => {
  let calls = 0;
  const deps = dependencies({
    async requestAI() {
      calls += 1;
      throw new Error("must not run");
    }
  });
  await assert.rejects(
    benchmarkWritingReviewKimiCurrent(inputs().slice(0, 3), deps),
    /exactly four fixed cases/
  );
  const reordered = inputs();
  [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
  await assert.rejects(
    benchmarkWritingReviewKimiCurrent(reordered, deps),
    /Unexpected Kimi current case/
  );
  await assert.rejects(
    benchmarkWritingReviewKimiCurrent([...inputs(), inputs()[0]], deps),
    /exactly four fixed cases/
  );
  assert.equal(calls, 0);
});

test("one timeout records null usage and later cases continue without retry", async () => {
  const calls = new Map();
  const results = await benchmarkWritingReviewKimiCurrent(
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
          model: WRITING_REVIEW_KIMI_CURRENT_MODEL,
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
  assert.deepEqual(Array.from(calls.values()), [1, 1, 1, 1]);
  assert.equal(results[0].prompt_tokens, null);
  assert.equal(results[0].cost, null);
});

test("invalid JSON, Schema failure, and strict localization failure stay distinct without repair", async () => {
  const results = await benchmarkWritingReviewKimiCurrent(
    inputs(),
    dependencies({
      async requestAI(input) {
        const caseLabel = input.question.question_id;
        if (caseLabel === "email_good") {
          return {
            content: "```json secret-invalid-json ```",
            model: WRITING_REVIEW_KIMI_CURRENT_MODEL,
            usage: usage()
          };
        }
        const raw = rawReview(caseLabel);
        if (caseLabel === "email_weak") delete raw.overall_feedback;
        if (caseLabel === "ad_good") {
          raw.language_edits[0].original_text = "Transit Reduce";
        }
        return {
          content: JSON.stringify(raw),
          model: WRITING_REVIEW_KIMI_CURRENT_MODEL,
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
  assert.deepEqual(results.map((result) => result.schema_valid), [
    false,
    false,
    true,
    true
  ]);
  assert.equal(JSON.stringify(results[0]).includes("secret-invalid-json"), false);
  assert.equal(results[2].validated_result, null);
  assert.equal(results[2].validated_raw_result.schema_version, "2.2");
  assert.equal(results[2].raw_official_score, 5);
  assert.equal(results[2].raw_language_edit_count, 1);
  assert.equal(results[2].raw_content_feedback_count, 1);
  assert.deepEqual(results[2].raw_content_feedback_categories, { elaboration: 1 });
  assert.ok(results[2].localization_issue_count > 0);
});

test("successful details preserve scores, content, localization, usage, and upstream costs", async () => {
  const results = await benchmarkWritingReviewKimiCurrent(
    inputs(),
    dependencies({
      async requestAI(input) {
        const caseLabel = input.question.question_id;
        return {
          content: JSON.stringify(rawReview(caseLabel)),
          model: WRITING_REVIEW_KIMI_CURRENT_MODEL,
          usage: usage(2)
        };
      }
    })
  );
  assert.deepEqual(Object.keys(results[0].dimension_scores).sort(), [
    "communicative_purpose_and_elaboration",
    "lexical_and_grammatical_control",
    "social_conventions",
    "syntactic_range_and_word_choice"
  ]);
  assert.deepEqual(Object.keys(results[2].dimension_scores).sort(), [
    "elaboration",
    "lexical_and_grammatical_control",
    "relevance",
    "syntactic_range_and_word_choice"
  ]);
  assert.equal(results[0].validated_result.language_edits[0].start, 2);
  assert.equal(results[0].validated_result.language_edits[0].end, 10);
  assert.equal(results[0].language_edits[0].original_text, "am write");
  assert.equal(results[0].content_feedback[0].category, "elaboration");
  assert.equal(results[0].overall_feedback, "email_good 总体评价。");
  assert.equal(results[0].prompt_tokens, 4002);
  assert.equal(results[0].completion_tokens, 2002);
  assert.equal(results[0].reasoning_tokens, 1002);
  assert.equal(results[0].total_tokens, 6002);
  assert.equal(results[0].cost, 0.04);
  assert.equal(results[0].upstream_inference_cost, 0.038);
  assert.equal(results[0].upstream_inference_prompt_cost, 0.004);
  assert.equal(results[0].upstream_inference_completions_cost, 0.034);
});

test("historical high baselines are read per case and absence stays null", () => {
  assert.equal(
    WRITING_REVIEW_KIMI_CURRENT_HISTORICAL_DIR,
    "tmp/writing-review-reasoning-stability"
  );
  const baselines = historicalBaselines({
    email_weak: {
      result: "timeout",
      schema_valid: false,
      official_score: null,
      dimension_scores: null,
      language_edit_count: null,
      content_feedback_count: null,
      content_feedback_categories: {},
      validated_result: null
    },
    ad_good: {
      result: "invalid_json",
      schema_valid: false,
      official_score: null,
      dimension_scores: null,
      language_edit_count: null,
      content_feedback_count: null,
      content_feedback_categories: {},
      validated_result: null
    }
  });
  assert.equal(baselines[0].case_label, "email_good");
  assert.equal(baselines[1].result, "timeout");
  assert.equal(baselines[2].result, "invalid_json");
  assert.equal(
    readWritingReviewKimiHistoricalBaseline(
      WRITING_REVIEW_KIMI_CURRENT_CASES[0],
      "/missing",
      () => {
        throw new Error("ENOENT");
      }
    ),
    null
  );
});

test("summary counts statuses, reproduction flags, and success-only aggregate correctly", async () => {
  const nowValues = [0, 100, 200, 400, 500, 800, 900, 1300];
  const results = await benchmarkWritingReviewKimiCurrent(
    inputs(),
    dependencies({
      now: () => nowValues.shift(),
      async requestAI(input) {
        const caseLabel = input.question.question_id;
        if (caseLabel === "email_weak") {
          throw new OpenRouterWritingReviewError(
            "AI_REQUEST_TIMEOUT",
            "timeout",
            504
          );
        }
        if (caseLabel === "ad_good") {
          return {
            content: "not-json",
            model: WRITING_REVIEW_KIMI_CURRENT_MODEL,
            usage: usage(8)
          };
        }
        const index = caseLabel === "email_good" ? 0 : 2;
        return {
          content: JSON.stringify(rawReview(caseLabel)),
          model: WRITING_REVIEW_KIMI_CURRENT_MODEL,
          usage: usage(index)
        };
      }
    })
  );
  const summary = buildWritingReviewKimiCurrentSummary(
    results,
    historicalBaselines()
  );
  assert.deepEqual(summary.statistics, {
    total_cases: 4,
    success: 2,
    timeout: 1,
    provider_error: 0,
    invalid_json: 1,
    validation_error: 0,
    localization_error: 0,
    schema_success_count: 2,
    localization_success_count: 2,
    success_rate: 0.5,
    email_weak_timeout_reproduced: true,
    ad_good_invalid_json_reproduced: true
  });
  assert.equal(summary.aggregate.successful_cases, 2);
  assert.equal(summary.aggregate.avg_elapsed_ms, 250);
  assert.equal(summary.aggregate.median_elapsed_ms, 250);
  assert.equal(summary.aggregate.avg_reasoning_tokens, 1001);
  assert.equal(summary.aggregate.avg_completion_tokens, 2001);
  assert.equal(summary.aggregate.avg_total_tokens, 6001);
  assert.equal(summary.aggregate.avg_cost, 0.03);
});

test("schema-valid localization failure counts as Schema success only", async () => {
  const results = await benchmarkWritingReviewKimiCurrent(
    inputs(),
    dependencies({
      async requestAI(input) {
        const caseLabel = input.question.question_id;
        const raw = rawReview(caseLabel);
        if (caseLabel === "ad_good") {
          raw.language_edits[0].original_text = "not present";
        }
        return {
          content: JSON.stringify(raw),
          model: WRITING_REVIEW_KIMI_CURRENT_MODEL,
          usage: usage()
        };
      }
    })
  );
  const summary = buildWritingReviewKimiCurrentSummary(
    results,
    historicalBaselines()
  );
  assert.equal(summary.statistics.localization_error, 1);
  assert.equal(summary.statistics.success, 3);
  assert.equal(summary.statistics.schema_success_count, 4);
  assert.equal(summary.statistics.localization_success_count, 3);
  assert.equal(summary.aggregate.successful_cases, 3);
});

test("writer creates four details, compact summary, and requested comparison report", async () => {
  const results = await benchmarkWritingReviewKimiCurrent(inputs(), dependencies());
  const baselines = historicalBaselines();
  const files = new Map();
  const summary = writeWritingReviewKimiCurrentFiles(
    "/safe/kimi-current",
    results,
    baselines,
    {
      mkdirSync(directory, options) {
        assert.equal(directory, "/safe/kimi-current");
        assert.deepEqual(options, { recursive: true });
      },
      writeFileSync(file, content, options) {
        assert.equal(options.mode, 0o600);
        files.set(file, String(content));
      }
    }
  );
  assert.equal(
    WRITING_REVIEW_KIMI_CURRENT_OUTPUT_DIR,
    "tmp/writing-review-kimi-current-prompt"
  );
  assert.deepEqual(Array.from(files.keys()).sort(), [
    path.join("/safe/kimi-current", "ad-good.json"),
    path.join("/safe/kimi-current", "ad-weak.json"),
    path.join("/safe/kimi-current", "comparison.md"),
    path.join("/safe/kimi-current", "email-good.json"),
    path.join("/safe/kimi-current", "email-weak.json"),
    path.join("/safe/kimi-current", "summary.json")
  ]);
  assert.equal(summary.results.length, 4);
  assert.equal("validated_result" in summary.results[0], false);
  assert.equal("validated_result" in summary.historical_baselines[0], false);
  const detail = JSON.parse(
    files.get(path.join("/safe/kimi-current", "email-good.json"))
  );
  assert.equal(detail.result, "success");
  assert.equal(detail.schema_valid, true);
  assert.equal(detail.language_edits.length, 1);
  assert.equal(detail.content_feedback.length, 1);
  assert.equal(detail.validated_result.schema_version, "2.2");
  const markdown = files.get(path.join("/safe/kimi-current", "comparison.md"));
  assert.match(markdown, /^# Kimi K3 High — Current Prompt Stability Benchmark/m);
  assert.equal((markdown.match(/## email_good/g) ?? []).length, 1);
  assert.match(markdown, /Historical Kimi high/);
  assert.match(markdown, /Current Prompt Kimi high/);
  assert.match(markdown, /current prompt changed the span rule/i);
  assert.match(markdown, /Exact shared/);
  assert.match(markdown, /Historical only/);
  assert.match(markdown, /Current only/);
  assert.match(markdown, /是否仍为 5/);
  assert.match(markdown, /是否再次 timeout/);
  assert.match(markdown, /是否再次 invalid_json/);
  assert.match(markdown, /teenage years vs age 10/);
  assert.match(markdown, /schema_success_count/);
  assert.match(markdown, /avg_completion_tokens/);
  assert.match(markdown, /email_weak_timeout_reproduced/);
  assert.match(markdown, /ad_good_invalid_json_reproduced/);
});

test("mock OpenRouter calls use production messages, strict v2.2 Schema, Kimi high, and no retry", async () => {
  const bodies = [];
  const results = await benchmarkWritingReviewKimiCurrent(
    inputs(),
    dependencies({
      async requestAI(input, signal) {
        const caseLabel = input.question.question_id;
        return requestOpenRouterWritingReview(input, {
          env: {
            OPENROUTER_API_KEY: "test-key",
            OPENROUTER_WRITING_MODEL: "unused"
          },
          jsonSchema: AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA,
          modelOverride: WRITING_REVIEW_KIMI_CURRENT_MODEL,
          reasoningEffort: WRITING_REVIEW_KIMI_CURRENT_EFFORT,
          signal,
          async fetchImpl(_url, init) {
            bodies.push(JSON.parse(init.body));
            return Response.json({
              choices: [
                { message: { content: JSON.stringify(rawReview(caseLabel)) } }
              ],
              usage: {}
            });
          }
        });
      }
    })
  );
  assert.ok(results.every((result) => result.result === "success"));
  assert.equal(bodies.length, 4);
  assert.ok(bodies.every((body) => body.model === "moonshotai/kimi-k3"));
  assert.ok(bodies.every((body) => body.reasoning.effort === "high"));
  assert.ok(
    bodies.every((body) => body.response_format.json_schema.strict === true)
  );
  assert.ok(
    bodies.every((body) => body.response_format.json_schema.schema.oneOf)
  );
  assert.ok(bodies.every((body) => body.provider.require_parameters === true));
  assert.ok(bodies.every((body) => body.stream === false));
  assert.ok(
    bodies.every((body) =>
      body.messages[0].content.includes(
        "smallest uniquely localizable contiguous source span"
      )
    )
  );
  assert.equal(JSON.stringify(bodies).includes("unused"), false);
});

test("CLI is benchmark-only, output is ignored, and no sensitive input is logged", () => {
  const root = path.resolve(__dirname, "..");
  const script = fs.readFileSync(
    path.join(root, "scripts/benchmark-writing-review-kimi-current.ts"),
    "utf8"
  );
  const moduleSource = fs.readFileSync(
    path.join(root, "lib/writingReviewKimiCurrentBenchmark.ts"),
    "utf8"
  );
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8")
  );
  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.equal(
    packageJson.scripts["benchmark:writing-kimi-current"],
    "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --env-file-if-exists=.env.local --experimental-strip-types scripts/benchmark-writing-review-kimi-current.ts"
  );
  assert.match(gitignore, /\/tmp\/writing-review-kimi-current-prompt\//);
  assert.match(script, /WRITING_REVIEW_KIMI_CURRENT_CASES/);
  assert.match(script, /loadWritingReviewComparisonSource/);
  assert.match(script, /requestOpenRouterWritingReview/);
  assert.match(script, /AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA/);
  assert.match(script, /parseAIReviewRawResultV22/);
  assert.match(script, /parseAIReviewRawResultV22ForResponse/);
  assert.match(
    script,
    /reasoningEffort: benchmark\.WRITING_REVIEW_KIMI_CURRENT_EFFORT/
  );
  assert.match(script, /readWritingReviewKimiHistoricalBaseline/);
  assert.match(script, /-high\.json/);
  assert.doesNotMatch(
    `${script}\n${moduleSource}`,
    /\.from\("writing_reviews"\)|\.insert\(|\.update\(|\.upsert\(|\.delete\(/
  );
  assert.doesNotMatch(
    script,
    /console\.(?:log|table)\([^\n]*(?:response_text|responseText|question|messages|OPENROUTER_API_KEY)/
  );
  assert.doesNotMatch(moduleSource, /JSON5|strip.*fence|fuzzy|levenshtein/i);
  assert.equal((script.match(/requestOpenRouterWritingReview\(/g) ?? []).length, 1);
});

test("standalone markdown builder keeps the requested current and historical sections", async () => {
  const results = await benchmarkWritingReviewKimiCurrent(inputs(), dependencies());
  const markdown = buildWritingReviewKimiCurrentMarkdown(
    results,
    historicalBaselines()
  );
  assert.match(markdown, /Case \| Result \| Time \| Reasoning \| Total \| Cost/);
  assert.equal((markdown.match(/Historical Kimi high/g) ?? []).length, 4);
  assert.equal((markdown.match(/Current Prompt Kimi high/g) ?? []).length, 4);
});

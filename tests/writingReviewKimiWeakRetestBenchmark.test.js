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
  WRITING_REVIEW_KIMI_WEAK_RETEST_CASES,
  WRITING_REVIEW_KIMI_WEAK_RETEST_EFFORT,
  WRITING_REVIEW_KIMI_WEAK_RETEST_HISTORICAL_DIR,
  WRITING_REVIEW_KIMI_WEAK_RETEST_MODEL,
  WRITING_REVIEW_KIMI_WEAK_RETEST_OUTPUT_DIR,
  WRITING_REVIEW_KIMI_WEAK_RETEST_ROUND1_DIR,
  WRITING_REVIEW_KIMI_WEAK_RETEST_TIMEOUT_MS,
  benchmarkWritingReviewKimiWeakRetest,
  buildWritingReviewKimiWeakRetestMarkdown,
  buildWritingReviewKimiWeakRetestSummary,
  readWritingReviewKimiWeakStoredRun,
  writeWritingReviewKimiWeakRetestFiles
} = require("../lib/writingReviewKimiWeakRetestBenchmark.ts");

const responses = {
  email_weak: "I want ask help.",
  ad_weak:
    "Teenage years is important. Growth environments matter. Kindful people help."
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
  const taskType = caseLabel === "email_weak" ? "email" : "academic_discussion";
  const [original_text, replacement_text] =
    caseLabel === "email_weak"
      ? ["want ask", "want to ask"]
      : ["years is", "years are"];
  return {
    schema_version: "2.2",
    task_type: taskType,
    language_edits: [
      {
        edit_id: `${caseLabel}-edit`,
        original_text,
        replacement_text,
        category: "grammar",
        severity: "major",
        explanation: "需要修正语法形式。"
      }
    ],
    scores: {
      official_score: { ai_score: 3, rationale: "整体评分依据。" },
      dimension_scores: dimensions(taskType, 3)
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

function inputs() {
  return WRITING_REVIEW_KIMI_WEAK_RETEST_CASES.map((benchmarkCase) => ({
    attemptId: benchmarkCase.attempt_id,
    caseLabel: benchmarkCase.case_label,
    qualityLabel: benchmarkCase.quality_label,
    taskType: benchmarkCase.task_type,
    question: { question_id: benchmarkCase.case_label },
    responseText: responses[benchmarkCase.case_label]
  }));
}

function usage(index = 0) {
  return {
    ...EMPTY_OPENROUTER_USAGE,
    prompt_tokens: 4000 + index,
    cached_tokens: 100,
    completion_tokens: 2000 + index,
    reasoning_tokens: 1000 + index,
    total_tokens: 6000 + index,
    cost: 0.02 + index * 0.01,
    upstream_inference_cost: 0.018 + index * 0.01,
    upstream_inference_prompt_cost: 0.004,
    upstream_inference_completions_cost: 0.014 + index * 0.01
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
        model: WRITING_REVIEW_KIMI_WEAK_RETEST_MODEL,
        usage: usage()
      };
    },
    parseRawReview: parseAIReviewRawResultV22,
    parseReview: parseAIReviewRawResultV22ForResponse,
    ...overrides
  };
}

function stored(caseLabel, result, overrides = {}) {
  const benchmarkCase = WRITING_REVIEW_KIMI_WEAK_RETEST_CASES.find(
    (item) => item.case_label === caseLabel
  );
  return {
    case_label: caseLabel,
    attempt_id: benchmarkCase.attempt_id,
    task_type: benchmarkCase.task_type,
    quality_label: "weak",
    provider: "openrouter",
    model: "moonshotai/kimi-k3",
    reasoning_effort: "high",
    operation: "stored_benchmark",
    elapsed_ms: result === "timeout" ? 240000 : 67000,
    ...usage(4),
    result,
    schema_valid: result === "success",
    official_score: result === "success" ? 3 : null,
    dimension_scores:
      result === "success" ? dimensions(benchmarkCase.task_type, 3) : null,
    language_edit_count: result === "success" ? 12 : null,
    content_feedback_count: result === "success" ? 3 : null,
    content_feedback_categories:
      result === "success" ? { elaboration: 2, language_improvement: 1 } : {},
    overall_feedback: result === "success" ? "历史总体评价。" : null,
    localization_issue_count: 0,
    ...overrides
  };
}

function loadStored(caseLabel, run, result, overrides = {}) {
  const benchmarkCase = WRITING_REVIEW_KIMI_WEAK_RETEST_CASES.find(
    (item) => item.case_label === caseLabel
  );
  return readWritingReviewKimiWeakStoredRun(
    benchmarkCase,
    run,
    `/safe/${caseLabel}.json`,
    () => JSON.stringify(stored(caseLabel, result, overrides))
  );
}

async function successfulResults() {
  return benchmarkWritingReviewKimiWeakRetest(inputs(), dependencies());
}

test("weak retest fixes two attempt IDs, model, high reasoning, and timeout", () => {
  assert.deepEqual(
    WRITING_REVIEW_KIMI_WEAK_RETEST_CASES.map((item) => ({
      case_label: item.case_label,
      attempt_id: item.attempt_id,
      task_type: item.task_type
    })),
    [
      {
        case_label: "email_weak",
        attempt_id: "cde72af6-e6d0-439b-b3ac-91fb2ab117b1",
        task_type: "email"
      },
      {
        case_label: "ad_weak",
        attempt_id: "a7ad7e9f-b4ef-4ee0-9b39-43f1d7020cdc",
        task_type: "academic_discussion"
      }
    ]
  );
  assert.equal(WRITING_REVIEW_KIMI_WEAK_RETEST_MODEL, "moonshotai/kimi-k3");
  assert.equal(WRITING_REVIEW_KIMI_WEAK_RETEST_EFFORT, "high");
  assert.equal(WRITING_REVIEW_KIMI_WEAK_RETEST_TIMEOUT_MS, 240_000);
});

test("two cases run sequentially exactly once in email then AD order", async () => {
  const calls = [];
  let active = false;
  const results = await benchmarkWritingReviewKimiWeakRetest(
    inputs(),
    dependencies({
      timeoutMs: 1,
      async requestAI(input) {
        assert.equal(active, false);
        active = true;
        const caseLabel = input.question.question_id;
        calls.push(caseLabel);
        await Promise.resolve();
        active = false;
        return {
          content: JSON.stringify(rawReview(caseLabel)),
          model: WRITING_REVIEW_KIMI_WEAK_RETEST_MODEL,
          usage: usage(calls.length)
        };
      }
    })
  );
  assert.deepEqual(calls, ["email_weak", "ad_weak"]);
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.result === "success"));
  assert.ok(
    results.every(
      (result) => result.operation === "kimi_weak_retest_benchmark"
    )
  );
});

test("fixed guard blocks missing, reordered, or extra inputs before requests", async () => {
  let calls = 0;
  const deps = dependencies({
    async requestAI() {
      calls += 1;
      throw new Error("must not run");
    }
  });
  await assert.rejects(
    benchmarkWritingReviewKimiWeakRetest(inputs().slice(0, 1), deps),
    /exactly 2 fixed cases/
  );
  await assert.rejects(
    benchmarkWritingReviewKimiWeakRetest([...inputs()].reverse(), deps),
    /Unexpected Kimi current case/
  );
  await assert.rejects(
    benchmarkWritingReviewKimiWeakRetest([...inputs(), inputs()[0]], deps),
    /exactly 2 fixed cases/
  );
  assert.equal(calls, 0);
});

test("email timeout is not retried and AD still runs", async () => {
  const calls = new Map();
  const results = await benchmarkWritingReviewKimiWeakRetest(
    inputs(),
    dependencies({
      async requestAI(input) {
        const caseLabel = input.question.question_id;
        calls.set(caseLabel, (calls.get(caseLabel) ?? 0) + 1);
        if (caseLabel === "email_weak") {
          throw new OpenRouterWritingReviewError(
            "AI_REQUEST_TIMEOUT",
            "timeout",
            504
          );
        }
        return {
          content: JSON.stringify(rawReview(caseLabel)),
          model: WRITING_REVIEW_KIMI_WEAK_RETEST_MODEL,
          usage: usage()
        };
      }
    })
  );
  assert.deepEqual(results.map((result) => result.result), ["timeout", "success"]);
  assert.deepEqual(Array.from(calls.values()), [1, 1]);
  assert.equal(results[0].cost, null);
});

test("fenced JSON is invalid and strict localization retains validated raw data", async () => {
  const results = await benchmarkWritingReviewKimiWeakRetest(
    inputs(),
    dependencies({
      async requestAI(input) {
        const caseLabel = input.question.question_id;
        if (caseLabel === "email_weak") {
          return {
            content: "```json secret-output ```",
            model: WRITING_REVIEW_KIMI_WEAK_RETEST_MODEL,
            usage: usage()
          };
        }
        const raw = rawReview(caseLabel);
        raw.language_edits[0].original_text = "Years Is";
        return {
          content: JSON.stringify(raw),
          model: WRITING_REVIEW_KIMI_WEAK_RETEST_MODEL,
          usage: usage()
        };
      }
    })
  );
  assert.deepEqual(results.map((result) => result.result), [
    "invalid_json",
    "localization_error"
  ]);
  assert.equal(JSON.stringify(results[0]).includes("secret-output"), false);
  assert.equal(results[1].schema_valid, true);
  assert.equal(results[1].validated_result, null);
  assert.equal(results[1].validated_raw_result.schema_version, "2.2");
  assert.equal(results[1].raw_official_score, 3);
  assert.equal(results[1].raw_language_edit_count, 1);
  assert.equal(results[1].raw_content_feedback_count, 1);
  assert.deepEqual(results[1].raw_content_feedback_categories, {
    elaboration: 1
  });
  assert.ok(results[1].localization_issue_count > 0);
});

test("historical and current-prompt round1 readers whitelist fixed Kimi high files", () => {
  assert.equal(
    WRITING_REVIEW_KIMI_WEAK_RETEST_HISTORICAL_DIR,
    "tmp/writing-review-reasoning-stability"
  );
  assert.equal(
    WRITING_REVIEW_KIMI_WEAK_RETEST_ROUND1_DIR,
    "tmp/writing-review-kimi-current-prompt"
  );
  const historical = loadStored("email_weak", "historical", "timeout");
  const round1 = loadStored("ad_weak", "current_prompt_round1", "timeout");
  assert.equal(historical.run, "historical");
  assert.equal(historical.result, "timeout");
  assert.equal(round1.run, "current_prompt_round1");
  assert.equal(round1.result, "timeout");
  assert.equal(
    readWritingReviewKimiWeakStoredRun(
      WRITING_REVIEW_KIMI_WEAK_RETEST_CASES[0],
      "historical",
      "/missing",
      () => {
        throw new Error("ENOENT");
      }
    ),
    null
  );
  assert.equal(
    readWritingReviewKimiWeakStoredRun(
      WRITING_REVIEW_KIMI_WEAK_RETEST_CASES[0],
      "historical",
      "/wrong-model",
      () =>
        JSON.stringify(
          stored("email_weak", "timeout", { model: "another-model" })
        )
    ),
    null
  );
});

test("summary records required fields, three-run timeout counts, and retest flags", async () => {
  const results = await benchmarkWritingReviewKimiWeakRetest(
    inputs(),
    dependencies({
      async requestAI(input) {
        const caseLabel = input.question.question_id;
        if (caseLabel === "email_weak") {
          throw new OpenRouterWritingReviewError(
            "AI_REQUEST_TIMEOUT",
            "timeout",
            504
          );
        }
        return {
          content: JSON.stringify(rawReview(caseLabel)),
          model: WRITING_REVIEW_KIMI_WEAK_RETEST_MODEL,
          usage: usage(2)
        };
      }
    })
  );
  const historical = [
    loadStored("email_weak", "historical", "timeout"),
    loadStored("ad_weak", "historical", "success")
  ];
  const round1 = [
    loadStored("email_weak", "current_prompt_round1", "timeout"),
    loadStored("ad_weak", "current_prompt_round1", "timeout")
  ];
  const summary = buildWritingReviewKimiWeakRetestSummary(
    results,
    historical,
    round1
  );
  assert.equal(summary.email_weak_timeout_count, 3);
  assert.equal(summary.ad_weak_timeout_count, 1);
  assert.equal(summary.email_weak_timeout_reproduced_again, true);
  assert.equal(summary.ad_weak_timeout_reproduced_again, false);
  assert.equal(summary.retry, 0);
  assert.equal(summary.timeout_ms, 240000);
  assert.equal(summary.cases[0].historical_result, "timeout");
  assert.equal(summary.cases[0].current_prompt_round1_result, "timeout");
  assert.equal(summary.cases[0].retest_result, "timeout");
  assert.equal(summary.cases[1].schema_valid, true);
  assert.equal(summary.cases[1].prompt_tokens, 4002);
  assert.equal(summary.cases[1].cached_tokens, 100);
  assert.equal(summary.cases[1].completion_tokens, 2002);
  assert.equal(summary.cases[1].reasoning_tokens, 1002);
  assert.equal(summary.cases[1].total_tokens, 6002);
  assert.equal(summary.cases[1].cost, 0.04);
  assert.equal(summary.cases[1].official_score, 3);
  assert.equal(summary.cases[1].language_edit_count, 1);
  assert.equal(summary.cases[1].content_feedback_count, 1);
  assert.deepEqual(summary.cases[1].content_feedback_categories, {
    elaboration: 1
  });
});

test("writer creates only the new two details, summary, and factual comparison", async () => {
  const results = await successfulResults();
  const historical = [
    loadStored("email_weak", "historical", "timeout"),
    loadStored("ad_weak", "historical", "success")
  ];
  const round1 = [
    loadStored("email_weak", "current_prompt_round1", "timeout"),
    loadStored("ad_weak", "current_prompt_round1", "timeout")
  ];
  const files = new Map();
  writeWritingReviewKimiWeakRetestFiles(
    "/safe/weak-retest",
    results,
    historical,
    round1,
    {
      mkdirSync(directory, options) {
        assert.equal(directory, "/safe/weak-retest");
        assert.deepEqual(options, { recursive: true });
      },
      writeFileSync(file, content, options) {
        assert.equal(options.mode, 0o600);
        files.set(file, String(content));
      }
    }
  );
  assert.equal(
    WRITING_REVIEW_KIMI_WEAK_RETEST_OUTPUT_DIR,
    "tmp/writing-review-kimi-weak-retest"
  );
  assert.deepEqual(Array.from(files.keys()).sort(), [
    path.join("/safe/weak-retest", "ad-weak.json"),
    path.join("/safe/weak-retest", "comparison.md"),
    path.join("/safe/weak-retest", "email-weak.json"),
    path.join("/safe/weak-retest", "summary.json")
  ]);
  const detail = JSON.parse(
    files.get(path.join("/safe/weak-retest", "ad-weak.json"))
  );
  assert.equal(detail.validated_result.schema_version, "2.2");
  assert.equal(detail.language_edits.length, 1);
  const markdown = files.get(path.join("/safe/weak-retest", "comparison.md"));
  assert.match(markdown, /^# Kimi K3 High — Weak Case Retest/m);
  assert.equal((markdown.match(/\| email_weak \|/g) ?? []).length, 3);
  assert.equal((markdown.match(/\| ad_weak \|/g) ?? []).length, 3);
  assert.match(markdown, /Historical elapsed: 67000 ms/);
  assert.match(markdown, /Current Prompt Round 1 was timeout: true/);
  assert.match(markdown, /第三次仍 timeout/);
  assert.match(markdown, /是否出现异常长 reasoning/);
  assert.match(markdown, /Retest Feedback Content/);
  assert.doesNotMatch(markdown, /root cause|根因是|因为.*timeout/iu);
});

test("two mock OpenRouter requests use production messages and strict v2.2 Kimi high", async () => {
  const bodies = [];
  const results = await benchmarkWritingReviewKimiWeakRetest(
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
          modelOverride: WRITING_REVIEW_KIMI_WEAK_RETEST_MODEL,
          reasoningEffort: WRITING_REVIEW_KIMI_WEAK_RETEST_EFFORT,
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
  assert.equal(bodies.length, 2);
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
});

test("CLI is read-only, isolated, ignored, and never logs sensitive inputs", () => {
  const root = path.resolve(__dirname, "..");
  const script = fs.readFileSync(
    path.join(root, "scripts/benchmark-writing-review-kimi-weak-retest.ts"),
    "utf8"
  );
  const moduleSource = fs.readFileSync(
    path.join(root, "lib/writingReviewKimiWeakRetestBenchmark.ts"),
    "utf8"
  );
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8")
  );
  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.equal(
    packageJson.scripts["benchmark:writing-kimi-weak-retest"],
    "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --env-file-if-exists=.env.local --experimental-strip-types scripts/benchmark-writing-review-kimi-weak-retest.ts"
  );
  assert.match(gitignore, /\/tmp\/writing-review-kimi-weak-retest\//);
  assert.match(script, /WRITING_REVIEW_KIMI_WEAK_RETEST_CASES/);
  assert.match(script, /loadWritingReviewComparisonSource/);
  assert.match(script, /requestOpenRouterWritingReview/);
  assert.match(script, /AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA/);
  assert.match(script, /parseAIReviewRawResultV22ForResponse/);
  assert.match(script, /WRITING_REVIEW_KIMI_WEAK_RETEST_HISTORICAL_DIR/);
  assert.match(script, /WRITING_REVIEW_KIMI_WEAK_RETEST_ROUND1_DIR/);
  assert.match(script, /-high\.json/);
  assert.match(script, /replace\("_", "-"\)/);
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

test("standalone comparison remains available when prior files are missing", async () => {
  const markdown = buildWritingReviewKimiWeakRetestMarkdown(
    await successfulResults(),
    [null, null],
    [null, null]
  );
  assert.match(markdown, /Historical result: unavailable/);
  assert.match(markdown, /Current Prompt Round 1 result: unavailable/);
  assert.match(markdown, /Current Prompt Retest result: success/);
});

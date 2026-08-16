const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  EMPTY_OPENROUTER_USAGE,
  OpenRouterWritingReviewError,
  buildWritingReviewMessages,
  requestOpenRouterWritingReview
} = require("../lib/openrouterWritingReview.ts");
const {
  AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA,
  parseAIReviewRawResultV22,
  parseAIReviewRawResultV22ForResponse
} = require("../lib/writingReviewSchemaV22.ts");
const {
  WRITING_REVIEW_KIMI_MEDIUM_WEAK_CASES,
  WRITING_REVIEW_KIMI_MEDIUM_WEAK_EFFORT,
  WRITING_REVIEW_KIMI_MEDIUM_WEAK_HIGH_DIR,
  WRITING_REVIEW_KIMI_MEDIUM_WEAK_MODEL,
  WRITING_REVIEW_KIMI_MEDIUM_WEAK_OUTPUT_DIR,
  WRITING_REVIEW_KIMI_MEDIUM_WEAK_RETRY,
  WRITING_REVIEW_KIMI_MEDIUM_WEAK_TIMEOUT_MS,
  benchmarkWritingReviewKimiMediumWeak,
  buildWritingReviewKimiMediumWeakMarkdown,
  buildWritingReviewKimiMediumWeakSummary,
  readWritingReviewKimiMediumWeakHighResult,
  writeWritingReviewKimiMediumWeakFiles
} = require("../lib/writingReviewKimiMediumWeakBenchmark.ts");

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
  return WRITING_REVIEW_KIMI_MEDIUM_WEAK_CASES.map((benchmarkCase) => ({
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
  let tick = 0;
  return {
    now: () => tick++ * 100,
    requestWithTimeout: immediateTimeout,
    async requestAI(input) {
      const caseLabel = input.question.question_id;
      return {
        content: JSON.stringify(rawReview(caseLabel)),
        model: WRITING_REVIEW_KIMI_MEDIUM_WEAK_MODEL,
        usage: usage(caseLabel === "email_weak" ? 1 : 2)
      };
    },
    parseRawReview: parseAIReviewRawResultV22,
    parseReview: parseAIReviewRawResultV22ForResponse,
    ...overrides
  };
}

function highStored(caseLabel, overrides = {}) {
  const benchmarkCase = WRITING_REVIEW_KIMI_MEDIUM_WEAK_CASES.find(
    (item) => item.case_label === caseLabel
  );
  const review = rawReview(caseLabel);
  return {
    case_label: caseLabel,
    attempt_id: benchmarkCase.attempt_id,
    task_type: benchmarkCase.task_type,
    provider: "openrouter",
    model: "moonshotai/kimi-k3",
    reasoning_effort: "high",
    result: "success",
    elapsed_ms: caseLabel === "email_weak" ? 500 : 600,
    ...usage(caseLabel === "email_weak" ? 10 : 20),
    schema_valid: true,
    official_score: 3,
    dimension_scores: Object.fromEntries(
      Object.entries(review.scores.dimension_scores).map(([key, item]) => [
        key,
        item.ai_score
      ])
    ),
    language_edits: review.language_edits,
    content_feedback: review.content_feedback,
    language_edit_count: review.language_edits.length,
    content_feedback_count: review.content_feedback.length,
    content_feedback_categories: { elaboration: 1 },
    overall_feedback: "High 总体评价。",
    ...overrides
  };
}

function readHigh(caseLabel, overrides = {}) {
  const benchmarkCase = WRITING_REVIEW_KIMI_MEDIUM_WEAK_CASES.find(
    (item) => item.case_label === caseLabel
  );
  return readWritingReviewKimiMediumWeakHighResult(
    benchmarkCase,
    `/safe/${caseLabel}.json`,
    () => JSON.stringify(highStored(caseLabel, overrides))
  );
}

function highResults() {
  return [readHigh("email_weak"), readHigh("ad_weak")];
}

test("medium weak fixes the two attempts, Kimi K3 medium, timeout, and retry zero", () => {
  assert.deepEqual(
    WRITING_REVIEW_KIMI_MEDIUM_WEAK_CASES.map((item) => ({
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
  assert.equal(WRITING_REVIEW_KIMI_MEDIUM_WEAK_MODEL, "moonshotai/kimi-k3");
  assert.equal(WRITING_REVIEW_KIMI_MEDIUM_WEAK_EFFORT, "medium");
  assert.equal(WRITING_REVIEW_KIMI_MEDIUM_WEAK_TIMEOUT_MS, 240_000);
  assert.equal(WRITING_REVIEW_KIMI_MEDIUM_WEAK_RETRY, 0);
});

test("exactly two requests run serially once in email then AD order", async () => {
  const calls = [];
  let active = false;
  const results = await benchmarkWritingReviewKimiMediumWeak(
    inputs(),
    dependencies({
      async requestAI(input) {
        assert.equal(active, false);
        active = true;
        const caseLabel = input.question.question_id;
        calls.push(caseLabel);
        await Promise.resolve();
        active = false;
        return {
          content: JSON.stringify(rawReview(caseLabel)),
          model: WRITING_REVIEW_KIMI_MEDIUM_WEAK_MODEL,
          usage: usage(calls.length)
        };
      }
    })
  );
  assert.deepEqual(calls, ["email_weak", "ad_weak"]);
  assert.equal(results.length, 2);
  assert.ok(results.every((result) => result.result === "success"));
  assert.ok(results.every((result) => result.reasoning_effort === "medium"));
  assert.ok(
    results.every(
      (result) => result.operation === "kimi_medium_weak_benchmark"
    )
  );
  assert.ok(results.every((result) => result.localization_valid === true));
});

test("missing, reordered, and extra inputs are blocked before any request", async () => {
  let calls = 0;
  const deps = dependencies({
    async requestAI() {
      calls += 1;
      throw new Error("must not run");
    }
  });
  await assert.rejects(
    benchmarkWritingReviewKimiMediumWeak(inputs().slice(0, 1), deps),
    /exactly 2 fixed cases/
  );
  await assert.rejects(
    benchmarkWritingReviewKimiMediumWeak([...inputs()].reverse(), deps),
    /Unexpected Kimi current case/
  );
  await assert.rejects(
    benchmarkWritingReviewKimiMediumWeak([...inputs(), inputs()[0]], deps),
    /exactly 2 fixed cases/
  );
  assert.equal(calls, 0);
});

test("one failure is not retried and does not prevent the second case", async () => {
  const calls = [];
  const results = await benchmarkWritingReviewKimiMediumWeak(
    inputs(),
    dependencies({
      async requestAI(input) {
        const caseLabel = input.question.question_id;
        calls.push(caseLabel);
        if (caseLabel === "email_weak") {
          throw new OpenRouterWritingReviewError(
            "AI_REQUEST_TIMEOUT",
            "timeout",
            504
          );
        }
        return {
          content: JSON.stringify(rawReview(caseLabel)),
          model: WRITING_REVIEW_KIMI_MEDIUM_WEAK_MODEL,
          usage: usage(2)
        };
      }
    })
  );
  assert.deepEqual(calls, ["email_weak", "ad_weak"]);
  assert.deepEqual(results.map((result) => result.result), ["timeout", "success"]);
  assert.equal(results[0].localization_valid, null);
});

test("invalid JSON is not repaired and strict localization keeps validated raw diagnostics", async () => {
  const results = await benchmarkWritingReviewKimiMediumWeak(
    inputs(),
    dependencies({
      async requestAI(input) {
        const caseLabel = input.question.question_id;
        if (caseLabel === "email_weak") {
          return {
            content: "```json secret-output ```",
            model: WRITING_REVIEW_KIMI_MEDIUM_WEAK_MODEL,
            usage: usage(1)
          };
        }
        const raw = rawReview(caseLabel);
        raw.language_edits[0].original_text = "Years Is";
        return {
          content: JSON.stringify(raw),
          model: WRITING_REVIEW_KIMI_MEDIUM_WEAK_MODEL,
          usage: usage(2)
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
  assert.equal(results[1].localization_valid, false);
  assert.equal(results[1].validated_result, null);
  assert.equal(results[1].validated_raw_result.schema_version, "2.2");
  assert.equal(results[1].raw_official_score, 3);
  assert.equal(results[1].raw_language_edit_count, 1);
  assert.equal(results[1].raw_content_feedback_count, 1);
  assert.ok(results[1].localization_issue_count > 0);
});

test("two mock OpenRouter calls use official messages, v2.2 schema, and medium", async () => {
  const bodies = [];
  const benchmarkInputs = inputs();
  const results = await benchmarkWritingReviewKimiMediumWeak(
    benchmarkInputs,
    dependencies({
      async requestAI(input, signal) {
        const caseLabel = input.question.question_id;
        return requestOpenRouterWritingReview(input, {
          env: {
            OPENROUTER_API_KEY: "test-key",
            OPENROUTER_WRITING_MODEL: "unused"
          },
          jsonSchema: AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA,
          modelOverride: WRITING_REVIEW_KIMI_MEDIUM_WEAK_MODEL,
          reasoningEffort: WRITING_REVIEW_KIMI_MEDIUM_WEAK_EFFORT,
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
  assert.deepEqual(
    bodies.map((body) => body.messages),
    benchmarkInputs.map((input) => buildWritingReviewMessages(input))
  );
  assert.ok(bodies.every((body) => body.model === "moonshotai/kimi-k3"));
  assert.ok(bodies.every((body) => body.reasoning.effort === "medium"));
  assert.ok(
    bodies.every((body) => body.response_format.json_schema.strict === true)
  );
  assert.ok(
    bodies.every((body) => body.response_format.json_schema.schema.oneOf)
  );
  assert.ok(bodies.every((body) => body.provider.require_parameters === true));
  assert.ok(bodies.every((body) => body.stream === false));
});

test("high reader accepts only latest matching successful Kimi high results", () => {
  assert.equal(
    WRITING_REVIEW_KIMI_MEDIUM_WEAK_HIGH_DIR,
    "tmp/writing-review-kimi-weak-retest"
  );
  const high = readHigh("email_weak");
  assert.equal(high.result, "success");
  assert.equal(high.reasoning_effort, "high");
  assert.equal(high.localization_valid, true);
  assert.equal(high.language_edits.length, 1);
  assert.equal(
    readHigh("email_weak", { reasoning_effort: "medium" }),
    null
  );
  assert.equal(readHigh("email_weak", { result: "timeout" }), null);
  assert.equal(readHigh("email_weak", { model: "another-model" }), null);
  assert.equal(
    readWritingReviewKimiMediumWeakHighResult(
      WRITING_REVIEW_KIMI_MEDIUM_WEAK_CASES[0],
      "/missing",
      () => {
        throw new Error("ENOENT");
      }
    ),
    null
  );
});

test("summary and comparison calculate all medium-minus-high deltas", async () => {
  const medium = await benchmarkWritingReviewKimiMediumWeak(
    inputs(),
    dependencies()
  );
  const high = highResults();
  const summary = buildWritingReviewKimiMediumWeakSummary(medium, high);
  assert.equal(summary.medium_success_count, 2);
  assert.equal(summary.medium_timeout_count, 0);
  assert.equal(summary.avg_medium_elapsed_ms, 100);
  assert.equal(summary.avg_medium_reasoning_tokens, 1001.5);
  assert.equal(summary.avg_medium_total_tokens, 6001.5);
  assert.equal(summary.avg_medium_cost, 0.035);
  assert.equal(summary.high_recalled, false);
  assert.equal(summary.cases[0].elapsed_delta_medium_minus_high, -400);
  assert.equal(summary.cases[0].reasoning_delta, -9);
  assert.equal(summary.cases[0].total_tokens_delta, -9);
  assert.ok(Math.abs(summary.cases[0].cost_delta - -0.09) < 1e-12);
  assert.equal(summary.cases[0].official_score_delta, 0);
  assert.deepEqual(summary.cases[0].dimension_score_deltas, {
    communicative_purpose_and_elaboration: 0,
    syntactic_range_and_word_choice: 0,
    social_conventions: 0,
    lexical_and_grammatical_control: 0
  });
  assert.equal(summary.cases[0].language_edit_count_delta, 0);
  assert.equal(summary.cases[0].content_feedback_count_delta, 0);
  assert.equal(summary.cases[0].shared_language_edits.length, 1);
  assert.equal(summary.cases[0].high_only_language_edits.length, 0);
  assert.equal(summary.cases[0].medium_only_language_edits.length, 0);
  assert.equal(summary.cases[0].high.content_feedback_categories.elaboration, 1);
  assert.equal(summary.cases[0].medium.content_feedback_categories.elaboration, 1);
});

test("writer creates two details, summary, and required comparison without a winner", async () => {
  const medium = await benchmarkWritingReviewKimiMediumWeak(
    inputs(),
    dependencies()
  );
  const high = highResults();
  const files = new Map();
  writeWritingReviewKimiMediumWeakFiles(
    "/safe/medium-weak",
    medium,
    high,
    {
      mkdirSync(directory, options) {
        assert.equal(directory, "/safe/medium-weak");
        assert.deepEqual(options, { recursive: true });
      },
      writeFileSync(file, content, options) {
        assert.equal(options.mode, 0o600);
        files.set(file, String(content));
      }
    }
  );
  assert.equal(
    WRITING_REVIEW_KIMI_MEDIUM_WEAK_OUTPUT_DIR,
    "tmp/writing-review-kimi-medium-weak"
  );
  assert.deepEqual(Array.from(files.keys()).sort(), [
    path.join("/safe/medium-weak", "ad-weak.json"),
    path.join("/safe/medium-weak", "comparison.md"),
    path.join("/safe/medium-weak", "email-weak.json"),
    path.join("/safe/medium-weak", "summary.json")
  ]);
  const detail = JSON.parse(
    files.get(path.join("/safe/medium-weak", "email-weak.json"))
  );
  assert.equal(detail.reasoning_effort, "medium");
  assert.equal(detail.validated_result.schema_version, "2.2");
  assert.equal(detail.localization_valid, true);
  const storedSummary = JSON.parse(
    files.get(path.join("/safe/medium-weak", "summary.json"))
  );
  assert.equal(storedSummary.cases.length, 2);
  assert.ok(storedSummary.cases.every((item) => item.high && item.medium));
  const markdown = files.get(path.join("/safe/medium-weak", "comparison.md"));
  assert.match(markdown, /^# Kimi K3 Medium vs High — Weak Cases/m);
  assert.equal((markdown.match(/\| email_weak \| High \|/g) ?? []).length, 1);
  assert.equal((markdown.match(/\| email_weak \| Medium \|/g) ?? []).length, 1);
  assert.equal((markdown.match(/\| ad_weak \| High \|/g) ?? []).length, 1);
  assert.equal((markdown.match(/\| ad_weak \| Medium \|/g) ?? []).length, 1);
  assert.match(markdown, /Shared \(1\)/);
  assert.match(markdown, /High-only \(0\)/);
  assert.match(markdown, /Medium-only \(0\)/);
  assert.match(markdown, /Different spans may represent the same error/);
  assert.match(markdown, /make a directional goal/);
  assert.match(markdown, /nurture is necessary/);
  assert.match(markdown, /No automatic winner is declared/);
  assert.doesNotMatch(markdown, /Winner:/i);
});

test("CLI stays benchmark-only, reads high, avoids database writes, and logs no secrets", () => {
  const root = path.resolve(__dirname, "..");
  const script = fs.readFileSync(
    path.join(root, "scripts/benchmark-writing-review-kimi-medium-weak.ts"),
    "utf8"
  );
  const moduleSource = fs.readFileSync(
    path.join(root, "lib/writingReviewKimiMediumWeakBenchmark.ts"),
    "utf8"
  );
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8")
  );
  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.equal(
    packageJson.scripts["benchmark:writing-kimi-medium-weak"],
    "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --env-file-if-exists=.env.local --experimental-strip-types scripts/benchmark-writing-review-kimi-medium-weak.ts"
  );
  assert.match(gitignore, /\/tmp\/writing-review-kimi-medium-weak\//);
  assert.match(script, /loadWritingReviewComparisonSource/);
  assert.match(script, /requestOpenRouterWritingReview/);
  assert.match(script, /AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA/);
  assert.match(script, /parseAIReviewRawResultV22ForResponse/);
  assert.match(script, /WRITING_REVIEW_KIMI_MEDIUM_WEAK_HIGH_DIR/);
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
  assert.equal((script.match(/reasoningEffort:/g) ?? []).length, 1);
});

test("comparison rejects missing high pairs instead of calling or inventing a fallback", async () => {
  const medium = await benchmarkWritingReviewKimiMediumWeak(
    inputs(),
    dependencies()
  );
  assert.throws(
    () => buildWritingReviewKimiMediumWeakMarkdown(medium, [highResults()[0]]),
    /two aligned result pairs/
  );
});

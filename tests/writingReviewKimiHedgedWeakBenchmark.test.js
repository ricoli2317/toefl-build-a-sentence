const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  EMPTY_OPENROUTER_USAGE,
  buildWritingReviewMessages,
  requestOpenRouterWritingReview
} = require("../lib/openrouterWritingReview.ts");
const {
  AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA,
  parseAIReviewRawResultV22,
  parseAIReviewRawResultV22ForResponse
} = require("../lib/writingReviewSchemaV22.ts");
const {
  WRITING_REVIEW_KIMI_HEDGED_BASELINE_SOURCES,
  WRITING_REVIEW_KIMI_HEDGED_WEAK_CASES,
  WRITING_REVIEW_KIMI_HEDGED_WEAK_EFFORT,
  WRITING_REVIEW_KIMI_HEDGED_WEAK_MODEL,
  WRITING_REVIEW_KIMI_HEDGED_WEAK_OUTPUT_DIR,
  WRITING_REVIEW_KIMI_HEDGE_DEADLINE_MS,
  WRITING_REVIEW_KIMI_HEDGE_DELAY_MS,
  benchmarkWritingReviewKimiHedgedWeak,
  buildWritingReviewKimiHedgedWeakMarkdown,
  buildWritingReviewKimiHedgedWeakSummary,
  buildWritingReviewKimiSingleBaselineSummary,
  readWritingReviewKimiSingleBaseline,
  runWritingReviewKimiHedgedCase,
  writeWritingReviewKimiHedgedWeakFiles
} = require("../lib/writingReviewKimiHedgedWeakBenchmark.ts");

const responses = {
  email_weak: "I want ask help.",
  ad_weak:
    "Teenage years is important. Growth environments matter. Kindful people help."
};

function dimensions(taskType, score = 3) {
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
      dimension_scores: dimensions(taskType)
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

function usage(cost = 0.03, reasoning = 1200) {
  return {
    ...EMPTY_OPENROUTER_USAGE,
    prompt_tokens: 4000,
    cached_tokens: 0,
    completion_tokens: 2000,
    reasoning_tokens: reasoning,
    total_tokens: 6000,
    cost,
    upstream_inference_cost: cost
  };
}

function response(caseLabel, options = {}) {
  return {
    content:
      options.content ?? JSON.stringify(options.review ?? rawReview(caseLabel)),
    model: WRITING_REVIEW_KIMI_HEDGED_WEAK_MODEL,
    usage: options.usage ?? usage()
  };
}

function inputs() {
  return WRITING_REVIEW_KIMI_HEDGED_WEAK_CASES.map((benchmarkCase) => ({
    attemptId: benchmarkCase.attempt_id,
    caseLabel: benchmarkCase.case_label,
    qualityLabel: benchmarkCase.quality_label,
    taskType: benchmarkCase.task_type,
    question: { question_id: benchmarkCase.case_label },
    responseText: responses[benchmarkCase.case_label]
  }));
}

function dependencies(overrides = {}) {
  return {
    async requestAI(input) {
      return response(input.question.question_id);
    },
    parseRawReview: parseAIReviewRawResultV22,
    parseReview: parseAIReviewRawResultV22ForResponse,
    ...overrides
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

class ManualClock {
  constructor() {
    this.time = 0;
    this.nextId = 1;
    this.timers = [];
  }

  now = () => this.time;

  setTimeout = (callback, delayMs) => {
    const timer = {
      id: this.nextId++,
      callback,
      delayMs,
      dueAt: this.time + delayMs,
      cancelled: false,
      fired: false
    };
    this.timers.push(timer);
    return timer;
  };

  clearTimeout = (timer) => {
    timer.cancelled = true;
  };

  setTime(time) {
    assert.ok(time >= this.time);
    this.time = time;
  }

  fireDelay(delayMs) {
    const timer = this.timers.find(
      (item) =>
        !item.cancelled && !item.fired && item.delayMs === delayMs
    );
    assert.ok(timer, `missing active ${delayMs}ms timer`);
    this.time = Math.max(this.time, timer.dueAt);
    timer.fired = true;
    timer.callback();
  }
}

function controlledDependencies(clock, requestAI, overrides = {}) {
  return dependencies({
    now: clock.now,
    setTimeoutImpl: clock.setTimeout,
    clearTimeoutImpl: clock.clearTimeout,
    requestAI,
    ...overrides
  });
}

async function flush() {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function storedBaseline(caseLabel, run, result, overrides = {}) {
  const benchmarkCase = WRITING_REVIEW_KIMI_HEDGED_WEAK_CASES.find(
    (item) => item.case_label === caseLabel
  );
  return {
    case_label: caseLabel,
    attempt_id: benchmarkCase.attempt_id,
    task_type: benchmarkCase.task_type,
    provider: "openrouter",
    model: "moonshotai/kimi-k3",
    reasoning_effort: "high",
    run,
    result,
    elapsed_ms: result === "success" ? 100000 : 240000,
    ...usage(result === "success" ? 0.1 : null, 3000),
    schema_valid: result === "success",
    official_score: result === "success" ? 3 : null,
    ...overrides
  };
}

function baseline(caseLabel, run, result, overrides = {}) {
  const benchmarkCase = WRITING_REVIEW_KIMI_HEDGED_WEAK_CASES.find(
    (item) => item.case_label === caseLabel
  );
  return readWritingReviewKimiSingleBaseline(
    benchmarkCase,
    run,
    `/safe/${caseLabel}-${run}.json`,
    () => JSON.stringify(storedBaseline(caseLabel, run, result, overrides))
  );
}

function baselines() {
  return WRITING_REVIEW_KIMI_HEDGED_WEAK_CASES.map((benchmarkCase) => [
    baseline(
      benchmarkCase.case_label,
      "historical_reasoning_stability",
      benchmarkCase.case_label === "email_weak" ? "timeout" : "success",
      benchmarkCase.case_label === "ad_weak" ? { elapsed_ms: 70000 } : {}
    ),
    baseline(
      benchmarkCase.case_label,
      "current_prompt_round1",
      "timeout"
    ),
    baseline(benchmarkCase.case_label, "weak_retest", "success", {
      elapsed_ms: benchmarkCase.case_label === "email_weak" ? 180000 : 20000
    })
  ]);
}

test("fixed cases, model, high effort, hedge delay, and deadline are exact", () => {
  assert.deepEqual(
    WRITING_REVIEW_KIMI_HEDGED_WEAK_CASES.map((item) => ({
      case_label: item.case_label,
      attempt_id: item.attempt_id
    })),
    [
      {
        case_label: "email_weak",
        attempt_id: "cde72af6-e6d0-439b-b3ac-91fb2ab117b1"
      },
      {
        case_label: "ad_weak",
        attempt_id: "a7ad7e9f-b4ef-4ee0-9b39-43f1d7020cdc"
      }
    ]
  );
  assert.equal(WRITING_REVIEW_KIMI_HEDGED_WEAK_MODEL, "moonshotai/kimi-k3");
  assert.equal(WRITING_REVIEW_KIMI_HEDGED_WEAK_EFFORT, "high");
  assert.equal(WRITING_REVIEW_KIMI_HEDGE_DELAY_MS, 60_000);
  assert.equal(WRITING_REVIEW_KIMI_HEDGE_DEADLINE_MS, 240_000);
});

test("primary success before 60 seconds does not start hedge", async () => {
  const clock = new ManualClock();
  const calls = [];
  const logs = [];
  const result = await runWritingReviewKimiHedgedCase(
    inputs()[0],
    controlledDependencies(clock, async (input, signal) => {
      calls.push({ input, signal });
      clock.setTime(50000);
      return response("email_weak", { usage: usage(0.04) });
    }, {
      onRequestStart(input, request) {
        logs.push(`Starting ${input.caseLabel}: ${request}`);
      }
    })
  );
  assert.equal(calls.length, 1);
  assert.deepEqual(logs, ["Starting email_weak: primary"]);
  assert.equal(result.hedge_triggered, false);
  assert.equal(result.requests_started, 1);
  assert.equal(result.winner, "primary");
  assert.equal(result.end_to_end_elapsed_ms, 50000);
  assert.equal(result.hedge, null);
  assert.equal(result.result, "success");
});

test("primary still pending at 60 seconds starts hedge and primary winner aborts it", async () => {
  const clock = new ManualClock();
  const primary = deferred();
  const hedge = deferred();
  const calls = [];
  const logs = [];
  const resultPromise = runWritingReviewKimiHedgedCase(
    inputs()[0],
    controlledDependencies(clock, (input, signal) => {
      const call = { input, signal, pending: calls.length === 0 ? primary : hedge };
      calls.push(call);
      return call.pending.promise;
    }, {
      onRequestStart(input, request) {
        logs.push(`Starting ${input.caseLabel}: ${request}`);
      }
    })
  );
  await flush();
  clock.fireDelay(60_000);
  await flush();
  assert.equal(calls.length, 2);
  assert.deepEqual(logs, [
    "Starting email_weak: primary",
    "Starting email_weak: hedge"
  ]);
  clock.setTime(110000);
  primary.resolve(response("email_weak", { usage: usage(0.05) }));
  const result = await resultPromise;
  assert.equal(result.winner, "primary");
  assert.equal(result.hedge.result, "aborted_due_to_winner");
  assert.equal(result.loser_status, "aborted_due_to_winner");
  assert.equal(calls[1].signal.aborted, true);
  assert.equal(result.hedge.cost, null);
  assert.equal(result.observed_completed_cost, 0.05);
});

test("hedge winner aborts primary and aborted cost remains null", async () => {
  const clock = new ManualClock();
  const pending = [deferred(), deferred()];
  const signals = [];
  const resultPromise = runWritingReviewKimiHedgedCase(
    inputs()[0],
    controlledDependencies(clock, (_input, signal) => {
      signals.push(signal);
      return pending[signals.length - 1].promise;
    })
  );
  await flush();
  clock.fireDelay(60_000);
  await flush();
  clock.setTime(100000);
  pending[1].resolve(response("email_weak", { usage: usage(0.06) }));
  const result = await resultPromise;
  assert.equal(result.winner, "hedge");
  assert.equal(result.primary.result, "aborted_due_to_winner");
  assert.equal(signals[0].aborted, true);
  assert.equal(result.primary.cost, null);
  assert.equal(result.winner_cost, 0.06);
  assert.equal(result.observed_completed_cost, 0.06);
});

test("after hedge one terminal failure waits for the other full success", async () => {
  const clock = new ManualClock();
  const pending = [deferred(), deferred()];
  let calls = 0;
  const resultPromise = runWritingReviewKimiHedgedCase(
    inputs()[0],
    controlledDependencies(clock, () => pending[calls++].promise)
  );
  await flush();
  clock.fireDelay(60_000);
  await flush();
  clock.setTime(100000);
  pending[0].resolve(
    response("email_weak", {
      content: "not-json",
      usage: usage(0.02)
    })
  );
  await flush();
  let settled = false;
  resultPromise.then(() => {
    settled = true;
  });
  await flush();
  assert.equal(settled, false);
  clock.setTime(120000);
  pending[1].resolve(response("email_weak", { usage: usage(0.03) }));
  const result = await resultPromise;
  assert.equal(result.primary.result, "invalid_json");
  assert.equal(result.winner, "hedge");
  assert.equal(result.loser_status, "terminal_failure");
  assert.equal(result.observed_completed_cost, 0.05);
  assert.equal(result.winner_cost, 0.03);
});

test("primary terminal failure before 60 seconds ends case without hedge", async () => {
  const clock = new ManualClock();
  let calls = 0;
  const result = await runWritingReviewKimiHedgedCase(
    inputs()[0],
    controlledDependencies(clock, async () => {
      calls += 1;
      clock.setTime(40000);
      return response("email_weak", { content: "not-json" });
    })
  );
  assert.equal(calls, 1);
  assert.equal(result.result, "invalid_json");
  assert.equal(result.hedge_triggered, false);
  assert.equal(result.hedge, null);
  assert.equal(result.winner, null);
  assert.equal(result.loser_status, null);
});

test("winner must pass schema and strict localization", async () => {
  const clock = new ManualClock();
  const pending = [deferred(), deferred()];
  let calls = 0;
  const resultPromise = runWritingReviewKimiHedgedCase(
    inputs()[1],
    controlledDependencies(clock, () => pending[calls++].promise)
  );
  await flush();
  clock.fireDelay(60_000);
  await flush();
  const bad = rawReview("ad_weak");
  bad.language_edits[0].original_text = "Years Is";
  clock.setTime(100000);
  pending[0].resolve(response("ad_weak", { review: bad, usage: usage(0.02) }));
  await flush();
  clock.setTime(105000);
  pending[1].resolve(response("ad_weak", { usage: usage(0.03) }));
  const result = await resultPromise;
  assert.equal(result.primary.result, "localization_error");
  assert.equal(result.primary.schema_valid, true);
  assert.equal(result.primary.localization_valid, false);
  assert.equal(result.primary.validated_raw_result.schema_version, "2.2");
  assert.equal(result.winner, "hedge");
  assert.equal(result.result, "success");
});

test("overall 240-second deadline aborts both without success", async () => {
  const clock = new ManualClock();
  const signals = [];
  const never = [deferred(), deferred()];
  const resultPromise = runWritingReviewKimiHedgedCase(
    inputs()[0],
    controlledDependencies(clock, (_input, signal) => {
      signals.push(signal);
      return never[signals.length - 1].promise;
    })
  );
  await flush();
  clock.fireDelay(60_000);
  await flush();
  clock.fireDelay(240_000);
  const result = await resultPromise;
  assert.equal(result.result, "timeout");
  assert.equal(result.end_to_end_elapsed_ms, 240000);
  assert.equal(result.primary.result, "timeout");
  assert.equal(result.hedge.result, "timeout");
  assert.equal(result.loser_status, "timeout");
  assert.ok(signals.every((signal) => signal.aborted));
  assert.equal(result.observed_completed_cost, null);
});

test("two cases are serial and start at most four total requests", async () => {
  const clock = new ManualClock();
  const pending = [];
  const calls = [];
  const benchmarkPromise = benchmarkWritingReviewKimiHedgedWeak(
    inputs(),
    controlledDependencies(clock, (input, signal) => {
      const item = deferred();
      pending.push(item);
      calls.push({ caseLabel: input.question.question_id, signal });
      return item.promise;
    })
  );
  await flush();
  assert.deepEqual(calls.map((call) => call.caseLabel), ["email_weak"]);
  clock.fireDelay(60_000);
  await flush();
  assert.deepEqual(calls.map((call) => call.caseLabel), [
    "email_weak",
    "email_weak"
  ]);
  clock.setTime(100000);
  pending[1].resolve(response("email_weak"));
  await flush();
  assert.deepEqual(calls.map((call) => call.caseLabel), [
    "email_weak",
    "email_weak",
    "ad_weak"
  ]);
  clock.fireDelay(60_000);
  await flush();
  assert.deepEqual(calls.map((call) => call.caseLabel), [
    "email_weak",
    "email_weak",
    "ad_weak",
    "ad_weak"
  ]);
  clock.setTime(200000);
  pending[3].resolve(response("ad_weak"));
  const results = await benchmarkPromise;
  assert.equal(calls.length, 4);
  assert.ok(results.every((result) => result.requests_started === 2));
  assert.ok(calls[0].signal.aborted);
  assert.ok(calls[2].signal.aborted);
});

test("mock OpenRouter requests use identical production messages and strict v2.2 high", async () => {
  const bodies = [];
  const benchmarkInputs = inputs();
  const results = await benchmarkWritingReviewKimiHedgedWeak(
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
          modelOverride: WRITING_REVIEW_KIMI_HEDGED_WEAK_MODEL,
          reasoningEffort: WRITING_REVIEW_KIMI_HEDGED_WEAK_EFFORT,
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
  assert.equal(bodies.length, 2);
  assert.ok(results.every((result) => result.requests_started === 1));
  assert.deepEqual(
    bodies.map((body) => body.messages),
    benchmarkInputs.map((input) => buildWritingReviewMessages(input))
  );
  assert.ok(bodies.every((body) => body.model === "moonshotai/kimi-k3"));
  assert.ok(bodies.every((body) => body.reasoning.effort === "high"));
  assert.ok(
    bodies.every((body) => body.response_format.json_schema.strict === true)
  );
  assert.ok(bodies.every((body) => body.provider.require_parameters === true));
});

test("baseline reader and aggregate exclude timeouts from successful median", () => {
  assert.deepEqual(
    WRITING_REVIEW_KIMI_HEDGED_BASELINE_SOURCES.map((source) => source.run),
    [
      "historical_reasoning_stability",
      "current_prompt_round1",
      "weak_retest"
    ]
  );
  const runs = [
    baseline("email_weak", "historical_reasoning_stability", "timeout"),
    baseline("email_weak", "current_prompt_round1", "success", {
      elapsed_ms: 100000,
      cost: 0.08,
      reasoning_tokens: 2000
    }),
    baseline("email_weak", "weak_retest", "success", {
      elapsed_ms: 180000,
      cost: 0.12,
      reasoning_tokens: 4000
    })
  ];
  const summary = buildWritingReviewKimiSingleBaselineSummary(runs);
  assert.equal(summary.run_count, 3);
  assert.equal(summary.success_count, 2);
  assert.equal(summary.timeout_count, 1);
  assert.equal(summary.success_rate, 2 / 3);
  assert.deepEqual(summary.successful_elapsed_times_ms, [100000, 180000]);
  assert.equal(summary.successful_median_elapsed_ms, 140000);
  assert.deepEqual(summary.successful_costs, [0.08, 0.12]);
  assert.deepEqual(summary.successful_reasoning_tokens, [2000, 4000]);
  assert.equal(
    baseline("email_weak", "weak_retest", "success", {
      model: "wrong-model"
    }),
    null
  );
});

test("summary, writer, and Markdown record baseline and one hedged observation", async () => {
  const clock = new ManualClock();
  const results = await benchmarkWritingReviewKimiHedgedWeak(
    inputs(),
    controlledDependencies(clock, async (input) =>
      response(input.question.question_id)
    )
  );
  const history = baselines();
  const summary = buildWritingReviewKimiHedgedWeakSummary(results, history);
  assert.equal(summary.single_request_recalled, false);
  assert.equal(summary.hedged_observations_per_case, 1);
  assert.equal(summary.cases[0].single_request_baseline.timeout_count, 2);
  assert.equal(
    summary.cases[0].hedged_minus_single_success_median_elapsed_ms,
    -180000
  );
  const files = new Map();
  writeWritingReviewKimiHedgedWeakFiles(
    "/safe/hedged",
    results,
    history,
    {
      mkdirSync(directory, options) {
        assert.equal(directory, "/safe/hedged");
        assert.deepEqual(options, { recursive: true });
      },
      writeFileSync(file, content, options) {
        assert.equal(options.mode, 0o600);
        files.set(file, String(content));
      }
    }
  );
  assert.equal(
    WRITING_REVIEW_KIMI_HEDGED_WEAK_OUTPUT_DIR,
    "tmp/writing-review-kimi-hedged-weak"
  );
  assert.deepEqual(Array.from(files.keys()).sort(), [
    path.join("/safe/hedged", "ad-weak.json"),
    path.join("/safe/hedged", "comparison.md"),
    path.join("/safe/hedged", "email-weak.json"),
    path.join("/safe/hedged", "summary.json")
  ]);
  const detail = JSON.parse(
    files.get(path.join("/safe/hedged", "email-weak.json"))
  );
  assert.equal(detail.validated_result.schema_version, "2.2");
  const markdown = files.get(path.join("/safe/hedged", "comparison.md"));
  assert.match(
    markdown,
    /^# Kimi K3 High — Single Request vs 60s Hedged Request/m
  );
  assert.match(markdown, /### Single-request history/);
  assert.match(markdown, /### Hedged run/);
  assert.match(markdown, /observed_completed_total_cost/);
  assert.match(markdown, /Single-request timeouts: 2\/3/);
  assert.match(markdown, /one hedged observation/);
  assert.match(markdown, /No automatic conclusion/);
});

test("CLI is isolated, reads all baselines, and does not log sensitive input", () => {
  const root = path.resolve(__dirname, "..");
  const script = fs.readFileSync(
    path.join(root, "scripts/benchmark-writing-review-kimi-hedged-weak.ts"),
    "utf8"
  );
  const moduleSource = fs.readFileSync(
    path.join(root, "lib/writingReviewKimiHedgedWeakBenchmark.ts"),
    "utf8"
  );
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(root, "package.json"), "utf8")
  );
  const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  assert.equal(
    packageJson.scripts["benchmark:writing-kimi-hedged-weak"],
    "node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --env-file-if-exists=.env.local --experimental-strip-types scripts/benchmark-writing-review-kimi-hedged-weak.ts"
  );
  assert.match(gitignore, /\/tmp\/writing-review-kimi-hedged-weak\//);
  assert.match(script, /WRITING_REVIEW_KIMI_HEDGED_BASELINE_SOURCES/);
  assert.match(script, /loadWritingReviewComparisonSource/);
  assert.match(script, /requestOpenRouterWritingReview/);
  assert.match(script, /AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA/);
  assert.match(script, /parseAIReviewRawResultV22ForResponse/);
  assert.match(
    script,
    /console\.log\(`Starting \$\{input\.caseLabel\}: \$\{request\}`\)/
  );
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

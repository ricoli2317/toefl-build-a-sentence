const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  EMPTY_OPENROUTER_USAGE,
  OpenRouterWritingReviewError
} = require("../lib/openrouterWritingReview.ts");
const {
  requestProductionWritingReviewHedged,
  WRITING_REVIEW_PRODUCTION_MODEL,
  WRITING_REVIEW_PRODUCTION_REASONING,
  WRITING_REVIEW_PRODUCTION_RETRY
} = require("../lib/writingReviewProductionHedge.ts");
const {
  WRITING_REVIEW_HEDGE_DEADLINE_MS,
  WRITING_REVIEW_HEDGE_DELAY_MS
} = require("../lib/writingReviewHedgedRequest.ts");
const {
  parseAIReviewRawResultV22,
  parseAIReviewRawResultV22ForResponse
} = require("../lib/writingReviewSchemaV22.ts");
const {
  generateAndSaveWritingReview
} = require("../lib/writingReviewGeneration.ts");
const {
  regenerateFullWritingReview
} = require("../lib/writingReviewFullRegeneration.ts");

const responseText = "I am write today.";
const input = {
  taskType: "email",
  question: { question_id: "q1" },
  responseText
};

function rawReview(overrides = {}) {
  const dimension = { ai_score: 3, ai_basis: "中文评分依据。" };
  return {
    schema_version: "2.2",
    task_type: "email",
    language_edits: [
      {
        edit_id: "edit-1",
        original_text: "am write",
        replacement_text: "am writing",
        category: "grammar",
        severity: "major",
        explanation: "需要修正语法。"
      }
    ],
    scores: {
      official_score: { ai_score: 3, rationale: "中文整体依据。" },
      dimension_scores: {
        communicative_purpose_and_elaboration: dimension,
        syntactic_range_and_word_choice: dimension,
        social_conventions: dimension,
        lexical_and_grammatical_control: dimension
      }
    },
    content_feedback: [
      {
        feedback_id: "feedback-1",
        category: "elaboration",
        original_sentence: responseText,
        issue: "展开不足。",
        suggestion: "补充细节。",
        proposed_revision: "I am writing today to explain my request."
      }
    ],
    overall_feedback: "中文总体评价。",
    ...overrides
  };
}

function usage(cost) {
  return {
    ...EMPTY_OPENROUTER_USAGE,
    prompt_tokens: 100,
    completion_tokens: 200,
    reasoning_tokens: 150,
    total_tokens: 300,
    cost
  };
}

function response(options = {}) {
  return {
    content: options.content ?? JSON.stringify(options.review ?? rawReview()),
    model: WRITING_REVIEW_PRODUCTION_MODEL,
    usage: options.usage ?? usage(0.02)
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
  time = 0;
  nextId = 1;
  timers = [];

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

  fireDelay(delayMs) {
    const timer = this.timers.find(
      (candidate) =>
        !candidate.cancelled &&
        !candidate.fired &&
        candidate.delayMs === delayMs
    );
    assert.ok(timer, `missing active ${delayMs}ms timer`);
    this.time = Math.max(this.time, timer.dueAt);
    timer.fired = true;
    timer.callback();
  }
}

async function flush() {
  for (let index = 0; index < 12; index += 1) await Promise.resolve();
}

function productionDependencies(requestAI, clock, onComplete) {
  return {
    requestAI,
    parseRawReview: parseAIReviewRawResultV22,
    parseReview: parseAIReviewRawResultV22ForResponse,
    ...(clock
      ? {
          now: clock.now,
          setTimeoutImpl: clock.setTimeout,
          clearTimeoutImpl: clock.clearTimeout
        }
      : {}),
    ...(onComplete ? { onComplete } : {})
  };
}

test("production hedge configuration is domestic Kimi K3 high, 60s, 240s, retry zero", () => {
  assert.equal(WRITING_REVIEW_PRODUCTION_MODEL, "kimi-k3");
  assert.equal(WRITING_REVIEW_PRODUCTION_REASONING, "high");
  assert.equal(WRITING_REVIEW_PRODUCTION_RETRY, 0);
  assert.equal(WRITING_REVIEW_HEDGE_DELAY_MS, 60_000);
  assert.equal(WRITING_REVIEW_HEDGE_DEADLINE_MS, 240_000);
});

test("primary success before 60s does not start a hedge", async () => {
  const calls = [];
  let telemetry;
  const result = await requestProductionWritingReviewHedged(
    input,
    productionDependencies(async (_input, signal) => {
      calls.push(signal);
      return response();
    }, null, (value) => {
      telemetry = value;
    })
  );
  assert.equal(result.review.schema_version, "2.2");
  assert.equal(calls.length, 1);
  assert.equal(telemetry.hedge_triggered, false);
  assert.equal(telemetry.requests_started, 1);
  assert.equal(telemetry.winner, "primary");
});

test("60s pending starts hedge; primary winner aborts hedge", async () => {
  const clock = new ManualClock();
  const requests = [deferred(), deferred()];
  const signals = [];
  const run = requestProductionWritingReviewHedged(
    input,
    productionDependencies((_input, signal) => {
      signals.push(signal);
      return requests[signals.length - 1].promise;
    }, clock)
  );
  assert.equal(signals.length, 1);
  clock.fireDelay(60_000);
  await flush();
  assert.equal(signals.length, 2);
  requests[0].resolve(response({ usage: usage(0.01) }));
  const result = await run;
  assert.equal(result.telemetry.winner, "primary");
  assert.equal(result.telemetry.loser_status, "aborted_due_to_winner");
  assert.equal(signals[1].aborted, true);
  assert.equal(result.telemetry.hedge_cost, null);
});

test("hedge winner aborts primary", async () => {
  const clock = new ManualClock();
  const requests = [deferred(), deferred()];
  const signals = [];
  const run = requestProductionWritingReviewHedged(
    input,
    productionDependencies((_input, signal) => {
      signals.push(signal);
      return requests[signals.length - 1].promise;
    }, clock)
  );
  clock.fireDelay(60_000);
  await flush();
  requests[1].resolve(response());
  const result = await run;
  assert.equal(result.telemetry.winner, "hedge");
  assert.equal(signals[0].aborted, true);
  assert.equal(result.telemetry.primary_cost, null);
});

test("a post-hedge strict localization failure retains cost and waits for success", async () => {
  const clock = new ManualClock();
  const primary = deferred();
  const hedge = deferred();
  const requests = [primary, hedge];
  let call = 0;
  let settled = false;
  const run = requestProductionWritingReviewHedged(
    input,
    productionDependencies(() => requests[call++].promise, clock)
  );
  run.finally(() => {
    settled = true;
  });
  clock.fireDelay(60_000);
  await flush();
  primary.resolve(
    response({
      review: rawReview({
        language_edits: [
          {
            edit_id: "bad-location",
            original_text: "missing source text",
            replacement_text: "replacement",
            category: "grammar",
            severity: "major",
            explanation: "定位应失败。"
          }
        ]
      }),
      usage: usage(0.01)
    })
  );
  await flush();
  assert.equal(settled, false);
  hedge.resolve(response({ usage: usage(0.02) }));
  const result = await run;
  assert.equal(result.telemetry.primary_result, "localization_error");
  assert.equal(result.telemetry.winner, "hedge");
  assert.equal(result.telemetry.observed_completed_cost, 0.03);
});

test("primary terminal failure before 60s does not start hedge", async () => {
  let calls = 0;
  let telemetry;
  await assert.rejects(
    requestProductionWritingReviewHedged(
      input,
      productionDependencies(async () => {
        calls += 1;
        return response({ content: "not-json", usage: usage(0.01) });
      }, null, (value) => {
        telemetry = value;
      })
    ),
    (error) => error.code === "AI_RESPONSE_INVALID"
  );
  assert.equal(calls, 1);
  assert.equal(telemetry.hedge_triggered, false);
  assert.equal(telemetry.primary_result, "invalid_json");
});

test("240s deadline is shared by primary and hedge and aborts both", async () => {
  const clock = new ManualClock();
  const signals = [];
  const run = requestProductionWritingReviewHedged(
    input,
    productionDependencies((_input, signal) => {
      signals.push(signal);
      return new Promise(() => {});
    }, clock)
  );
  clock.fireDelay(60_000);
  await flush();
  clock.fireDelay(240_000);
  await assert.rejects(
    run,
    (error) =>
      error instanceof OpenRouterWritingReviewError &&
      error.code === "AI_REQUEST_TIMEOUT" &&
      error.status === 504
  );
  assert.equal(signals.length, 2);
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, true);
  assert.equal(clock.time, 240_000);
});

test("generate writes once only after the fully validated hedge winner", async () => {
  const clock = new ManualClock();
  const primary = deferred();
  const hedge = deferred();
  const requests = [primary, hedge];
  let requestIndex = 0;
  let inserts = 0;
  const generated = generateAndSaveWritingReview("attempt-1", {
    repository: {
      async findAttempt() {
        return {
          attempt_id: "attempt-1",
          task_type: "email",
          question_id: "q1",
          response_text: responseText,
          status: "submitted"
        };
      },
      async findExistingReview() {
        return null;
      },
      async findQuestion() {
        return { question_id: "q1" };
      },
      async insertReview() {
        inserts += 1;
        return { review_id: "review-1" };
      }
    },
    requestAI: async (requestInput) => {
      const result = await requestProductionWritingReviewHedged(
        requestInput,
        productionDependencies(() => requests[requestIndex++].promise, clock)
      );
      return result.response;
    },
    parseReview: parseAIReviewRawResultV22ForResponse
  });
  await flush();
  clock.fireDelay(60_000);
  await flush();
  primary.resolve(response({ content: "not-json" }));
  await flush();
  assert.equal(inserts, 0);
  hedge.resolve(response());
  await generated;
  assert.equal(inserts, 1);
});

test("regenerate hedge failure preserves the old working review and published snapshot", async () => {
  const oldReview = {
    language_edits: [{ edit_id: "old-working" }],
    published_language_edits: [{ edit_id: "old-published" }],
    published_at: "2026-08-13T08:00:00.000Z"
  };
  let updates = 0;
  let requests = 0;
  await assert.rejects(
    regenerateFullWritingReview("attempt-1", {
      repository: {
        async findAttempt() {
          return {
            attempt_id: "attempt-1",
            task_type: "email",
            question_id: "q1",
            response_text: responseText,
            status: "submitted"
          };
        },
        async findReview() {
          return { review_id: "review-1", status: "published" };
        },
        async findQuestion() {
          return { question_id: "q1" };
        },
        async updateWorkingReview() {
          updates += 1;
          return { review_id: "review-1" };
        }
      },
      requestAI: async (requestInput) => {
        const result = await requestProductionWritingReviewHedged(
          requestInput,
          productionDependencies(async () => {
            requests += 1;
            return response({ content: "not-json", usage: usage(0.01) });
          })
        );
        return result.response;
      },
      parseReview: parseAIReviewRawResultV22ForResponse
    }),
    (error) => error.code === "AI_RESPONSE_INVALID"
  );
  assert.equal(requests, 1);
  assert.equal(updates, 0);
  assert.deepEqual(oldReview.language_edits, [{ edit_id: "old-working" }]);
  assert.deepEqual(oldReview.published_language_edits, [
    { edit_id: "old-published" }
  ]);
  assert.equal(oldReview.published_at, "2026-08-13T08:00:00.000Z");
});

test("only full-review routes use hedge; feedback regenerate remains single request", () => {
  const root = process.cwd();
  const generate = fs.readFileSync(
    path.join(root, "app/api/teacher/writing/reviews/[attemptId]/generate-ai/route.ts"),
    "utf8"
  );
  const regenerate = fs.readFileSync(
    path.join(root, "app/api/teacher/writing/reviews/[attemptId]/regenerate-ai/route.ts"),
    "utf8"
  );
  const feedback = fs.readFileSync(
    path.join(root, "app/api/teacher/writing/reviews/[attemptId]/feedback/[feedbackId]/regenerate/route.ts"),
    "utf8"
  );
  for (const source of [generate, regenerate]) {
    assert.match(source, /requestProductionWritingReviewHedged/);
    assert.match(source, /WRITING_REVIEW_PRODUCTION_MODEL/);
    assert.match(source, /WRITING_REVIEW_PRODUCTION_REASONING/);
    assert.match(source, /getWritingReviewProviderConfig/);
    assert.match(source, /requestWritingReview\(providerConfig, requestInput/);
    assert.match(source, /reasoningEffort: WRITING_REVIEW_PRODUCTION_REASONING/);
    assert.match(source, /AI_REVIEW_RAW_RESULT_V22_JSON_SCHEMA/);
    assert.match(source, /parseAIReviewRawResultV22ForResponse/);
  }
  assert.doesNotMatch(feedback, /requestProductionWritingReviewHedged/);
  assert.match(feedback, /getWritingReviewProviderConfig/);
  assert.match(feedback, /requestWritingReviewStructuredOutput/);
  assert.match(feedback, /WRITING_FEEDBACK_REQUEST_TIMEOUT_MS/);
});

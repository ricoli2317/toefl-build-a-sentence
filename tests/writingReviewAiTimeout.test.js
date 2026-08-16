const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  OpenRouterWritingReviewError,
  WRITING_FEEDBACK_REQUEST_TIMEOUT_MS,
  WRITING_REVIEW_FULL_REQUEST_TIMEOUT_MS,
  requestOpenRouterWithTimeout,
  requestOpenRouterWritingReview
} = require("../lib/openrouterWritingReview.ts");
const {
  classifyWritingReviewAiError,
  logWritingReviewAi,
  writingReviewAiLogDatabaseRow
} = require("../lib/writingReviewAiLog.ts");

function controlledTimers() {
  let callback = null;
  const cleared = [];
  const timer = { id: "timer" };
  return {
    timer,
    cleared,
    fire() { callback?.(); },
    setTimeoutImpl(next) { callback = next; return timer; },
    clearTimeoutImpl(value) { cleared.push(value); }
  };
}

test("production timeout constants are four minutes and two minutes", () => {
  assert.equal(WRITING_REVIEW_FULL_REQUEST_TIMEOUT_MS, 240_000);
  assert.equal(WRITING_FEEDBACK_REQUEST_TIMEOUT_MS, 120_000);
});

test("request before deadline succeeds once and clears timer", async () => {
  const timers = controlledTimers();
  let calls = 0;
  const result = await requestOpenRouterWithTimeout(
    async (signal) => {
      calls += 1;
      assert.equal(signal.aborted, false);
      return "ok";
    },
    {
      timeoutMs: 240_000,
      timeoutMessage: "timeout",
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl
    }
  );
  assert.equal(result, "ok");
  assert.equal(calls, 1);
  assert.deepEqual(timers.cleared, [timers.timer]);
});

test("ordinary provider error is not mislabeled timeout and clears timer", async () => {
  const timers = controlledTimers();
  const providerError = new Error("provider failed");
  await assert.rejects(
    requestOpenRouterWithTimeout(
      async () => { throw providerError; },
      {
        timeoutMs: 240_000,
        timeoutMessage: "timeout",
        setTimeoutImpl: timers.setTimeoutImpl,
        clearTimeoutImpl: timers.clearTimeoutImpl
      }
    ),
    (error) => error === providerError
  );
  assert.deepEqual(timers.cleared, [timers.timer]);
});

test("hard timeout aborts signal, returns 504, clears timer, and never retries", async () => {
  const timers = controlledTimers();
  let calls = 0;
  let receivedSignal = null;
  const pending = requestOpenRouterWithTimeout(
    (signal) => {
      calls += 1;
      receivedSignal = signal;
      return new Promise(() => {});
    },
    {
      timeoutMs: 240_000,
      timeoutMessage: "AI 初批生成超时，请稍后重试。",
      setTimeoutImpl: timers.setTimeoutImpl,
      clearTimeoutImpl: timers.clearTimeoutImpl
    }
  );
  timers.fire();
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "AI_REQUEST_TIMEOUT");
    assert.equal(error.status, 504);
    assert.equal(error.message, "AI 初批生成超时，请稍后重试。");
    return true;
  });
  assert.equal(receivedSignal.aborted, true);
  assert.equal(calls, 1);
  assert.deepEqual(timers.cleared, [timers.timer]);
});

test("timeout wrapper passes its AbortSignal into the underlying fetch", async () => {
  let capturedSignal = null;
  const response = await requestOpenRouterWritingReview(
    { taskType: "email", question: {}, responseText: "Response." },
    {
      env: { OPENROUTER_API_KEY: "mock-secret", OPENROUTER_WRITING_MODEL: "moonshotai/kimi-k3" },
      jsonSchema: {},
      timeoutMs: 240_000,
      fetchImpl: async (_url, init) => {
        capturedSignal = init.signal;
        return Response.json({ choices: [{ message: { content: "{}" } }] });
      }
    }
  );
  assert.equal(response.model, "moonshotai/kimi-k3");
  assert.ok(capturedSignal instanceof AbortSignal);
  assert.equal(capturedSignal.aborted, false);
});

test("AI timeout error is classified without leaking sensitive request data", () => {
  const timeout = new OpenRouterWritingReviewError(
    "AI_REQUEST_TIMEOUT",
    "AI 初批生成超时，请稍后重试。",
    504
  );
  assert.equal(classifyWritingReviewAiError(timeout), "timeout");
  assert.equal(classifyWritingReviewAiError(new Error("other")), "invalid_ai_response");

  const calls = [];
  const originalInfo = console.info;
  console.info = (...arguments_) => calls.push(arguments_);
  try {
    logWritingReviewAi({
      request_id: "11111111-1111-4111-8111-111111111111",
      operation: "full_regenerate",
      attempt_id: "attempt-1",
      task_type: "academic_discussion",
      model: "moonshotai/kimi-k3",
      prompt_version: "writing_review_prompt_test",
      schema_version: "2.2",
      status: "failed",
      pipeline_stage: "provider_request",
      error_type: "timeout",
      error_code: "AI_REQUEST_TIMEOUT",
      elapsed_ms: 240_104,
    });
  } finally {
    console.info = originalInfo;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "[writing-review-ai]");
  assert.equal(calls[0][1].request_id, "11111111-1111-4111-8111-111111111111");
  assert.equal(calls[0][1].status, "failed");
  assert.equal(calls[0][1].pipeline_stage, "provider_request");
  assert.equal(calls[0][1].error_code, "AI_REQUEST_TIMEOUT");
  assert.equal(calls[0][1].total_tokens, null);
  assert.equal(calls[0][1].cost, null);
  const serialized = JSON.stringify(calls);
  assert.doesNotMatch(serialized, /mock-secret|Authorization|response_text|original_question|"prompt"\s*:/);
});

test("AI persistence projection records provider usage without logging content", () => {
  const row = writingReviewAiLogDatabaseRow({
      request_id: "22222222-2222-4222-8222-222222222222",
      operation: "generate_ai",
      attempt_id: "attempt-usage",
      task_type: "email",
      model: "moonshotai/kimi-k3",
      prompt_version: "writing_review_prompt_test",
      schema_version: "2.2",
      status: "success",
      pipeline_stage: "review_persistence",
      elapsed_ms: 183421,
      prompt_tokens: 2450,
      completion_tokens: 5120,
      reasoning_tokens: 4300,
      accepted_prediction_tokens: 12,
      rejected_prediction_tokens: 2,
      cached_tokens: 800,
      total_tokens: 7570,
      cost: 0.004321098765,
      upstream_inference_cost: 0.0039,
      upstream_inference_prompt_cost: 0.0007,
      upstream_inference_completions_cost: 0.0032,
      hedge_triggered: true,
      requests_started: 2,
      winner: "hedge",
      end_to_end_elapsed_ms: 183421,
      primary_result: "validation_error",
      primary_elapsed_ms: 170000,
      primary_cost: 0.001,
      hedge_result: "success",
      hedge_elapsed_ms: 123421,
      hedge_cost: 0.004321098765,
      loser_status: "terminal_failure",
      winner_cost: 0.004321098765,
      observed_completed_cost: 0.005321098765,
      provider_response: { response_text: "must not be logged" }
    });
  assert.equal(row.prompt_tokens, 2450);
  assert.equal(row.completion_tokens, 5120);
  assert.equal(row.total_tokens, 7570);
  assert.equal(row.reasoning_tokens, 4300);
  assert.equal(row.cached_tokens, 800);
  assert.equal(row.cost, 0.004321098765);
  assert.equal(row.upstream_inference_cost, 0.0039);
  assert.equal(row.hedge_triggered, true);
  assert.equal(row.requests_started, 2);
  assert.equal(row.winner, "hedge");
  assert.equal(row.observed_completed_cost, 0.005321098765);
  assert.equal("provider_response" in row, false);
  assert.doesNotMatch(JSON.stringify(row), /response_text|original_question|"prompt"\s*:|Authorization/);
});

test("full routes use shared hedge while feedback keeps its single timeout and safe logs", () => {
  const root = process.cwd();
  const generate = fs.readFileSync(path.join(root, "app/api/teacher/writing/reviews/[attemptId]/generate-ai/route.ts"), "utf8");
  const regenerate = fs.readFileSync(path.join(root, "app/api/teacher/writing/reviews/[attemptId]/regenerate-ai/route.ts"), "utf8");
  const feedback = fs.readFileSync(path.join(root, "app/api/teacher/writing/reviews/[attemptId]/feedback/[feedbackId]/regenerate/route.ts"), "utf8");
  assert.match(generate, /requestProductionWritingReviewHedged/);
  assert.match(generate, /WRITING_REVIEW_PRODUCTION_MODEL/);
  assert.match(generate, /WRITING_REVIEW_PRODUCTION_REASONING/);
  assert.match(generate, /operation: "generate_ai"/);
  assert.match(regenerate, /requestProductionWritingReviewHedged/);
  assert.match(regenerate, /WRITING_REVIEW_PRODUCTION_MODEL/);
  assert.match(regenerate, /WRITING_REVIEW_PRODUCTION_REASONING/);
  assert.match(regenerate, /operation: "full_regenerate"/);
  assert.match(feedback, /WRITING_FEEDBACK_REQUEST_TIMEOUT_MS/);
  assert.doesNotMatch(feedback, /requestProductionWritingReviewHedged/);
  assert.match(feedback, /operation: "feedback_regenerate"/);
  for (const source of [generate, regenerate, feedback]) {
    assert.match(source, /\.\.\.aiUsage/);
    assert.doesNotMatch(source, /setTimeout\(/);
    assert.doesNotMatch(source, /response_text|Authorization|OPENROUTER_API_KEY/);
  }
});

test("frontends restore loading state and preserve local content after timeout", () => {
  const root = process.cwd();
  const list = fs.readFileSync(path.join(root, "components/teacher/TeacherWritingReviewList.tsx"), "utf8");
  const workspace = fs.readFileSync(path.join(root, "components/teacher/TeacherWritingReviewWorkspace.tsx"), "utf8");
  assert.doesNotMatch(list, /generate-ai|AI_REQUEST_TIMEOUT|setStatusOverrides/);
  assert.match(workspace, /async function regenerateAll\(\)[\s\S]*finally[\s\S]*setOperation\(null\)/);
  assert.match(workspace, /generateInitialReview/);
  assert.match(workspace, /const result = await regenerateFeedback[\s\S]*catch[\s\S]*finally[\s\S]*setRegenerating\(false\)/);
  assert.doesNotMatch(workspace, /catch \(error\)[\s\S]{0,180}setPrompt\(""\)/);
});

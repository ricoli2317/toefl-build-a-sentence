const test = require("node:test");
const assert = require("node:assert/strict");
const {
  MOONSHOT_CHAT_COMPLETIONS_URL,
  MOONSHOT_WRITING_REVIEW_MODEL,
  MoonshotWritingReviewError,
  requestMoonshotWithTimeout,
  requestMoonshotWritingReview
} = require("../lib/moonshotWritingReview.ts");

function input() {
  return {
    taskType: "academic_discussion",
    question: {
      professor_name: "Dr. Hall",
      professor_prompt: "Are teenage years crucial?",
      student_1_name: "Ana",
      student_1_response: "Yes.",
      student_2_name: "Ben",
      student_2_response: "No."
    },
    responseText: "Teenage years are crucial because growth environments matter."
  };
}

function completion(usage) {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: '{"schema_version":"2.2"}' } }],
      ...(usage === undefined ? {} : { usage })
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
}

test("Moonshot client sends max/high as top-level reasoning_effort with strict v2.2 schema", async () => {
  const requests = [];
  const schema = { type: "object", properties: { schema_version: { const: "2.2" } } };
  for (const reasoningEffort of ["max", "high"]) {
    await requestMoonshotWritingReview(input(), {
      env: { MOONSHOT_API_KEY: "test-key" },
      jsonSchema: schema,
      reasoningEffort,
      async fetchImpl(url, init) {
        requests.push({ url, init, body: JSON.parse(init.body) });
        return completion({ prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 });
      }
    });
  }

  assert.equal(requests.length, 2);
  for (const [index, request] of requests.entries()) {
    assert.equal(request.url, "https://api.moonshot.cn/v1/chat/completions");
    assert.equal(request.url, MOONSHOT_CHAT_COMPLETIONS_URL);
    assert.equal(request.body.model, "kimi-k3");
    assert.equal(request.body.model, MOONSHOT_WRITING_REVIEW_MODEL);
    assert.equal(request.body.stream, false);
    assert.equal(request.body.reasoning_effort, index === 0 ? "max" : "high");
    assert.equal("reasoning" in request.body, false);
    assert.equal("provider" in request.body, false);
    assert.deepEqual(request.body.response_format, {
      type: "json_schema",
      json_schema: {
        name: "tps_writing_review",
        strict: true,
        schema
      }
    });
    const messages = JSON.stringify(request.body.messages);
    assert.match(messages, /WORD CHOICE & COLLOCATION AUDIT/);
    assert.match(messages, /teenage years are crucial/i);
    assert.match(messages, /growth environments/i);
  }
});

test("Moonshot client requires its own API key and never falls back", async () => {
  let called = false;
  await assert.rejects(
    requestMoonshotWritingReview(input(), {
      env: { MOONSHOT_API_KEY: "" },
      jsonSchema: {},
      reasoningEffort: "max",
      async fetchImpl() {
        called = true;
        return completion();
      }
    }),
    (error) => {
      assert.equal(error.code, "MOONSHOT_API_KEY_MISSING");
      assert.equal(error.message, "MOONSHOT_API_KEY is not configured in .env.local");
      return true;
    }
  );
  assert.equal(called, false);
});

test("Moonshot client extracts available compatible usage and cost without calculating", async () => {
  const response = await requestMoonshotWritingReview(input(), {
    env: { MOONSHOT_API_KEY: "test-key" },
    jsonSchema: {},
    reasoningEffort: "high",
    async fetchImpl() {
      return completion({
        prompt_tokens: 100,
        completion_tokens: 80,
        total_tokens: 180,
        cost: 0,
        prompt_tokens_details: { cached_tokens: 12 },
        completion_tokens_details: {
          reasoning_tokens: 50,
          accepted_prediction_tokens: 7,
          rejected_prediction_tokens: 2
        },
        cost_details: {
          upstream_inference_cost: 0.00123456789,
          upstream_inference_prompt_cost: 0.0002,
          upstream_inference_completions_cost: 0.00103456789,
          ignored_private_field: "not copied"
        }
      });
    }
  });

  assert.deepEqual(response.usage, {
    prompt_tokens: 100,
    cached_tokens: 12,
    completion_tokens: 80,
    reasoning_tokens: 50,
    accepted_prediction_tokens: 7,
    rejected_prediction_tokens: 2,
    total_tokens: 180,
    cost: 0,
    upstream_inference_cost: 0.00123456789,
    upstream_inference_prompt_cost: 0.0002,
    upstream_inference_completions_cost: 0.00103456789
  });
});

test("Moonshot client tolerates a missing usage object", async () => {
  const response = await requestMoonshotWritingReview(input(), {
    env: { MOONSHOT_API_KEY: "test-key" },
    jsonSchema: {},
    reasoningEffort: "max",
    async fetchImpl() {
      return completion();
    }
  });
  assert.ok(Object.values(response.usage).every((value) => value === null));
});

test("Moonshot timeout aborts one request at 240 seconds and clears its timer", async () => {
  let scheduledMs = null;
  let timeoutCallback = null;
  let cleared = false;
  let receivedSignal = null;
  const pending = requestMoonshotWithTimeout(
    (signal) => {
      receivedSignal = signal;
      return new Promise(() => {});
    },
    {
      timeoutMs: 240_000,
      timeoutMessage: "Moonshot max benchmark timed out.",
      setTimeoutImpl(callback, milliseconds) {
        timeoutCallback = callback;
        scheduledMs = milliseconds;
        return { fake: true };
      },
      clearTimeoutImpl() {
        cleared = true;
      }
    }
  );
  assert.equal(scheduledMs, 240_000);
  assert.equal(receivedSignal.aborted, false);
  timeoutCallback();
  await assert.rejects(pending, (error) => {
    assert.ok(error instanceof MoonshotWritingReviewError);
    assert.equal(error.code, "AI_REQUEST_TIMEOUT");
    return true;
  });
  assert.equal(receivedSignal.aborted, true);
  assert.equal(cleared, true);
});

test("Moonshot provider failures expose only safe status context", async () => {
  await assert.rejects(
    requestMoonshotWritingReview(input(), {
      env: { MOONSHOT_API_KEY: "test-key" },
      jsonSchema: {},
      reasoningEffort: "max",
      async fetchImpl() {
        return new Response("secret provider response", { status: 429 });
      }
    }),
    (error) => {
      assert.equal(error.code, "MOONSHOT_REQUEST_FAILED");
      assert.equal(error.message, "Moonshot API returned HTTP 429.");
      assert.doesNotMatch(error.message, /secret provider response/);
      return true;
    }
  );
});

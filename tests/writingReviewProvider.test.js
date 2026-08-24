const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getWritingReviewProviderConfig,
  requestWritingReview,
  requestWritingReviewStructuredOutput
} = require("../lib/writingReviewProvider.ts");
const {
  requestProductionWritingReviewHedged
} = require("../lib/writingReviewProductionHedge.ts");
const {
  parseAIReviewRawResultV22,
  parseAIReviewRawResultV22ForResponse
} = require("../lib/writingReviewSchemaV22.ts");

function input(taskType) {
  return {
    taskType,
    question: { question_id: `${taskType}-question` },
    responseText: "I am writing today."
  };
}

function review(taskType) {
  const dimensions = taskType === "email"
    ? ["communicative_purpose_and_elaboration", "syntactic_range_and_word_choice", "social_conventions", "lexical_and_grammatical_control"]
    : ["relevance", "elaboration", "syntactic_range_and_word_choice", "lexical_and_grammatical_control"];
  return {
    schema_version: "2.2",
    task_type: taskType,
    language_edits: [],
    scores: {
      official_score: { ai_score: 4, rationale: "中文依据。" },
      dimension_scores: Object.fromEntries(dimensions.map((key) => [key, { ai_score: 4, ai_basis: "中文依据。" }]))
    },
    content_feedback: [],
    overall_feedback: "中文总体评价。"
  };
}

function completion(taskType) {
  return new Response(JSON.stringify({
    id: "test-generation",
    choices: [{ message: { content: JSON.stringify(review(taskType)) } }]
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("Moonshot is the default production provider with the domestic Kimi model", () => {
  assert.deepEqual(getWritingReviewProviderConfig({}), {
    provider: "moonshot",
    model: "kimi-k3",
    endpointHostname: "api.moonshot.cn"
  });
});

for (const taskType of ["email", "academic_discussion"]) {
  test(`${taskType} requests Moonshot directly by default`, async () => {
    const requests = [];
    const config = getWritingReviewProviderConfig({ MOONSHOT_API_KEY: "test-key" });
    await requestWritingReview(config, input(taskType), {
      env: { MOONSHOT_API_KEY: "test-key" },
      jsonSchema: { type: "object" },
      reasoningEffort: "high",
      async fetchImpl(url, init) {
        requests.push({ url, body: JSON.parse(init.body) });
        return completion(taskType);
      }
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "https://api.moonshot.cn/v1/chat/completions");
    assert.equal(requests[0].body.model, "kimi-k3");
    assert.equal(requests[0].body.reasoning_effort, "high");
    assert.equal("reasoning" in requests[0].body, false);
  });
}

test("a hedged production run keeps both branches on the selected Moonshot provider", async () => {
  const config = getWritingReviewProviderConfig({ MOONSHOT_API_KEY: "test-key" });
  const urls = [];
  const timers = [];
  let call = 0;
  let resolvePrimary;
  const primaryPending = new Promise((resolve) => { resolvePrimary = resolve; });
  const run = requestProductionWritingReviewHedged(input("email"), {
    requestAI: (requestInput, signal) => requestWritingReview(config, requestInput, {
      env: { MOONSHOT_API_KEY: "test-key" },
      jsonSchema: { type: "object" },
      reasoningEffort: "high",
      signal,
      async fetchImpl(url) {
        urls.push(url);
        call += 1;
        return call === 1 ? primaryPending : completion("email");
      }
    }),
    parseRawReview: parseAIReviewRawResultV22,
    parseReview: parseAIReviewRawResultV22ForResponse,
    now: () => 0,
    setTimeoutImpl(callback, delayMs) {
      const timer = { callback, delayMs, cancelled: false };
      timers.push(timer);
      return timer;
    },
    clearTimeoutImpl(timer) { timer.cancelled = true; }
  });
  await Promise.resolve();
  timers.find((timer) => timer.delayMs === 60_000).callback();
  await run;
  resolvePrimary(completion("email"));
  assert.deepEqual(urls, [
    "https://api.moonshot.cn/v1/chat/completions",
    "https://api.moonshot.cn/v1/chat/completions"
  ]);
});

test("manual OpenRouter selection keeps requests on OpenRouter", async () => {
  const config = getWritingReviewProviderConfig({
    WRITING_REVIEW_PROVIDER: "openrouter",
    OPENROUTER_WRITING_MODEL: "moonshotai/kimi-k3"
  });
  const urls = [];
  await requestWritingReview(config, input("email"), {
    env: {
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_WRITING_MODEL: "moonshotai/kimi-k3"
    },
    jsonSchema: { type: "object" },
    reasoningEffort: "high",
    async fetchImpl(url, init) {
      urls.push({ url, body: JSON.parse(init.body) });
      return completion("email");
    }
  });
  assert.equal(urls[0].url, "https://openrouter.ai/api/v1/chat/completions");
  assert.deepEqual(urls[0].body.reasoning, { effort: "high" });
  assert.equal("reasoning_effort" in urls[0].body, false);
});

test("manual DeepSeek Flash selection uses the official direct endpoint and tested C3 contract", async () => {
  const config = getWritingReviewProviderConfig({
    WRITING_REVIEW_PROVIDER: "deepseek_flash",
    DEEPSEEK_API_KEY: "test-key"
  });
  assert.deepEqual(config, {
    provider: "deepseek_flash",
    model: "deepseek-v4-flash",
    endpointHostname: "api.deepseek.com"
  });
  const requests = [];
  const response = await requestWritingReviewStructuredOutput(
    config,
    [{ role: "user", content: "Return a review." }],
    {
      env: { DEEPSEEK_API_KEY: "test-key" },
      jsonSchema: { type: "object", required: ["ok"] },
      schemaName: "tps_test",
      reasoningEffort: "high",
      async fetchImpl(url, init) {
        requests.push({ url, body: JSON.parse(init.body) });
        return new Response(JSON.stringify({
          id: "deepseek-generation",
          model: "deepseek-v4-flash",
          choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
          usage: {
            prompt_tokens: 10,
            prompt_cache_hit_tokens: 4,
            completion_tokens: 2,
            total_tokens: 12,
            completion_tokens_details: { reasoning_tokens: 1 }
          }
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
    }
  );
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(requests[0].body.model, "deepseek-v4-flash");
  assert.deepEqual(requests[0].body.thinking, { type: "enabled" });
  assert.equal(requests[0].body.reasoning_effort, "high");
  assert.deepEqual(requests[0].body.response_format, { type: "json_object" });
  assert.match(requests[0].body.messages.at(-1).content, /tps_test JSON Schema exactly/);
  assert.equal(response.generationId, "deepseek-generation");
  assert.equal(response.usage.cached_tokens, 4);
  assert.equal(response.usage.reasoning_tokens, 1);
  assert.equal(response.costObservability.currency, "CNY");
});

test("DeepSeek Flash missing configuration never falls back to Moonshot or OpenRouter", async () => {
  const config = getWritingReviewProviderConfig({
    WRITING_REVIEW_PROVIDER: "deepseek_flash"
  });
  let called = false;
  await assert.rejects(
    requestWritingReviewStructuredOutput(
      config,
      [{ role: "user", content: "Return JSON." }],
      {
        env: {},
        jsonSchema: { type: "object" },
        schemaName: "tps_test",
        reasoningEffort: "high",
        async fetchImpl() {
          called = true;
          return completion("email");
        }
      }
    ),
    (error) => error.code === "DEEPSEEK_API_KEY_MISSING"
  );
  assert.equal(called, false);
});

test("Moonshot configuration failures never call OpenRouter", async () => {
  const config = getWritingReviewProviderConfig({});
  let called = false;
  await assert.rejects(
    requestWritingReview(config, input("email"), {
      env: {}, jsonSchema: {}, reasoningEffort: "high",
      async fetchImpl() { called = true; return completion("email"); }
    }),
    (error) => error.code === "MOONSHOT_API_KEY_MISSING"
  );
  assert.equal(called, false);
});

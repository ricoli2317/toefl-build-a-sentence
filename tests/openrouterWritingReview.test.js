const test = require("node:test");
const assert = require("node:assert/strict");
const {
  buildWritingReviewMessages,
  requestOpenRouterWritingReview
} = require("../lib/openrouterWritingReview.ts");
const {
  AI_REVIEW_RAW_RESULT_JSON_SCHEMA,
  parseAIReviewRawResultForResponse
} = require("../lib/writingReviewSchema.ts");
const {
  generateAndSaveWritingReview
} = require("../lib/writingReviewGeneration.ts");
const {
  WRITING_REVIEW_COMPARISON_MODELS,
  WRITING_REVIEW_MODEL_TIMEOUT_MS,
  compareWritingReviewModels,
  parseWritingReviewComparisonArguments,
  resolveWritingReviewComparisonModel
} = require("../lib/writingReviewModelComparison.ts");
const {
  loadWritingReviewComparisonSource
} = require("../lib/writingReviewSource.ts");

const fixedDate = new Date("2026-08-13T08:00:00.000Z");
const emailResponse = "I am write to request more time.";

function emailQuestion() {
  return {
    question_id: "email-1",
    set_id: "email-set-1",
    set_title: "Email Set 1",
    year_month: "202608",
    source_labels: "official",
    scenario: "You need more time for an assignment.",
    task_instruction: "Write an email to your professor.",
    requirement_1: "Explain the situation.",
    requirement_2: "Request an extension.",
    requirement_3: "Suggest a new deadline.",
    closing_instruction: "Use an appropriate closing.",
    recipient: "Professor Lee",
    subject: "Assignment extension"
  };
}

function academicQuestion() {
  return {
    question_id: "discussion-1",
    set_id: "discussion-set-1",
    set_title: "Discussion Set 1",
    year_month: "202608",
    source_labels: "official",
    professor_name: "Dr. Lee",
    professor_prompt: "Should cities invest more in public transportation?",
    student_1_name: "Anna",
    student_1_response: "Yes, because it reduces traffic.",
    student_2_name: "Mark",
    student_2_response: "No, because roads are more flexible."
  };
}

function emailReview() {
  return {
    schema_version: "1.0",
    task_type: "email",
    language_edits: [
      {
        edit_id: "edit-1",
        start: 2,
        end: 10,
        original_text: "am write",
        replacement_text: "am writing",
        category: "grammar",
        severity: "moderate",
        explanation: "Use the present progressive after 'am'."
      }
    ],
    score: {
      rubric_score: 3,
      rationale: "The purpose is clear, but a noticeable error limits effectiveness."
    },
    rubric_analysis: {
      communicative_purpose_and_elaboration: "The request is clear but minimally developed.",
      syntax_and_word_choice: "The response uses a limited but adequate range.",
      social_conventions: "The request is appropriately polite.",
      lexical_and_grammatical_control: "A verb-form error affects fluency."
    },
    content_feedback: [
      {
        feedback_id: "feedback-1",
        category: "elaboration",
        issue: "The reason for needing more time is missing.",
        suggestion: "Briefly explain the reason for the request.",
        example: "I was ill for two days and could not finish the assignment."
      }
    ],
    overall_feedback: "A clear request that needs more detail and tighter language control."
  };
}

function academicReview() {
  return {
    schema_version: "1.0",
    task_type: "academic_discussion",
    language_edits: [],
    score: {
      rubric_score: 5,
      rationale: "The contribution is relevant, well developed, and consistently clear."
    },
    rubric_analysis: {
      relevance_and_elaboration: "The response directly answers and develops the question.",
      syntax_and_word_choice: "Varied structures and precise vocabulary express the ideas.",
      lexical_and_grammatical_control: "The response has almost no language errors."
    },
    content_feedback: [
      {
        feedback_id: "feedback-1",
        category: "discussion_contribution",
        issue: "A counterpoint could make the contribution richer.",
        suggestion: "Acknowledge one limitation before reinforcing the position.",
        example: "Although construction is costly, the long-term benefits justify it."
      }
    ],
    overall_feedback: "A focused and convincing discussion contribution."
  };
}

function rawReview(review = emailReview()) {
  const result = structuredClone(review);
  result.language_edits = result.language_edits.map(
    ({ start: _start, end: _end, ...edit }) => edit
  );
  return result;
}

function submittedAttempt(taskType = "email") {
  return {
    attempt_id: "attempt-1",
    task_type: taskType,
    question_id: taskType === "email" ? "email-1" : "discussion-1",
    response_text:
      taskType === "email"
        ? emailResponse
        : "Cities should invest in transit because it reduces congestion.",
    status: "submitted"
  };
}

function createHarness({
  attempt = submittedAttempt(),
  existingReview = null,
  question = emailQuestion(),
  aiContent = JSON.stringify(rawReview())
} = {}) {
  const calls = { ai: 0, insert: 0 };
  let inserted = null;
  const repository = {
    async findAttempt() {
      return attempt;
    },
    async findExistingReview() {
      return existingReview;
    },
    async findQuestion() {
      return question;
    },
    async insertReview(input) {
      calls.insert += 1;
      inserted = input;
      return { review_id: "review-1" };
    }
  };

  return {
    calls,
    getInserted: () => inserted,
    dependencies: {
      repository,
      async requestAI() {
        calls.ai += 1;
        return { content: aiContent, model: "mock/writing-model" };
      },
      parseReview: parseAIReviewRawResultForResponse,
      now: () => fixedDate
    }
  };
}

function assertCode(code) {
  return (error) => {
    assert.equal(error.code, code);
    return true;
  };
}

test("valid Email AI response passes validation and is saved with the required mapping", async () => {
  const harness = createHarness();
  const result = await generateAndSaveWritingReview("attempt-1", harness.dependencies);

  assert.equal(result.status, "reviewing");
  assert.equal(result.aiGeneratedAt, fixedDate.toISOString());
  assert.equal(harness.calls.insert, 1);
  assert.deepEqual(harness.getInserted(), {
    attempt_id: "attempt-1",
    task_type: "email",
    status: "reviewing",
    ai_model: "mock/writing-model",
    ai_review_raw: emailReview(),
    ai_generated_at: fixedDate.toISOString(),
    language_edits: emailReview().language_edits.map((edit) => ({
      ...edit,
      source: "ai"
    })),
    scores: emailReview().score,
    content_feedback: {
      rubric_analysis: emailReview().rubric_analysis,
      items: emailReview().content_feedback.map((item) => ({
        ...item,
        source: "ai"
      })),
      overall_feedback: emailReview().overall_feedback
    },
    teacher_comment: ""
  });
  assert.equal("published_at" in harness.getInserted(), false);
});

test("valid Academic Discussion AI response passes validation", async () => {
  const harness = createHarness({
    attempt: submittedAttempt("academic_discussion"),
    question: academicQuestion(),
    aiContent: JSON.stringify(rawReview(academicReview()))
  });

  await generateAndSaveWritingReview("attempt-1", harness.dependencies);
  assert.equal(harness.calls.insert, 1);
  assert.equal(harness.getInserted().task_type, "academic_discussion");
});

test("OpenRouter non-2xx response fails without exposing its body", async () => {
  await assert.rejects(
    requestOpenRouterWritingReview(
      { taskType: "email", question: emailQuestion(), responseText: emailResponse },
      {
        env: { OPENROUTER_API_KEY: "test-key", OPENROUTER_WRITING_MODEL: "model" },
        jsonSchema: AI_REVIEW_RAW_RESULT_JSON_SCHEMA,
        fetchImpl: async () =>
          new Response("internal provider details", { status: 429 })
      }
    ),
    (error) => {
      assert.equal(error.code, "OPENROUTER_REQUEST_FAILED");
      assert.equal(error.message.includes("internal provider details"), false);
      return true;
    }
  );
});

test("malformed assistant JSON fails before database insert", async () => {
  const harness = createHarness({ aiContent: "{not json" });
  await assert.rejects(
    generateAndSaveWritingReview("attempt-1", harness.dependencies),
    assertCode("AI_RESPONSE_INVALID")
  );
  assert.equal(harness.calls.insert, 0);
});

test("schema-invalid AI response fails before database insert", async () => {
  const review = emailReview();
  review.score.rubric_score = 6;
  const harness = createHarness({ aiContent: JSON.stringify(review) });
  await assert.rejects(
    generateAndSaveWritingReview("attempt-1", harness.dependencies),
    assertCode("AI_RESPONSE_INVALID")
  );
  assert.equal(harness.calls.insert, 0);
});

test("unlocatable raw original_text fails before database insert", async () => {
  const review = rawReview();
  review.language_edits[0].original_text = "does not exist";
  const harness = createHarness({ aiContent: JSON.stringify(review) });
  await assert.rejects(
    generateAndSaveWritingReview("attempt-1", harness.dependencies),
    assertCode("AI_RESPONSE_INVALID")
  );
  assert.equal(harness.calls.insert, 0);
});

test("missing OpenRouter API key returns a server configuration error", async () => {
  await assert.rejects(
    requestOpenRouterWritingReview(
      { taskType: "email", question: emailQuestion(), responseText: emailResponse },
      {
        env: { OPENROUTER_WRITING_MODEL: "model" },
        jsonSchema: AI_REVIEW_RAW_RESULT_JSON_SCHEMA
      }
    ),
    assertCode("OPENROUTER_API_KEY_MISSING")
  );
});

test("missing OpenRouter model returns a server configuration error", async () => {
  await assert.rejects(
    requestOpenRouterWritingReview(
      { taskType: "email", question: emailQuestion(), responseText: emailResponse },
      {
        env: { OPENROUTER_API_KEY: "test-key" },
        jsonSchema: AI_REVIEW_RAW_RESULT_JSON_SCHEMA
      }
    ),
    assertCode("OPENROUTER_MODEL_MISSING")
  );
});

test("draft attempt is rejected without calling OpenRouter", async () => {
  const attempt = { ...submittedAttempt(), status: "draft" };
  const harness = createHarness({ attempt });
  await assert.rejects(
    generateAndSaveWritingReview("attempt-1", harness.dependencies),
    assertCode("ATTEMPT_NOT_SUBMITTED")
  );
  assert.equal(harness.calls.ai, 0);
  assert.equal(harness.calls.insert, 0);
});

test("existing writing review is rejected without calling OpenRouter", async () => {
  const harness = createHarness({ existingReview: { review_id: "review-existing" } });
  await assert.rejects(
    generateAndSaveWritingReview("attempt-1", harness.dependencies),
    assertCode("REVIEW_ALREADY_EXISTS")
  );
  assert.equal(harness.calls.ai, 0);
  assert.equal(harness.calls.insert, 0);
});

test("generate timeout does not insert a partial review and does not retry", async () => {
  const harness = createHarness();
  harness.dependencies.requestAI = async () => {
    harness.calls.ai += 1;
    const error = new Error("AI 初批生成超时，请稍后重试。");
    error.code = "AI_REQUEST_TIMEOUT";
    error.status = 504;
    throw error;
  };
  await assert.rejects(
    generateAndSaveWritingReview("attempt-1", harness.dependencies),
    (error) => error.code === "AI_REQUEST_TIMEOUT" && error.status === 504
  );
  assert.equal(harness.calls.ai, 1);
  assert.equal(harness.calls.insert, 0);
});

test("task_type mismatch is invalid and is never saved", async () => {
  const harness = createHarness({ aiContent: JSON.stringify(rawReview(academicReview())) });
  await assert.rejects(
    generateAndSaveWritingReview("attempt-1", harness.dependencies),
    assertCode("AI_RESPONSE_INVALID")
  );
  assert.equal(harness.calls.insert, 0);
});

test("OpenRouter request uses strict JSON Schema structured output and full input", async () => {
  let capturedRequest;
  const result = await requestOpenRouterWritingReview(
    { taskType: "email", question: emailQuestion(), responseText: emailResponse },
    {
      env: {
        OPENROUTER_API_KEY: "test-secret-key",
        OPENROUTER_WRITING_MODEL: "configured/model"
      },
      jsonSchema: AI_REVIEW_RAW_RESULT_JSON_SCHEMA,
      fetchImpl: async (url, init) => {
        capturedRequest = { url, init, body: JSON.parse(init.body) };
        return Response.json({
          choices: [{ message: { content: JSON.stringify(rawReview()) } }],
          usage: {
            prompt_tokens: 321,
            completion_tokens: 123,
            total_tokens: 444
          }
        });
      }
    }
  );

  assert.equal(result.model, "configured/model");
  assert.deepEqual(result.usage, {
    prompt_tokens: 321,
    cached_tokens: null,
    completion_tokens: 123,
    reasoning_tokens: null,
    accepted_prediction_tokens: null,
    rejected_prediction_tokens: null,
    total_tokens: 444,
    cost: null,
    upstream_inference_cost: null,
    upstream_inference_prompt_cost: null,
    upstream_inference_completions_cost: null
  });
  assert.equal(capturedRequest.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(capturedRequest.body.stream, false);
  assert.equal(capturedRequest.body.model, "configured/model");
  assert.equal("reasoning" in capturedRequest.body, false);
  assert.deepEqual(capturedRequest.body.provider, { require_parameters: true });
  assert.equal(capturedRequest.body.response_format.type, "json_schema");
  assert.equal(capturedRequest.body.response_format.json_schema.strict, true);
  assert.deepEqual(
    capturedRequest.body.response_format.json_schema.schema,
    AI_REVIEW_RAW_RESULT_JSON_SCHEMA
  );
  const prompt = capturedRequest.body.messages.map((message) => message.content).join("\n");
  assert.match(prompt, /Official TOEFL Write an Email Scoring Guide/);
  assert.match(prompt, /scores\.official_score\.ai_score/);
  assert.match(prompt, /not ETS-reported independent subscores/);
  assert.match(prompt, /Never average, add, weight/);
  assert.match(prompt, /original_sentence/);
  assert.match(prompt, /do not return start or end offsets/);
  assert.match(prompt, /if the response ends with "Also, "/);
  assert.match(prompt, /include it in language_edits/);
  assert.match(prompt, /Assignment extension/);
  assert.match(prompt, /I am write to request more time/);
  assert.equal(capturedRequest.init.headers.Authorization, "Bearer test-secret-key");
});

for (const effort of ["max", "high", "low"]) {
  test(`reasoning benchmark ${effort} reaches the actual OpenRouter request body`, async () => {
    let requestBody;
    await requestOpenRouterWritingReview(
      { taskType: "email", question: emailQuestion(), responseText: emailResponse },
      {
        env: {
          OPENROUTER_API_KEY: "test-secret-key",
          OPENROUTER_WRITING_MODEL: "moonshotai/kimi-k3"
        },
        jsonSchema: AI_REVIEW_RAW_RESULT_JSON_SCHEMA,
        reasoningEffort: effort,
        fetchImpl: async (_url, init) => {
          requestBody = JSON.parse(init.body);
          return Response.json({
            choices: [{ message: { content: JSON.stringify(rawReview()) } }]
          });
        }
      }
    );
    assert.deepEqual(requestBody.reasoning, { effort });
  });
}

test("Academic Discussion prompt includes its official guide and source responses", () => {
  const prompt = buildWritingReviewMessages({
    taskType: "academic_discussion",
    question: academicQuestion(),
    responseText: submittedAttempt("academic_discussion").response_text
  })
    .map((message) => message.content)
    .join("\n");
  assert.match(prompt, /Official TOEFL Write for an Academic Discussion Scoring Guide/);
  assert.match(prompt, /Should cities invest more in public transportation/);
  assert.match(prompt, /Yes, because it reduces traffic/);
  assert.match(prompt, /No, because roads are more flexible/);
});

test("new review prompt requires Chinese explanatory prose while preserving English writing fields", () => {
  const prompt = buildWritingReviewMessages({
    taskType: "email",
    question: emailQuestion(),
    responseText: emailResponse
  })
    .map((message) => message.content)
    .join("\n");
  assert.match(prompt, /OUTPUT LANGUAGE RULES/);
  assert.match(prompt, /language_edits\[\]\.explanation must be in Simplified Chinese/);
  assert.match(prompt, /scores\.official_score\.rationale must be in Simplified Chinese/);
  assert.match(prompt, /dimension_scores\.\*\.ai_basis must be in Simplified Chinese/);
  assert.match(prompt, /content_feedback\[\]\.issue must be in Simplified Chinese/);
  assert.match(prompt, /content_feedback\[\]\.suggestion must be in Simplified Chinese/);
  assert.match(prompt, /overall_feedback must be in Simplified Chinese/);
  assert.match(prompt, /original_text, replacement_text, and original_sentence must preserve the student's English/);
  assert.doesNotMatch(prompt, /content_feedback\[\]\.example/);
  assert.match(prompt, /Do not translate the student's original writing into Chinese/);
});

test("modelOverride changes only the requested model and does not require the default model", async () => {
  let requestBody;
  const result = await requestOpenRouterWritingReview(
    { taskType: "email", question: emailQuestion(), responseText: emailResponse },
    {
      env: { OPENROUTER_API_KEY: "test-key" },
      jsonSchema: AI_REVIEW_RAW_RESULT_JSON_SCHEMA,
      modelOverride: "comparison/model",
      fetchImpl: async (_url, init) => {
        requestBody = JSON.parse(init.body);
        return Response.json({
          choices: [{ message: { content: JSON.stringify(rawReview()) } }]
        });
      }
    }
  );

  assert.equal(result.model, "comparison/model");
  assert.equal(requestBody.model, "comparison/model");
  assert.deepEqual(result.usage, {
    prompt_tokens: null,
    cached_tokens: null,
    completion_tokens: null,
    reasoning_tokens: null,
    accepted_prediction_tokens: null,
    rejected_prediction_tokens: null,
    total_tokens: null,
    cost: null,
    upstream_inference_cost: null,
    upstream_inference_prompt_cost: null,
    upstream_inference_completions_cost: null
  });
});

test("OpenRouter usage extracts only token and cost diagnostic fields", async () => {
  const result = await requestOpenRouterWritingReview(
    { taskType: "email", question: emailQuestion(), responseText: emailResponse },
    {
      env: {
        OPENROUTER_API_KEY: "test-secret-key",
        OPENROUTER_WRITING_MODEL: "configured/model"
      },
      jsonSchema: AI_REVIEW_RAW_RESULT_JSON_SCHEMA,
      fetchImpl: async () => Response.json({
        choices: [{ message: { content: JSON.stringify(rawReview()) } }],
        usage: {
          prompt_tokens: 4812,
          prompt_tokens_details: { cached_tokens: 1200, provider_secret: "ignored" },
          completion_tokens: 9151,
          completion_tokens_details: {
            reasoning_tokens: 7600,
            accepted_prediction_tokens: 14,
            rejected_prediction_tokens: 3,
            provider_internal: "ignored"
          },
          total_tokens: 13963,
          cost: 0,
          cost_details: {
            upstream_inference_cost: 0.00123456789,
            upstream_inference_prompt_cost: 0.00012345678,
            upstream_inference_completions_cost: 0.00111111111,
            unapproved_cost_field: 999
          }
        }
      })
    }
  );

  assert.deepEqual(result.usage, {
    prompt_tokens: 4812,
    cached_tokens: 1200,
    completion_tokens: 9151,
    reasoning_tokens: 7600,
    accepted_prediction_tokens: 14,
    rejected_prediction_tokens: 3,
    total_tokens: 13963,
    cost: 0,
    upstream_inference_cost: 0.00123456789,
    upstream_inference_prompt_cost: 0.00012345678,
    upstream_inference_completions_cost: 0.00111111111
  });
  assert.equal("provider_secret" in result.usage, false);
  assert.equal("unapproved_cost_field" in result.usage, false);
});

test("comparison CLI argument parsing ignores pnpm's standalone separator", () => {
  assert.deepEqual(
    parseWritingReviewComparisonArguments([
      "--",
      "1c58b33a-4e9e-41fd-9adb-1b871fbe32c1",
      "--source-only"
    ]),
    {
      attemptId: "1c58b33a-4e9e-41fd-9adb-1b871fbe32c1",
      sourceOnly: true,
      model: null,
      unknownOption: null
    }
  );
});

test("comparison CLI model aliases select only the requested model", () => {
  const cases = [
    ["deepseek", "deepseek/deepseek-v4-flash"],
    ["qwen", "qwen/qwen3.8-max"],
    ["kimi", "moonshotai/kimi-k3"]
  ];

  for (const [alias, expectedModel] of cases) {
    const parsed = parseWritingReviewComparisonArguments([
      "attempt-1",
      "--model",
      alias
    ]);
    assert.equal(parsed.attemptId, "attempt-1");
    assert.equal(parsed.model, alias);
    assert.equal(parsed.unknownOption, null);
    assert.equal(resolveWritingReviewComparisonModel(parsed.model), expectedModel);
  }
});

test("comparison CLI accepts a full model ID", () => {
  assert.equal(
    resolveWritingReviewComparisonModel("vendor/custom-model"),
    "vendor/custom-model"
  );
});

test("comparison defaults to all three models in the original order", async () => {
  const calls = [];
  const comparisons = await compareWritingReviewModels(
    { taskType: "email", question: emailQuestion(), responseText: emailResponse },
    {
      async requestAI(_input, model) {
        calls.push(model);
        return {
          content: JSON.stringify(rawReview()),
          model,
          usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null }
        };
      },
      parseReview: parseAIReviewRawResultForResponse
    }
  );

  assert.deepEqual(calls, [...WRITING_REVIEW_COMPARISON_MODELS]);
  assert.deepEqual(
    comparisons.map(({ model }) => model),
    [...WRITING_REVIEW_COMPARISON_MODELS]
  );
});

for (const [alias, expectedModel] of [
  ["deepseek", "deepseek/deepseek-v4-flash"],
  ["qwen", "qwen/qwen3.8-max"],
  ["kimi", "moonshotai/kimi-k3"]
]) {
  test(`--model ${alias} runs only ${expectedModel}`, async () => {
    const calls = [];
    const selectedModel = resolveWritingReviewComparisonModel(alias);
    const comparisons = await compareWritingReviewModels(
      { taskType: "email", question: emailQuestion(), responseText: emailResponse },
      {
        models: [selectedModel],
        async requestAI(_input, model) {
          calls.push(model);
          return {
            content: JSON.stringify(rawReview()),
            model,
            usage: {
              prompt_tokens: null,
              completion_tokens: null,
              total_tokens: null
            }
          };
        },
        parseReview: parseAIReviewRawResultForResponse
      }
    );

    assert.deepEqual(calls, [expectedModel]);
    assert.equal(comparisons.length, 1);
    assert.equal(comparisons[0].success, true);
  });
}

test("each comparison model has an independent five-minute timeout", () => {
  assert.equal(WRITING_REVIEW_MODEL_TIMEOUT_MS, 300000);
});

test("timed-out model is aborted and the next model still runs", async () => {
  const firstModel = WRITING_REVIEW_COMPARISON_MODELS[0];
  const secondModel = WRITING_REVIEW_COMPARISON_MODELS[1];
  const calls = [];
  let firstSignal;

  const comparisons = await compareWritingReviewModels(
    { taskType: "email", question: emailQuestion(), responseText: emailResponse },
    {
      models: [firstModel, secondModel],
      timeoutMs: 5,
      async requestAI(_input, model, signal) {
        calls.push(model);
        if (model === firstModel) {
          firstSignal = signal;
          return new Promise(() => {});
        }
        return {
          content: JSON.stringify(rawReview()),
          model,
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 }
        };
      },
      parseReview: parseAIReviewRawResultForResponse
    }
  );

  assert.equal(firstSignal.aborted, true);
  assert.deepEqual(calls, [firstModel, secondModel]);
  assert.equal(comparisons[0].success, false);
  assert.equal(comparisons[0].error, "MODEL_TIMEOUT");
  assert.ok(comparisons[0].latency_ms >= 0);
  assert.equal(comparisons[1].success, true);
});

test("model comparison is sequential, fixed-order, and isolates one model failure", async () => {
  const calls = [];
  let activeRequest = false;
  const usage = {
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150
  };
  let clock = 0;

  const comparisons = await compareWritingReviewModels(
    { taskType: "email", question: emailQuestion(), responseText: emailResponse },
    {
      now: () => {
        clock += 10;
        return clock;
      },
      async requestAI(_input, model) {
        assert.equal(activeRequest, false, "models must not run concurrently");
        activeRequest = true;
        calls.push(model);
        activeRequest = false;
        if (model === "qwen/qwen3.8-max") throw new Error("mock provider failure");
        return { content: JSON.stringify(rawReview()), model, usage };
      },
      parseReview: parseAIReviewRawResultForResponse
    }
  );

  assert.deepEqual(calls, [...WRITING_REVIEW_COMPARISON_MODELS]);
  assert.deepEqual(
    comparisons.map((comparison) => comparison.success),
    [true, false, true]
  );
  assert.equal(comparisons[0].result.score.rubric_score, 3);
  assert.equal(comparisons[0].result.language_edits[0].start, 2);
  assert.equal(comparisons[0].result.language_edits[0].end, 10);
  assert.equal(comparisons[1].result, null);
  assert.match(comparisons[1].error, /mock provider failure/);
  assert.deepEqual(
    {
      prompt_tokens: comparisons[2].prompt_tokens,
      completion_tokens: comparisons[2].completion_tokens,
      total_tokens: comparisons[2].total_tokens
    },
    usage
  );
  assert.ok(comparisons.every((comparison) => comparison.latency_ms === 10));
});

test("comparison records local validation failure and continues to later models", async () => {
  const invalidReview = rawReview();
  invalidReview.language_edits[0].original_text = "missing original text";
  let callIndex = 0;

  const comparisons = await compareWritingReviewModels(
    { taskType: "email", question: emailQuestion(), responseText: emailResponse },
    {
      async requestAI(_input, model) {
        const content = callIndex++ === 0 ? invalidReview : rawReview();
        return {
          content: JSON.stringify(content),
          model,
          usage: {
            prompt_tokens: 100,
            completion_tokens: 50,
            total_tokens: 150
          }
        };
      },
      parseReview: parseAIReviewRawResultForResponse
    }
  );

  assert.equal(comparisons[0].success, false);
  assert.match(comparisons[0].error, /original_text/);
  assert.deepEqual(
    comparisons.slice(1).map((comparison) => comparison.success),
    [true, true]
  );
  assert.deepEqual({
    prompt_tokens: comparisons[0].prompt_tokens,
    completion_tokens: comparisons[0].completion_tokens,
    total_tokens: comparisons[0].total_tokens
  }, {
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150
  });
});

test("source loading preserves the Supabase query stage, code, and message", async () => {
  const supabase = mockSourceSupabase({
    writing_attempts: {
      data: null,
      error: { code: "PGRST_TEST", message: "mock attempt query failure" }
    }
  });

  await assert.rejects(
    loadWritingReviewComparisonSource(supabase, "attempt-1"),
    (error) => {
      assert.equal(error.stage, "writing_attempt");
      assert.equal(error.supabaseCode, "PGRST_TEST");
      assert.match(error.message, /stage: writing_attempt/);
      assert.match(error.message, /code: PGRST_TEST/);
      assert.match(error.message, /mock attempt query failure/);
      return true;
    }
  );
});

test("source loading reads a submitted attempt and its task-specific full question", async () => {
  const attempt = submittedAttempt();
  attempt.set_id = "email-set-1";
  attempt.word_count = 7;
  const question = emailQuestion();
  const supabase = mockSourceSupabase({
    writing_attempts: { data: attempt, error: null },
    email_questions: { data: question, error: null }
  });

  const source = await loadWritingReviewComparisonSource(supabase, "attempt-1");
  assert.equal(source.attempt.attempt_id, "attempt-1");
  assert.equal(source.question.subject, "Assignment extension");
});

function mockSourceSupabase(resultsByTable) {
  return {
    from(table) {
      const result = resultsByTable[table] ?? { data: null, error: null };
      const query = {
        select() {
          return query;
        },
        eq() {
          return query;
        },
        async maybeSingle() {
          return result;
        }
      };
      return query;
    }
  };
}

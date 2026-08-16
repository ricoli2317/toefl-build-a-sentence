const test = require("node:test");
const assert = require("node:assert/strict");
const {
  WRITING_FEEDBACK_PROMPT_MAX_LENGTH,
  WRITING_FEEDBACK_REGENERATION_JSON_SCHEMA,
  buildWritingFeedbackRegenerationMessages,
  parseWritingFeedbackRegenerationResult,
  regenerateWritingContentFeedback
} = require("../lib/writingReviewFeedbackRegeneration.ts");
const {
  requestOpenRouterStructuredOutput
} = require("../lib/openrouterWritingReview.ts");
const { OpenRouterWritingReviewError } = require("../lib/openrouterWritingReview.ts");
const {
  assertWritingReviewTeacher
} = require("../lib/writingReviewWorkspaceServer.ts");

const responseText =
  "Cities should invest in transit. Better buses can reduce traffic for everyone.";

function feedback(overrides = {}) {
  const originalSentence = "Better buses can reduce traffic for everyone.";
  const start = responseText.indexOf(originalSentence);
  return {
    feedback_id: "feedback-1",
    start,
    end: start + originalSentence.length,
    original_sentence: originalSentence,
    category: "elaboration",
    issue: "The claim needs a concrete mechanism or example.",
    suggestion: "Explain how better service changes commuter behavior.",
    example: "Frequent buses can persuade commuters to leave their cars at home.",
    proposed_revision: "Better buses can reduce traffic by giving commuters a reliable alternative to driving.",
    included: true,
    ...overrides
  };
}

function otherFeedback(overrides = {}) {
  const originalSentence = "Cities should invest in transit.";
  return feedback({
    feedback_id: "feedback-2",
    start: 0,
    end: originalSentence.length,
    original_sentence: originalSentence,
    category: "relevance",
    issue: "The position could connect more directly to the prompt.",
    suggestion: "State the connection explicitly.",
    example: "Cities should invest in transit to reduce congestion.",
    proposed_revision: "Cities should invest in public transit because it can reduce congestion.",
    ...overrides
  });
}

function question(taskType) {
  return taskType === "email"
    ? {
        question_id: "email-1",
        set_id: "set-1",
        set_title: "Email Set",
        year_month: "202608",
        source_labels: "official",
        scenario: "You need more time.",
        task_instruction: "Write an email.",
        requirement_1: "Explain why.",
        requirement_2: "Request more time.",
        requirement_3: "Suggest a date.",
        closing_instruction: "Close appropriately.",
        recipient: "Professor Lee",
        subject: "Extension"
      }
    : {
        question_id: "discussion-1",
        set_id: "set-1",
        set_title: "Discussion Set",
        year_month: "202608",
        source_labels: "official",
        professor_name: "Professor Lee",
        professor_prompt: "Should cities invest in public transit?",
        student_1_name: "Anna",
        student_1_response: "Yes, it reduces traffic.",
        student_2_name: "Mark",
        student_2_response: "Roads are more flexible."
      };
}

function harness({
  taskType = "academic_discussion",
  initialItems = [feedback(), otherFeedback()],
  latestItems,
  aiContent = JSON.stringify({
    suggestion: "Explain the causal link between service frequency and car use.",
    proposed_revision: "Better buses can reduce traffic by giving commuters a reliable alternative to driving."
  }),
  aiError = null,
  review = true
} = {}) {
  const calls = { ai: 0, findReview: 0, update: 0 };
  const immutable = {
    ai_review_raw: { schema_version: "2.0", original: true },
    scores: { official_score: { teacher_score: 4 } },
    language_edits: [{ edit_id: "edit-1" }],
    teacher_comment: "Existing teacher comment",
    published_content_feedback: { items: [{ feedback_id: "published" }] },
    published_scores: { official_score: { teacher_score: 3 } },
    published_language_edits: [{ edit_id: "published-edit" }],
    published_teacher_comment: "Published comment",
    published_at: "2026-08-13T08:00:00.000Z"
  };
  const database = {
    ...structuredClone(immutable),
    content_feedback: {
      items: structuredClone(initialItems),
      overall_feedback: "Existing overall feedback"
    }
  };
  let updatedPayload = null;
  let capturedMessages = null;
  const repository = {
    async findAttempt() {
      return {
        attempt_id: "attempt-1",
        task_type: taskType,
        question_id: taskType === "email" ? "email-1" : "discussion-1",
        response_text: responseText,
        status: "submitted"
      };
    },
    async findReview() {
      calls.findReview += 1;
      if (!review) return null;
      const items =
        calls.findReview > 1 && latestItems
          ? structuredClone(latestItems)
          : structuredClone(database.content_feedback.items);
      return {
        content_feedback: {
          ...structuredClone(database.content_feedback),
          items
        }
      };
    },
    async findQuestion() {
      return question(taskType);
    },
    async updateContentFeedback(_attemptId, contentFeedback) {
      calls.update += 1;
      updatedPayload = structuredClone(contentFeedback);
      database.content_feedback = structuredClone(contentFeedback);
      return { updated_at: "2026-08-13T09:00:00.000Z" };
    }
  };
  return {
    calls,
    database,
    immutable,
    getMessages: () => capturedMessages,
    getUpdatedPayload: () => updatedPayload,
    dependencies: {
      repository,
      async requestAI(messages) {
        calls.ai += 1;
        capturedMessages = messages;
        if (aiError) throw aiError;
        return { content: aiContent };
      }
    }
  };
}

async function regenerate(testHarness, body = { prompt: "Focus on stronger evidence." }) {
  return regenerateWritingContentFeedback(
    "attempt-1",
    "feedback-1",
    body,
    testHarness.dependencies
  );
}

function assertCode(code) {
  return (error) => error.code === code;
}

for (const taskType of ["email", "academic_discussion"]) {
  test(`${taskType} feedback regenerates suggestion and proposed revision with full context`, async () => {
    const testHarness = harness({ taskType });
    const result = await regenerate(testHarness);
    assert.deepEqual(Object.keys(result).sort(), [
      "feedback_id",
      "proposed_revision",
      "suggestion",
      "updated_at"
    ]);
    const context = JSON.parse(testHarness.getMessages()[1].content);
    assert.equal(context.task_type, taskType);
    assert.equal(context.response_text, responseText);
    assert.equal(context.original_question.question_id, question(taskType).question_id);
    assert.equal(context.current_feedback.feedback_id, "feedback-1");
    assert.equal(context.current_feedback.issue, feedback().issue);
    assert.equal(context.teacher_prompt, "Focus on stronger evidence.");
  });
}

test("Structured Output permits only required suggestion and proposed revision", () => {
  assert.deepEqual(WRITING_FEEDBACK_REGENERATION_JSON_SCHEMA.required, [
    "suggestion",
    "proposed_revision"
  ]);
  assert.equal(WRITING_FEEDBACK_REGENERATION_JSON_SCHEMA.additionalProperties, false);
  assert.deepEqual(
    Object.keys(WRITING_FEEDBACK_REGENERATION_JSON_SCHEMA.properties).sort(),
    ["proposed_revision", "suggestion"]
  );
  assert.deepEqual(parseWritingFeedbackRegenerationResult('{"suggestion":"Do this.","proposed_revision":"Revised sentence."}'), {
    suggestion: "Do this.",
    proposed_revision: "Revised sentence."
  });
});

test("local regeneration uses the shared strict non-streaming OpenRouter infrastructure", async () => {
  const messages = buildWritingFeedbackRegenerationMessages({
    taskType: "email",
    question: question("email"),
    responseText,
    feedback: feedback(),
    teacherPrompt: "Focus on stronger evidence."
  });
  let captured;
  const result = await requestOpenRouterStructuredOutput(messages, {
    env: {
      OPENROUTER_API_KEY: "mock-secret",
      OPENROUTER_WRITING_MODEL: "moonshotai/kimi-k3"
    },
    jsonSchema: WRITING_FEEDBACK_REGENERATION_JSON_SCHEMA,
    schemaName: "tps_writing_feedback_regeneration",
    fetchImpl: async (url, init) => {
      captured = { url, init, body: JSON.parse(init.body) };
      return Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                suggestion: "Add a concrete mechanism.",
                proposed_revision: "Better buses can reduce traffic by replacing some car trips."
              })
            }
          }
        ]
      });
    }
  });

  assert.equal(result.model, "moonshotai/kimi-k3");
  assert.equal(captured.url, "https://openrouter.ai/api/v1/chat/completions");
  assert.equal(captured.body.stream, false);
  assert.deepEqual(captured.body.messages, messages);
  assert.deepEqual(captured.body.provider, { require_parameters: true });
  assert.deepEqual(captured.body.response_format, {
    type: "json_schema",
    json_schema: {
      name: "tps_writing_feedback_regeneration",
      strict: true,
      schema: WRITING_FEEDBACK_REGENERATION_JSON_SCHEMA
    }
  });
  assert.equal(captured.init.headers.Authorization, "Bearer mock-secret");
});

test("local regeneration requires Chinese suggestion and English revision", () => {
  const prompt = buildWritingFeedbackRegenerationMessages({
    taskType: "academic_discussion",
    question: question("academic_discussion"),
    responseText,
    feedback: feedback(),
    teacherPrompt: "Make it more specific."
  })[0].content;
  assert.match(prompt, /suggestion.*Simplified Chinese/);
  assert.match(prompt, /even when the teacher prompt is in English/);
  assert.doesNotMatch(prompt, /example.*written in English/);
  assert.match(prompt, /proposed_revision must be written in English/);
});

test("local regeneration explains every material proposed revision change", () => {
  const prompt = buildWritingFeedbackRegenerationMessages({
    taskType: "email",
    question: question("email"),
    responseText,
    feedback: feedback(),
    teacherPrompt: "Also improve any wording that truly must change."
  })[0].content;
  assert.match(prompt, /PROPOSED REVISION FIDELITY/);
  assert.match(prompt, /Every material insertion, deletion, replacement, or structural change/);
  assert.match(prompt, /directly explained by that item's issue or suggestion/);
  assert.match(prompt, /Do not add unrelated stylistic polishing/);
  assert.match(prompt, /existing issue and the newly generated suggestion together must explain every material change/);
  assert.match(prompt, /teacher's additional instruction[\s\S]*new suggestion must explicitly explain those changes/);
  assert.match(prompt, /never silently rewrite other wording/);
  assert.match(prompt, /suggestion.*Simplified Chinese/);
  assert.match(prompt, /proposed_revision must be written in English/);
});

test("empty and overlong teacher prompts fail before reads or AI", async () => {
  for (const prompt of ["   ", "x".repeat(WRITING_FEEDBACK_PROMPT_MAX_LENGTH + 1)]) {
    const testHarness = harness();
    await assert.rejects(regenerate(testHarness, { prompt }), assertCode("INVALID_TEACHER_PROMPT"));
    assert.equal(testHarness.calls.findReview, 0);
    assert.equal(testHarness.calls.ai, 0);
  }
});

test("missing feedback fails without calling AI", async () => {
  const testHarness = harness({ initialItems: [otherFeedback()] });
  await assert.rejects(regenerate(testHarness), assertCode("FEEDBACK_NOT_FOUND"));
  assert.equal(testHarness.calls.ai, 0);
});

test("teacher-source feedback cannot use local AI regeneration", async () => {
  const testHarness = harness({
    initialItems: [feedback({ source: "teacher" }), otherFeedback()]
  });
  await assert.rejects(
    regenerate(testHarness),
    assertCode("TEACHER_FEEDBACK_UNSUPPORTED")
  );
  assert.equal(testHarness.calls.ai, 0);
  assert.equal(testHarness.calls.update, 0);
});

test("legacy v1 feedback fails without calling AI", async () => {
  const legacy = feedback();
  delete legacy.original_sentence;
  delete legacy.start;
  delete legacy.end;
  const testHarness = harness({ initialItems: [legacy] });
  await assert.rejects(
    regenerate(testHarness),
    assertCode("LEGACY_FEEDBACK_UNSUPPORTED")
  );
  assert.equal(testHarness.calls.ai, 0);
});

test("invalid feedback offsets fail without calling AI", async () => {
  const testHarness = harness({ initialItems: [feedback({ start: 1 })] });
  await assert.rejects(
    regenerate(testHarness),
    assertCode("FEEDBACK_POSITION_INVALID")
  );
  assert.equal(testHarness.calls.ai, 0);
});

test("unknown AI fields and empty suggestion are rejected without update", async () => {
  for (const aiContent of [
    JSON.stringify({ suggestion: "Specific.", proposed_revision: "Revision.", issue: "changed" }),
    JSON.stringify({ suggestion: "   ", proposed_revision: "Revision." }),
    JSON.stringify({ suggestion: "Specific.", proposed_revision: "   " })
  ]) {
    const testHarness = harness({ aiContent });
    await assert.rejects(regenerate(testHarness), assertCode("AI_RESPONSE_INVALID"));
    assert.equal(testHarness.calls.update, 0);
  }
});

test("AI service failure never updates the database", async () => {
  const testHarness = harness({ aiError: new Error("mock provider failure") });
  await assert.rejects(regenerate(testHarness), assertCode("AI_SERVICE_ERROR"));
  assert.equal(testHarness.calls.update, 0);
});

test("feedback timeout returns AI_REQUEST_TIMEOUT and preserves working and published data", async () => {
  const timeout = new OpenRouterWritingReviewError(
    "AI_REQUEST_TIMEOUT",
    "AI 建议生成超时，请稍后重试。",
    504
  );
  const testHarness = harness({ aiError: timeout });
  const before = structuredClone(testHarness.database);
  await assert.rejects(
    regenerate(testHarness),
    (error) =>
      error.code === "AI_REQUEST_TIMEOUT" &&
      error.status === 504 &&
      error.message === "AI 建议生成超时，请稍后重试。"
  );
  assert.equal(testHarness.calls.ai, 1, "timeout must not retry OpenRouter");
  assert.equal(testHarness.calls.update, 0);
  assert.deepEqual(testHarness.database, before);
});

test("success re-reads current DB state and changes only target suggestion/proposed revision", async () => {
  const concurrentOther = otherFeedback({ suggestion: "Concurrent newer suggestion." });
  const latestTarget = feedback({
    issue: "A concurrently refined issue that must remain unchanged.",
    included: false
  });
  const testHarness = harness({ latestItems: [latestTarget, concurrentOther] });
  const beforeTarget = structuredClone(latestTarget);
  await regenerate(testHarness, {
    prompt: "Use a clearer mechanism.",
    content_feedback: { items: [{ feedback_id: "malicious-client-overwrite" }] }
  });

  assert.equal(testHarness.calls.findReview, 2);
  assert.equal(testHarness.calls.update, 1);
  const updated = testHarness.getUpdatedPayload();
  const target = updated.items[0];
  assert.equal(target.suggestion, "Explain the causal link between service frequency and car use.");
  assert.equal(target.example, beforeTarget.example, "legacy example must be preserved");
  assert.equal(target.proposed_revision, "Better buses can reduce traffic by giving commuters a reliable alternative to driving.");
  for (const key of [
    "feedback_id",
    "category",
    "original_sentence",
    "start",
    "end",
    "issue",
    "included"
  ]) {
    assert.deepEqual(target[key], beforeTarget[key], `${key} must remain unchanged`);
  }
  assert.deepEqual(updated.items[1], concurrentOther);
  assert.equal(updated.overall_feedback, "Existing overall feedback");
});

test("working update leaves AI, scores, edits, comments, and all published snapshots unchanged", async () => {
  const testHarness = harness();
  await regenerate(testHarness);
  for (const [key, value] of Object.entries(testHarness.immutable)) {
    assert.deepEqual(testHarness.database[key], value, `${key} must remain unchanged`);
  }
});

test("published review keeps its old published snapshot after local regeneration", async () => {
  const testHarness = harness();
  const publishedBefore = structuredClone(testHarness.database.published_content_feedback);
  await regenerate(testHarness);
  assert.deepEqual(testHarness.database.published_content_feedback, publishedBefore);
  assert.equal(testHarness.database.published_at, "2026-08-13T08:00:00.000Z");
});

test("non-teacher is rejected", () => {
  assert.throws(
    () => assertWritingReviewTeacher({ error: "Unauthorized", userId: "student-1" }),
    (error) => error.code === "UNAUTHORIZED" && error.status === 403
  );
});

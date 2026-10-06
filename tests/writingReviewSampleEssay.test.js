const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildWritingReviewSemanticC3Messages } = require("../lib/writingReviewSemanticPrompt.ts");
const {
  buildWritingSampleEssayMessages,
  generateWritingSampleEssay,
  parseWritingSampleEssayInstruction,
  parseWritingSampleEssayText,
  WritingSampleEssayError
} = require("../lib/writingReviewSampleEssay.ts");
const {
  buildManualWritingReviewDraft,
  buildWritingReviewPublishUpdate,
  buildWritingReviewSaveUpdate
} = require("../lib/writingReviewWorkspace.ts");
const {
  loadWritingReviewWorkspace,
  publishedSnapshotMatchesDraft,
  saveWritingReviewWorkspace
} = require("../lib/writingReviewWorkspaceServer.ts");
const { loadStudentPublishedWritingReview } = require("../lib/writingPublishedReviewServer.ts");

const responseText = "Dear Professor Lee, I need more time.";

function emailQuestion() {
  return {
    question_id: "email-1",
    set_id: "set-1",
    set_title: "8.15 Email",
    year_month: "202608",
    source_labels: "official",
    scenario: "You are writing to your professor to request more time.",
    task_instruction: "Write an email to your professor.",
    requirement_1: "Explain why you need more time.",
    requirement_2: "Request an extension.",
    requirement_3: "Suggest a new deadline.",
    closing_instruction: "Close the email appropriately.",
    recipient: "Professor Lee",
    subject: "Request for Extension"
  };
}

function discussionQuestion() {
  return {
    question_id: "discussion-1",
    set_id: "set-2",
    set_title: "8.16 Discussion",
    year_month: "202608",
    source_labels: "official",
    professor_name: "Professor Chen",
    professor_prompt: "Should cities invest in public transit?",
    student_1_name: "Anna",
    student_1_response: "Yes, it reduces traffic.",
    student_2_name: "Mark",
    student_2_response: "Roads are more flexible."
  };
}

function manualEmailDraft() {
  const draft = buildManualWritingReviewDraft("email");
  draft.content_feedback.overall_feedback = "总体评价。";
  draft.scores.official_score.teacher_score = 4;
  draft.scores.official_score.rationale = "评分理由。";
  return draft;
}

// ---------------------------------------------------------------------------
// C3 prompt: exactly the three hard rules, no rubric injection, no rewrite
// ---------------------------------------------------------------------------

test("C3 Email prompt adds only the Subject exclusion and keeps the existing contract", () => {
  const messages = buildWritingReviewSemanticC3Messages({
    taskType: "email",
    question: emailQuestion(),
    anchoredResponse: "⟦TPS_UNIT:U01⟧Dear Professor Lee,"
  });
  const system = messages[0].content;
  assert.match(
    system,
    /The subject is provided by the task and is not part of the student's required response\. Do not penalize the student or give negative feedback for omitting a subject line\./
  );
  assert.doesNotMatch(system, /Responding to either peer is optional/);
  assert.doesNotMatch(system, /under-100-word adjustment/);

  // Existing structure is unchanged:
  assert.match(system, /You are an expert TOEFL writing rater\. Use the official 0–5 rubric\./);
  assert.match(system, /Anchor handling rules:/);
  assert.match(system, /Language revision rules:/);
  assert.match(system, /Output-language rules:/);
  assert.match(system, /Return one JSON object only/);
  assert.match(
    system,
    /Output all and only these dimension_scores keys: communicative_purpose_and_elaboration, syntactic_range_and_word_choice, social_conventions, lexical_and_grammatical_control\./
  );
  // No legacy six-band rubric was injected:
  assert.doesNotMatch(system, /Score 5 — Fully successful/);
  assert.doesNotMatch(system, /Official TOEFL Write an Email Scoring Guide/);
});

test("C3 Academic Discussion prompt adds the peer-optional rule and the under-100 adjustment only", () => {
  const messages = buildWritingReviewSemanticC3Messages({
    taskType: "academic_discussion",
    question: discussionQuestion(),
    anchoredResponse: "⟦TPS_UNIT:U01⟧I agree because transit helps.",
    wordCount: 87
  });
  const system = messages[0].content;
  const user = messages[1].content;

  assert.match(system, /Responding to either peer is optional\./);
  assert.match(
    system,
    /Do not penalize a response for failing to address one or both student posts\./
  );
  assert.match(
    system,
    /A response can fully satisfy the task by directly answering the professor's question and making a meaningful, supported contribution\./
  );
  assert.match(system, /5 → 4, 4 → 3, 3 → 2, 2 → 1, 1 → 1, 0 → 0/);
  assert.match(
    system,
    /Never turn a valid English response with a base score of 1 into 0 merely because it is under 100 words\./
  );
  assert.match(system, /Apply the adjustment exactly once\./);
  assert.match(user, /"word_count":87/);

  // Existing structure is unchanged:
  assert.match(
    system,
    /Output all and only these dimension_scores keys: relevance, elaboration, syntactic_range_and_word_choice, lexical_and_grammatical_control\./
  );
  assert.match(system, /Return one JSON object only/);
  assert.match(system, /Anchor handling rules:/);
  // No subject rule leaked into AD, no rubric injected:
  assert.doesNotMatch(system, /subject line/);
  assert.doesNotMatch(system, /Score 5 — Fully successful/);
  assert.doesNotMatch(system, /Official TOEFL Write for an Academic Discussion Scoring Guide/);
});

test("C3 Email prompt never carries the AD word-count rule and vice versa", () => {
  const emailSystem = buildWritingReviewSemanticC3Messages({
    taskType: "email",
    question: emailQuestion(),
    anchoredResponse: "Dear Professor,"
  })[0].content;
  const adSystem = buildWritingReviewSemanticC3Messages({
    taskType: "academic_discussion",
    question: discussionQuestion(),
    anchoredResponse: "I agree.",
    wordCount: 50
  })[0].content;
  assert.doesNotMatch(emailSystem, /under-100-word|fewer than 100 words|either peer is optional/);
  assert.doesNotMatch(adSystem, /subject is provided by the task|omitting a subject line/);
});

// ---------------------------------------------------------------------------
// Sample essay prompt: full task context + task-specific rubric, nothing else
// ---------------------------------------------------------------------------

test("sample essay Email prompt contains the complete task, student response, teacher instruction, and Email rubric", () => {
  const messages = buildWritingSampleEssayMessages({
    taskType: "email",
    question: emailQuestion(),
    responseText,
    teacherInstruction: "生成4分水平范文"
  });
  const system = messages[0].content;
  const user = messages[1].content;

  assert.match(system, /Official TOEFL Write an Email Scoring Guide \(holistic 0-5\)/);
  assert.match(system, /Score 5 — Fully successful:/);
  assert.match(system, /Score 4 — Generally successful:/);
  assert.match(system, /Score 3 — Partially successful:/);
  assert.match(system, /Score 2 — Mostly unsuccessful:/);
  assert.match(system, /Score 1 — Unsuccessful:/);
  assert.match(system, /Score 0:/);
  assert.match(
    system,
    /The teacher's instruction has highest priority\./
  );

  const parsed = JSON.parse(user);
  assert.equal(parsed.task_type, "email");
  assert.equal(parsed.teacher_instruction, "生成4分水平范文");
  assert.equal(parsed.student_response, responseText);
  for (const value of [
    emailQuestion().scenario,
    emailQuestion().task_instruction,
    emailQuestion().requirement_1,
    emailQuestion().requirement_2,
    emailQuestion().requirement_3,
    emailQuestion().closing_instruction,
    emailQuestion().recipient,
    emailQuestion().subject
  ]) {
    assert.ok(user.includes(value), `missing ${value}`);
  }
  assert.equal(parsed.original_task.subject, "Request for Extension");
});

test("sample essay Academic Discussion prompt contains the complete task, both peers, fixed directions, and the AD rubric", () => {
  const messages = buildWritingSampleEssayMessages({
    taskType: "academic_discussion",
    question: discussionQuestion(),
    responseText: "I agree because transit helps.",
    teacherInstruction: "生成全新范文，不参考学生回答"
  });
  const system = messages[0].content;
  const user = messages[1].content;

  assert.match(system, /Official TOEFL Write for an Academic Discussion Scoring Guide \(holistic 0-5\)/);
  assert.match(system, /Score 5 — Fully successful:/);
  assert.doesNotMatch(system, /Write an Email Scoring Guide/);
  assert.match(user, /Should cities invest in public transit\?/);
  assert.match(user, /Anna/);
  assert.match(user, /Yes, it reduces traffic\./);
  assert.match(user, /Mark/);
  assert.match(user, /Roads are more flexible\./);
  assert.match(user, /An effective response will contain at least 100 words\./);
  assert.equal(
    JSON.parse(user).teacher_instruction,
    "生成全新范文，不参考学生回答"
  );
});

test("sample essay prompts exclude review-only contracts (no C3 schema, localization, or feedback structure)", () => {
  for (const [taskType, question] of [
    ["email", emailQuestion()],
    ["academic_discussion", discussionQuestion()]
  ]) {
    const messages = buildWritingSampleEssayMessages({
      taskType,
      question,
      responseText,
      teacherInstruction: "保持学生思路"
    });
    const joined = messages.map((message) => message.content).join("\n");
    for (const forbidden of [
      "unit_revisions",
      "language_edits",
      "content_feedback",
      "writing_review_c3",
      "json_schema",
      "TPS_UNIT",
      "official_score",
      "proposed_revision",
      "feedback_id"
    ]) {
      assert.equal(joined.includes(forbidden), false, `must not include ${forbidden}`);
    }
    assert.ok(joined.includes("Return only the model response itself."));
  }
});

test("sample essay response parsing trims, unwraps a single fence, and rejects empty or marker text", () => {
  assert.equal(parseWritingSampleEssayText("  Hello essay.  "), "Hello essay.");
  assert.equal(parseWritingSampleEssayText("```\nHello essay.\n```"), "Hello essay.");
  assert.equal(parseWritingSampleEssayText("```text\nHello essay.\n```"), "Hello essay.");
  assert.throws(
    () => parseWritingSampleEssayText("   "),
    (error) => error.code === "AI_RESPONSE_INVALID"
  );
  assert.throws(
    () => parseWritingSampleEssayText("⟦TPS_UNIT:U01⟧text"),
    (error) => error.code === "AI_RESPONSE_INVALID"
  );
});

test("sample essay instruction validation rejects blank, missing, and oversized input", () => {
  assert.equal(parseWritingSampleEssayInstruction({ instruction: "  4 分  " }), "4 分");
  assert.throws(
    () => parseWritingSampleEssayInstruction({}),
    (error) => error.code === "INVALID_TEACHER_INSTRUCTION"
  );
  assert.throws(
    () => parseWritingSampleEssayInstruction({ instruction: " " }),
    (error) => error.code === "INVALID_TEACHER_INSTRUCTION"
  );
  assert.throws(
    () => parseWritingSampleEssayInstruction({ instruction: "x".repeat(2001) }),
    (error) => error.code === "INVALID_TEACHER_INSTRUCTION"
  );
});

// ---------------------------------------------------------------------------
// Sample essay generation service
// ---------------------------------------------------------------------------

function fakeSampleRepository(options = {}) {
  const attempt = options.attempt === undefined
    ? { attempt_id: "attempt-1", assignment_id: null, task_type: "email", question_id: "email-1", response_text: responseText, status: "submitted" }
    : options.attempt;
  const question = options.question === undefined ? emailQuestion() : options.question;
  const calls = { save: [] };
  return {
    calls,
    async findAttempt() {
      return attempt;
    },
    async findQuestion() {
      return question;
    },
    async readSampleEssayState() {
      return options.state ?? null;
    },
    async compareAndSaveSampleEssay(input) {
      calls.save.push(input);
      if (options.conflict) {
        throw new WritingSampleEssayError("SAMPLE_ESSAY_CONFLICT", "conflict", 409);
      }
      return {
        instruction: input.instruction,
        draft: input.draft,
        updated_at: "2026-08-13T12:00:01.000Z"
      };
    }
  };
}

test("successful sample essay generation persists the instruction and draft as one write", async () => {
  const repository = fakeSampleRepository();
  let request = null;
  const result = await generateWritingSampleEssay(
    "attempt-1",
    { instruction: "保留学生思路，生成 4 分水平范文" },
    {
      repository,
      requestAI: async (messages, context) => {
        request = { messages, context };
        return { content: "  Model essay.  " };
      }
    }
  );
  assert.equal(request.context.taskType, "email");
  assert.equal(repository.calls.save.length, 1);
  assert.equal(
    repository.calls.save[0].instruction,
    "保留学生思路，生成 4 分水平范文"
  );
  assert.equal(repository.calls.save[0].draft, "Model essay.");
  assert.equal(repository.calls.save[0].expected, null);
  assert.equal(result.instruction, "保留学生思路，生成 4 分水平范文");
  assert.equal(result.draft, "Model essay.");
});

test("sample essay generation failure never writes a draft", async () => {
  const repository = fakeSampleRepository();
  await assert.rejects(
    generateWritingSampleEssay(
      "attempt-1",
      { instruction: "生成范文" },
      {
        repository,
        requestAI: async () => {
          throw Object.assign(new Error("transport"), { code: "MOONSHOT_REQUEST_FAILED" });
        }
      }
    ),
    (error) => error.code === "AI_SERVICE_ERROR"
  );
  assert.equal(repository.calls.save.length, 0);

  const timeoutRepository = fakeSampleRepository();
  await assert.rejects(
    generateWritingSampleEssay(
      "attempt-1",
      { instruction: "生成范文" },
      {
        repository: timeoutRepository,
        requestAI: async () => {
          throw Object.assign(new Error("timeout"), { code: "AI_REQUEST_TIMEOUT" });
        }
      }
    ),
    (error) => error.code === "AI_REQUEST_TIMEOUT"
  );
  assert.equal(timeoutRepository.calls.save.length, 0);
});

test("sample essay generation validates attempt state, question, and stale writes", async () => {
  await assert.rejects(
    generateWritingSampleEssay(
      "attempt-1",
      { instruction: "生成范文" },
      {
        repository: fakeSampleRepository({ attempt: null }),
        requestAI: async () => ({ content: "essay" })
      }
    ),
    (error) => error.code === "ATTEMPT_NOT_FOUND"
  );
  await assert.rejects(
    generateWritingSampleEssay(
      "attempt-1",
      { instruction: "生成范文" },
      {
        repository: fakeSampleRepository({
          attempt: { attempt_id: "attempt-1", task_type: "email", question_id: "email-1", response_text: responseText, status: "draft" }
        }),
        requestAI: async () => ({ content: "essay" })
      }
    ),
    (error) => error.code === "ATTEMPT_NOT_SUBMITTED"
  );
  await assert.rejects(
    generateWritingSampleEssay(
      "attempt-1",
      { instruction: "生成范文" },
      {
        repository: fakeSampleRepository({ question: null }),
        requestAI: async () => ({ content: "essay" })
      }
    ),
    (error) => error.code === "QUESTION_NOT_FOUND"
  );
  await assert.rejects(
    generateWritingSampleEssay(
      "attempt-1",
      { instruction: "生成范文" },
      {
        repository: fakeSampleRepository({
          state: { instruction: "old", draft: "old draft", updated_at: null },
          conflict: true
        }),
        requestAI: async () => ({ content: "new essay" })
      }
    ),
    (error) => error.code === "SAMPLE_ESSAY_CONFLICT" && error.status === 409
  );
});

// ---------------------------------------------------------------------------
// Publish / draft separation
// ---------------------------------------------------------------------------

test("Publish copies the current sample draft into the published snapshot only when one exists", () => {
  const draft = manualEmailDraft();
  const withSample = buildWritingReviewPublishUpdate(
    draft,
    "2026-08-13T12:00:00.000Z",
    "V1 essay"
  );
  assert.equal(withSample.published_sample_essay, "V1 essay");
  assert.equal(withSample.status, "published");

  const withoutSample = buildWritingReviewPublishUpdate(
    draft,
    "2026-08-13T12:00:00.000Z",
    null
  );
  assert.equal("published_sample_essay" in withoutSample, false);
  const blankSample = buildWritingReviewPublishUpdate(
    draft,
    "2026-08-13T12:00:00.000Z",
    "   "
  );
  assert.equal("published_sample_essay" in blankSample, false);
});

test("a newer sample draft marks the published snapshot as out of date so Publish runs again", () => {
  const draft = manualEmailDraft();
  const publishedV1 = {
    ...buildWritingReviewPublishUpdate(draft, "2026-08-13T12:00:00.000Z", "V1"),
    published_at: "2026-08-13T12:00:00.000Z",
    sample_essay_draft: "V2"
  };
  assert.equal(publishedSnapshotMatchesDraft(publishedV1, draft), false);

  const publishedV2 = { ...publishedV1, published_sample_essay: "V2" };
  assert.equal(publishedSnapshotMatchesDraft(publishedV2, draft), true);

  const noSample = {
    ...buildWritingReviewPublishUpdate(draft, "2026-08-13T12:00:00.000Z", null),
    published_at: "2026-08-13T12:00:00.000Z",
    sample_essay_draft: null
  };
  assert.equal(publishedSnapshotMatchesDraft(noSample, draft), true);
});

// ---------------------------------------------------------------------------
// Integrated draft/published lifecycle across workspace and student APIs
// ---------------------------------------------------------------------------

function fakeDb(tables) {
  let clock = 0;
  return {
    tables,
    from(table) {
      const filters = [];
      let update;
      let insert;
      const query = {
        select() { return query; },
        eq(column, value) { filters.push([column, value]); return query; },
        is(column, value) { filters.push([column, value]); return query; },
        update(value) { update = structuredClone(value); return query; },
        insert(value) { insert = structuredClone(value); return query; },
        async maybeSingle() {
          const rows = tables[table] ?? [];
          const matches = (row) => filters.every(([column, value]) => row[column] === value);
          if (update) {
            const row = rows.find(matches);
            if (!row) return { data: null, error: null };
            clock += 1;
            Object.assign(row, update, {
              updated_at: `2026-08-13T12:00:${String(clock).padStart(2, "0")}.000Z`
            });
            return { data: structuredClone(row), error: null };
          }
          if (insert) {
            if (table === "writing_reviews" && rows.some((row) => row.attempt_id === insert.attempt_id)) {
              return { data: null, error: { code: "23505", message: "duplicate" } };
            }
            rows.push(structuredClone(insert));
            return { data: structuredClone(rows[rows.length - 1]), error: null };
          }
          const row = rows.find(matches) ?? null;
          return { data: row ? structuredClone(row) : null, error: null };
        }
      };
      return query;
    }
  };
}

function fakeFamilyTables(overrides = {}) {
  const review = {
    review_id: "review-1",
    attempt_id: "attempt-1",
    task_type: "email",
    status: "reviewing",
    ai_model: null,
    ai_generated_at: null,
    ai_review_raw: null,
    ...buildWritingReviewSaveUpdate(manualEmailDraft()),
    published_language_edits: null,
    published_scores: null,
    published_content_feedback: null,
    published_teacher_comment: null,
    published_sample_essay: null,
    sample_essay_instruction: null,
    sample_essay_draft: null,
    published_at: null,
    updated_at: "2026-08-13T08:05:00.000Z",
    ...overrides
  };
  return {
    writing_attempts: [{
      attempt_id: "attempt-1",
      user_id: "student-1",
      task_type: "email",
      question_id: "email-1",
      set_id: "set-1",
      response_text: responseText,
      word_count: 8,
      status: "submitted",
      writing_mode: "practice",
      elapsed_seconds: 100,
      overtime_ranges: null,
      submitted_at: "2026-08-13T08:00:00.000Z"
    }],
    profiles: [{ id: "student-1", email: "student@example.com", full_name: "Student One" }],
    email_questions: [emailQuestion()],
    academic_discussion_questions: [],
    writing_reviews: [review]
  };
}

function sampleRepositoryForDb(db, tables) {
  return {
    async findAttempt() {
      return tables.writing_attempts[0] ?? null;
    },
    async findQuestion() {
      return tables.email_questions[0] ?? null;
    },
    async readSampleEssayState(attemptId) {
      const { data } = await db.from("writing_reviews").select().eq("attempt_id", attemptId).maybeSingle();
      if (!data) return null;
      return {
        instruction: data.sample_essay_instruction ?? null,
        draft: data.sample_essay_draft ?? null,
        updated_at: data.updated_at ?? null
      };
    },
    async compareAndSaveSampleEssay({ attemptId, expected, instruction, draft }) {
      let query = db.from("writing_reviews")
        .update({ sample_essay_instruction: instruction, sample_essay_draft: draft })
        .eq("attempt_id", attemptId);
      if (expected) {
        query = expected.instruction === null
          ? query.is("sample_essay_instruction", null)
          : query.eq("sample_essay_instruction", expected.instruction);
        query = expected.draft === null
          ? query.is("sample_essay_draft", null)
          : query.eq("sample_essay_draft", expected.draft);
      }
      const { data } = await query.maybeSingle();
      if (!data) {
        throw new WritingSampleEssayError("SAMPLE_ESSAY_CONFLICT", "conflict", 409);
      }
      return {
        instruction: data.sample_essay_instruction ?? null,
        draft: data.sample_essay_draft ?? null,
        updated_at: data.updated_at ?? null
      };
    }
  };
}

async function generateInto(db, tables, instruction, essay) {
  return generateWritingSampleEssay("attempt-1", { instruction }, {
    repository: sampleRepositoryForDb(db, tables),
    requestAI: async () => ({ content: essay })
  });
}

test("generate V1 → publish V1 → generate V2 → publish V2 keeps student visibility one step behind", async () => {
  const tables = fakeFamilyTables();
  const db = fakeDb(tables);
  const draft = manualEmailDraft();

  // 12/13: generation persists instruction + draft; workspace restores both.
  await generateInto(db, tables, "生成 4 分水平范文", "V1 essay");
  const workspaceAfterV1 = await loadWritingReviewWorkspace(db, "attempt-1");
  assert.equal(workspaceAfterV1.review.sample_essay_instruction, "生成 4 分水平范文");
  assert.equal(workspaceAfterV1.review.sample_essay_draft, "V1 essay");
  assert.equal(workspaceAfterV1.review.published_sample_essay, null);

  // Student sees nothing before Publish.
  await assert.rejects(
    loadStudentPublishedWritingReview(db, "student-1", "attempt-1"),
    (error) => error.code === "REVIEW_NOT_PUBLISHED"
  );

  // 14: Publish V1 exposes V1 to the student.
  await saveWritingReviewWorkspace(db, "attempt-1", draft, {
    publish: true,
    now: () => new Date("2026-08-14T08:00:00.000Z")
  });
  const studentAfterPublish = await loadStudentPublishedWritingReview(db, "student-1", "attempt-1");
  assert.equal(studentAfterPublish.review.sample_essay, "V1 essay");

  // 15: V2 draft (not published yet): teacher sees V2, student still sees V1.
  await generateInto(db, tables, "语言更简单一些", "V2 essay");
  const workspaceAfterV2 = await loadWritingReviewWorkspace(db, "attempt-1");
  assert.equal(workspaceAfterV2.review.sample_essay_draft, "V2 essay");
  assert.equal(workspaceAfterV2.review.published_sample_essay, "V1 essay");
  const studentBeforeRepublish = await loadStudentPublishedWritingReview(db, "student-1", "attempt-1");
  assert.equal(studentBeforeRepublish.review.sample_essay, "V1 essay");
  assert.equal(JSON.stringify(studentBeforeRepublish).includes("V2 essay"), false);

  // 16: Publish again switches the student to V2 without touching review content.
  const reviewContentBefore = structuredClone(tables.writing_reviews[0].published_content_feedback);
  await saveWritingReviewWorkspace(db, "attempt-1", draft, {
    publish: true,
    now: () => new Date("2026-08-15T08:00:00.000Z")
  });
  assert.deepEqual(tables.writing_reviews[0].published_content_feedback, reviewContentBefore);
  const studentAfterRepublish = await loadStudentPublishedWritingReview(db, "student-1", "attempt-1");
  assert.equal(studentAfterRepublish.review.sample_essay, "V2 essay");
});

test("an already published review can add its first sample essay and publish it without changing the review content", async () => {
  const draft = manualEmailDraft();
  const firstPublished = buildWritingReviewPublishUpdate(
    draft,
    "2026-08-13T12:00:00.000Z"
  );
  const tables = fakeFamilyTables({
    status: "published",
    ...firstPublished,
    published_at: "2026-08-13T12:00:00.000Z"
  });
  const db = fakeDb(tables);

  await generateInto(db, tables, "保留学生思路，补充支持细节", "Sample for a published review");
  const studentBeforePublish = await loadStudentPublishedWritingReview(db, "student-1", "attempt-1");
  assert.equal(studentBeforePublish.review.sample_essay, null);

  await saveWritingReviewWorkspace(db, "attempt-1", draft, {
    publish: true,
    now: () => new Date("2026-08-16T08:00:00.000Z")
  });
  const studentAfterPublish = await loadStudentPublishedWritingReview(db, "student-1", "attempt-1");
  assert.equal(studentAfterPublish.review.sample_essay, "Sample for a published review");
  assert.deepEqual(
    tables.writing_reviews[0].published_language_edits,
    firstPublished.published_language_edits
  );
  assert.deepEqual(
    tables.writing_reviews[0].published_scores,
    firstPublished.published_scores
  );
  assert.equal(tables.writing_reviews[0].published_at, "2026-08-16T08:00:00.000Z");
});

test("a review published without a sample essay is never given an empty student essay", async () => {
  const draft = manualEmailDraft();
  const tables = fakeFamilyTables({
    status: "published",
    ...buildWritingReviewPublishUpdate(draft, "2026-08-13T12:00:00.000Z"),
    published_at: "2026-08-13T12:00:00.000Z",
    sample_essay_draft: null,
    published_sample_essay: null
  });
  const db = fakeDb(tables);
  const payload = await loadStudentPublishedWritingReview(db, "student-1", "attempt-1");
  assert.equal(payload.review.sample_essay, null);
  assert.equal("sample_essay" in payload.review, true);
});

test("repeated Publish with an up-to-date sample snapshot stays a no-op", async () => {
  const draft = manualEmailDraft();
  const tables = fakeFamilyTables();
  const db = fakeDb(tables);
  await generateInto(db, tables, "生成范文", "V1 essay");
  await saveWritingReviewWorkspace(db, "attempt-1", draft, {
    publish: true,
    now: () => new Date("2026-08-14T08:00:00.000Z")
  });
  const updatedAtAfterFirstPublish = tables.writing_reviews[0].updated_at;
  const publishedAtAfterFirstPublish = tables.writing_reviews[0].published_at;

  await saveWritingReviewWorkspace(db, "attempt-1", draft, {
    publish: true,
    now: () => new Date("2026-08-15T08:00:00.000Z")
  });
  assert.equal(tables.writing_reviews[0].updated_at, updatedAtAfterFirstPublish);
  assert.equal(tables.writing_reviews[0].published_at, publishedAtAfterFirstPublish);
});

test("Save never writes any published sample field", async () => {
  const tables = fakeFamilyTables();
  const db = fakeDb(tables);
  await generateInto(db, tables, "生成范文", "draft essay");
  await saveWritingReviewWorkspace(db, "attempt-1", manualEmailDraft());
  assert.equal(tables.writing_reviews[0].published_sample_essay, null);
  assert.equal(tables.writing_reviews[0].status, "reviewing");
});

// ---------------------------------------------------------------------------
// Source wiring: tabs, isolation, and AI log operation
// ---------------------------------------------------------------------------

test("teacher workspace exposes the 范文 mode with an isolated sample-essay action", () => {
  const teacher = read("components/teacher/TeacherWritingReviewWorkspace.tsx");
  assert.match(teacher, /type WorkspaceMode = "workspace" \| "original" \| "revised" \| "sample"/);
  assert.match(teacher, /<ModeButton active=\{mode === "sample"\} onClick=\{\(\) => setMode\("sample"\)\}>/);
  assert.match(teacher, /范文/);
  assert.match(teacher, /生成范文/);
  assert.match(teacher, /正在生成\.\.\./);
  assert.match(teacher, /\/sample-essay\/generate/);
  assert.match(teacher, /sample_essay_draft/);
  // Sample generation must never be routed through the review regeneration calls.
  assert.doesNotMatch(teacher, /generateSampleEssay[\s\S]{0,400}regenerate-ai/);
});

test("student review renders the 范文 tab only from the published snapshot", () => {
  const student = read("components/student/StudentWritingReview.tsx");
  assert.match(student, /type ReviewView = "marked" \| "revised" \| "original" \| "question" \| "sample"/);
  assert.match(student, /hasSampleEssay \? \(/);
  assert.match(student, />范文<\/ReviewViewTab>/);
  assert.match(student, /view === "sample"/);
  assert.match(student, /whitespace-pre-wrap">\{sampleEssay\}/);
  // The student page never receives the teacher instruction or draft fields.
  assert.doesNotMatch(student, /sample_essay_instruction|sample_essay_draft/);
});

test("sample essay generation is logged as its own operation with its own route", () => {
  const route = read("app/api/teacher/writing/reviews/[attemptId]/sample-essay/generate/route.ts");
  const aiLog = read("lib/writingReviewAiLog.ts");
  const logs = read("components/teacher/TeacherWritingAiLogs.tsx");
  assert.match(route, /operation: "sample_essay_generate"/);
  assert.match(route, /requestWritingReviewTextOutput/);
  assert.match(route, /WRITING_SAMPLE_ESSAY_PROMPT_VERSION/);
  assert.match(route, /persistWritingReviewAiLogBestEffort/);
  assert.doesNotMatch(route, /jsonSchema|JSON_SCHEMA|writingReviewC3JsonSchema/);
  assert.match(aiLog, /"sample_essay_generate"/);
  assert.match(logs, /sample_essay_generate/);
});

test("teacher routes for full review regeneration remain untouched by the sample essay path", () => {
  const generateAi = read("app/api/teacher/writing/reviews/[attemptId]/generate-ai/route.ts");
  const regenerateAi = read("app/api/teacher/writing/reviews/[attemptId]/regenerate-ai/route.ts");
  for (const route of [generateAi, regenerateAi]) {
    assert.doesNotMatch(route, /sample[-_]essay/i);
  }
});

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, "..", relativePath), "utf8");
}

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  getOrCreateWritingDraft
} = require("../lib/writingAttemptLifecycle.ts");
const {
  buildWritingAttemptUpdate
} = require("../lib/writing.ts");

function question(taskType = "email") {
  return {
    question_id: taskType === "email" ? "email-question" : "discussion-question",
    set_id: taskType === "email" ? "email-set" : "discussion-set"
  };
}

function attempt({
  assignmentId = null,
  id = "attempt-1",
  taskType = "email",
  status = "draft",
  responseText = "Saved response",
  remainingSeconds = 321
} = {}) {
  const sourceQuestion = question(taskType);
  return {
    attempt_id: id,
    assignment_id: assignmentId,
    user_id: "student-1",
    task_type: taskType,
    question_id: sourceQuestion.question_id,
    set_id: sourceQuestion.set_id,
    response_text: responseText,
    word_count: 2,
    status,
    time_limit_seconds: taskType === "email" ? 420 : 600,
    remaining_seconds: remainingSeconds,
    writing_mode: "exam",
    elapsed_seconds: 99,
    overtime_ranges: [],
    started_at: "2026-08-13T00:00:00.000Z",
    saved_at: "2026-08-13T00:01:00.000Z",
    submitted_at: status === "submitted" ? "2026-08-13T00:02:00.000Z" : null,
    created_at: "2026-08-13T00:00:00.000Z",
    updated_at: "2026-08-13T00:01:00.000Z"
  };
}

function createMemoryRepository(initialAttempts = []) {
  const attempts = initialAttempts;
  let insertCount = 0;
  return {
    attempts,
    get insertCount() {
      return insertCount;
    },
    async findDraft({ assignmentId = null, userId, taskType, questionId }) {
      return {
        data:
          attempts.find(
            (item) =>
              item.user_id === userId &&
              item.assignment_id === assignmentId &&
              item.task_type === taskType &&
              item.question_id === questionId &&
              item.status === "draft"
          ) ?? null,
        error: null
      };
    },
    async insertDraft({ assignmentId = null, userId, taskType, question: sourceQuestion, now, writingMode }) {
      insertCount += 1;
      const existingDraft = attempts.find(
        (item) =>
          item.user_id === userId &&
          item.assignment_id === assignmentId &&
          item.task_type === taskType &&
          item.question_id === sourceQuestion.question_id &&
          item.status === "draft"
      );
      if (existingDraft) {
        return {
          data: null,
          error: {
            code: "23505",
            message:
              'duplicate key value violates unique constraint "writing_attempts_one_draft_per_question"'
          }
        };
      }
      const created = {
        ...attempt({
          assignmentId,
          id: `attempt-${attempts.length + 1}`,
          taskType,
          responseText: "",
          remainingSeconds: taskType === "email" ? 420 : 600
        }),
        user_id: userId,
        question_id: sourceQuestion.question_id,
        set_id: sourceQuestion.set_id,
        started_at: now,
        saved_at: null,
        writing_mode: writingMode,
        elapsed_seconds: 0,
        overtime_ranges: []
      };
      attempts.push(created);
      return { data: created, error: null };
    }
  };
}

function createInput(taskType = "email") {
  const sourceQuestion = question(taskType);
  return {
    userId: "student-1",
    taskType,
    questionId: sourceQuestion.question_id,
    question: sourceQuestion,
    writingMode: "exam"
  };
}

test("first entry creates a new draft", async () => {
  const repository = createMemoryRepository();
  const result = await getOrCreateWritingDraft(createInput(), repository);
  assert.equal(result.resumed, false);
  assert.equal(result.attempt.status, "draft");
  assert.equal(repository.insertCount, 1);
});

test("an existing draft is resumed with its text, timer, and attempt ID without insert", async () => {
  const existing = attempt();
  const repository = createMemoryRepository([existing]);
  const result = await getOrCreateWritingDraft(createInput(), repository);
  assert.equal(result.resumed, true);
  assert.equal(result.attempt.attempt_id, "attempt-1");
  assert.equal(result.attempt.response_text, "Saved response");
  assert.equal(result.attempt.remaining_seconds, 321);
  assert.equal(repository.insertCount, 0);
});

test("refresh resumes the same draft", async () => {
  const repository = createMemoryRepository();
  const first = await getOrCreateWritingDraft(createInput(), repository);
  const refreshed = await getOrCreateWritingDraft(createInput(), repository);
  assert.equal(refreshed.attempt.attempt_id, first.attempt.attempt_id);
  assert.equal(refreshed.resumed, true);
  assert.equal(repository.insertCount, 1);
});

test("mode belongs to a new attempt and an existing draft keeps its original mode", async () => {
  const repository = createMemoryRepository();
  const practiceInput = { ...createInput(), writingMode: "practice" };
  const created = await getOrCreateWritingDraft(practiceInput, repository);
  assert.equal(created.attempt.writing_mode, "practice");
  const resumed = await getOrCreateWritingDraft(createInput(), repository);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.attempt.writing_mode, "practice");
});

test("assignment draft preserves every database identity field and stays isolated", async () => {
  for (const [taskType, writingMode, assignmentId] of [
    ["email", "practice", "assignment-email"],
    ["academic_discussion", "exam", "assignment-discussion"]
  ]) {
    const repository = createMemoryRepository();
    const input = { ...createInput(taskType), assignmentId, writingMode };
    const created = await getOrCreateWritingDraft(input, repository);
    assert.equal(created.attempt.assignment_id, assignmentId);
    assert.equal(created.attempt.task_type, taskType);
    assert.equal(created.attempt.question_id, input.questionId);
    assert.equal(created.attempt.user_id, input.userId);
    assert.equal(created.attempt.writing_mode, writingMode);
    const resumed = await getOrCreateWritingDraft(input, repository);
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.attempt.attempt_id, created.attempt.attempt_id);
  }
});

test("ordinary and assignment drafts for the same bank question never resume each other", async () => {
  const repository = createMemoryRepository();
  const ordinary = await getOrCreateWritingDraft(createInput(), repository);
  const assigned = await getOrCreateWritingDraft(
    { ...createInput(), assignmentId: "assignment-1" },
    repository
  );
  assert.notEqual(ordinary.attempt.attempt_id, assigned.attempt.attempt_id);
  assert.equal(ordinary.attempt.assignment_id, null);
  assert.equal(assigned.attempt.assignment_id, "assignment-1");
});

test("submit mutation transitions the current draft to submitted", () => {
  const now = "2026-08-13T01:00:00.000Z";
  const update = buildWritingAttemptUpdate({
    action: "submit",
    now,
    elapsedSeconds: 320,
    overtimeRanges: [{ start: 8, end: 10 }],
    remainingSeconds: 100,
    responseText: "This is my final response."
  });
  assert.deepEqual(update, {
    elapsed_seconds: 320,
    overtime_ranges: [{ start: 8, end: 10 }],
    remaining_seconds: 100,
    response_text: "This is my final response.",
    word_count: 5,
    saved_at: now,
    status: "submitted",
    submitted_at: now
  });
});

test("Retake after submission creates a new draft and preserves the submitted attempt", async () => {
  const submitted = attempt({ status: "submitted" });
  const repository = createMemoryRepository([submitted]);
  const retake = await getOrCreateWritingDraft(createInput(), repository);
  assert.equal(retake.resumed, false);
  assert.notEqual(retake.attempt.attempt_id, submitted.attempt_id);
  assert.equal(repository.attempts[0].status, "submitted");
});

test("one question can accumulate multiple submitted attempts", async () => {
  const repository = createMemoryRepository();
  const submittedIds = [];
  for (let index = 0; index < 3; index += 1) {
    const current = await getOrCreateWritingDraft(createInput(), repository);
    current.attempt.status = "submitted";
    current.attempt.submitted_at = `2026-08-13T0${index}:00:00.000Z`;
    submittedIds.push(current.attempt.attempt_id);
  }
  assert.equal(new Set(submittedIds).size, 3);
  assert.equal(
    repository.attempts.filter((item) => item.status === "submitted").length,
    3
  );
});

test("clicking Retake again resumes the existing Retake draft", async () => {
  const submitted = attempt({ status: "submitted" });
  const repository = createMemoryRepository([submitted]);
  const firstRetake = await getOrCreateWritingDraft(createInput(), repository);
  const secondRetake = await getOrCreateWritingDraft(createInput(), repository);
  assert.equal(secondRetake.resumed, true);
  assert.equal(secondRetake.attempt.attempt_id, firstRetake.attempt.attempt_id);
});

test("a concurrent unique conflict re-reads and returns the winning draft", async () => {
  let draft = null;
  let initialLookups = 0;
  let releaseLookups;
  const lookupGate = new Promise((resolve) => {
    releaseLookups = resolve;
  });
  const repository = {
    async findDraft() {
      if (initialLookups < 2) {
        initialLookups += 1;
        if (initialLookups === 2) releaseLookups();
        await lookupGate;
        return { data: null, error: null };
      }
      return { data: draft, error: null };
    },
    async insertDraft({ taskType }) {
      if (draft) {
        return {
          data: null,
          error: {
            code: "23505",
            message:
              'duplicate key value violates unique constraint "writing_attempts_one_draft_per_question"'
          }
        };
      }
      draft = attempt({ id: "winning-draft", taskType });
      return { data: draft, error: null };
    }
  };

  const [first, second] = await Promise.all([
    getOrCreateWritingDraft(createInput(), repository),
    getOrCreateWritingDraft(createInput(), repository)
  ]);
  assert.equal(first.attempt.attempt_id, "winning-draft");
  assert.equal(second.attempt.attempt_id, "winning-draft");
  assert.equal(
    [first, second].filter((result) => result.recoveredFromConflict).length,
    1
  );
});

test("an unrecoverable unique conflict never exposes the PostgreSQL message", async () => {
  const repository = {
    async findDraft() {
      return { data: null, error: null };
    },
    async insertDraft() {
      return {
        data: null,
        error: {
          code: "23505",
          message:
            'duplicate key value violates unique constraint "writing_attempts_one_draft_per_question"'
        }
      };
    }
  };

  await assert.rejects(
    getOrCreateWritingDraft(createInput(), repository),
    (error) => {
      assert.equal(error.message, "暂时无法进入写作练习，请稍后重试。");
      assert.equal(error.message.includes("duplicate key"), false);
      return true;
    }
  );
});

test("Email and Academic Discussion share the same draft lifecycle", async () => {
  for (const taskType of ["email", "academic_discussion"]) {
    const repository = createMemoryRepository();
    const first = await getOrCreateWritingDraft(createInput(taskType), repository);
    const resumed = await getOrCreateWritingDraft(createInput(taskType), repository);
    assert.equal(first.attempt.task_type, taskType);
    assert.equal(resumed.attempt.attempt_id, first.attempt.attempt_id);
    assert.equal(resumed.resumed, true);
  }
});

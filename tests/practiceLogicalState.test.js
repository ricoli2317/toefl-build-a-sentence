const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  attachLogicalPracticeStudentState
} = require("../lib/practiceLogicalState.ts");

const projectRoot = path.resolve(__dirname, "..");

function item({
  itemId = "item-1",
  taskType = "build_sentence",
  sourceId = "source-canonical",
  setId = taskType === "build_sentence" ? "set-canonical" : null,
  questionId = taskType === "build_sentence" ? null : "question-canonical",
  displayNumber = "057"
} = {}) {
  return {
    item_id: itemId,
    task_type: taskType,
    display_number: displayNumber,
    canonical: {
      source_id: sourceId,
      source_set_id: setId,
      source_question_id: questionId
    }
  };
}

function source({
  itemId = "item-1",
  taskType = "build_sentence",
  sourceId = "source-canonical",
  setId = taskType === "build_sentence" ? "set-canonical" : null,
  questionId = taskType === "build_sentence" ? null : "question-canonical",
  canonical = true
} = {}) {
  return {
    sourceId,
    itemId,
    taskType,
    sourceSetId: setId,
    sourceQuestionId: questionId,
    isCanonical: canonical
  };
}

function basAttempt(attemptId, setId, submittedAt = "2026-08-18T10:00:00.000Z") {
  return {
    attempt_id: attemptId,
    set_id: setId,
    submitted_at: submittedAt,
    created_at: "2026-08-18T09:00:00.000Z"
  };
}

function writingAttempt({
  attemptId,
  assignmentId = null,
  taskType = "email",
  questionId = "question-canonical",
  status = "draft",
  updatedAt = "2026-08-18T10:00:00.000Z",
  submittedAt = status === "submitted" ? updatedAt : null
}) {
  return {
    attempt_id: attemptId,
    assignment_id: assignmentId,
    task_type: taskType,
    question_id: questionId,
    status,
    saved_at: updatedAt,
    submitted_at: submittedAt,
    created_at: "2026-08-18T09:00:00.000Z",
    updated_at: updatedAt
  };
}

function attach({ items, sources, buildSentenceAttempts, writingAttempts }) {
  return attachLogicalPracticeStudentState({
    items,
    sources,
    buildSentenceAttempts,
    writingAttempts
  });
}

test("BAS without attempts is unstarted and starts from the canonical source", () => {
  const result = attach({ items: [item()], sources: [source()] })[0];
  assert.deepEqual(result.student_state, {
    status: "unstarted",
    resume_attempt_id: null,
    latest_attempt_id: null,
    latest_completed_attempt_id: null,
    can_start: true,
    can_resume: false,
    can_retake: false,
    can_view_result: false
  });
  assert.deepEqual(result.actions.start, {
    source_id: "source-canonical",
    source_set_id: "set-canonical",
    source_question_id: null
  });
});

test("BAS completion on a duplicate historical source completes the logical item", () => {
  const sources = [
    source(),
    source({ sourceId: "source-old", setId: "set-old", canonical: false })
  ];
  const result = attach({
    items: [item()],
    sources,
    buildSentenceAttempts: [basAttempt("attempt-old", "set-old")]
  })[0];
  assert.equal(result.student_state.status, "completed");
  assert.equal(result.student_state.latest_attempt_id, "attempt-old");
  assert.deepEqual(result.actions.view_result, {
    attempt_id: "attempt-old",
    source_set_id: "set-old",
    source_question_id: null
  });
  assert.deepEqual(result.actions.retake, {
    source_id: "source-canonical",
    source_set_id: "set-canonical",
    source_question_id: null
  });
});

test("BAS latest attempt uses submitted_at then attempt_id across duplicate sources", () => {
  const result = attach({
    items: [item()],
    sources: [
      source(),
      source({ sourceId: "source-a", setId: "set-a", canonical: false })
    ],
    buildSentenceAttempts: [
      basAttempt("attempt-a", "set-a", "2026-08-18T10:00:00.000Z"),
      basAttempt("attempt-b", "set-canonical", "2026-08-18T10:00:00.000Z")
    ]
  })[0];
  assert.equal(result.student_state.latest_attempt_id, "attempt-b");
  assert.equal(result.student_state.latest_completed_attempt_id, "attempt-b");
  assert.equal(result.actions.view_result.source_set_id, "set-canonical");
});

test("grammar attempts never affect BAS logical state", () => {
  const sources = [
    source(),
    source({ sourceId: "grammar", setId: "grammar-all-conditionals", canonical: false })
  ];
  const result = attach({
    items: [item()],
    sources,
    buildSentenceAttempts: [basAttempt("attempt-grammar", "grammar-all-conditionals")]
  })[0];
  assert.equal(result.student_state.status, "unstarted");
  assert.equal(result.student_state.latest_attempt_id, null);
});

test("wrongbook attempts never affect BAS logical state", () => {
  const result = attach({
    items: [item()],
    sources: [
      source(),
      source({ sourceId: "wrongbook", setId: "wrongbook-student-1", canonical: false })
    ],
    buildSentenceAttempts: [basAttempt("attempt-wrongbook", "wrongbook-student-1")]
  })[0];
  assert.equal(result.student_state.status, "unstarted");
  assert.equal(result.student_state.latest_attempt_id, null);
});

test("BAS exposes no invented resume action because BAS has no persisted draft", () => {
  const result = attach({
    items: [item()],
    sources: [source()],
    buildSentenceAttempts: [basAttempt("attempt-1", "set-canonical")]
  })[0];
  assert.equal(result.student_state.resume_attempt_id, null);
  assert.equal(result.student_state.can_resume, false);
  assert.equal(result.actions.resume, null);
});

test("Writing without attempts is unstarted", () => {
  const writingItem = item({ taskType: "email" });
  const result = attach({
    items: [writingItem],
    sources: [source({ taskType: "email" })]
  })[0];
  assert.equal(result.student_state.status, "unstarted");
  assert.equal(result.student_state.can_start, true);
});

test("free Writing draft is in progress and resumes the exact attempt and raw question", () => {
  const result = attach({
    items: [item({ taskType: "email" })],
    sources: [source({ taskType: "email" })],
    writingAttempts: [writingAttempt({ attemptId: "draft-1" })]
  })[0];
  assert.equal(result.student_state.status, "in_progress");
  assert.equal(result.student_state.resume_attempt_id, "draft-1");
  assert.deepEqual(result.actions.resume, {
    attempt_id: "draft-1",
    source_set_id: null,
    source_question_id: "question-canonical"
  });
});

test("submitted Writing attempt is completed with exact historical result target", () => {
  const result = attach({
    items: [item({ taskType: "email" })],
    sources: [source({ taskType: "email" })],
    writingAttempts: [writingAttempt({ attemptId: "submitted-1", status: "submitted" })]
  })[0];
  assert.equal(result.student_state.status, "completed");
  assert.equal(result.student_state.latest_completed_attempt_id, "submitted-1");
  assert.deepEqual(result.actions.view_result, {
    attempt_id: "submitted-1",
    source_set_id: null,
    source_question_id: "question-canonical"
  });
});

test("newer Writing draft wins current status while preserving latest completed", () => {
  const result = attach({
    items: [item({ taskType: "email" })],
    sources: [source({ taskType: "email" })],
    writingAttempts: [
      writingAttempt({
        attemptId: "submitted-old",
        status: "submitted",
        updatedAt: "2026-08-17T10:00:00.000Z"
      }),
      writingAttempt({
        attemptId: "draft-new",
        updatedAt: "2026-08-18T10:00:00.000Z"
      })
    ]
  })[0];
  assert.equal(result.student_state.status, "in_progress");
  assert.equal(result.student_state.resume_attempt_id, "draft-new");
  assert.equal(result.student_state.latest_attempt_id, "draft-new");
  assert.equal(result.student_state.latest_completed_attempt_id, "submitted-old");
  assert.equal(result.student_state.can_view_result, true);
});

test("duplicate Writing sources aggregate submitted A and draft B into one logical item", () => {
  const result = attach({
    items: [item({ taskType: "email", questionId: "question-b" })],
    sources: [
      source({ taskType: "email", questionId: "question-b" }),
      source({
        taskType: "email",
        sourceId: "source-a",
        questionId: "question-a",
        canonical: false
      })
    ],
    writingAttempts: [
      writingAttempt({
        attemptId: "submitted-a",
        questionId: "question-a",
        status: "submitted",
        updatedAt: "2026-08-17T10:00:00.000Z"
      }),
      writingAttempt({ attemptId: "draft-b", questionId: "question-b" })
    ]
  })[0];
  assert.equal(result.student_state.status, "in_progress");
  assert.equal(result.actions.resume.source_question_id, "question-b");
  assert.equal(result.actions.view_result.source_question_id, "question-a");
});

test("question-bank and custom Assignment attempts are excluded from free-practice state", () => {
  const result = attach({
    items: [item({ taskType: "email" })],
    sources: [source({ taskType: "email" })],
    writingAttempts: [
      writingAttempt({ attemptId: "bank-assignment", assignmentId: "assignment-1" }),
      writingAttempt({
        attemptId: "custom-assignment",
        assignmentId: "assignment-2",
        questionId: "custom:assignment-2",
        status: "submitted"
      })
    ]
  })[0];
  assert.equal(result.student_state.status, "unstarted");
});

test("multiple Writing drafts use updated_at then attempt_id without deleting history", () => {
  const result = attach({
    items: [item({ taskType: "academic_discussion" })],
    sources: [
      source({ taskType: "academic_discussion" }),
      source({
        taskType: "academic_discussion",
        sourceId: "source-old",
        questionId: "question-old",
        canonical: false
      })
    ],
    writingAttempts: [
      writingAttempt({
        attemptId: "draft-a",
        taskType: "academic_discussion",
        questionId: "question-old"
      }),
      writingAttempt({
        attemptId: "draft-b",
        taskType: "academic_discussion"
      })
    ]
  })[0];
  assert.equal(result.student_state.resume_attempt_id, "draft-b");
});

test("multiple submitted Writing attempts use submitted_at then attempt_id", () => {
  const result = attach({
    items: [item({ taskType: "email" })],
    sources: [source({ taskType: "email" })],
    writingAttempts: [
      writingAttempt({ attemptId: "submitted-a", status: "submitted" }),
      writingAttempt({ attemptId: "submitted-b", status: "submitted" })
    ]
  })[0];
  assert.equal(result.student_state.latest_completed_attempt_id, "submitted-b");
});

test("Writing retake targets current canonical raw question, not historical submitted source", () => {
  const result = attach({
    items: [item({ taskType: "email", questionId: "question-current" })],
    sources: [
      source({ taskType: "email", questionId: "question-current" }),
      source({
        taskType: "email",
        sourceId: "source-old",
        questionId: "question-old",
        canonical: false
      })
    ],
    writingAttempts: [
      writingAttempt({
        attemptId: "submitted-old",
        questionId: "question-old",
        status: "submitted"
      })
    ]
  })[0];
  assert.equal(result.actions.view_result.source_question_id, "question-old");
  assert.deepEqual(result.actions.retake, {
    source_id: "source-canonical",
    source_set_id: null,
    source_question_id: "question-current"
  });
});

test("display_number correction leaves item identity and student state unchanged", () => {
  const input = {
    sources: [source({ taskType: "email" })],
    writingAttempts: [writingAttempt({ attemptId: "submitted-1", status: "submitted" })]
  };
  const before = attach({ ...input, items: [item({ taskType: "email", displayNumber: "060" })] })[0];
  const after = attach({ ...input, items: [item({ taskType: "email", displayNumber: "057B" })] })[0];
  assert.equal(before.item_id, after.item_id);
  assert.equal(before.student_state.status, after.student_state.status);
  assert.equal(before.student_state.latest_attempt_id, after.student_state.latest_attempt_id);
});

test("catalog items are aggregated from one batch and student state can load before public sources", () => {
  const items = Array.from({ length: 10 }, (_, index) =>
    item({ itemId: `item-${index}`, setId: `set-${index}` })
  );
  const sources = Array.from({ length: 10 }, (_, index) =>
    source({ itemId: `item-${index}`, setId: `set-${index}` })
  );
  const attempts = Array.from({ length: 10 }, (_, index) =>
    basAttempt(`attempt-${index}`, `set-${index}`)
  );
  const results = attach({ items, sources, buildSentenceAttempts: attempts });
  assert.equal(results.length, 10);
  assert.ok(results.every((result) => result.student_state.status === "completed"));

  const catalogSource = fs.readFileSync(
    path.join(projectRoot, "lib/practiceLogicalCatalog.ts"),
    "utf8"
  );
  assert.match(catalogSource, /catalog\.items\.flatMap/);
  assert.match(catalogSource, /\.from\("attempts"\)[\s\S]*?\.eq\("student_id", input\.studentId\)/);
  assert.match(catalogSource, /\.from\("writing_attempts"\)[\s\S]*?\.eq\("user_id", input\.studentId\)/);
  assert.doesNotMatch(catalogSource, /\.in\("set_id", setIds\)|\.in\("question_id", questionIds\)/);
  assert.doesNotMatch(catalogSource, /catalog\.items\.map\([\s\S]{0,300}\.from\(/);
});

test("practice-catalog passes authenticated student identity into logical state loading", () => {
  const route = fs.readFileSync(
    path.join(projectRoot, "app/api/practice-catalog/route.ts"),
    "utf8"
  );
  assert.match(route, /requireUserWithRole\(bearerToken\(request\), "student"\)/);
  assert.match(route, /studentId: auth\.userId/);
});

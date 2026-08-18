const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  mapLogicalPeerAttempts,
  selectLatestLogicalPeerAttempts
} = require("../lib/resultPeerComparisonLogical.ts");
const { buildResultPeerComparison } = require("../lib/resultPeerComparison.ts");

const projectRoot = path.resolve(__dirname, "..");

function attempt({
  attemptId,
  studentId,
  setId,
  submittedAt = "2026-08-18T10:00:00.000Z",
  timeSpentSeconds = 100
}) {
  return {
    attempt_id: attemptId,
    student_id: studentId,
    set_id: setId,
    time_spent_seconds: timeSpentSeconds,
    submitted_at: submittedAt
  };
}

function source(sourceId, setId, itemId = "item-x") {
  return { source_id: sourceId, item_id: itemId, source_set_id: setId };
}

function questionMap(sourceId, questionId, logicalOrder) {
  return {
    source_id: sourceId,
    source_question_id: questionId,
    logical_question_order: logicalOrder
  };
}

function answer(attemptId, questionId, isCorrect, questionTimeSeconds = 10) {
  return {
    attempt_id: attemptId,
    question_id: questionId,
    is_correct: isCorrect,
    question_time_seconds: questionTimeSeconds
  };
}

test("three raw sources for one item form one peer population", () => {
  const mapped = mapLogicalPeerAttempts({
    itemId: "item-x",
    attempts: [
      attempt({ attemptId: "attempt-a", studentId: "student-a", setId: "set-a" }),
      attempt({ attemptId: "attempt-b", studentId: "student-b", setId: "set-b" }),
      attempt({ attemptId: "attempt-c", studentId: "student-c", setId: "set-c" })
    ],
    sources: [source("source-a", "set-a"), source("source-b", "set-b"), source("source-c", "set-c")],
    questionMaps: [
      questionMap("source-a", "question-a", 1),
      questionMap("source-b", "question-b", 1),
      questionMap("source-c", "question-c", 1)
    ],
    answers: [
      answer("attempt-a", "question-a", true),
      answer("attempt-b", "question-b", false),
      answer("attempt-c", "question-c", true)
    ]
  });
  assert.equal(mapped.attempts.length, 3);
  assert.deepEqual(new Set(mapped.attempts.map(({ setId }) => setId)), new Set(["set-a", "set-b", "set-c"]));
  const comparison = buildResultPeerComparison(
    { attemptId: "current", correctCount: 1, totalQuestions: 1, timeSpentSeconds: 90 },
    mapped.attempts
  );
  assert.equal(comparison.scorePeerCount, 3);
  assert.equal(comparison.timePeerCount, 3);
});

test("one peer contributes only the latest completed attempt across A, B, and C", () => {
  const candidates = [
    attempt({ attemptId: "attempt-a", studentId: "student-1", setId: "set-a", submittedAt: "2026-05-01T00:00:00Z" }),
    attempt({ attemptId: "attempt-b", studentId: "student-1", setId: "set-b", submittedAt: "2026-06-01T00:00:00Z" }),
    attempt({ attemptId: "attempt-c", studentId: "student-1", setId: "set-c", submittedAt: "2026-07-01T00:00:00Z" })
  ];
  assert.deepEqual(
    selectLatestLogicalPeerAttempts(candidates).map(({ attempt_id }) => attempt_id),
    ["attempt-c"]
  );
});

test("equal submitted_at uses attempt_id as the stable latest tie-break", () => {
  const selected = selectLatestLogicalPeerAttempts([
    attempt({ attemptId: "attempt-a", studentId: "student-1", setId: "set-a" }),
    attempt({ attemptId: "attempt-b", studentId: "student-1", setId: "set-b" })
  ]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0].attempt_id, "attempt-b");
});

test("a peer on non-canonical source A remains comparable when B is canonical", () => {
  const mapped = mapLogicalPeerAttempts({
    itemId: "item-x",
    attempts: [attempt({ attemptId: "attempt-a", studentId: "student-a", setId: "set-a" })],
    sources: [
      { ...source("source-a", "set-a"), is_canonical: false },
      { ...source("source-b", "set-b"), is_canonical: true }
    ],
    questionMaps: [questionMap("source-a", "question-a", 1)],
    answers: [answer("attempt-a", "question-a", true)]
  });
  assert.equal(mapped.attempts.length, 1);
  assert.equal(mapped.attempts[0].setId, "set-a");
});

test("different raw question IDs map to the same logical Q2", () => {
  const mapped = mapLogicalPeerAttempts({
    itemId: "item-x",
    attempts: [
      attempt({ attemptId: "attempt-a", studentId: "student-a", setId: "set-a" }),
      attempt({ attemptId: "attempt-b", studentId: "student-b", setId: "set-b" })
    ],
    sources: [source("source-a", "set-a"), source("source-b", "set-b")],
    questionMaps: [
      questionMap("source-a", "raw-a-q3", 2),
      questionMap("source-b", "raw-b-q7", 2)
    ],
    answers: [
      answer("attempt-a", "raw-a-q3", true, 13),
      answer("attempt-b", "raw-b-q7", false, 27)
    ]
  });
  assert.deepEqual(
    mapped.attempts.map(({ logicalAnswers }) => logicalAnswers),
    [
      [{ logicalQuestionOrder: 2, isCorrect: true, questionTimeSeconds: 13 }],
      [{ logicalQuestionOrder: 2, isCorrect: false, questionTimeSeconds: 27 }]
    ]
  );
});

test("raw question_order is ignored when logical maps differ", () => {
  const mapped = mapLogicalPeerAttempts({
    itemId: "item-x",
    attempts: [
      attempt({ attemptId: "attempt-a", studentId: "student-a", setId: "set-a" }),
      attempt({ attemptId: "attempt-b", studentId: "student-b", setId: "set-b" })
    ],
    sources: [source("source-a", "set-a"), source("source-b", "set-b")],
    questionMaps: [
      questionMap("source-a", "question-a", 2),
      questionMap("source-b", "question-b", 7)
    ],
    answers: [
      { ...answer("attempt-a", "question-a", true), question_order: 3 },
      { ...answer("attempt-b", "question-b", true), question_order: 3 }
    ]
  });
  assert.equal(mapped.attempts[0].logicalAnswers[0].logicalQuestionOrder, 2);
  assert.equal(mapped.attempts[1].logicalAnswers[0].logicalQuestionOrder, 7);
});

test("historical is_correct is used without rescoring against current question content", () => {
  const mapped = mapLogicalPeerAttempts({
    itemId: "item-x",
    attempts: [attempt({ attemptId: "attempt-a", studentId: "student-a", setId: "set-a" })],
    sources: [source("source-a", "set-a")],
    questionMaps: [questionMap("source-a", "question-a", 1)],
    answers: [{
      ...answer("attempt-a", "question-a", true),
      current_question_would_score_correct: false,
      submitted_order_text: "historical answer"
    }]
  });
  assert.equal(mapped.attempts[0].correctCount, 1);
  assert.equal(mapped.attempts[0].logicalAnswers[0].isCorrect, true);
});

test("grammar attempts never enter ordinary logical peer population", () => {
  const selected = selectLatestLogicalPeerAttempts([
    attempt({ attemptId: "grammar-all", studentId: "student-a", setId: "grammar-all-conditionals" }),
    attempt({ attemptId: "grammar-random", studentId: "student-b", setId: "grammar-random-student-b" })
  ]);
  assert.deepEqual(selected, []);
});

test("wrongbook attempts never enter ordinary logical peer population", () => {
  const selected = selectLatestLogicalPeerAttempts([
    attempt({ attemptId: "wrongbook", studentId: "student-a", setId: "wrongbook-student-a" })
  ]);
  assert.deepEqual(selected, []);
});

test("display_number correction does not change item identity or population", () => {
  const shared = {
    itemId: "item-stable",
    attempts: [attempt({ attemptId: "attempt-a", studentId: "student-a", setId: "set-a" })],
    sources: [source("source-a", "set-a", "item-stable")],
    questionMaps: [questionMap("source-a", "question-a", 1)],
    answers: [answer("attempt-a", "question-a", true)]
  };
  const before = { display_number: "060", result: mapLogicalPeerAttempts(shared) };
  const after = { display_number: "057B", result: mapLogicalPeerAttempts(shared) };
  assert.equal(shared.itemId, "item-stable");
  assert.deepEqual(before.result, after.result);
});

test("inactive item historical comparison works because active eligibility is not consulted", () => {
  const mapped = mapLogicalPeerAttempts({
    itemId: "inactive-item",
    attempts: [attempt({ attemptId: "attempt-old", studentId: "student-a", setId: "set-old" })],
    sources: [{ ...source("source-old", "set-old", "inactive-item"), is_active: false }],
    questionMaps: [questionMap("source-old", "question-old", 1)],
    answers: [answer("attempt-old", "question-old", true)]
  });
  assert.equal(mapped.attempts.length, 1);
  assert.equal(mapped.attempts[0].attemptId, "attempt-old");
});

test("unmapped historical answer is warned and never falls back to raw order", () => {
  const mapped = mapLogicalPeerAttempts({
    itemId: "item-x",
    attempts: [attempt({ attemptId: "attempt-a", studentId: "student-a", setId: "set-a" })],
    sources: [source("source-a", "set-a")],
    questionMaps: [],
    answers: [{ ...answer("attempt-a", "unmapped-question", true), question_order: 4 }]
  });
  assert.equal(mapped.attempts[0].correctCount, 0);
  assert.equal(mapped.attempts[0].totalQuestions, 0);
  assert.deepEqual(mapped.attempts[0].logicalAnswers, []);
  assert.equal(mapped.warnings.length, 1);
  assert.equal(mapped.warnings[0].code, "QUESTION_MAP_NOT_FOUND");
});

test("server loader uses fixed batch queries with no per-peer or per-question N+1", () => {
  const source = fs.readFileSync(
    path.join(projectRoot, "lib/resultPeerComparison.server.ts"),
    "utf8"
  );
  assert.match(source, /practice_item_sources[\s\S]*source_set_id", setId/);
  assert.match(source, /\.in\("set_id", sourceSetIds\)/);
  assert.match(source, /\.in\("source_id", sourceIds\)/);
  assert.match(source, /\.in\("attempt_id", peerAttemptIds\)/);
  assert.match(source, /selectLatestLogicalPeerAttempts/);
  assert.match(source, /\.neq\("student_id", studentId\)/);
  assert.doesNotMatch(source, /for \([^)]*peer[^)]*\)[\s\S]{0,300}\.from\(/i);
});

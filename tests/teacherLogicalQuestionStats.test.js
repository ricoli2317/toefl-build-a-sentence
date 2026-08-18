const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  buildTeacherLogicalQuestionStats
} = require("../lib/teacherLogicalQuestionStats.ts");

const projectRoot = path.resolve(__dirname, "..");

function item(displayNumber = "057A", active = true) {
  return {
    item_id: "item-x",
    task_type: "build_sentence",
    display_number: displayNumber,
    is_active: active
  };
}

function source(sourceId, setId, canonical = false) {
  return {
    source_id: sourceId,
    item_id: "item-x",
    task_type: "build_sentence",
    source_set_id: setId,
    is_canonical: canonical
  };
}

function question(sourceId, setId, rawOrder) {
  return {
    question_id: `${sourceId}-q${rawOrder}`,
    set_id: setId,
    set_title: `${setId} title`,
    question_order: rawOrder,
    prompt: `${sourceId} prompt ${rawOrder}`,
    sentence_template: `${sourceId} [blank] template ${rawOrder}`,
    options_text: `option-${sourceId}-${rawOrder}`,
    correct_order_text: `correct-${sourceId}-${rawOrder}`,
    final_sentence: `final-${sourceId}-${rawOrder}`
  };
}

function mapsFor(sourceId, logicalOrderForRaw = (rawOrder) => rawOrder) {
  return Array.from({ length: 10 }, (_, index) => {
    const rawOrder = index + 1;
    return {
      source_id: sourceId,
      source_question_id: `${sourceId}-q${rawOrder}`,
      source_question_order: rawOrder,
      logical_question_order: logicalOrderForRaw(rawOrder)
    };
  });
}

function questionsFor(sourceId, setId) {
  return Array.from({ length: 10 }, (_, index) => question(sourceId, setId, index + 1));
}

function attempt(attemptId, studentId, setId) {
  return { attempt_id: attemptId, student_id: studentId, set_id: setId };
}

function answer({
  answerId,
  attemptId,
  studentId,
  setId,
  questionId,
  correct,
  submitted = "historical tokens",
  time = 12
}) {
  return {
    attempt_answer_id: answerId,
    attempt_id: attemptId,
    question_id: questionId,
    student_id: studentId,
    set_id: setId,
    submitted_order_text: submitted,
    is_correct: correct,
    question_time_seconds: time
  };
}

function swap(left, right) {
  return (rawOrder) => rawOrder === left ? right : rawOrder === right ? left : rawOrder;
}

function fixture(overrides = {}) {
  const sources = [
    source("source-a", "set-a"),
    source("source-b", "set-b"),
    source("source-c", "set-c", true)
  ];
  return {
    items: [item()],
    sources,
    questionMaps: [
      ...mapsFor("source-a", swap(2, 3)),
      ...mapsFor("source-b", swap(2, 7)),
      ...mapsFor("source-c", swap(2, 9))
    ],
    questions: [
      ...questionsFor("source-a", "set-a"),
      ...questionsFor("source-b", "set-b"),
      ...questionsFor("source-c", "set-c")
    ],
    attempts: [],
    answers: [],
    ...overrides
  };
}

function build(overrides = {}) {
  return buildTeacherLogicalQuestionStats(fixture(overrides));
}

function logicalQuestion(result, order) {
  return result.items[0].questions.find((question) => question.logicalQuestionOrder === order);
}

test("source A raw Q3 and source B raw Q7 aggregate into logical Q2", () => {
  const result = build({
    attempts: [attempt("attempt-a", "student-a", "set-a"), attempt("attempt-b", "student-b", "set-b")],
    answers: [
      answer({ answerId: "answer-a", attemptId: "attempt-a", studentId: "student-a", setId: "set-a", questionId: "source-a-q3", correct: true }),
      answer({ answerId: "answer-b", attemptId: "attempt-b", studentId: "student-b", setId: "set-b", questionId: "source-b-q7", correct: false })
    ]
  });

  const q2 = logicalQuestion(result, 2);
  assert.equal(q2.answerCount, 2);
  assert.equal(q2.correctCount, 1);
  assert.equal(q2.accuracy, 0.5);
  assert.deepEqual(q2.attemptAnswerIds, ["answer-a", "answer-b"]);
});

test("equal raw question_order can map to different logical questions", () => {
  const customMaps = fixture().questionMaps.map((mapping) => {
    if (mapping.source_id === "source-a" && mapping.source_question_order === 4) {
      return { ...mapping, logical_question_order: 5 };
    }
    if (mapping.source_id === "source-a" && mapping.source_question_order === 5) {
      return { ...mapping, logical_question_order: 4 };
    }
    return mapping;
  });
  const result = build({
    questionMaps: customMaps,
    attempts: [attempt("attempt-a", "student-a", "set-a"), attempt("attempt-b", "student-b", "set-b")],
    answers: [
      answer({ answerId: "answer-a", attemptId: "attempt-a", studentId: "student-a", setId: "set-a", questionId: "source-a-q4", correct: true }),
      answer({ answerId: "answer-b", attemptId: "attempt-b", studentId: "student-b", setId: "set-b", questionId: "source-b-q4", correct: true })
    ]
  });

  assert.deepEqual(logicalQuestion(result, 4).attemptAnswerIds, ["answer-b"]);
  assert.deepEqual(logicalQuestion(result, 5).attemptAnswerIds, ["answer-a"]);
});

test("three attempts by the same student all participate", () => {
  const result = build({
    attempts: [
      attempt("attempt-a", "same-student", "set-a"),
      attempt("attempt-b", "same-student", "set-b"),
      attempt("attempt-c", "same-student", "set-c")
    ],
    answers: [
      answer({ answerId: "answer-a", attemptId: "attempt-a", studentId: "same-student", setId: "set-a", questionId: "source-a-q3", correct: true }),
      answer({ answerId: "answer-b", attemptId: "attempt-b", studentId: "same-student", setId: "set-b", questionId: "source-b-q7", correct: false }),
      answer({ answerId: "answer-c", attemptId: "attempt-c", studentId: "same-student", setId: "set-c", questionId: "source-c-q9", correct: true })
    ]
  });

  assert.equal(logicalQuestion(result, 2).answerCount, 3);
  assert.equal(logicalQuestion(result, 2).accuracy, 2 / 3);
});

test("historical is_correct is used without rescoring", () => {
  const historical = answer({ answerId: "answer-a", attemptId: "attempt-a", studentId: "student-a", setId: "set-a", questionId: "source-a-q3", correct: true });
  historical.current_question_would_score_correct = false;
  const result = build({
    attempts: [attempt("attempt-a", "student-a", "set-a")],
    answers: [historical]
  });

  assert.equal(logicalQuestion(result, 2).correctCount, 1);
  assert.equal(result.mappedAnswers[0].isCorrect, true);
});

test("historical question_time_seconds remains attached after cross-source mapping", () => {
  const result = build({
    attempts: [attempt("attempt-a", "student-a", "set-a"), attempt("attempt-b", "student-b", "set-b")],
    answers: [
      answer({ answerId: "answer-a", attemptId: "attempt-a", studentId: "student-a", setId: "set-a", questionId: "source-a-q3", correct: true, time: 11 }),
      answer({ answerId: "answer-b", attemptId: "attempt-b", studentId: "student-b", setId: "set-b", questionId: "source-b-q7", correct: false, time: 29 })
    ]
  });

  assert.deepEqual(result.mappedAnswers.map(({ questionTimeSeconds }) => questionTimeSeconds), [11, 29]);
});

test("canonical source supplies content while non-canonical answers supply statistics", () => {
  const result = build({
    attempts: [attempt("attempt-a", "student-a", "set-a"), attempt("attempt-b", "student-b", "set-b")],
    answers: [
      answer({ answerId: "answer-a", attemptId: "attempt-a", studentId: "student-a", setId: "set-a", questionId: "source-a-q3", correct: true }),
      answer({ answerId: "answer-b", attemptId: "attempt-b", studentId: "student-b", setId: "set-b", questionId: "source-b-q7", correct: false })
    ]
  });

  const q2 = logicalQuestion(result, 2);
  assert.equal(q2.answerCount, 2);
  assert.equal(q2.representativeQuestion.sourceId, "source-c");
  assert.equal(q2.representativeQuestion.sourceQuestionId, "source-c-q9");
  assert.equal(q2.representativeQuestion.sourceQuestionOrder, 9);
});

test("result always contains exactly Q1 through Q10 in logical order", () => {
  const result = build();
  assert.deepEqual(
    result.items[0].questions.map(({ logicalQuestionOrder }) => logicalQuestionOrder),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  );
  assert.equal(new Set(result.items[0].questions.map(({ logicalQuestionId }) => logicalQuestionId)).size, 10);
});

test("grammar and wrongbook answers cannot enter logical Q statistics", () => {
  const result = build({
    sources: [
      ...fixture().sources,
      source("source-grammar", "grammar-all-tense"),
      source("source-wrongbook", "wrongbook-student")
    ],
    questionMaps: [
      ...fixture().questionMaps,
      ...mapsFor("source-grammar"),
      ...mapsFor("source-wrongbook")
    ],
    attempts: [
      attempt("grammar", "student-a", "grammar-all-tense"),
      attempt("wrongbook", "student-b", "wrongbook-student")
    ],
    answers: [
      answer({ answerId: "grammar-answer", attemptId: "grammar", studentId: "student-a", setId: "grammar-all-tense", questionId: "source-grammar-q1", correct: true }),
      answer({ answerId: "wrongbook-answer", attemptId: "wrongbook", studentId: "student-b", setId: "wrongbook-student", questionId: "source-wrongbook-q1", correct: true })
    ]
  });

  assert.equal(result.mappedAnswers.length, 0);
  assert.equal(logicalQuestion(result, 1).answerCount, 0);
});

test("frequent-wrong inputs aggregate exact historical submitted text across sources", () => {
  const result = build({
    attempts: [attempt("attempt-a", "student-a", "set-a"), attempt("attempt-b", "student-b", "set-b")],
    answers: [
      answer({ answerId: "answer-a", attemptId: "attempt-a", studentId: "student-a", setId: "set-a", questionId: "source-a-q3", correct: false, submitted: "wrong historical A" }),
      answer({ answerId: "answer-b", attemptId: "attempt-b", studentId: "student-b", setId: "set-b", questionId: "source-b-q7", correct: false, submitted: "wrong historical B" })
    ]
  });

  assert.deepEqual(
    result.mappedAnswers.map(({ submittedOrderText }) => submittedOrderText),
    ["wrong historical A", "wrong historical B"]
  );
  assert.equal(logicalQuestion(result, 2).incorrectCount, 2);
});

test("mapped detail rows retain exact answer, attempt, raw set, and raw question identities", () => {
  const result = build({
    attempts: [attempt("exact-attempt", "student-a", "set-a")],
    answers: [answer({ answerId: "exact-answer", attemptId: "exact-attempt", studentId: "student-a", setId: "set-a", questionId: "source-a-q3", correct: false, time: 37 })]
  });

  assert.deepEqual(result.mappedAnswers[0], {
    itemId: "item-x",
    logicalQuestionOrder: 2,
    attemptAnswerId: "exact-answer",
    attemptId: "exact-attempt",
    studentId: "student-a",
    rawSetId: "set-a",
    rawQuestionId: "source-a-q3",
    submittedOrderText: "historical tokens",
    isCorrect: false,
    questionTimeSeconds: 37
  });
});

test("display number correction changes only display metadata", () => {
  const before = buildTeacherLogicalQuestionStats(fixture({ items: [item("060")] }));
  const after = buildTeacherLogicalQuestionStats(fixture({ items: [item("057B")] }));
  assert.equal(before.items[0].itemId, after.items[0].itemId);
  assert.deepEqual(before.items[0].questions, after.items[0].questions);
  assert.equal(after.items[0].displayNumber, "057B");
});

test("inactive item historical logical questions remain available", () => {
  const result = build({ items: [item("057A", false)] });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].isActive, false);
  assert.equal(result.items[0].questions.length, 10);
});

test("missing canonical Q mapping is explicit and never falls back to raw question_order", () => {
  const questionMaps = fixture().questionMaps.filter(
    (mapping) => !(mapping.source_id === "source-c" && mapping.logical_question_order === 2)
  );
  const result = build({ questionMaps });
  const q2 = logicalQuestion(result, 2);
  assert.equal(q2.representativeQuestion, null);
  assert.equal(
    result.warnings.some((warning) =>
      warning.code === "CANONICAL_LOGICAL_ORDER_MISSING" && warning.logicalQuestionOrder === 2
    ),
    true
  );
});

test("API and UI use one batched map and logical identity while preserving raw routes", () => {
  const route = fs.readFileSync(path.join(projectRoot, "app/api/teacher/stats/route.ts"), "utf8");
  const dashboard = fs.readFileSync(path.join(projectRoot, "components/TeacherDashboard.tsx"), "utf8");

  assert.match(route, /Promise\.all\([\s\S]*practice_item_question_map/);
  assert.match(route, /buildTeacherLogicalQuestionStats\(\{[\s\S]*attempts:\s*attemptRows,[\s\S]*answers:\s*answerRows/);
  assert.doesNotMatch(route, /for\s*\([^)]*logicalQuestion[^)]*\)[\s\S]{0,300}\.from\(/i);
  assert.match(dashboard, /key=\{question\.logicalQuestionId\}/);
  assert.match(dashboard, /logicalSet\.itemId\)\}\/questions\/\$\{question\.logicalQuestionOrder\}/);
  assert.match(dashboard, /logicalAnswerIds\.has\(answer\.attemptAnswerId\)/);
  assert.match(dashboard, /logicalQuestion[\s\S]*item\.submittedOrderText/);
  assert.match(dashboard, /rawSet[\s\S]*question\.setId === rawSet\.setId/);
});

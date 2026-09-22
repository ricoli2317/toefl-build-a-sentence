const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  buildReadingAnswerKeyPresentations
} = require("../lib/reading/correctionResult.ts");
const {
  buildTeacherReadingAnswerKeyView
} = require("../lib/teacherReadingQuestionBank.ts");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

test("answer-key presentations format every Reading question type without a student answer", () => {
  const presentations = buildReadingAnswerKeyPresentations({
    questions: [
      { question_id: "q-ctw", question_order: 1, question_type: "ctw", correct_option_id: null, correct_anchor_id: null, correct_sentence_id: null },
      { question_id: "q-rdl", question_order: 1, question_type: "rdl", correct_option_id: "opt-b", correct_anchor_id: null, correct_sentence_id: null },
      { question_id: "q-ins", question_order: 1, question_type: "rap_sentence_insertion", correct_option_id: null, correct_anchor_id: "anchor-2", correct_sentence_id: null },
      { question_id: "q-sel", question_order: 1, question_type: "rap_sentence_selection", correct_option_id: null, correct_anchor_id: null, correct_sentence_id: "sent-3" }
    ],
    options: [
      { question_id: "q-rdl", option_id: "opt-a", option_order: 1, option_text: "A" },
      { question_id: "q-rdl", option_id: "opt-b", option_order: 2, option_text: "B" }
    ],
    ctwSlots: [
      { question_id: "q-ctw", slot_id: "slot-1", slot_order: 1, answer: "They", display_text: "Th__", missing_text: "ey", prefix: "Th" }
    ],
    anchors: [
      { question_id: "q-ins", anchor_id: "anchor-1", anchor_order: 1 },
      { question_id: "q-ins", anchor_id: "anchor-2", anchor_order: 2 }
    ],
    sentences: [
      { sentence_id: "sent-3", sentence_order: 3, sentence_text: "Third." }
    ]
  });

  assert.deepEqual(presentations["q-ctw:slot-1"].correctAnswer, {
    kind: "ctw_word",
    parts: [{ emphasized: false, text: "Th" }, { emphasized: true, text: "ey" }]
  });
  assert.equal(presentations["q-ctw:slot-1"].studentAnswer, "");
  assert.equal(presentations["q-rdl"].correctAnswer.text, "B");
  assert.deepEqual(presentations["q-rdl"].reviewState, {
    correctAnswerId: "opt-b",
    kind: "choice",
    studentAnswerId: null
  });
  assert.equal(presentations["q-ins"].correctAnswer.text, "Position 2");
  assert.equal(presentations["q-ins"].reviewState.kind, "insertion");
  assert.equal(presentations["q-sel"].correctAnswer.text, "Sentence 3");
  assert.equal(presentations["q-sel"].reviewState.kind, "sentence_selection");
});

test("answer-key view builds shared renderer props with correct answers only", () => {
  const view = buildTeacherReadingAnswerKeyView({
    entries: [
      { answerId: "q-ctw:slot-1", questionId: "q-ctw", slotId: "slot-1", order: 1, answer: null, ctwCharacters: ["e", "y"] },
      { answerId: "q-ctw:slot-2", questionId: "q-ctw", slotId: "slot-2", order: 2, answer: null, ctwCharacters: ["a"] },
      { answerId: "q-rdl", questionId: "q-rdl", slotId: null, order: 1, answer: { kind: "choice", optionId: "opt-b" }, ctwCharacters: null }
    ],
    presentations: {
      "q-rdl": {
        correctAnswer: { kind: "text", text: "B" },
        reviewState: { correctAnswerId: "opt-b", kind: "choice", studentAnswerId: null },
        studentAnswer: ""
      }
    }
  });

  assert.deepEqual(view.answers["q-ctw"], {
    kind: "ctw",
    slots: { "slot-1": ["e", "y"], "slot-2": ["a"] }
  });
  assert.deepEqual(view.answers["q-rdl"], { kind: "choice", optionId: "opt-b" });
  assert.deepEqual(
    view.reviewItems.map((item) => [item.answerId, item.isAnswered, item.isCorrect]),
    [["q-ctw:slot-1", true, true], ["q-ctw:slot-2", true, true], ["q-rdl", true, true]]
  );
  assert.equal(view.disclosures["q-rdl"].correctAnswer.text, "B");
});

test("student review and teacher answer key share one read-only rendering shell", () => {
  const practice = read("components/reading/ReadingPractice.tsx");
  assert.match(practice, /export function ReadingReadonlyReviewShell/);
  assert.match(practice, /if \(readOnly\) \{[\s\S]{0,400}ReadingReadonlyReviewShell/);
  assert.equal((practice.match(/answerKeyOnly=\{answerKeyOnly\}/g) ?? []).length, 7);
  assert.equal((practice.match(/answerKeyOnly \? null : \(/g) ?? []).length, 2);
  assert.match(practice, /answerZone=\{readOnly && reviewPresentation && reviewItem/);
  assert.match(practice, /\{canGoNext \|\| readOnly \? \(/);
});

test("teacher Reading detail renders the immersive shared shell without practice actions", () => {
  const ui = read("components/teacher/TeacherReadingQuestionBank.tsx");
  assert.match(ui, /ReadingReadonlyReviewShell/);
  assert.match(ui, /answerKeyOnly/);
  assert.match(ui, /lookupEnabled=\{false\}/);
  assert.doesNotMatch(ui, /student\/reading|forceNew|retake|submit/i);

  const page = read("app/teacher/question-bank/[monthKey]/page.tsx");
  assert.match(page, /itemId\.startsWith\("reading-"\)/);
  assert.match(page, /TeacherReadingQuestionBankItemViewer/);
  assert.match(page, /<TeacherAppShell title="题目详情">/);
});

test("Teacher Reading data reuses the canonical student loader and never touches attempts", () => {
  const loader = read("lib/reading/studentPractice.ts");
  assert.match(loader, /skipRdlAssetVerification/);
  assert.match(loader, /fetchAssets[\s\S]*\? null/);

  const answerKey = read("lib/teacherReadingAnswerKey.server.ts");
  assert.match(answerKey, /from\("reading_questions"\)/);
  assert.match(answerKey, /from\("reading_question_options"\)/);
  assert.match(answerKey, /from\("reading_ctw_slots"\)/);
  assert.match(answerKey, /from\("reading_rap_insertion_anchors"\)/);
  assert.match(answerKey, /from\("reading_passage_sentences"\)/);
  assert.doesNotMatch(answerKey, /reading_attempts|attempt_answers|reading_wrongbook/);
});

test("RDL selection-map logging is disabled when lookup is unavailable", () => {
  const practice = read("components/reading/ReadingPractice.tsx");
  assert.match(practice, /if \(lookupEnabled\) console\.error\("RDL selection map load failed"/);
});

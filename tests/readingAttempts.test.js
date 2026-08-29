const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { groupReadingSourceOccurrences } = require("../lib/reading/grouping.ts");
const { buildReadingSubmissionAnswers } = require("../lib/reading/attempts.ts");
const { toStudentReadingPracticePayload } = require("../lib/reading/studentPractice.ts");

const root = path.join(__dirname, "..");
const migration = fs.readFileSync(path.join(root, "supabase/reading_attempts.sql"), "utf8");
const createRoute = fs.readFileSync(path.join(root, "app/api/reading/attempts/route.ts"), "utf8");
const submitRoute = fs.readFileSync(
  path.join(root, "app/api/reading/attempts/[attemptId]/submit/route.ts"),
  "utf8"
);
const shell = fs.readFileSync(path.join(root, "components/reading/ReadingPractice.tsx"), "utf8");
const resultUi = fs.readFileSync(path.join(root, "components/PracticeResult.tsx"), "utf8");
const source = JSON.parse(fs.readFileSync(
  path.join(root, "data/reading/fixtures/reading-source.fixture.json"),
  "utf8"
));
const packages = groupReadingSourceOccurrences(source.occurrences).packages;

function practiceFor(module) {
  return toStudentReadingPracticePayload(structuredClone(
    packages.find((candidate) => candidate.item.module === module)
  ));
}

test("Reading draft identity is student + logical item + task type with a concurrency guard", () => {
  assert.match(migration, /reading_attempts_one_draft_per_item[\s\S]*student_id, logical_item_id, task_type/);
  assert.match(migration, /where status = 'draft'/);
  assert.match(migration, /on conflict \(student_id, logical_item_id, task_type\)[\s\S]*do nothing/);
  assert.match(createRoute, /get_or_create_reading_attempt/);
  assert.doesNotMatch(createRoute, /occurrence|display.*number/i);
});

test("get-or-create resumes an existing draft or submitted result instead of duplicating it", () => {
  assert.match(migration, /order by \(attempt\.status = 'draft'\) desc, attempt\.created_at desc/);
  assert.match(migration, /'created', v_created, 'resumed', not v_created/);
  assert.match(shell, /attempt\.status === "submitted"/);
  assert.match(shell, /正在打开已提交的练习结果/);
  assert.doesNotMatch(shell, /PracticeResultSummary/);
});

test("CTW submission is slot-level and contains entered letters only", () => {
  const practice = practiceFor("ctw");
  const question = practice.questions[0];
  const firstSlot = question.slots[0];
  const answers = buildReadingSubmissionAnswers(practice, {
    [question.questionId]: {
      kind: "ctw",
      slots: { [firstSlot.slotId]: ["a", "t", "i", "o", "n"] }
    }
  }, { [question.questionId]: 17 });
  assert.equal(answers.length, practice.item.scoringPointCount);
  assert.deepEqual(answers[0], {
    kind: "ctw_slot",
    questionId: question.questionId,
    questionTimeSeconds: 17,
    slotId: firstSlot.slotId,
    studentAnswer: "ation"
  });
  assert.equal(answers[1].studentAnswer, null);
});

test("RDL and RAP submissions preserve stable question and subtype answer IDs", () => {
  const rdl = practiceFor("rdl");
  const rdlQuestion = rdl.questions[0];
  const rdlAnswers = buildReadingSubmissionAnswers(rdl, {
    [rdlQuestion.questionId]: { kind: "choice", optionId: rdlQuestion.options[1].optionId }
  }, { [rdlQuestion.questionId]: 11 });
  assert.deepEqual(rdlAnswers[0], {
    kind: "option",
    questionId: rdlQuestion.questionId,
    questionTimeSeconds: 11,
    studentAnswer: rdlQuestion.options[1].optionId
  });

  const rap = practiceFor("rap");
  const [mc, insertion, selection] = rap.questions;
  const rapAnswers = buildReadingSubmissionAnswers(rap, {
    [mc.questionId]: { kind: "choice", optionId: mc.options[0].optionId },
    [insertion.questionId]: { kind: "insertion", anchorId: insertion.anchors[2].anchorId },
    [selection.questionId]: { kind: "sentence_selection", sentenceId: rap.passage.paragraphs[1].sentences[0].sentenceId }
  }, Object.fromEntries(rap.questions.map((question, index) => [question.questionId, index + 21])));
  assert.deepEqual(rapAnswers.map((answer) => answer.kind), [
    "option", "insertion_anchor", "sentence_selection"
  ]);
  assert.deepEqual(rapAnswers.map((answer) => answer.questionId), rap.questions.map((question) => question.questionId));
});

test("server transaction scores every Reading subtype from authoritative columns", () => {
  assert.match(migration, /lower\(btrim\(submitted\.student_answer\)\) = lower\(slot\.missing_text\)/);
  assert.match(migration, /submitted\.student_answer = question\.correct_option_id/);
  assert.match(migration, /submitted\.student_answer = question\.correct_anchor_id/);
  assert.match(migration, /submitted\.student_answer = question\.correct_sentence_id/);
  assert.match(migration, /count\(\*\) filter \(where answer\.is_correct\)/);
});

test("unanswered scoring points are persisted as incorrect null answers", () => {
  assert.match(migration, /left join lateral[\s\S]*student_answer/);
  assert.match(migration, /coalesce\([\s\S]*false[\s\S]*\)/);
  assert.match(migration, /unanswered_points/);
  assert.match(migration, /nullif\(btrim\(coalesce\(answer\.student_answer, ''\)\), ''\) is null/);
});

test("invalid answer IDs and duplicate stable IDs fail before persistence", () => {
  const duplicateCheck = migration.indexOf("READING_DUPLICATE_ANSWER_ID");
  const membershipCheck = migration.indexOf("READING_ANSWER_ID_NOT_IN_ITEM");
  const firstInsert = migration.indexOf("insert into public.reading_attempt_answers");
  assert.ok(duplicateCheck > 0 && duplicateCheck < firstInsert);
  assert.ok(membershipCheck > duplicateCheck && membershipCheck < firstInsert);
  assert.match(migration, /reading_question_options/);
  assert.match(migration, /reading_rap_insertion_anchors/);
  assert.match(migration, /reading_passage_sentences/);
});

test("ownership and logical-item binding are checked on the locked attempt row", () => {
  assert.match(migration, /attempt\.student_id = v_user_id[\s\S]*attempt\.logical_item_id = p_logical_item_id[\s\S]*for update/);
  assert.match(migration, /auth\.uid\(\)/);
  assert.doesNotMatch(submitRoute, /studentId|userId/);
});

test("submit is one atomic database function and repeated submits return the official result", () => {
  assert.match(submitRoute, /rpc\("submit_reading_attempt_with_times"/);
  assert.match(migration, /if v_attempt\.status = 'submitted' then[\s\S]*alreadySubmitted', true/);
  assert.match(migration, /for update/);
  assert.match(migration, /update public\.reading_attempts[\s\S]*status = 'submitted'/);
  assert.doesNotMatch(submitRoute, /\.from\("reading_attempt_answers"\)|\.insert\(|\.update\(/);
});

test("client cannot submit or receive authoritative score fields", () => {
  assert.match(submitRoute, /p_answers: body\.answers/);
  assert.doesNotMatch(submitRoute, /body\.(correct|score|isCorrect|is_correct)/);
  assert.doesNotMatch(shell, /correctOptionId|correctAnchorId|correctSentenceId|missingText/);
  assert.doesNotMatch(createRoute, /createServiceSupabase/);
});

test("answer rows have slot/question granularity, foreign keys, indexes, and own-row RLS", () => {
  assert.match(migration, /create table if not exists public\.reading_attempt_answers/);
  assert.match(migration, /foreign key \(question_id, logical_item_id\)/);
  assert.match(migration, /foreign key \(question_id, slot_id\)/);
  assert.match(migration, /reading_attempt_answers_slot_identity/);
  assert.match(migration, /reading_attempt_answers_question_identity/);
  assert.match(migration, /students_select_own_reading_attempt_answers/);
});

test("BAS owns the shared PracticeResultSummary and Reading practice does not render a partial result", () => {
  assert.match(resultUi, /export function PracticeResultSummary/);
  assert.match(resultUi, /function ResultSummary[\s\S]*<PracticeResultSummary/);
  assert.doesNotMatch(shell, /import \{ PracticeResultSummary \} from "@\/components\/PracticeResult"/);
  assert.doesNotMatch(shell, /ResultMetricCard|icon=\{Trophy\}|label="正确率"/);
  assert.match(resultUi, /data-testid="reading-result-breakdown"/);
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { normalizeQuestionTimes } = require("../lib/reading/resultSession.ts");

const root = path.join(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");
const practiceUi = read("components/reading/ReadingPractice.tsx");
const resultUi = read("components/reading/ReadingResult.tsx");
const resultRoute = read("app/api/reading/results/[attemptId]/route.ts");
const peerRoute = read("app/api/reading/results/[attemptId]/peer-comparison/route.ts");

test("Reading submit has one success-path result navigation and no partial result render", () => {
  const submitStart = practiceUi.indexOf("const submit = useCallback");
  const submitEnd = practiceUi.indexOf("if (attempt.status === \"submitted\")", submitStart);
  const submitSource = practiceUi.slice(submitStart, submitEnd);
  assert.equal((submitSource.match(/router\.replace\(/g) ?? []).length, 1);
  assert.doesNotMatch(submitSource, /setAttempt\(result\.attempt\)|router\.refresh|window\.location\.reload|setTimeout/);
  assert.doesNotMatch(practiceUi, /PracticeResultSummary/);
});

test("main Reading result and peer comparison use independent requests", () => {
  assert.match(resultUi, /loadReadingResult\(attemptId, session\)/);
  assert.match(resultUi, /loadReadingPeerComparison\(attemptId\)/);
  assert.match(resultUi, /RESULT_COMPARISON_LOADING_TEXT/);
  assert.doesNotMatch(resultUi, /router\.refresh|window\.location\.reload|setTimeout/);
  assert.match(peerRoute, /buildResultPeerComparison/);
  assert.match(peerRoute, /\.eq\("logical_item_id", ownedAttempt\.logical_item_id\)/);
  assert.match(peerRoute, /\.neq\("student_id", auth\.userId\)/);
});

test("Reading result summary is unified and removes duplicate completion copy", () => {
  assert.match(resultUi, /title="练习结果"/);
  assert.doesNotMatch(resultUi, /练习已完成|本次练习用时|itemTitle.*练习结果/);
  assert.match(resultUi, /scoreComparison=\{scoreComparison\}/);
  assert.match(resultUi, /timeComparison=\{timeComparison\}/);
  assert.doesNotMatch(resultUi, /incorrectPoints=|unansweredPoints=|reading-result-breakdown/);
});

test("CTW result renders one paragraph with answer-only state colors", () => {
  assert.match(resultUi, /data-testid="ctw-result-passage"/);
  assert.match(resultUi, /<span>\{segment\.prefix\}<\/span>/);
  assert.match(resultUi, /segment\.studentAnswer \|\| "____"/);
  assert.match(resultUi, /text-student-primary/);
  assert.match(resultUi, /text-student-error/);
  assert.match(resultUi, /className="mt-6 text-sm leading-6 text-student-text"/);
  assert.match(resultUi, /className="mb-4 last:mb-0"/);
  assert.doesNotMatch(resultUi, /正确答案|你的答案|correctAnswer/);
  assert.doesNotMatch(resultRoute, /missing_text|correct_option_id|correct_anchor_id|correct_sentence_id/);
});

test("RDL and RAP share centered state chips with time and neutral unanswered state", () => {
  assert.match(resultUi, /export function ReadingQuestionStatusChips/);
  assert.match(resultUi, /flex flex-wrap justify-center gap-3/);
  assert.match(resultUi, /第\{answer\.order\}题 · \{formatQuestionTime/);
  assert.match(resultUi, /!answer\.isAnswered \? "unanswered"/);
  assert.match(resultUi, /border-student-border bg-student-bg text-student-muted/);
  assert.match(resultUi, /<Link[\s\S]*href=\{`\/student\/reading\/results\/\$\{encodeURIComponent\(attemptId\)\}\/questions\/\$\{questionIndex\}`\}/);
  assert.match(resultRoute, /question_time_seconds/);
  assert.match(resultUi, /if \(seconds === null\) return "时间暂无记录"/);
});

test("question-time normalization keeps only finite non-negative whole seconds", () => {
  assert.deepEqual(normalizeQuestionTimes({ q1: 1.6, q2: -1, q3: Number.NaN, "": 4 }), { q1: 2 });
});

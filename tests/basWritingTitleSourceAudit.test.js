const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const { createHistoricalPracticeDisplayResolver } = require("../lib/historicalPracticeDisplay.ts");

const root = path.join(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

/**
 * The BAS / WE / AD display-title audit:
 *
 *   Every user-visible title of the three logical Writing item types comes from
 *   the current practice item (套题NNN / 题目NNN + 小标题). The stored historical
 *   set_title / source label / date label / Assignment snapshot is provenance
 *   data only and must never become a display fallback again — neither on the
 *   submit hot path nor on any cold result / history / assignment / teacher
 *   read.
 */

function basResolver() {
  return createHistoricalPracticeDisplayResolver({
    items: [{
      item_id: "bas-item",
      task_type: "build_sentence",
      display_number: "143",
      display_title: null,
      is_active: true
    }],
    sources: [{
      source_id: "bas-source",
      item_id: "bas-item",
      task_type: "build_sentence",
      source_set_id: "202609-0915-3",
      source_question_id: null
    }]
  });
}

test("BAS submit hot path resolves the permanent 套题 title instead of the raw set_title", () => {
  const route = read("app/api/submissions/route.ts");
  assert.match(route, /loadBuildSentenceHistoricalPracticeDisplayResolver\(/);
  assert.match(route, /resolveBuildSentence\(\{/);
  assert.match(route, /setTitle: historicalDisplay\.displayName/);
  assert.match(route, /set_title: setTitle/);
  // The raw caller label / stored historical set_title must never be the
  // attempt title again: they are only the resolver's fallback input.
  assert.doesNotMatch(route, /setTitle: body\.setTitle \?\? questionRows\[0\]\?\.set_title/);
  assert.doesNotMatch(route, /setTitle: questionRows\[0\]\?\.set_title/);
});

test("BAS historical set_title 9.15 - 3 resolves to the permanent title on both chains", () => {
  const display = basResolver().resolveBuildSentence({
    fallbackDisplayName: "9.15 - 3",
    rawSetId: "202609-0915-3"
  });
  assert.equal(display.displayName, "套题143");
  assert.equal(display.resolution, "logical");
  // The cold result API and the student practice-history API both run the same
  // resolver before the payload reaches the UI.
  assert.match(read("app/api/attempts/[attemptId]/route.ts"), /historicalDisplay\.displayName/);
  assert.match(read("app/api/practice-history/route.ts"), /enrichBuildSentenceHistoricalAttempts/);
  // The one result UI renders the attempt payload title verbatim.
  const resultUi = read("components/PracticeResult.tsx");
  assert.match(resultUi, /title=\{formatResultSetTitle\(attempt\.set_id, attempt\.set_title\)\}/);
});

test("WE / AD result surfaces render the resolved display_name only", () => {
  const practice = read("components/writing/WritingPractice.tsx");
  assert.match(practice, /setTitle=\{displayName\}/);
  assert.doesNotMatch(practice, /displayName \?\? question\.set_title/);

  const review = read("components/student/StudentWritingReview.tsx");
  assert.match(review, /state\.data\.display_name\}/);
  assert.match(review, /review\.display_name\}/);
  assert.doesNotMatch(review, /display_name \?\? [a-zA-Z.]*set_title/);

  const history = read("components/writing/WritingSubmissionHistory.tsx");
  assert.match(history, /const questionDisplayName = question\.display_name;/);
  assert.doesNotMatch(history, /display_name \?\? [a-zA-Z.]*set_title/);

  const catalog = read("components/writing/WritingCatalog.tsx");
  assert.match(catalog, /setTitle: set\.display_name/);
  assert.doesNotMatch(catalog, /display_name \?\? set\.set_title/);
});

test("the writing attempt APIs resolve the logical display name for every read", () => {
  for (const file of [
    "app/api/writing/attempts/route.ts",
    "app/api/writing/attempts/[attemptId]/route.ts",
    "app/api/writing/reviews/route.ts",
    "app/api/writing/reviews/[attemptId]/route.ts",
    "app/api/writing/catalog/route.ts",
    "app/api/writing/submissions/route.ts",
    "app/api/student/dashboard-summary/route.ts"
  ]) {
    const source = read(file);
    assert.match(
      source,
      /loadWritingHistoricalPracticeDisplayResolver|loadHistoricalPracticeDisplayResolver/,
      file
    );
    assert.match(source, /displayName/, file);
  }
  // The dashboard draft label previously showed the raw email_questions
  // set_title (1.21-1 style); it now resolves the logical题目 title.
  assert.match(read("app/api/student/dashboard-summary/route.ts"), /resolveWritingAttempt\(\{/);
});

test("student, teacher and Assignment reads share the same logical title resolver", () => {
  const helper = read("lib/historicalPracticeDisplay.ts");
  assert.match(helper, /assignmentId: assignment\.assignmentId/);
  // BAS Assignment rows resolve by their raw source set, WE / AD by raw question.
  assert.match(helper, /basResolver\.resolveBuildSentence\(\{/);
  assert.match(helper, /resolveWritingAttempt\(\{/);

  for (const file of [
    "lib/studentWritingAssignments.server.ts",
    "app/api/teacher/writing/assignments/route.ts",
    "app/api/teacher/writing/assignments/[assignmentId]/route.ts",
    "app/api/teacher/writing/assignments/batches/[batchId]/route.ts",
    "app/api/writing/assignments/calendar/route.ts"
  ]) {
    const source = read(file);
    assert.match(source, /loadWritingAssignmentDisplayNames\(/, file);
    assert.match(source, /sourceSetId:/, file);
    assert.match(source, /isAssignmentDisplayNameType/, file);
  }
});

test("Assignment snapshots never replace a resolvable logical title in the UI helpers", () => {
  const assignments = read("lib/writingAssignments.ts");
  const start = assignments.indexOf("export function writingAssignmentQuestionDisplayTitle");
  const body = assignments.slice(start, start + 420);
  assert.match(body, /assignment\.display_name\?\.trim\(\)/);
  assert.doesNotMatch(body, /question_snapshot\?\.set_title/);
});

test("BAS / WE / AD practice and history payloads keep raw ids for identity only", () => {
  // The raw ids (set_id / question_id) stay in payloads for routing, retake and
  // cache keys; they must not be rendered as titles. The student practice
  // history reuses the shared resolver through the teacher build and never
  // renders a raw stored set_title itself.
  const studentHistory = read("lib/studentPracticeHistory.ts");
  assert.doesNotMatch(studentHistory, /attempt\.set_title/);
  assert.doesNotMatch(studentHistory, /titles\.get\(setId\)/);
  const teacherPractice = read("lib/teacherStudentPractice.ts");
  assert.doesNotMatch(
    teacherPractice,
    /input\.basTitles\?\.get\(setId\)\?\.trim\(\) \|\| attempt\.set_title/
  );
});

test("wrongbook surfaces never render raw stored set titles", () => {
  const route = read("app/api/wrong-questions/route.ts");
  const home = read("components/WrongQuestionsHome.tsx");
  // The lightweight home shows task types only; it never renders a raw stored
  // set / question title, so the old overview resolver wiring is gone.
  assert.doesNotMatch(route, /title: attempt\?\.set_title/);
  assert.doesNotMatch(route, /wrongbook_overview_bas_display/);
  assert.doesNotMatch(home, /set_title/);
  // Official BAS titles still resolve through the one shared logical resolver.
  const submissions = read("app/api/submissions/route.ts");
  assert.match(submissions, /displayResolver\.resolveBuildSentence\(/);
  assert.match(submissions, /setTitle: historicalDisplay\.displayName/);
});

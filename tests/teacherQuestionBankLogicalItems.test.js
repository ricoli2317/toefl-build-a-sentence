const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");
const page = read("app/teacher/question-bank/page.tsx");
const itemPage = read("app/teacher/question-bank/[monthKey]/page.tsx");
const legacySetPage = read("app/teacher/question-bank/[monthKey]/[setId]/page.tsx");
const component = read("components/TeacherQuestionBank.tsx");
const api = read("app/api/teacher/question-bank/route.ts");

test("teacher question bank root renders Logical Items with the student shared card", () => {
  assert.match(page, /TeacherQuestionBankCatalog/);
  assert.doesNotMatch(page + component, /PracticeMonthCard|TeacherQuestionBankMonths|month\.month_key/);
  assert.match(component, /PracticeSetCatalogList/);
  assert.match(component, /formatOccurrenceDates\(item\.occurrence_dates\)/);
  assert.match(component, /logicalPracticeItemTitle\(item\)/);
  assert.match(component, /questionCount: item\.question_count/);
});

test("BAS, Email, and AD are explicit Logical Item tabs that preserve type in detail links", () => {
  for (const value of ["build_sentence", "email", "academic_discussion"]) {
    assert.match(component, new RegExp(`taskType: "${value}"`));
  }
  assert.match(component, /\?taskType=\$\{taskType\}&page=\$\{page\}/);
  assert.match(component, /rootHref = `\/teacher\/question-bank\?taskType=\$\{taskType\}&page=\$\{returnPage\}`/);
});

test("teacher API reuses the logical catalog and canonical public universe", () => {
  assert.match(api, /getLogicalPracticeCatalog/);
  assert.match(api, /loadPracticePublicUniverse/);
  assert.match(api, /getPublicCanonicalSource\(itemId\)/);
  assert.match(api, /logicalQuestionOrder/);
  assert.match(api, /questions\.length !== 10/);
  assert.doesNotMatch(api, /display_number\s*=|first_seen_date\s*=|generateLogicalWritingTitle/);
});

test("writing detail reuses only the prompt renderer and never touches attempt lifecycle", () => {
  assert.match(component, /WritingQuestionReview/);
  assert.match(component, /data-readonly-writing-question/);
  for (const forbidden of [
    "WritingPractice",
    "writing_attempts",
    "/api/writing/attempts",
    "Save",
    "Submit",
    "Retake",
    "editor"
  ]) {
    assert.doesNotMatch(component + api, new RegExp(forbidden, "i"));
  }
});

test("legacy month and nested raw-set URLs redirect to the teacher question bank root", () => {
  assert.match(itemPage, /\^\\d\{6\}\$/);
  assert.match(itemPage, /redirect\("\/teacher\/question-bank"\)/);
  assert.match(legacySetPage, /redirect\("\/teacher\/question-bank"\)/);
});

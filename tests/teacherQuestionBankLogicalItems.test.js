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
  assert.match(component, /item\.occurrence_date_counts \?\? item\.occurrence_dates/);
  assert.match(component, /logicalPracticeItemTitle\(item\)/);
  assert.match(component, /questionCount: item\.question_count/);
});

test("BAS, Email, and AD are explicit Logical Item tabs that preserve type in detail links", () => {
  for (const value of ["build_sentence", "email", "academic_discussion"]) {
    assert.match(component, new RegExp(`taskType: "${value}"`));
  }
  assert.match(component, /\?taskType=\$\{taskType\}&page=\$\{visiblePage\}/);
  assert.match(component, /rootHref = `\/teacher\/question-bank\?taskType=\$\{taskType\}&page=\$\{returnPage\}`/);
});

test("question-bank tabs put the three Reading tasks before the three Writing tasks", () => {
  const groups = component.slice(
    component.indexOf("const QUESTION_BANK_TASK_GROUPS"),
    component.indexOf("type TeacherLogicalItem")
  );
  assert.deepEqual(
    [...groups.matchAll(/taskType: "([^"]+)"/g)].map((match) => match[1]),
    ["ctw", "rdl", "rap", "build_sentence", "email", "academic_discussion"]
  );
  assert.ok(groups.indexOf('label: "阅读"') < groups.indexOf('label: "写作"'));
});

test("question-bank tabs use a mobile three-column grid and a desktop row with a group divider", () => {
  const tabs = component.slice(
    component.indexOf("function QuestionBankTaskTabs("),
    component.indexOf("function QuestionBankTaskTab(")
  );
  assert.match(tabs, /grid auto-rows-fr grid-cols-3 gap-2 md:flex md:items-stretch md:gap-3/);
  assert.match(tabs, /<span\s+aria-hidden="true"\s+className="hidden md:block md:w-px md:self-stretch md:bg-student-border"/);
  const reading = tabs.indexOf("readingGroup.tabs.map");
  const divider = tabs.indexOf("<span");
  const writing = tabs.indexOf("writingGroup.tabs.map");
  assert.ok(reading >= 0 && reading < divider && divider < writing);
  assert.equal((tabs.match(/<QuestionBankTaskTab /g) ?? []).length, 2);
  assert.doesNotMatch(tabs, /\{group\.label\}/);
});

test("shared question-bank task tabs retain task links, active state, and equal-width layout", () => {
  const tab = component.slice(
    component.indexOf("function QuestionBankTaskTab("),
    component.indexOf("function TeacherWritingQuestionBankCatalog(")
  );
  assert.match(tab, /const active = tab\.taskType === taskType/);
  assert.match(tab, /aria-current=\{active \? "page" : undefined\}/);
  assert.match(tab, /active \? "student-button-primary" : "student-button-secondary"/);
  assert.match(tab, /min-h-10 w-full flex-1 px-4 text-center/);
  assert.match(tab, /href=\{`\/teacher\/question-bank\?taskType=\$\{tab\.taskType\}`\}/);
  assert.match(tab, /\{tab\.label\}/);
});

test("teacher logical catalog uses one task-scoped request and local discovery pagination", () => {
  assert.match(component, /catalog:\$\{taskType\}`/);
  assert.doesNotMatch(component, /catalog:\$\{taskType\}:\$\{page\}/);
  assert.match(component, /CatalogDiscoveryControls/);
  assert.match(component, /showStatus=\{false\}/);
  assert.match(component, /filterAndSortCatalogItems/);
  assert.match(component, /filteredItems\.slice\(from, from \+ catalog\.pagination\.page_size\)/);
  assert.match(component, /setTimeout\(\(\) => setDebouncedQuery\(controls\.query\), 200\)/);
  assert.match(component, /`\/api\/teacher\/question-bank\?taskType=\$\{taskType\}`/);
  assert.doesNotMatch(component, /api\/teacher\/question-bank\?taskType=\$\{taskType\}&page=/);
  assert.doesNotMatch(component, /student_state|attempts_current_catalog_page/);
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

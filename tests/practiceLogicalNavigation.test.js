const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  LOGICAL_PRACTICE_ROOTS,
  logicalPracticeActionHref,
  parseLogicalCatalogPage
} = require("../lib/practiceLogicalNavigation.ts");
const { getStudentResultNavigation } = require("../lib/studentNavigation.ts");

const projectRoot = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

test("BAS, Email, and AD roots render the corresponding logical practice catalog", () => {
  const roots = [
    ["app/student/practice-sets/page.tsx", "build_sentence"],
    ["app/student/write-email/page.tsx", "email"],
    ["app/student/academic-discussion/page.tsx", "academic_discussion"]
  ];
  for (const [file, taskType] of roots) {
    const source = read(file);
    assert.match(source, /LogicalPracticeCatalog/);
    assert.match(source, new RegExp(`taskType="${taskType}"`));
    assert.match(source, /parseLogicalCatalogPage\(searchParams\.page\)/);
    assert.doesNotMatch(source, /MonthList|WritingMonthList|WritingSetList|SetList/);
  }
});

test("logical root UI reads only practice-catalog and keeps server ordering", () => {
  const source = read("components/LogicalPracticeCatalog.tsx");
  assert.match(source, /\/api\/practice-catalog\?taskType=/);
  assert.match(source, /&page=\$\{page\}/);
  assert.doesNotMatch(source, /\/api\/sets|\/api\/writing\/catalog/);
  assert.match(source, /catalog\.items\.map/);
  assert.doesNotMatch(source, /catalog\.items\.sort/);
});

test("pagination parses and preserves page query values", () => {
  assert.equal(parseLogicalCatalogPage(undefined), 1);
  assert.equal(parseLogicalCatalogPage("2"), 2);
  assert.equal(parseLogicalCatalogPage(["3", "4"]), 3);
  assert.equal(parseLogicalCatalogPage("0"), 1);
  assert.equal(parseLogicalCatalogPage("1.5"), 1);
  const source = read("components/LogicalPracticeCatalog.tsx");
  assert.match(source, /\?page=\$\{page - 1\}/);
  assert.match(source, /\?page=\$\{page \+ 1\}/);
});

test("logical list React identity is item_id and never display_number", () => {
  const source = read("components/LogicalPracticeCatalog.tsx");
  assert.match(source, /setId: item\.item_id/);
  assert.match(read("components/shared/PracticeCatalog.tsx"), /key=\{set\.setId\}/);
  assert.doesNotMatch(source, /setId: item\.display_number/);
});

test("display-number corrections change text only, never action routes", () => {
  const canonical = {
    source_id: "source-1",
    source_set_id: "202608-0818-1",
    source_question_id: null
  };
  const before = { item_id: "item-1", display_number: "060", canonical };
  const after = { ...before, display_number: "057B" };
  assert.equal(before.item_id, after.item_id);
  assert.equal(
    logicalPracticeActionHref("build_sentence", "start", before.canonical),
    logicalPracticeActionHref("build_sentence", "start", after.canonical)
  );
});

test("BAS start and retake use canonical raw set while result uses exact attempt", () => {
  const source = {
    source_id: "canonical-source",
    source_set_id: "canonical-set",
    source_question_id: null
  };
  const historicalResult = {
    attempt_id: "historical-attempt",
    source_set_id: "old-duplicate-set",
    source_question_id: null
  };
  assert.equal(
    logicalPracticeActionHref("build_sentence", "start", source),
    "/student/practice/canonical-set"
  );
  assert.equal(
    logicalPracticeActionHref("build_sentence", "retake", source),
    "/student/practice/canonical-set"
  );
  assert.equal(
    logicalPracticeActionHref("build_sentence", "view_result", historicalResult),
    "/student/results/historical-attempt"
  );
});

test("Writing resume and view routes use exact attempt identities", () => {
  const draft = {
    attempt_id: "draft-attempt",
    source_set_id: null,
    source_question_id: "historical-question"
  };
  const submitted = {
    attempt_id: "submitted-attempt",
    source_set_id: null,
    source_question_id: "old-question"
  };
  assert.equal(
    logicalPracticeActionHref("email", "resume", draft),
    "/student/write-email/practice/historical-question?attempt=draft-attempt"
  );
  assert.equal(
    logicalPracticeActionHref("email", "view_result", submitted),
    "/student/write-email/submission/submitted-attempt"
  );
  assert.equal(
    logicalPracticeActionHref("academic_discussion", "view_result", submitted),
    "/student/academic-discussion/submission/submitted-attempt"
  );
});

test("Writing start and retake target the current canonical raw question", () => {
  const canonical = {
    source_id: "current-source",
    source_set_id: null,
    source_question_id: "current-question"
  };
  assert.equal(
    logicalPracticeActionHref("email", "start", canonical),
    "/student/write-email/practice/current-question"
  );
  assert.equal(
    logicalPracticeActionHref("academic_discussion", "retake", canonical),
    "/student/academic-discussion/practice/current-question?new=1"
  );
});

test("Sidebar and Dashboard task entrances point to canonical logical roots", () => {
  assert.deepEqual(LOGICAL_PRACTICE_ROOTS, {
    build_sentence: "/student/practice-sets",
    email: "/student/write-email",
    academic_discussion: "/student/academic-discussion"
  });
  const shell = read("components/student/StudentShell.tsx");
  assert.match(shell, /href: STUDENT_ROUTES\.buildASentence/);
  assert.match(shell, /href: STUDENT_ROUTES\.writeEmail/);
  assert.match(shell, /href: STUDENT_ROUTES\.academicDiscussion/);
  const dashboard = read("components/student/StudentDashboard.tsx");
  assert.match(dashboard, /href=\{STUDENT_ROUTES\.buildASentence\}/);
  assert.match(dashboard, /href=\{config\.listHref\}/);
  assert.doesNotMatch(dashboard, /href=\{draft\s*\?/);
});

test("old BAS and Writing month-list URLs redirect to canonical roots", () => {
  const redirects = [
    ["app/student/practice-sets/[monthKey]/page.tsx", "buildASentence"],
    ["app/student/sets/[monthKey]/page.tsx", "buildASentence"],
    ["app/student/write-email/[monthKey]/page.tsx", "writeEmail"],
    ["app/student/academic-discussion/[monthKey]/page.tsx", "academicDiscussion"]
  ];
  for (const [file, routeKey] of redirects) {
    const source = read(file);
    assert.match(source, /redirect\(STUDENT_ROUTES\./);
    assert.match(source, new RegExp(`STUDENT_ROUTES\\.${routeKey}`));
    assert.doesNotMatch(source, /MonthList|WritingSetList|SetList/);
  }
});

test("historical practice, result, submission, and submission-history deep links remain", () => {
  const detailRoutes = [
    "app/student/practice/[setId]/page.tsx",
    "app/student/results/[attemptId]/page.tsx",
    "app/student/write-email/practice/[questionId]/page.tsx",
    "app/student/write-email/submission/[attemptId]/page.tsx",
    "app/student/write-email/submissions/[questionId]/page.tsx",
    "app/student/academic-discussion/practice/[questionId]/page.tsx",
    "app/student/academic-discussion/submission/[attemptId]/page.tsx",
    "app/student/academic-discussion/submissions/[questionId]/page.tsx"
  ];
  for (const file of detailRoutes) {
    assert.equal(fs.existsSync(path.join(projectRoot, file)), true);
    assert.doesNotMatch(read(file), /redirect\(STUDENT_ROUTES/);
  }
});

test("public BAS result and Writing return navigation no longer contain a month layer", () => {
  const navigation = getStudentResultNavigation("202608-0818-1");
  assert.equal(navigation.backHref, "/student/practice-sets");
  assert.deepEqual(navigation.crumbs.map(({ label }) => label), [
    "学生首页",
    "套题练习",
    "练习结果"
  ]);
  assert.doesNotMatch(read("components/writing/WritingPractice.tsx"), /listHref[\s\S]{0,140}question\.year_month/);
  assert.match(read("components/writing/WritingSubmissionHistory.tsx"), /const listHref = config\.listHref/);
});

test("free logical roots consume server student_state/actions and cannot count Assignment locally", () => {
  const source = read("components/LogicalPracticeCatalog.tsx");
  assert.match(source, /item\.student_state\.status/);
  assert.match(source, /item\.actions\[actionName\]/);
  assert.doesNotMatch(source, /assignment_id|writing_attempts|question_id\s*===/);
});

test("legacy list and detail APIs remain available for compatibility", () => {
  for (const file of [
    "app/api/sets/route.ts",
    "app/api/sets/[setId]/questions/route.ts",
    "app/api/writing/catalog/route.ts",
    "app/api/writing/attempts/[attemptId]/route.ts"
  ]) {
    assert.equal(fs.existsSync(path.join(projectRoot, file)), true);
  }
});

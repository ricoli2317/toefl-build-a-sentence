const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  getReadingFullSetResultNavigation,
  getReadingResultNavigation,
  getWritingResultNavigation,
  parseReadingResultSource,
  readingFullSetResultHref,
  readingResultHref,
  safeStudentReturnTo,
  writingSubmissionResultHref
} = require("../lib/studentNavigation.ts");

const root = path.join(__dirname, "..");
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), "utf8");

test("fresh Reading results stay in each task catalog", () => {
  const cases = [
    ["ctw", "/student/reading/ctw", "Complete the Words"],
    ["rdl", "/student/reading/rdl", "Read in Daily Life"],
    ["rap", "/student/reading/rap", "Read an Academic Passage"]
  ];
  for (const [taskType, expectedBackHref, expectedCatalogLabel] of cases) {
    const navigation = getReadingResultNavigation(taskType);
    assert.equal(navigation.backHref, expectedBackHref);
    assert.deepEqual(
      navigation.crumbs.map((crumb) => crumb.label),
      ["学生首页", expectedCatalogLabel, "练习结果"]
    );
    assert.equal(navigation.crumbs.some((crumb) => crumb.label === "练习历史"), false);
  }
});

test("fresh Reading Full Set result returns to the Full Set catalog", () => {
  const navigation = getReadingFullSetResultNavigation("20260917A");
  assert.equal(navigation.backHref, "/student/reading/full-sets");
  assert.deepEqual(
    navigation.crumbs.map((crumb) => crumb.label),
    ["学生首页", "Full Set Practice", "20260917A"]
  );
  assert.equal(navigation.crumbs.some((crumb) => crumb.label === "练习历史"), false);
});

test("fresh Writing results return to the matching Writing catalog", () => {
  const cases = [
    ["email", "/student/write-email"],
    ["academic_discussion", "/student/academic-discussion"]
  ];
  for (const [taskType, expectedBackHref] of cases) {
    const navigation = getWritingResultNavigation(taskType);
    assert.deepEqual(navigation, {
      backHref: expectedBackHref,
      backLabel: "返回题目列表"
    });
  }
  assert.deepEqual(getWritingResultNavigation("email", "assignment-1"), {
    backHref: "/student/assignments",
    backLabel: "返回作业"
  });
});

test("Practice History keeps Reading, Full Set, and Writing result navigation in history", () => {
  for (const taskType of ["ctw", "rdl", "rap"]) {
    const navigation = getReadingResultNavigation(taskType, "practice-history");
    assert.equal(navigation.backHref, "/student/practice-history");
    assert.deepEqual(
      navigation.crumbs.map((crumb) => crumb.label),
      ["学生首页", "练习历史", "查看结果"]
    );
  }

  const fullSet = getReadingFullSetResultNavigation("20260917A", "practice-history");
  assert.equal(fullSet.backHref, "/student/practice-history");
  assert.deepEqual(fullSet.crumbs.map((crumb) => crumb.label), [
    "学生首页",
    "练习历史",
    "20260917A"
  ]);

  for (const taskType of ["email", "academic_discussion"]) {
    assert.deepEqual(
      getWritingResultNavigation(taskType, null, "/student/practice-history"),
      { backHref: "/student/practice-history", backLabel: "返回练习历史" }
    );
  }
});

test("result entry context is explicit, refresh-safe, and rejects external return targets", () => {
  assert.equal(readingResultHref("attempt A"), "/student/reading/results/attempt%20A");
  assert.equal(
    readingResultHref("attempt A", "practice-history"),
    "/student/reading/results/attempt%20A?source=practice-history"
  );
  assert.equal(
    readingFullSetResultHref("set A", "attempt A", "practice-history"),
    "/student/reading/full-sets/set%20A/result/attempt%20A?source=practice-history"
  );
  assert.equal(
    writingSubmissionResultHref("email", "attempt A", "/student/practice-history"),
    "/student/write-email/submission/attempt%20A?returnTo=%2Fstudent%2Fpractice-history"
  );
  assert.equal(parseReadingResultSource(["practice-history", "unknown"]), "practice-history");
  assert.equal(parseReadingResultSource("unknown"), undefined);
  assert.equal(safeStudentReturnTo("https://evil.example/student/practice-history"), undefined);
});

test("submit and history routes wire the explicit context into shared Result UIs", () => {
  const readingPractice = read("components/reading/ReadingPractice.tsx");
  const fullSetRunner = read("components/reading/ReadingFullSetRunner.tsx");
  const writingPractice = read("components/writing/WritingPractice.tsx");
  const unifiedHistory = read("lib/unifiedPracticeHistory.ts");
  const readingResultPage = read("app/student/reading/results/[attemptId]/page.tsx");
  const fullSetResultPage = read("app/student/reading/full-sets/[fullSetId]/result/[attemptId]/page.tsx");

  assert.match(readingPractice, /router\.replace\(`\/student\/reading\/results\/\$\{encodeURIComponent\(result\.attempt\.attemptId\)\}`\)/);
  assert.match(fullSetRunner, /actionHref=\{`\$\{STUDENT_ROUTES\.readingFullSets\}/);
  assert.match(writingPractice, /router\.replace\([\s\S]*WRITING_TASK_CONFIG\[taskType\]\.submissionHref/);
  assert.match(unifiedHistory, /readingResultHref\(attemptId, "practice-history"\)/);
  assert.match(unifiedHistory, /readingFullSetResultHref\([\s\S]*"practice-history"/);
  assert.match(unifiedHistory, /writingSubmissionResultHref\([\s\S]*STUDENT_ROUTES\.practiceHistory/);
  assert.match(readingResultPage, /parseReadingResultSource\(searchParams\.source\)/);
  assert.match(fullSetResultPage, /parseReadingResultSource\(searchParams\.source\)/);
});

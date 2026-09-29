const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  assignmentResultNavigation,
  getReadingFullSetResultNavigation,
  getReadingResultNavigation,
  getStudentResultNavigation,
  safeStudentReturnTo,
  withStudentReturnTo
} = require("../lib/studentNavigation.ts");
const {
  studentAssignmentPracticeHref,
  studentAssignmentResultHref
} = require("../lib/studentAssignmentPractice.ts");

const projectRoot = path.resolve(__dirname, "..");
const source = (relativePath) =>
  fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

const ASSIGNMENT_DETAIL = "/student/assignments/batches/group-1";
const DAY_LIST = "/student/assignments/day/2026-09-28";

test("returnTo only accepts same-site /student paths", () => {
  assert.equal(safeStudentReturnTo(ASSIGNMENT_DETAIL), ASSIGNMENT_DETAIL);
  assert.equal(
    safeStudentReturnTo(`${ASSIGNMENT_DETAIL}?returnTo=${encodeURIComponent(DAY_LIST)}`),
    `${ASSIGNMENT_DETAIL}?returnTo=${encodeURIComponent(DAY_LIST)}`
  );
  assert.equal(safeStudentReturnTo("https://evil.example.com/student/x"), undefined);
  assert.equal(safeStudentReturnTo("//evil.example.com/student/x"), undefined);
  assert.equal(safeStudentReturnTo("/teacher/writing/assignments"), undefined);
  assert.equal(safeStudentReturnTo("/student/../teacher/x"), undefined);
  assert.equal(safeStudentReturnTo("\\student\\x"), undefined);
  assert.equal(safeStudentReturnTo(undefined), undefined);
});

test("withStudentReturnTo appends the safe origin and drops everything else", () => {
  assert.equal(
    withStudentReturnTo("/student/results/attempt-1", ASSIGNMENT_DETAIL),
    `/student/results/attempt-1?returnTo=${encodeURIComponent(ASSIGNMENT_DETAIL)}`
  );
  assert.equal(
    withStudentReturnTo("/student/reading/practice/item-1?x=1", DAY_LIST),
    `/student/reading/practice/item-1?x=1&returnTo=${encodeURIComponent(DAY_LIST)}`
  );
  assert.equal(withStudentReturnTo("/student/results/attempt-1", "https://evil.example.com"), "/student/results/attempt-1");
  assert.equal(withStudentReturnTo("/student/results/attempt-1", undefined), "/student/results/attempt-1");
});

test("the result navigations prefer the Assignment origin over the catalog source", () => {
  const reading = getReadingResultNavigation("ctw", "practice-history", DAY_LIST);
  assert.equal(reading.backHref, DAY_LIST);
  assert.deepEqual(reading.crumbs.map((crumb) => crumb.label), ["学生首页", "我的作业", "练习结果"]);

  const readingWithoutReturnTo = getReadingResultNavigation("ctw");
  assert.equal(readingWithoutReturnTo.backHref, "/student/reading/ctw");

  const bas = getStudentResultNavigation("202607-0001", { returnTo: ASSIGNMENT_DETAIL });
  assert.equal(bas.backHref, ASSIGNMENT_DETAIL);

  const fullSet = getReadingFullSetResultNavigation("套题", undefined, ASSIGNMENT_DETAIL);
  assert.equal(fullSet.backHref, ASSIGNMENT_DETAIL);
  assert.equal(
    getReadingFullSetResultNavigation("套题").backHref,
    "/student/reading/full-sets"
  );
  assert.deepEqual(assignmentResultNavigation(DAY_LIST), {
    backHref: DAY_LIST,
    crumbs: [
      { label: "学生首页", href: "/student/sets" },
      { label: "我的作业", href: "/student/assignments" },
      { label: "练习结果" }
    ]
  });
});

test("practice and result hrefs carry the Assignment origin for every item type", () => {
  assert.equal(
    studentAssignmentPracticeHref(
      { assignmentId: "assignment-1", itemId: "EMAIL-1", taskType: "email" },
      ASSIGNMENT_DETAIL
    ),
    `/student/assignments/assignment-1?returnTo=${encodeURIComponent(ASSIGNMENT_DETAIL)}`
  );
  assert.equal(
    studentAssignmentPracticeHref(
      { itemId: null, sourceSetId: "202607-0001", taskType: "build_sentence" },
      ASSIGNMENT_DETAIL
    ),
    `/student/practice/202607-0001?returnTo=${encodeURIComponent(ASSIGNMENT_DETAIL)}`
  );
  assert.equal(
    studentAssignmentPracticeHref({ itemId: "reading-ctw-1", taskType: "ctw" }, ASSIGNMENT_DETAIL),
    `/student/reading/practice/reading-ctw-1?returnTo=${encodeURIComponent(ASSIGNMENT_DETAIL)}`
  );
  assert.equal(
    studentAssignmentPracticeHref({ itemId: "20260901A", taskType: "full_set" }, ASSIGNMENT_DETAIL),
    `/student/reading/full-sets/20260901A?returnTo=${encodeURIComponent(ASSIGNMENT_DETAIL)}`
  );
  assert.equal(
    studentAssignmentResultHref({ attemptId: "attempt-1", itemId: "set-1", taskType: "build_sentence" }, ASSIGNMENT_DETAIL),
    `/student/results/attempt-1?returnTo=${encodeURIComponent(ASSIGNMENT_DETAIL)}`
  );
  assert.equal(
    studentAssignmentResultHref({ attemptId: "attempt-2", itemType: "ctw", itemId: "reading-ctw-1", taskType: "ctw" }, ASSIGNMENT_DETAIL),
    `/student/reading/results/attempt-2?returnTo=${encodeURIComponent(ASSIGNMENT_DETAIL)}`
  );
  assert.equal(
    studentAssignmentResultHref({ attemptId: "attempt-3", itemId: "20260901A", taskType: "full_set" }, ASSIGNMENT_DETAIL),
    `/student/reading/full-sets/20260901A/result/attempt-3?returnTo=${encodeURIComponent(ASSIGNMENT_DETAIL)}`
  );
  // The ordinary catalog link never gains a returnTo.
  assert.equal(
    studentAssignmentPracticeHref({ itemId: "reading-ctw-1", taskType: "ctw" }),
    "/student/reading/practice/reading-ctw-1"
  );
});

test("the Assignment detail keeps its own origin (day list → detail → back)", () => {
  const studentUi = source("components/student/StudentWritingAssignments.tsx");
  // The day list hands its own URL to the group / item card.
  assert.match(studentUi, /returnTo=\{dayHref\}/);
  // The group card opens the detail with that returnTo.
  assert.match(studentUi, /withStudentReturnTo\(\s*\n?\s*`\$\{STUDENT_ROUTES\.assignments\}\/batches/);
  // The detail page keeps its own returnTo for every item card and its back link.
  assert.match(studentUi, /backHref=\{returnTo \?\? STUDENT_ROUTES\.assignments\}/);
  assert.match(studentUi, /const detailHref = withStudentReturnTo\(/);
  assert.match(studentUi, /returnTo=\{detailHref\}/);
  // The batch page validates the querystring origin before using it.
  const batchPage = source("app/student/assignments/batches/[batchId]/page.tsx");
  assert.match(batchPage, /safeStudentReturnTo\(searchParams\.returnTo\)/);
  const dayPage = source("app/student/assignments/day/[date]/page.tsx");
  assert.match(dayPage, /safeStudentReturnTo\(searchParams\.returnTo\)/);
  // The assignment entry passes its own origin into WritingPractice.
  assert.match(source("app/student/assignments/[assignmentId]/page.tsx"), /returnTo=\{safeStudentReturnTo\(searchParams\.returnTo\)\}/);
  assert.match(studentUi, /returnTo=\{returnTo\}/);
});

test("practice and result routes restore the Assignment detail", () => {
  // BAS practice forwards the origin into the result redirect.
  const practiceSession = source("components/PracticeSession.tsx");
  assert.match(practiceSession, /withStudentReturnTo\(`\/student\/results\/\$\{payload\.attemptId\}`, returnTo\)/);
  // WE / AD practice exits to the Assignment origin (never the calendar) and
  // forwards it when submitting.
  const writingPractice = source("components/writing/WritingPractice.tsx");
  assert.match(writingPractice, /safeStudentReturnTo\(returnTo\) \?\? "\/student\/assignments"/);
  assert.match(writingPractice, /router\.replace\(withStudentReturnTo\(/);
  // Reading practice forwards it to the result page and uses it for Back.
  const readingPractice = source("components/reading/ReadingPractice.tsx");
  assert.match(readingPractice, /onBack=\{\(\) => safeReturnTo \? router\.push\(safeReturnTo\) : router\.back\(\)\}/);
  assert.match(readingPractice, /resultReturnTo=\{safeReturnTo\}/);
  assert.match(readingPractice, /withStudentReturnTo\([\s\S]{0,120}\/student\/reading\/results\//);
  // Reading result, BAS result and Full Set result accept and use returnTo.
  assert.match(source("app/student/reading/results/[attemptId]/page.tsx"), /returnTo=\{safeStudentReturnTo/);
  assert.match(source("app/student/results/[attemptId]/page.tsx"), /returnTo=\{safeStudentReturnTo/);
  assert.match(source("components/reading/ReadingResult.tsx"), /getReadingResultNavigation\(attempt\.taskType, source, returnTo\)/);
  assert.match(source("components/PracticeResult.tsx"), /returnTo,\n\s*source/);
  // Full Set: prepare page → attempt runner → result keep the origin.
  assert.match(source("app/student/reading/full-sets/[fullSetId]/page.tsx"), /returnTo=\{safeStudentReturnTo/);
  assert.match(source("app/student/reading/full-sets/[fullSetId]/attempt/[attemptId]/page.tsx"), /returnTo=\{safeStudentReturnTo/);
  assert.match(source("components/reading/ReadingFullSetRunner.tsx"), /withStudentReturnTo\([\s\S]{0,200}\/result\//);
  assert.match(source("components/reading/ReadingFullSetResult.tsx"), /getReadingFullSetResultNavigation\(result\.attempt\.title, source, returnTo\)/);
  // Retake buttons keep the origin for 重新练习.
  assert.match(source("components/reading/ReadingRetakeButton.tsx"), /returnTo\?: string \| string\[\] \| null/);
  assert.match(source("components/reading/ReadingFullSetRetakeButton.tsx"), /returnTo\?: string \| string\[\] \| null/);
  assert.match(source("components/student/StudentWritingAssignments.tsx"), /returnTo=\{returnTo\}/);
});

test("ordinary catalog navigation is unchanged and the detail canvas uses the student shell", () => {
  const shell = source("components/student/StudentShell.tsx");
  // Only the per-item Assignment entry stays immersive; the group detail page
  // renders inside the normal student shell / canvas again.
  assert.match(shell, /\^\\\/student\\\/assignments\\\/\(\?!day\(\?:\\\/\|\$\)\|batches\(\?:\\\/\|\$\)\)\[\^\/\]\+/);
  assert.match(shell, /pathname\.startsWith\("\/student\/reading\/practice\/"\)/);
  // The catalog result pages keep their default back destinations.
  const navigation = source("lib/studentNavigation.ts");
  assert.doesNotMatch(navigation, /router\.back/);
  assert.match(navigation, /backHref: STUDENT_ROUTES\.practiceSets/);
  assert.match(navigation, /backHref: destination\.href/);
  // The student detail / list cards never emit a teacher action.
  const studentUi = source("components/student/StudentWritingAssignments.tsx");
  assert.doesNotMatch(studentUi, /teacher-button|teacherApiFetch|刷新状态|删除作业/);
});

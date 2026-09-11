const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  formatReadingFullSetTime
} = require("../lib/reading/fullSetPresentation.ts");

const root = path.join(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const shell = read("components/student/StudentShell.tsx");
const routes = read("lib/studentNavigation.ts");
const catalog = read("components/reading/ReadingFullSetCatalog.tsx");
const catalogPage = read("app/student/reading/full-sets/page.tsx");
const detail = read("components/reading/ReadingFullSetDetail.tsx");
const detailPage = read("app/student/reading/full-sets/[fullSetId]/page.tsx");

test("student Reading navigation exposes the Full Set catalog without replacing CTW, RDL, or RAP", () => {
  assert.match(routes, /readingFullSets: "\/student\/reading\/full-sets"/);
  assert.match(shell, /href: STUDENT_ROUTES\.readingCtw/);
  assert.match(shell, /href: STUDENT_ROUTES\.readingRdl/);
  assert.match(shell, /href: STUDENT_ROUTES\.readingRap/);
  assert.match(shell, /href: STUDENT_ROUTES\.readingFullSets[\s\S]{0,120}label: "套题练习"/);
  assert.match(shell, /path\.startsWith\(STUDENT_ROUTES\.readingFullSets\)/);
});

test("Full Set catalog consumes the existing catalog API in its original order", () => {
  assert.match(catalog, /fetch\("\/api\/reading\/full-sets"/);
  assert.match(catalog, /state\.data\.fullSets\.map\(\(fullSet\)/);
  assert.doesNotMatch(catalog, /\.sort\(|20260602|blacklist/i);
  assert.match(catalog, /\{fullSet\.title\}/);
  assert.doesNotMatch(catalog, /sourceLabel|occurrenceDate/);
  assert.match(catalogPage, /title="套题练习"/);
  assert.match(catalogPage, /subtitle=/);
});

test("Full Set cards format both legal Module 1 times and the Module 2 time", () => {
  assert.equal(formatReadingFullSetTime(1230), "20:30");
  assert.equal(formatReadingFullSetTime(1110), "18:30");
  assert.equal(formatReadingFullSetTime(540), "9:00");
  assert.match(catalog, /questionCount=\{35\}/);
  assert.match(catalog, /questionCount=\{15\}/);
  assert.match(catalog, /module1TimeLimitSeconds/);
  assert.match(catalog, /module2TimeLimitSeconds/);
  assert.match(catalog, /共 50 题/);
});

test("Full Set UI keeps internal aggregation names out of student-facing rendering", () => {
  const ui = `${catalog}\n${catalogPage}\n${detail}\n${detailPage}`;
  assert.doesNotMatch(ui, /pattern_1|pattern_2|module1Pattern|M1 Pattern/);
  assert.doesNotMatch(ui, /setInterval|deadline|autosave|submitAttempt|createAttempt/);
});

test("Full Set catalog has skeleton, product error, empty state, and retry", () => {
  assert.match(catalog, /ReadingFullSetCatalogSkeleton/);
  assert.match(catalog, /正在加载套题/);
  assert.match(catalog, /套题加载失败，请重试。/);
  assert.match(catalog, /暂无可用套题/);
  assert.match(catalog, /重新加载/);
});

test("Full Set action opens a preparation page backed by the detail API", () => {
  assert.match(catalog, /STUDENT_ROUTES\.readingFullSets.*encodeURIComponent\(fullSet\.fullSetId\)/);
  assert.match(catalog, /开始练习/);
  assert.match(detailPage, /ReadingFullSetDetail/);
  assert.match(detail, /fetch\(`\/api\/reading\/full-sets\/\$\{encodeURIComponent\(fullSetId\)\}`/);
  assert.match(detail, /backHref=\{STUDENT_ROUTES\.readingFullSets\}/);
  assert.match(detail, /两个 Module 分别计时/);
  assert.match(detail, /Module 1 提交后进入 Module 2/);
  assert.match(detail, /每个 Module 开始后独立倒计时/);
  assert.match(detail, /readingFullSetPrepAction/);
  assert.match(detail, /startReadingFullSetAttempt/);
  assert.match(detail, /startReadingFullSetModule2/);
});

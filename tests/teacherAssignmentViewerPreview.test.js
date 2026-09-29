const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const source = (relativePath) =>
  fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

const PAGE = "app/teacher/question-bank/[monthKey]/page.tsx";
const WRITING_VIEWER = "components/TeacherQuestionBank.tsx";
const READING_VIEWER = "components/teacher/TeacherReadingQuestionBank.tsx";
const READING_SHELL = "components/reading/ReadingPractice.tsx";
const PICKER = "components/teacher/TeacherAssignmentCatalogPicker.tsx";

/**
 * 查看题目 opens the existing read-only teacher question route in a new tab
 * with `preview=1`. The standalone mode only ever renders the current question:
 * no shell, no breadcrumbs, no 返回题库, no previous / next and no other entry
 * back into the teacher app.
 */
test("查看题目 opens the standalone preview in a new browser tab", () => {
  const picker = source(PICKER);
  assert.match(
    picker,
    /<Link[\s\S]*?href=\{viewerHref\}[\s\S]*?rel="noopener noreferrer"[\s\S]*?target="_blank"[\s\S]*?>/
  );
  // The link stays outside the row label and never toggles the checkbox.
  const row = picker.match(/function renderSelectableRow[\s\S]*?\n  \}\n\}/)?.[0] ?? "";
  assert.ok(row.indexOf("</label>") < row.indexOf("<Link"));
  assert.match(row, /event\.stopPropagation\(\)/);
});

test("the question-bank item page renders preview mode without the teacher shell", () => {
  const page = source(PAGE);
  assert.match(page, /searchParams\.preview === "1"/);
  // Preview never wraps the writing viewer in the app shell.
  assert.match(page, /if \(preview\) \{[\s\S]{0,400}<TeacherQuestionBankItemViewer[\s\S]{0,120}preview/);
  const previewBranch = page.slice(page.indexOf("if (preview) {"));
  assert.doesNotMatch(previewBranch.slice(0, previewBranch.indexOf("return (")), /TeacherAppShell/);
  // The reading branch is handed the same preview flag.
  assert.match(page, /TeacherReadingQuestionBankItemViewer[\s\S]{0,160}preview=\{preview\}/);
});

test("the writing item viewer hides cross-feature navigation but keeps BAS internal paging", () => {
  const viewer = source(WRITING_VIEWER);
  assert.match(viewer, /preview = false/);
  // Breadcrumbs and 返回教师题库 only exist outside preview.
  assert.match(viewer, /\{preview \? null : \([\s\S]{0,600}TeacherBreadcrumbs[\s\S]{0,600}返回教师题库/);
  // BAS keeps its own 套题内部 navigation (same set, Q1 → Q10) even in preview.
  assert.match(viewer, /<BasLogicalItemViewer[\s\S]{0,160}questions=\{data\.questions \?\? \[\]\}/);
  assert.doesNotMatch(viewer, /\{preview \? null : \([\s\S]{0,200}<QuestionViewerNav/);
  const basViewer = viewer.slice(viewer.indexOf("function BasLogicalItemViewer"));
  assert.match(basViewer, /<QuestionViewerNav[\s\S]{0,160}questionCount=\{questions\.length\}/);
});

test("the reading item viewer renders the standalone read-only shell with internal paging", () => {
  const viewer = source(READING_VIEWER);
  assert.match(viewer, /preview = false/);
  assert.match(viewer, /standalone=\{preview\}/);
  assert.match(viewer, /onBack=\{preview \? undefined : \(\) => router\.push\(bankHref\)\}/);
  assert.match(viewer, /onLeave=\{preview \? undefined : \(\) => router\.push\(bankHref\)\}/);

  const shell = source(READING_SHELL);
  assert.match(shell, /standalone = false/);
  assert.match(shell, /onBack=\{standalone \? undefined : onBack\}/);
  // Previous / Next stay enabled in standalone preview: they only move inside
  // the current logical item's own review items (the answer-key preview steps
  // through slots as well, so CTW 填空 keeps its internal navigation).
  assert.match(shell, /reviewItems\.map\(\(item\) =>\s*\n?\s*answerKeyOnly && item\.slotId \? item\.slotId : item\.questionId/);
  assert.match(shell, /readingQuestionNavigationTargets\(reviewNavigationKeys, reviewIndex\)/);
  assert.match(shell, /canGoNext=\{reviewNavigationTargets\.nextIndex !== null\}/);
  assert.match(shell, /canGoPrevious=\{reviewNavigationTargets\.previousIndex !== null\}/);
  assert.doesNotMatch(shell, /canGoNext=\{!standalone/);
  assert.doesNotMatch(shell, /canGoPrevious=\{!standalone/);
  // The header only renders a Back control when a back handler exists.
  assert.match(shell, /\{onBack \? \([\s\S]{0,300}onClick=\{onBack\}/);
});

test("preview mode is read-only: no edit entry and no question body preloading", () => {
  const page = source(PAGE);
  const viewer = source(WRITING_VIEWER);
  // The existing read-only route/component is reused; no second detail page.
  assert.match(page, /TeacherQuestionBankItemViewer/);
  assert.match(page, /TeacherReadingQuestionBankItemViewer/);
  // No editor is imported into the preview path.
  assert.doesNotMatch(page, /AssignmentForm|Editor/);
  assert.doesNotMatch(viewer, /Builder|Save|提交|编辑/);
});

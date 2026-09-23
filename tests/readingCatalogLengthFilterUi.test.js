const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const root = path.join(__dirname, "..");
const readingCatalog = fs.readFileSync(path.join(root, "components/reading/ReadingCatalog.tsx"), "utf8");
const logicalCatalog = fs.readFileSync(path.join(root, "components/LogicalPracticeCatalog.tsx"), "utf8");
const controls = fs.readFileSync(path.join(root, "components/shared/CatalogDiscoveryControls.tsx"), "utf8");

test("RDL alone injects the length control and six-control layout variant", () => {
  assert.match(readingCatalog, /layoutVariant=\{taskType === "rdl" \? "rdl" : "default"\}/);
  assert.match(readingCatalog, /rdlLengthFilter=\{taskType === "rdl"/);
  assert.doesNotMatch(logicalCatalog, /rdlLengthFilter|layoutVariant/);
});

test("RDL desktop layout keeps one wider search plus five equal controls", () => {
  assert.match(controls, /minmax\(13rem,1\.7fr\)_repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(controls, /layoutVariant === "rdl"/);
  assert.match(controls, /全部篇幅/);
});

test("teacher RDL hides status and uses four equal non-search controls", () => {
  const teacherReading = fs.readFileSync(path.join(root, "components/teacher/TeacherReadingQuestionBank.tsx"), "utf8");
  assert.match(teacherReading, /showStatus=\{false\}/);
  assert.match(controls, /repeat\(4,minmax\(0,1fr\)\)/);
  assert.match(controls, /showStatus = true/);
});

test("length changes stay local and reset pagination without another catalog request", () => {
  assert.match(readingCatalog, /lengthFilter[\s\S]*setPage\(1\)/);
  assert.equal((readingCatalog.match(/fetch\(`/g) || []).length, 1);
  assert.match(readingCatalog, /filterReadingCatalogByLength/);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  applyExternalWritingPaste,
  canUseExternalWritingPaste
} = require("../lib/writingEditorPaste.ts");
const { WRITING_TASK_CONFIG, countEnglishWords } = require("../lib/writing.ts");

test("student@test.com can paste in Write an Email", () => {
  assert.equal(canUseExternalWritingPaste("student@test.com", "email"), true);
  const result = applyExternalWritingPaste({
    currentText: "Hello professor.",
    end: 6,
    overtime: false,
    pastedText: "dear ",
    previousRanges: [],
    start: 6
  });
  assert.equal(result.text, "Hello dear professor.");
  assert.equal(countEnglishWords(result.text), 3);
});

test("student@test.com can paste in Academic Discussion", () => {
  assert.equal(
    canUseExternalWritingPaste("student@test.com", "academic_discussion"),
    true
  );
  const result = applyExternalWritingPaste({
    currentText: "I agree.",
    end: 2,
    overtime: false,
    pastedText: "strongly ",
    previousRanges: [],
    start: 2
  });
  assert.equal(result.text, "I strongly agree.");
  assert.equal(countEnglishWords(result.text), 3);
});

test("all other student emails remain blocked from external writing paste", () => {
  for (const email of ["student2@test.com", "teacher@test.com", "", null, undefined]) {
    assert.equal(canUseExternalWritingPaste(email, "email"), false);
    assert.equal(canUseExternalWritingPaste(email, "academic_discussion"), false);
  }
});

test("allowed paste after either practice threshold enters overtime ranges", () => {
  assert.equal(WRITING_TASK_CONFIG.email.timeLimitSeconds, 7 * 60);
  assert.equal(WRITING_TASK_CONFIG.academic_discussion.timeLimitSeconds, 10 * 60);
  for (const taskType of ["email", "academic_discussion"]) {
    assert.equal(canUseExternalWritingPaste("student@test.com", taskType), true);
    const result = applyExternalWritingPaste({
      currentText: "One two",
      end: 4,
      overtime: true,
      pastedText: "pasted ",
      previousRanges: [],
      start: 4
    });
    assert.equal(result.text, "One pasted two");
    assert.deepEqual(result.overtimeRanges, [{ start: 4, end: 11 }]);
  }
});

test("external paste permission comes from the authenticated session and still commits through the editor", () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), "components/writing/WritingPractice.tsx"),
    "utf8"
  );
  assert.match(source, /canUseExternalWritingPaste\(data\.session\?\.user\.email, taskType\)/);
  assert.match(source, /function onPaste[\s\S]*event\.preventDefault\(\)[\s\S]*if \(!allowExternalPaste\) return/);
  assert.match(source, /commit\([\s\S]*applyExternalWritingPaste/);
  assert.match(source, /onTextChange\(snapshot\.text, snapshot\.overtimeRanges\)/);
  assert.match(source, /insertFromPaste" && !allowExternalPaste/);
  assert.match(source, /key === "v"[\s\S]*if \(!allowExternalPaste\) event\.preventDefault\(\)/);
});

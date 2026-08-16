const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  normalizeWritingOvertimeRanges,
  splitWritingTextByOvertime,
  updateWritingOvertimeRanges
} = require("../lib/writingOvertime.ts");
const {
  formatElapsedWritingTime,
  formatWritingAttemptSummary
} = require("../lib/writing.ts");

function update(previousText, nextText, previousRanges = [], overtime = true) {
  return updateWritingOvertimeRanges({ previousText, nextText, previousRanges, overtime });
}

test("elapsed time formatting does not wrap after 59:59", () => {
  assert.equal(formatElapsedWritingTime(0), "00:00");
  assert.equal(formatElapsedWritingTime(402), "06:42");
  assert.equal(formatElapsedWritingTime(3605), "60:05");
  assert.equal(formatWritingAttemptSummary("practice", 756), "练习模式 ｜ 12:36");
  assert.equal(formatWritingAttemptSummary(null, null), "—");
});

test("pre-threshold input remains normal and post-threshold insertion is overtime", () => {
  assert.deepEqual(update("Hello", "Hello!", [], false), []);
  assert.deepEqual(update("Hello world", "Hello very world", [], true), [{ start: 6, end: 11 }]);
});

test("post-threshold paste and replacement mark only inserted text", () => {
  assert.deepEqual(update("One two", "One pasted two"), [{ start: 4, end: 11 }]);
  assert.deepEqual(update("One old end", "One new words end"), [{ start: 4, end: 13 }]);
});

test("deleting overtime text shrinks ranges without coloring neighbours", () => {
  assert.deepEqual(update("abcXYZdef", "abcXZdef", [{ start: 3, end: 6 }], false), [{ start: 3, end: 5 }]);
});

test("deleting normal text before overtime moves its offsets", () => {
  assert.deepEqual(update("normal RED", "RED", [{ start: 7, end: 10 }], false), [{ start: 0, end: 3 }]);
});

test("normalization preserves multiple disjoint ranges and clips invalid input", () => {
  assert.deepEqual(normalizeWritingOvertimeRanges([
    { start: 8, end: 10 },
    { start: 2, end: 4 },
    { start: 3, end: 6 },
    { start: -3, end: 1 },
    { start: 99, end: 100 }
  ], 10), [{ start: 0, end: 1 }, { start: 2, end: 6 }, { start: 8, end: 10 }]);
});

test("renderer segmentation uses foreground metadata without changing source text", () => {
  assert.deepEqual(splitWritingTextByOvertime("abcdef", [{ start: 2, end: 4 }]), [
    { start: 0, end: 2, text: "ab", overtime: false },
    { start: 2, end: 4, text: "cd", overtime: true },
    { start: 4, end: 6, text: "ef", overtime: false }
  ]);
});

test("Email and Academic Discussion mode choices use their centralized thresholds", () => {
  const writing = require("../lib/writing.ts");
  assert.equal(writing.WRITING_TASK_CONFIG.email.timeLimitSeconds, 420);
  assert.equal(writing.WRITING_TASK_CONFIG.academic_discussion.timeLimitSeconds, 600);
  const practiceSource = fs.readFileSync(path.join(__dirname, "../components/writing/WritingPractice.tsx"), "utf8");
  assert.match(practiceSource, /选择练习模式/);
  assert.match(practiceSource, /writingMode: selectedWritingMode/);
  assert.match(practiceSource, /answerMode === "exam".*remainingSeconds === 0/s);
  assert.match(practiceSource, /answerMode === "practice" \? "Elapsed" : "Time Left"/);
});

test("resuming a catalog draft carries its attempt ID and bypasses new-attempt selection", () => {
  const catalogSource = fs.readFileSync(path.join(__dirname, "../components/writing/WritingCatalog.tsx"), "utf8");
  assert.match(catalogSource, /\?attempt=\$\{encodeURIComponent\(set\.draft_attempt_id/);
});

test("overtime presentation is a distinct deep-red foreground and composes inside markers", () => {
  const overtimeSource = fs.readFileSync(path.join(__dirname, "../components/writing/WritingOvertimeText.tsx"), "utf8");
  const sharedMarkerSource = fs.readFileSync(path.join(__dirname, "../components/writing/WritingRevisionMarkedText.tsx"), "utf8");
  const teacherSource = fs.readFileSync(path.join(__dirname, "../components/teacher/TeacherWritingReviewWorkspace.tsx"), "utf8");
  assert.match(overtimeSource, /text-\[#8f1025\]/);
  assert.doesNotMatch(overtimeSource, /bg-red/);
  assert.match(sharedMarkerSource, /WritingOvertimeText/);
  assert.match(teacherSource, /overtimeRanges=\{data\.attempt\.overtime_ranges\}/);
  assert.match(teacherSource, /formatWritingAttemptSummary/);
});

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
const {
  calculateActiveWritingTimer
} = require("../lib/writingTimer.ts");

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

test("practice timer accumulates the mounted session but preserves remaining time", () => {
  assert.deepEqual(
    calculateActiveWritingTimer({
      persistedElapsedSeconds: 120,
      persistedRemainingSeconds: 420,
      sessionStartedAtMs: 1_000,
      writingMode: "practice",
      nowMs: 181_000
    }),
    { elapsedSeconds: 300, remainingSeconds: 420 }
  );
});

test("exam timer counts down throughout the mounted session", () => {
  assert.deepEqual(
    calculateActiveWritingTimer({
      persistedElapsedSeconds: 120,
      persistedRemainingSeconds: 300,
      sessionStartedAtMs: 1_000,
      writingMode: "exam",
      nowMs: 121_000
    }),
    { elapsedSeconds: 240, remainingSeconds: 180 }
  );
});

test("resume starts from persisted mode-specific state without counting offline time", () => {
  const resumedAt = 7_201_000;
  assert.deepEqual(
    calculateActiveWritingTimer({
      persistedElapsedSeconds: 200,
      persistedRemainingSeconds: 340,
      sessionStartedAtMs: resumedAt,
      writingMode: "practice",
      nowMs: resumedAt
    }),
    { elapsedSeconds: 200, remainingSeconds: 340 }
  );
  assert.deepEqual(
    calculateActiveWritingTimer({
      persistedElapsedSeconds: 80,
      persistedRemainingSeconds: 340,
      sessionStartedAtMs: resumedAt,
      writingMode: "exam",
      nowMs: resumedAt
    }),
    { elapsedSeconds: 80, remainingSeconds: 340 }
  );
});

test("saving does not reset the mounted-session timer anchor", () => {
  const input = {
    persistedElapsedSeconds: 60,
    persistedRemainingSeconds: 300,
    sessionStartedAtMs: 1_000,
    writingMode: "exam"
  };
  assert.deepEqual(calculateActiveWritingTimer({ ...input, nowMs: 61_000 }), {
    elapsedSeconds: 120,
    remainingSeconds: 240
  });
  assert.deepEqual(calculateActiveWritingTimer({ ...input, nowMs: 121_000 }), {
    elapsedSeconds: 180,
    remainingSeconds: 180
  });
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

test("shared WritingPractice persists exact timer snapshots without wall-clock resume", () => {
  const practiceSource = fs.readFileSync(path.join(__dirname, "../components/writing/WritingPractice.tsx"), "utf8");
  const updateRouteSource = fs.readFileSync(path.join(__dirname, "../app/api/writing/attempts/[attemptId]/route.ts"), "utf8");
  assert.match(practiceSource, /calculateActiveWritingTimer/);
  assert.match(practiceSource, /window\.addEventListener\("pagehide"/);
  assert.match(practiceSource, /requestUpdateRef\.current\("sync", \{ keepalive: true \}\)/);
  assert.match(practiceSource, /elapsedSeconds: timerSnapshot\.elapsedSeconds/);
  assert.match(practiceSource, /remainingSeconds: timerSnapshot\.remainingSeconds/);
  assert.doesNotMatch(practiceSource, /writingElapsedSeconds/);
  assert.doesNotMatch(updateRouteSource, /writingElapsedSeconds/);
  assert.doesNotMatch(updateRouteSource, /started_at/);
  assert.match(updateRouteSource, /Math\.max\([\s\S]*attempt\.elapsed_seconds/);
  assert.match(updateRouteSource, /Math\.min\(attempt\.remaining_seconds, requestedRemaining\)/);
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

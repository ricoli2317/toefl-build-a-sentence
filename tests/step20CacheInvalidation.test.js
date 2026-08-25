const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const read = (file) => fs.readFileSync(path.join(ROOT, file), "utf8");

const matrix = read("lib/cacheInvalidation.ts");
const studentCache = read("components/StudentDataCache.tsx");
const teacherCache = read("components/TeacherDataCache.tsx");
const logicalCatalog = read("components/LogicalPracticeCatalog.tsx");
const practiceSession = read("components/PracticeSession.tsx");
const writingPractice = read("components/writing/WritingPractice.tsx");
const reviewWorkspace = read("components/teacher/TeacherWritingReviewWorkspace.tsx");
const assignmentForm = read("components/teacher/TeacherWritingAssignmentForm.tsx");
const assignmentList = read("components/teacher/TeacherWritingAssignmentList.tsx");
const studentReview = read("components/student/StudentWritingReview.tsx");
const importQuestions = read("components/TeacherImportQuestions.tsx");

test("Import NEW_ITEM publishes practice catalog invalidation after a successful import", () => {
  assert.match(importQuestions, /successCount > 0[\s\S]*broadcastQuestionBankUpdated/);
  assert.match(read("lib/questionBankCacheEvents.ts"), /PRACTICE_CATALOG_UPDATED/);
  assert.match(matrix, /PRACTICE_CATALOG_UPDATED:[\s\S]*studentPracticeCatalog/);
});

test("duplicate occurrence and display correction invalidate historical naming consumers", () => {
  const eventBlock = matrix.match(/PRACTICE_CATALOG_UPDATED:[\s\S]*?\],\n  BAS_ATTEMPT_SUBMITTED/)?.[0] ?? "";
  for (const domain of [
    "studentPracticeHistory",
    "studentAttemptResult",
    "studentWritingHistory",
    "studentPublishedReviews",
    "teacherStats",
    "teacherWritingReviews",
    "teacherWritingReviewWorkspace"
  ]) assert.match(eventBlock, new RegExp(domain));
});

test("BAS submit invalidates logical card state while preserving the authoritative overlay", () => {
  assert.match(practiceSession, /recordOfficialAttempt\(officialAttempt!\)/);
  assert.match(practiceSession, /broadcastStudentPracticeCompleted/);
  assert.match(studentCache, /case "studentPracticeState":[\s\S]*recordOfficialAttempt[\s\S]*updateLogicalCatalogCompletion/);
});

test("BAS submit invalidates teacher statistics", () => {
  assert.match(matrix, /BAS_ATTEMPT_SUBMITTED:[\s\S]*teacherStats/);
  assert.match(teacherCache, /case "teacherStats":[\s\S]*TEACHER_STATS_CACHE_KEY/);
});

test("BAS submit invalidates practice history", () => {
  assert.match(matrix, /BAS_ATTEMPT_SUBMITTED:[\s\S]*studentPracticeHistory/);
  assert.match(studentCache, /case "studentPracticeHistory":[\s\S]*STUDENT_PRACTICE_HISTORY_CACHE_PREFIX/);
});

test("writing draft create and explicit save publish in-progress invalidation", () => {
  const matches = writingPractice.match(/type: "WRITING_DRAFT_UPDATED"/g) ?? [];
  assert.ok(matches.length >= 2);
  assert.match(writingPractice, /!attemptId && result\.attempt\.status === "draft"/);
  assert.match(writingPractice, /studentId: savedAttempt\.user_id/);
});

test("writing submit refreshes completed card state and submission history", () => {
  assert.match(writingPractice, /type: "WRITING_ATTEMPT_SUBMITTED"/);
  assert.match(matrix, /WRITING_ATTEMPT_SUBMITTED:[\s\S]*studentWritingHistory/);
  assert.match(studentCache, /case "studentWritingHistory":[\s\S]*STUDENT_WRITING_SUBMISSION_HISTORY_CACHE_PREFIX/);
});

test("retake POST uses the newly returned stable attempt id and draft event", () => {
  assert.match(writingPractice, /forceNew: Boolean\(forceNew\)/);
  assert.match(writingPractice, /attemptId: result\.attempt\.attempt_id/);
  assert.match(writingPractice, /router\.replace\([\s\S]*result\.attempt\.attempt_id/);
});

test("assignment attempt invalidates assignment state without invalidating free-practice catalog", () => {
  assert.match(matrix, /if \(event\.assignmentId\) \{[\s\S]*domains\.add\("studentAssignments"\)[\s\S]*\} else \{[\s\S]*domains\.add\("studentWritingCatalog"\)/);
  const draftBase = matrix.match(/WRITING_DRAFT_UPDATED: \[([^\]]*)\]/)?.[1] ?? "";
  assert.doesNotMatch(draftBase, /studentWritingCatalog|studentPracticeCatalog/);
});

test("review publish invalidates teacher review and student published-review domains", () => {
  const publishBlock = matrix.match(/WRITING_REVIEW_PUBLISHED:[\s\S]*?\],\n  ASSIGNMENT_UPDATED/)?.[0] ?? "";
  assert.match(publishBlock, /teacherWritingReviews/);
  assert.match(publishBlock, /teacherWritingReviewWorkspace/);
  assert.match(publishBlock, /studentPublishedReviews/);
  assert.match(publishBlock, /studentWritingOverview/);
});

test("AI generate and save do not expose unpublished reviews to students", () => {
  assert.match(reviewWorkspace, /type: "WRITING_REVIEW_UPDATED"/);
  assert.match(reviewWorkspace, /type: publish \? "WRITING_REVIEW_PUBLISHED" : "WRITING_REVIEW_UPDATED"/);
  const updatedBlock = matrix.match(/WRITING_REVIEW_UPDATED:[\s\S]*?\],\n  WRITING_REVIEW_PUBLISHED/)?.[0] ?? "";
  assert.doesNotMatch(updatedBlock, /studentPublishedReviews/);
});

test("display number correction refreshes metadata while cache identity remains stable", () => {
  assert.match(logicalCatalog, /studentLogicalCatalogCacheKey\(taskType\)/);
  assert.doesNotMatch(matrix, /display_number|displayNumber|display_title|first_seen_date/);
  assert.match(studentCache, /studentAttemptCacheKey\(attemptId: string\)/);
});

test("StudentDataCache generation guard prevents stale request A from replacing B", () => {
  assert.match(studentCache, /const generations = useRef\(new Map<string, number>\(\)\)/);
  assert.match(studentCache, /current\.promise === promise[\s\S]*current\.generation === generation[\s\S]*generations\.current\.get\(keyWithStudent\)/);
});

test("TeacherDataCache has the same generation-based stale response protection", () => {
  assert.match(teacherCache, /const generations = useRef\(new Map<string, number>\(\)\)/);
  assert.match(teacherCache, /current\.promise === promise[\s\S]*current\.generation === generation[\s\S]*generations\.current\.get\(key\)/);
});

test("BroadcastChannel subscriber removes both listeners and closes the channel", () => {
  assert.match(matrix, /removeEventListener\(CACHE_INVALIDATION_LOCAL_EVENT, onLocalEvent\)/);
  assert.match(matrix, /removeEventListener\("message", onMessage\)/);
  assert.match(matrix, /channel\?\.close\(\)/);
});

test("same-tab mutations use a local event and do not depend on BroadcastChannel self-loop", () => {
  const localDispatch = matrix.indexOf("window.dispatchEvent");
  const channelGuard = matrix.indexOf('if (typeof BroadcastChannel === "undefined") return;');
  assert.ok(localDispatch >= 0 && channelGuard > localDispatch);
  assert.match(matrix, /CustomEvent<CacheInvalidationEvent>/);
});

test("refresh errors retain last-known-good student and teacher data", () => {
  assert.match(studentCache, /status: "success",\n\s*data: previousData/);
  assert.match(teacherCache, /status: "success", data: previousData/);
});

test("pending-review imports cannot bypass the public catalog active-item filter", () => {
  const route = read("app/api/practice-catalog/route.ts");
  const universe = read("lib/practicePublicUniverse.ts");
  assert.match(route, /getLogicalPracticeItems/);
  assert.match(universe, /!item\.is_active/);
  assert.match(universe, /isFormalSource\(source\)/);
});

test("custom assignment mutation only targets assignment domains", () => {
  assert.match(assignmentForm, /assignmentQuestionSource: source/);
  assert.match(matrix, /ASSIGNMENT_UPDATED:[\s\S]*studentAssignments[\s\S]*teacherAssignments/);
  const assignmentBlock = matrix.match(/ASSIGNMENT_UPDATED:[\s\S]*?\],\n  TEACHER_STATS_UPDATED/)?.[0] ?? "";
  assert.doesNotMatch(assignmentBlock, /studentPracticeCatalog|studentWritingCatalog|teacherQuestionBank/);
});

test("no mutation uses display metadata as cache identity", () => {
  const cacheIdentitySources = `${matrix}\n${studentCache}\n${teacherCache}`;
  assert.doesNotMatch(cacheIdentitySources, /cache(?:Key|Identity)[^\n]*(?:displayNumber|display_number|displayTitle|firstSeen)/i);
  assert.match(studentReview, /studentPublishedWritingReviewCacheKey\(attemptId\)/);
});

test("assignment success broadcasts but assignment failure does not broadcast success", () => {
  assert.match(assignmentList, /cache\.invalidate[\s\S]*publishCacheInvalidation/);
  const catchBlock = assignmentList.match(/catch \(mutation\) \{[\s\S]*?\n    \}/)?.[0] ?? "";
  assert.doesNotMatch(catchBlock, /publishCacheInvalidation/);
});

test("logical catalog is inside StudentDataCache and receives no-store responses", () => {
  assert.match(logicalCatalog, /useStudentCachedData/);
  assert.match(logicalCatalog, /cache: "no-store"/);
  assert.match(studentCache, /STUDENT_LOGICAL_CATALOG_CACHE_PREFIX/);
});

test("dynamic BAS result, submission, and teacher stats APIs disable route and fetch caching", () => {
  for (const file of [
    "app/api/attempts/[attemptId]/route.ts",
    "app/api/submissions/route.ts",
    "app/api/teacher/stats/route.ts"
  ]) {
    const source = read(file);
    assert.match(source, /export const dynamic = "force-dynamic"/);
    assert.match(source, /Cache-Control[\s\S]{0,30}"no-store"/);
    assert.match(source, /cache: "no-store"/);
  }
});

test("teacher stats uses an explicit schema version instead of another ad-hoc key bump", () => {
  assert.match(teacherCache, /TEACHER_STATS_CACHE_SCHEMA_VERSION = 1/);
  assert.match(teacherCache, /teacher:stats:logical-schema-/);
});

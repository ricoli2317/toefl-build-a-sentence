const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  DEFAULT_TEACHER_WRITING_REVIEW_RETURN_TO,
  safeWritingReviewReturnTo,
  teacherWritingReviewWorkspaceHref
} = require("../lib/teacherWritingReviewNavigation.ts");

const root = path.resolve(__dirname, "..");
const source = (relativePath) =>
  fs.readFileSync(path.join(root, relativePath), "utf8");

test("writing review returnTo accepts every known teacher drill-down source", () => {
  const assignmentId = "123e4567-e89b-12d3-a456-426614174000";
  const studentId = "11111111-2222-3333-4444-555555555555";
  const classId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  for (const safe of [
    "/teacher/writing/reviews",
    "/teacher/writing/reviews?tab=class&classId=" + classId,
    "/teacher/writing/reviews/logs",
    "/teacher/writing/assignments",
    "/teacher/writing/assignments?view=class&classId=" + classId,
    `/teacher/writing/assignments/${assignmentId}`,
    `/teacher/writing/assignments/batches/${assignmentId}`,
    "/teacher/dashboard",
    "/teacher/dashboard?tab=classes",
    "/teacher/students",
    `/teacher/students/${studentId}?returnTo=%2Fteacher%2Fclasses%2F${classId}`,
    `/teacher/classes/${classId}`
  ]) {
    assert.equal(safeWritingReviewReturnTo(safe), safe, `${safe} must stay usable`);
  }
  for (const unsafe of [
    "https://example.com",
    "//example.com",
    "javascript:alert(1)",
    "/student/assignments",
    "/admin/student-bindings",
    "/teacher/unknown-page",
    "/teacher/../student/assignments",
    null,
    undefined,
    42
  ]) {
    assert.equal(
      safeWritingReviewReturnTo(unsafe),
      DEFAULT_TEACHER_WRITING_REVIEW_RETURN_TO
    );
  }
});

test("workspace href persists an encoded safe source across refreshes", () => {
  assert.equal(
    teacherWritingReviewWorkspaceHref(
      "attempt/unsafe",
      "/teacher/writing/assignments/123e4567-e89b-12d3-a456-426614174000"
    ),
    "/teacher/writing/reviews/attempt%2Funsafe?returnTo=%2Fteacher%2Fwriting%2Fassignments%2F123e4567-e89b-12d3-a456-426614174000"
  );
  assert.equal(
    teacherWritingReviewWorkspaceHref("attempt-1", "https://example.com"),
    "/teacher/writing/reviews/attempt-1?returnTo=%2Fteacher%2Fwriting%2Freviews"
  );
});

test("review entries pass explicit sources and workspace Back uses the validated prop", () => {
  const page = source("app/teacher/writing/reviews/[attemptId]/page.tsx");
  const workspace = source("components/teacher/TeacherWritingReviewWorkspace.tsx");
  const reviewList = source("components/teacher/TeacherWritingReviewList.tsx");
  const assignmentList = source("components/teacher/TeacherWritingAssignmentList.tsx");
  const assignmentDetail = source("components/teacher/TeacherWritingAssignmentDetailView.tsx");
  assert.match(page, /safeWritingReviewReturnTo/);
  assert.match(page, /returnTo=\{returnTo\}/);
  assert.match(workspace, /<WorkspaceToolbar[\s\S]*returnTo=\{returnTo\}/);
  assert.match(workspace, /href=\{returnTo\}/);
  assert.match(reviewList, /"\/teacher\/writing\/reviews"/);
  assert.match(assignmentList, /"\/teacher\/writing\/assignments"/);
  assert.match(assignmentDetail, /returnTo=\{assignmentDetailHref\}/);
});

test("Save Publish and AI mutations keep returnTo outside mutable workspace state", () => {
  const workspace = source("components/teacher/TeacherWritingReviewWorkspace.tsx");
  assert.match(workspace, /function TeacherWritingReviewWorkspace\(\{[\s\S]*returnTo/);
  assert.doesNotMatch(workspace, /setReturnTo|useState[^\n]*returnTo/);
  assert.match(workspace, /async function persist\(publish: boolean\)/);
  assert.match(workspace, /onPersist=\{persist\}/);
  assert.match(workspace, /onRegenerate=\{requestAiGeneration\}/);
});

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

test("writing review returnTo accepts only approved teacher writing routes", () => {
  const assignmentId = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(
    safeWritingReviewReturnTo("/teacher/writing/reviews"),
    "/teacher/writing/reviews"
  );
  assert.equal(
    safeWritingReviewReturnTo("/teacher/writing/assignments"),
    "/teacher/writing/assignments"
  );
  assert.equal(
    safeWritingReviewReturnTo(`/teacher/writing/assignments/${assignmentId}`),
    `/teacher/writing/assignments/${assignmentId}`
  );
  assert.equal(
    safeWritingReviewReturnTo(`/teacher/writing/assignments/batches/${assignmentId}`),
    `/teacher/writing/assignments/batches/${assignmentId}`
  );
  for (const unsafe of [
    "https://example.com",
    "//example.com",
    "javascript:alert(1)",
    "/teacher/dashboard",
    "/student/assignments",
    "/teacher/writing/assignments/not-a-uuid",
    "/teacher/writing/reviews?unexpected=1",
    null
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

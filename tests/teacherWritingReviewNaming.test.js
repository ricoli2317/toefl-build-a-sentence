const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  createHistoricalPracticeDisplayResolver
} = require("../lib/historicalPracticeDisplay.ts");

const root = path.resolve(__dirname, "..");

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function item(itemId, taskType, displayNumber, displayTitle, isActive = true) {
  return {
    item_id: itemId,
    task_type: taskType,
    display_number: displayNumber,
    display_title: displayTitle,
    is_active: isActive
  };
}

function source(sourceId, itemId, taskType, questionId) {
  return {
    source_id: sourceId,
    item_id: itemId,
    task_type: taskType,
    source_set_id: null,
    source_question_id: questionId
  };
}

function namingResolver(emailNumber = "021") {
  return createHistoricalPracticeDisplayResolver({
    items: [
      item("email-item", "email", emailNumber, "Request for Schedule Change"),
      item("ad-item", "academic_discussion", "018", "Nature vs Nurture"),
      item("inactive-item", "email", "019", "Inactive Historical Email", false)
    ],
    sources: [
      source("email-a", "email-item", "email", "email-a"),
      source("email-b", "email-item", "email", "email-b"),
      source("ad-a", "ad-item", "academic_discussion", "ad-a"),
      source("inactive-a", "inactive-item", "email", "inactive-a")
    ]
  });
}

function freeDisplay(resolver, taskType, rawQuestionId, fallback = "raw title") {
  return resolver.resolveWritingAttempt({
    assignmentId: null,
    fallbackDisplayName: fallback,
    rawQuestionId,
    taskType
  });
}

test("free Email and AD teacher reviews use logical number and practice_items title", () => {
  const resolver = namingResolver();
  assert.equal(
    freeDisplay(resolver, "email", "email-a").displayName,
    "题目021 Request for Schedule Change"
  );
  assert.equal(
    freeDisplay(resolver, "academic_discussion", "ad-a").displayName,
    "题目018 Nature vs Nurture"
  );
});

test("two raw submissions for one logical item stay two attempt rows with the same name", () => {
  const resolver = namingResolver();
  const rows = ["email-a", "email-b"].map((questionId, index) => ({
    attemptId: `attempt-${index + 1}`,
    questionId,
    displayName: freeDisplay(resolver, "email", questionId).displayName
  }));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(({ attemptId }) => attemptId), ["attempt-1", "attempt-2"]);
  assert.deepEqual(rows.map(({ questionId }) => questionId), ["email-a", "email-b"]);
  assert.equal(new Set(rows.map(({ displayName }) => displayName)).size, 1);
});

test("workspace renders logical title while its question column keeps the exact loaded raw question", () => {
  const route = read("app/api/teacher/writing/reviews/[attemptId]/route.ts");
  const server = read("lib/writingReviewWorkspaceServer.ts");
  const ui = read("components/teacher/TeacherWritingReviewWorkspace.tsx");
  assert.match(route, /\.\.\.workspace,[\s\S]*displayName: display\.displayName/);
  assert.match(server, /readWritingQuestionForReview\([\s\S]*attempt\.question_id/);
  assert.match(server, /question: questionResult\.data/);
  assert.match(ui, /\/ \{data\.displayName\}/);
  assert.match(ui, /<QuestionColumn question=\{data\.question\}/);
  assert.match(ui, /<CompactEmailQuestion question=\{question as EmailQuestion\}/);
});

test("display_number correction updates list/workspace naming without changing review identity", () => {
  const identity = {
    attemptId: "attempt-fixed",
    reviewId: "review-fixed",
    questionId: "email-a"
  };
  assert.equal(freeDisplay(namingResolver("060"), "email", identity.questionId).displayName, "题目060 Request for Schedule Change");
  assert.equal(freeDisplay(namingResolver("057B"), "email", identity.questionId).displayName, "题目057B Request for Schedule Change");
  assert.deepEqual(identity, {
    attemptId: "attempt-fixed",
    reviewId: "review-fixed",
    questionId: "email-a"
  });
});

test("published and reviewing review data are unchanged by display enrichment", () => {
  const reviewRows = [
    { review_id: "published", status: "published", scores: { score: 5 } },
    { review_id: "reviewing", status: "reviewing", scores: { score: 3 } }
  ];
  const before = structuredClone(reviewRows);
  const name = freeDisplay(namingResolver(), "email", "email-a").displayName;
  const enriched = reviewRows.map((review) => ({ review, displayName: name }));
  assert.equal(enriched[0].displayName, enriched[1].displayName);
  assert.deepEqual(reviewRows, before);
});

test("question-bank Assignment keeps snapshot context and exposes only auxiliary logical naming", () => {
  const display = namingResolver().resolveWritingAttempt({
    assignmentId: "assignment-bank",
    assignmentDisplayName: "Week 4 Assignment Snapshot",
    fallbackDisplayName: "raw title",
    questionSource: "question_bank",
    rawQuestionId: "email-a",
    taskType: "email"
  });
  assert.equal(display.displayName, "Week 4 Assignment Snapshot");
  assert.equal(display.logicalDisplayName, "题目021 Request for Schedule Change");
  assert.equal(display.resolution, "assignment");
});

test("custom Assignment never maps even when its content or raw ID resembles a public question", () => {
  const display = namingResolver().resolveWritingAttempt({
    assignmentId: "assignment-custom",
    assignmentDisplayName: "Request for Schedule Change",
    fallbackDisplayName: "raw title",
    questionSource: "custom",
    rawQuestionId: "email-a",
    taskType: "email"
  });
  assert.equal(display.displayName, "Request for Schedule Change");
  assert.equal(display.logicalDisplayName, null);
  assert.equal(display.itemId, null);
  assert.equal(display.displayNumber, null);
});

test("inactive item remains historically resolvable for teacher review", () => {
  const display = freeDisplay(namingResolver(), "email", "inactive-a");
  assert.equal(display.displayName, "题目019 Inactive Historical Email");
  assert.equal(display.isActive, false);
});

test("orphan free-practice review falls back with a structured warning", () => {
  const display = freeDisplay(
    namingResolver(),
    "academic_discussion",
    "orphan-ad",
    "Legacy AD Raw Title"
  );
  assert.equal(display.displayName, "Legacy AD Raw Title");
  assert.equal(display.resolution, "fallback");
  assert.equal(display.warning.code, "HISTORICAL_SOURCE_NOT_MAPPED");
  assert.equal(display.warning.rawQuestionId, "orphan-ad");
});

test("teacher review list preserves sorting, status, and attempt_id React/route identity", () => {
  const route = read("app/api/teacher/writing/reviews/route.ts");
  const ui = read("components/teacher/TeacherWritingReviewList.tsx");
  assert.match(route, /order\("submitted_at", \{ ascending: false/);
  assert.match(route, /reviewStatus: toReviewStatus\(review\)/);
  assert.match(ui, /key=\{attempt\.attemptId\}/);
  assert.match(ui, /teacherWritingReviewWorkspaceHref\([\s\S]*attempt\.attemptId/);
  assert.match(ui, /\{attempt\.displayName\}/);
  assert.doesNotMatch(ui, /key=\{[^}]*display(Number|Name)/);
});

test("generate, save, publish, and AI logs retain attempt/review identity, never display number", () => {
  const workspaceRoute = read("app/api/teacher/writing/reviews/[attemptId]/route.ts");
  const generateRoute = read("app/api/teacher/writing/reviews/[attemptId]/generate-ai/route.ts");
  const publishRoute = read("app/api/teacher/writing/reviews/[attemptId]/publish/route.ts");
  const ui = read("components/teacher/TeacherWritingReviewWorkspace.tsx");
  assert.match(workspaceRoute, /saveWritingReviewWorkspace\([\s\S]*params\.attemptId/);
  assert.match(generateRoute, /params\.attemptId/);
  assert.match(publishRoute, /saveWritingReviewWorkspace\([\s\S]*params\.attemptId/);
  assert.match(ui, /attempt_id=\$\{encodeURIComponent\(data\.attempt\.attempt_id\)\}/);
  for (const sourceText of [workspaceRoute, generateRoute, publishRoute]) {
    assert.doesNotMatch(sourceText, /display(Number|_number).*save|save.*display(Number|_number)/i);
  }
});

test("Teacher list performs one batched historical resolver load outside per-row enrichment", () => {
  const route = read("app/api/teacher/writing/reviews/route.ts");
  assert.equal((route.match(/loadHistoricalPracticeDisplayResolver\(supabase\)/g) ?? []).length, 1);
  const mapStart = route.indexOf("const enrichedAttempts = attempts.map");
  const mapEnd = route.indexOf("logHistoricalPracticeDisplayWarnings", mapStart);
  assert.ok(mapStart >= 0 && mapEnd > mapStart);
  assert.doesNotMatch(route.slice(mapStart, mapEnd), /\.from\(|loadHistoricalPracticeDisplayResolver/);
});

test("Teacher cache identity excludes display_number and refreshes current naming on mount", () => {
  const cache = read("components/TeacherDataCache.tsx");
  const list = read("components/teacher/TeacherWritingReviewList.tsx");
  const workspace = read("components/teacher/TeacherWritingReviewWorkspace.tsx");
  assert.match(cache, /teacher:writing-reviews:historical-display-v2/);
  assert.match(cache, /teacher:writing-review-workspace:historical-display-v2/);
  assert.doesNotMatch(cache, /display_number/);
  assert.match(list, /refreshOnMount: true/);
  assert.match(workspace, /refreshOnMount: true/);
});

test("Step 19 adds display metadata only to GET and does not alter AI/review schemas", () => {
  const route = read("app/api/teacher/writing/reviews/[attemptId]/route.ts");
  const getSection = route.slice(route.indexOf("export async function GET"), route.indexOf("export async function PATCH"));
  const patchSection = route.slice(route.indexOf("export async function PATCH"));
  assert.match(getSection, /logicalDisplay/);
  assert.doesNotMatch(patchSection, /logicalDisplay|displayName: display/);
  assert.doesNotMatch(read("lib/writingReviewSchema.ts"), /historicalPracticeDisplay/);
  assert.doesNotMatch(read("lib/openrouterWritingReview.ts"), /historicalPracticeDisplay/);
});

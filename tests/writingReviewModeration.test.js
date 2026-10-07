import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyWritingReviewModerationToEntries,
  isWritingReviewModerationAction,
  normalizeWritingReviewModerationAttemptIds,
  parseWritingReviewModerationResponse,
  writingReviewModerationNotice,
  writingReviewModerationSucceededIds,
  WRITING_REVIEW_MODERATION_MAX_ATTEMPTS
} from "../lib/writingReviewModeration.ts";
import {
  cacheDomainsForEvent
} from "../lib/cacheInvalidation.ts";
import {
  mergeRegeneratedWritingReviewItems,
  mergeRegeneratedWritingReviewTeacherState
} from "../lib/writingReviewFullRegeneration.ts";
import {
  filterWritingReviewListEntries,
  isWritingReviewListStatus
} from "../lib/teacherWritingReviewList.ts";
import {
  parseTeacherWritingReviewListSearchParams,
  teacherWritingReviewsListHref
} from "../lib/teacherWritingReviewNavigation.ts";

const ATTEMPT_A = "11111111-1111-4111-8111-111111111111";
const ATTEMPT_B = "22222222-2222-4222-8222-222222222222";
const ATTEMPT_C = "33333333-3333-4333-8333-333333333333";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relativePath) => readFileSync(resolve(projectRoot, relativePath), "utf8");

test("ignored is a first-class review list status and filter", () => {
  assert.equal(isWritingReviewListStatus("ignored"), true);
  assert.equal(isWritingReviewListStatus("banana"), false);

  const entries = [
    { attemptId: ATTEMPT_A, studentId: "s1", studentName: "甲", taskType: "email", reviewStatus: "pending" },
    { attemptId: ATTEMPT_B, studentId: "s1", studentName: "甲", taskType: "email", reviewStatus: "ignored" },
    { attemptId: ATTEMPT_C, studentId: "s2", studentName: "乙", taskType: "academic_discussion", reviewStatus: "published" }
  ];
  assert.deepEqual(
    filterWritingReviewListEntries(entries, { status: "ignored" }).map((entry) => entry.attemptId),
    [ATTEMPT_B]
  );
  // 全部 is the working list: 已忽略 rows only come back through the explicit
  // 忽略 filter, so the visible list and every count derived from it agree.
  assert.deepEqual(
    filterWritingReviewListEntries(entries, { status: "all" }).map((entry) => entry.attemptId),
    [ATTEMPT_A, ATTEMPT_C]
  );
  assert.deepEqual(
    filterWritingReviewListEntries(entries, { status: "pending", taskType: "email" }).map(
      (entry) => entry.attemptId
    ),
    [ATTEMPT_A]
  );
});

test("全部 excludes ignored from rows, counts and other status filters", () => {
  const entries = [
    { attemptId: "p1", studentId: "s1", studentName: "甲", taskType: "email", reviewStatus: "pending" },
    { attemptId: "p2", studentId: "s2", studentName: "乙", taskType: "email", reviewStatus: "pending" },
    { attemptId: "r1", studentId: "s2", studentName: "乙", taskType: "email", reviewStatus: "reviewing" },
    { attemptId: "g1", studentId: "s3", studentName: "丙", taskType: "academic_discussion", reviewStatus: "published" },
    { attemptId: "g2", studentId: "s3", studentName: "丙", taskType: "academic_discussion", reviewStatus: "published" },
    { attemptId: "i1", studentId: "s4", studentName: "丁", taskType: "email", reviewStatus: "ignored" },
    { attemptId: "i2", studentId: "s4", studentName: "丁", taskType: "academic_discussion", reviewStatus: "ignored" }
  ];
  const ids = (filters) =>
    filterWritingReviewListEntries(entries, filters).map((entry) => entry.attemptId);

  // 待批改 2, 批改中 1, 已发布 2, 忽略 2 → 全部 = 5, never 7.
  assert.deepEqual(ids({ status: "all" }), ["p1", "p2", "r1", "g1", "g2"]);
  assert.equal(ids({ status: "all" }).length, entries.length - 2);
  assert.deepEqual(ids({ status: "all", taskType: "email" }), ["p1", "p2", "r1"]);
  assert.deepEqual(ids({ status: "all", studentId: "s4" }), []);
  assert.deepEqual(ids({ status: "ignored" }), ["i1", "i2"]);
  assert.equal(ids({ status: "ignored" }).length, 2);
  // Other status filters keep their exact old meaning.
  assert.deepEqual(ids({ status: "pending" }), ["p1", "p2"]);
  assert.deepEqual(ids({ status: "reviewing" }), ["r1"]);
  assert.deepEqual(ids({ status: "published" }), ["g1", "g2"]);
  // A page count computed from the filtered list therefore matches the rows.
  assert.equal(ids({ status: "all" }).length + ids({ status: "ignored" }).length, entries.length);
});

test("the ignored status survives the URL round trip", () => {
  const href = teacherWritingReviewsListHref({ tab: "students", status: "ignored" });
  assert.match(href, /status=ignored/);
  assert.equal(
    parseTeacherWritingReviewListSearchParams({ status: "ignored" }).status,
    "ignored"
  );
  assert.equal(
    parseTeacherWritingReviewListSearchParams({ status: "banana" }).status,
    "all"
  );
});

test("moderation action guard accepts only return / ignore", () => {
  assert.equal(isWritingReviewModerationAction("return"), true);
  assert.equal(isWritingReviewModerationAction("ignore"), true);
  assert.equal(isWritingReviewModerationAction("delete"), false);
  assert.equal(isWritingReviewModerationAction(null), false);
});

test("attempt id normalization dedupes, lowercases and caps the batch", () => {
  assert.deepEqual(
    normalizeWritingReviewModerationAttemptIds([
      ATTEMPT_A,
      ATTEMPT_A.toUpperCase(),
      " not-a-uuid ",
      "42",
      ATTEMPT_B,
      null,
      123
    ]),
    [ATTEMPT_A, ATTEMPT_B]
  );
  assert.deepEqual(normalizeWritingReviewModerationAttemptIds("nope"), []);
  assert.deepEqual(normalizeWritingReviewModerationAttemptIds([]), []);

  const many = Array.from({ length: 250 }, (_value, index) =>
    `${String(index).padStart(8, "0")}-0000-4000-8000-000000000000`
  );
  assert.equal(
    normalizeWritingReviewModerationAttemptIds(many).length,
    WRITING_REVIEW_MODERATION_MAX_ATTEMPTS
  );
});

test("moderation responses are parsed strictly", () => {
  const parsed = parseWritingReviewModerationResponse({
    results: [
      { attemptId: ATTEMPT_A, outcome: "returned", reason: null },
      { attemptId: ATTEMPT_B, outcome: "skipped", reason: "already_reviewed" }
    ]
  });
  assert.deepEqual(parsed, {
    results: [
      { attemptId: ATTEMPT_A, outcome: "returned", reason: null },
      { attemptId: ATTEMPT_B, outcome: "skipped", reason: "already_reviewed" }
    ]
  });

  assert.equal(parseWritingReviewModerationResponse({}), null);
  assert.equal(parseWritingReviewModerationResponse({ results: "no" }), null);
  assert.equal(
    parseWritingReviewModerationResponse({
      results: [{ attemptId: ATTEMPT_A, outcome: "exploded" }]
    }),
    null
  );
  assert.equal(
    parseWritingReviewModerationResponse({
      results: [{ attemptId: "bad-id", outcome: "returned" }]
    }),
    null
  );
});

test("return drops rows and ignore keeps them as 已忽略", () => {
  const entries = [
    { attemptId: ATTEMPT_A, reviewStatus: "pending", studentId: "s1" },
    { attemptId: ATTEMPT_B, reviewStatus: "pending", studentId: "s1" },
    { attemptId: ATTEMPT_C, reviewStatus: "reviewing", studentId: "s2" }
  ];
  const results = [
    { attemptId: ATTEMPT_A, outcome: "returned", reason: null },
    { attemptId: ATTEMPT_C, outcome: "skipped", reason: "already_reviewed" }
  ];
  assert.deepEqual(
    applyWritingReviewModerationToEntries(entries, "return", results).map(
      (entry) => entry.attemptId
    ),
    [ATTEMPT_B, ATTEMPT_C]
  );

  const ignoredResults = [
    { attemptId: ATTEMPT_B, outcome: "ignored", reason: null }
  ];
  assert.deepEqual(
    applyWritingReviewModerationToEntries(entries, "ignore", ignoredResults),
    [
      { attemptId: ATTEMPT_A, reviewStatus: "pending", studentId: "s1" },
      { attemptId: ATTEMPT_B, reviewStatus: "ignored", studentId: "s1" },
      { attemptId: ATTEMPT_C, reviewStatus: "reviewing", studentId: "s2" }
    ]
  );
  assert.equal(writingReviewModerationSucceededIds(ignoredResults).has(ATTEMPT_B), true);
  assert.equal(writingReviewModerationSucceededIds(ignoredResults).has(ATTEMPT_A), false);
});

test("moderation notice reports processed and skipped attempts", () => {
  assert.equal(
    writingReviewModerationNotice("ignore", [
      { attemptId: ATTEMPT_A, outcome: "ignored", reason: null },
      { attemptId: ATTEMPT_B, outcome: "ignored", reason: null }
    ]),
    "已忽略 2 条。"
  );
  const partial = writingReviewModerationNotice("return", [
    { attemptId: ATTEMPT_A, outcome: "returned", reason: null },
    { attemptId: ATTEMPT_B, outcome: "skipped", reason: "already_reviewed" }
  ]);
  assert.match(partial, /已退回 1 条。/);
  assert.match(partial, /另有 1 条未处理/);
});

test("the empty ignored placeholder supports AI generation and regeneration", () => {
  // Exactly the shape the moderation RPC inserts for an ignored review.
  const placeholder = {
    language_edits: [],
    scores: {},
    content_feedback: { items: [], overall_feedback: "" },
    teacher_comment: ""
  };
  const merged = mergeRegeneratedWritingReviewItems(
    "I am writing to apply for the position.",
    [],
    [],
    placeholder
  );
  assert.deepEqual(merged.language_edits, []);
  assert.deepEqual(merged.content_feedback, []);

  const teacherState = mergeRegeneratedWritingReviewTeacherState(
    {
      official_score: { ai_score: 0, teacher_score: 0, rationale: "" },
      dimension_scores: {}
    },
    placeholder,
    "new overall"
  );
  assert.equal(teacherState.scores.official_score.teacher_score, 0);
  assert.equal(teacherState.overall_feedback, "new overall");
  assert.equal(teacherState.teacher_comment, "");
});

test("return invalidation splits assignment / standalone student caches", () => {
  const assignmentDomains = cacheDomainsForEvent({
    type: "WRITING_ATTEMPT_RETURNED",
    studentId: "s1",
    assignmentId: "a1"
  });
  assert.equal(assignmentDomains.includes("studentAssignments"), true);
  assert.equal(assignmentDomains.includes("studentWritingCatalog"), false);
  assert.equal(assignmentDomains.includes("teacherWritingReviews"), true);
  assert.equal(assignmentDomains.includes("teacherWritingReviewWorkspace"), true);

  const standaloneDomains = cacheDomainsForEvent({
    type: "WRITING_ATTEMPT_RETURNED",
    studentId: "s1",
    assignmentId: null
  });
  assert.equal(standaloneDomains.includes("studentWritingCatalog"), true);
  assert.equal(standaloneDomains.includes("studentAssignments"), false);
  assert.equal(standaloneDomains.includes("studentWritingAttempts"), true);
  assert.equal(standaloneDomains.includes("studentWritingHistory"), true);

  // The existing review update event keeps its exact domain set for 忽略.
  const ignoreDomains = cacheDomainsForEvent({
    type: "WRITING_REVIEW_UPDATED",
    studentId: "s1",
    attemptId: ATTEMPT_A
  });
  assert.deepEqual(ignoreDomains, [
    "teacherWritingReviews",
    "teacherWritingReviewWorkspace",
    "teacherClassReviews"
  ]);
});

test("批量取消 clears every selected id without API, refresh or filter changes", () => {
  const list = read("components/teacher/TeacherWritingReviewList.tsx");
  const bulkStart = list.indexOf("function WritingReviewBulkActions");
  const bulkEnd = list.indexOf("function WritingReviewReturnDialog");
  assert.ok(bulkStart > 0 && bulkEnd > bulkStart);
  const bulk = list.slice(bulkStart, bulkEnd);

  // The button sits beside 退回 / 忽略 and only calls onCancel.
  assert.match(bulk, /onCancel: \(\) => void/);
  assert.match(bulk, /onClick=\{onCancel\}/);
  assert.match(bulk, />\s*取消\s*</);
  assert.match(bulk, /teacher-button-secondary/);
  // Not a danger action: no red styling.
  assert.doesNotMatch(bulk, /red-|rose-/);
  // 取消 never sends a moderation request, never refreshes the list/filters
  // and never touches navigation or cached data.
  assert.doesNotMatch(bulk, /teacherFetch|requestIgnore|requestReturn|router\.|cache\.|invalidate/);

  // Both tabs wire 取消 to the selection reset only.
  const cancelWiring = list.match(/onCancel=\{\(\) => selection\.clear\(\)\}/g) ?? [];
  assert.equal(cancelWiring.length, 2);
  // selection.clear drops every id (including a full Select All / marquee
  // state) without any side effect.
  assert.match(list, /const clear = useCallback\(\(\) => \{/);
  assert.match(list, /setSelectedIds\(\(current\) => \(current\.size === 0 \? current : new Set\(\)\)\)/);
  // The whole bulk bar (and its 取消) disappears once nothing is selected,
  // which is what "exit the selection state" means here.
  const gatedBars = list.match(/selectedCount > 0 \? \(\s*<WritingReviewBulkActions/g) ?? [];
  assert.equal(gatedBars.length, 2);
});

test("the list keeps every 全部 consumer consistent with the ignored exclusion", () => {
  const list = read("components/teacher/TeacherWritingReviewList.tsx");
  // Both tabs derive the visible rows (and any count shown for them) from the
  // same shared predicate, so no client-side count can include ignored rows in
  // the 全部 view.
  assert.match(
    list,
    /filterWritingReviewListEntries\(attempts, \{\s*studentId: activeStudentId,\s*status: statusFilter,\s*taskType: taskFilter\s*\}\)/
  );
  assert.match(
    list,
    /filterWritingReviewListEntries\(attempts, \{\s*status: statusFilter,\s*taskType: taskFilter\s*\}\)/
  );
  // 全部 has no summary count badge that could drift from the filtered rows:
  // the shared filter bar renders labels only, and the bar's only count is
  // 已选 for the current selection.
  assert.match(list, /已选 \{count\} 条/);
  const filters = read("components/teacher/TeacherListFilters.tsx");
  assert.doesNotMatch(filters, /count/i);

  // The class overview counts already classify 已忽略 into no bucket, so
  // 全部 = 待批改 + 批改中 + 已发布 stays true there as well.
  const classServer = read("lib/teacherClasses.server.ts");
  assert.match(
    classServer,
    /else if \(review\.status !== "ignored"\) counts\.reviewing \+= 1;/
  );
  // The dashboard 待批改 count also subtracts ignored reviews.
  const dashboardServer = read("lib/teacherDashboardServer.ts");
  assert.match(dashboardServer, /selfIgnored -[\s\S]{0,20}assignmentIgnored/);
});

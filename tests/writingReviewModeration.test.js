import assert from "node:assert/strict";
import test from "node:test";

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
  assert.deepEqual(
    filterWritingReviewListEntries(entries, { status: "all" }).map((entry) => entry.attemptId),
    [ATTEMPT_A, ATTEMPT_B, ATTEMPT_C]
  );
  assert.deepEqual(
    filterWritingReviewListEntries(entries, { status: "pending", taskType: "email" }).map(
      (entry) => entry.attemptId
    ),
    [ATTEMPT_A]
  );
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

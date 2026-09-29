const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  ASSIGNMENT_ITEM_CONFIG,
  ASSIGNMENT_CATALOG_PAGE_SIZE,
  assignmentCatalogEntryKey,
  assignmentCatalogMonths,
  assignmentCatalogTopics,
  assignmentItemTypesForSubject,
  assignmentItemViewerHref,
  assignmentPreviewVisibility,
  buildAssignmentItemSnapshot,
  clearAssignmentCatalogEntries,
  filterAssignmentCatalogEntries,
  isAssignmentCatalogEntrySelected,
  paginateAssignmentCatalogEntries,
  selectAllAssignmentCatalogEntries,
  someAssignmentCatalogEntriesSelected,
  toggleAssignmentCatalogSelection,
  ASSIGNMENT_PREVIEW_LIMIT
} = require("../lib/assignmentCatalog.ts");
const {
  assignmentGroupProgress,
  defaultWritingAssignmentTitle,
  isWritingReviewItemType,
  nextWritingAssignmentAutoTitle
} = require("../lib/writingAssignments.ts");
const {
  teacherAssignmentItemAction,
  teacherAssignmentItemResultHref
} = require("../lib/teacherAssignmentItems.ts");
const {
  classAssignmentTitleBase,
  classesForAssignmentSubject
} = require("../lib/teacherClasses.ts");
const {
  ASSIGNMENT_DRAFT_STORAGE_KEY,
  defaultAssignmentPickerFilters,
  defaultAssignmentPickerState,
  assignmentPickerFiltersFor,
  readAssignmentDraft,
  selectAssignmentPickerItemType,
  setAssignmentPickerPage,
  updateAssignmentPickerFilters,
  writeAssignmentDraft
} = require("../lib/assignmentPickerState.ts");

const projectRoot = path.resolve(__dirname, "..");
const source = (relativePath) =>
  fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

const PICKER = "components/teacher/TeacherAssignmentCatalogPicker.tsx";
const CREATE_FORM = "components/teacher/TeacherWritingAssignmentForm.tsx";
const CATALOG_ROUTE = "app/api/teacher/writing/assignments/catalog/route.ts";
const CATALOG_SERVER = "lib/assignmentCatalog.server.ts";
const RESULTS_SERVER = "lib/assignmentResults.server.ts";
const LIST = "components/teacher/TeacherWritingAssignmentList.tsx";
const DETAIL_BODY = "components/teacher/TeacherWritingAssignmentDetailBody.tsx";
const PREVIEW = "components/teacher/TeacherAssignmentSelectionPreview.tsx";
const MIGRATION = "supabase/assignment_subjects_and_item_types.sql";

function entry(overrides) {
  return {
    catalog_category: null,
    item_id: "item-1",
    item_type: "email",
    months: ["2026-09"],
    reading_length: null,
    title: "Requesting a Refund",
    year_month: "2026-09",
    ...overrides
  };
}

// ---------------------------------------------------------------------------
// 1. Filters (month / topic / length / title search)
// ---------------------------------------------------------------------------

test("WE / AD filters combine month AND topic AND title search", () => {
  const entries = [
    entry({ item_id: "we-1", item_type: "email", months: ["2026-09"], catalog_category: "餐饮服务", title: "Asking About Catering Options" }),
    entry({ item_id: "we-2", item_type: "email", months: ["2026-08"], catalog_category: "餐饮服务", title: "Reporting a Service Issue" }),
    entry({ item_id: "ad-1", item_type: "academic_discussion", months: ["2026-09"], catalog_category: "教育", title: "Online Learning Debate" })
  ];
  const we = (filters) => filterAssignmentCatalogEntries(entries, { itemType: "email", ...filters }).map((item) => item.item_id);

  assert.deepEqual(we({}), ["we-1", "we-2"]);
  assert.deepEqual(we({ month: "2026-09" }), ["we-1"]);
  assert.deepEqual(we({ topic: "餐饮服务" }), ["we-1", "we-2"]);
  assert.deepEqual(we({ month: "2026-09", topic: "餐饮服务" }), ["we-1"]);
  assert.deepEqual(we({ month: "2026-09", topic: "餐饮服务", query: "catering" }), ["we-1"]);
  assert.deepEqual(we({ query: "service" }), ["we-2"]);
  // 全部 / empty dimensions never restrict.
  assert.deepEqual(we({ month: "", topic: "", query: "" }), ["we-1", "we-2"]);
  assert.deepEqual(
    filterAssignmentCatalogEntries(entries, { itemType: "academic_discussion", month: "2026-09", topic: "教育" })
      .map((item) => item.item_id),
    ["ad-1"]
  );
});

test("BAS filters only month + title search (no topic dimension)", () => {
  const entries = [
    entry({ item_id: "bas-1", item_type: "build_sentence", months: ["2026-09"], catalog_category: "anything", title: "套题001" }),
    entry({ item_id: "bas-2", item_type: "build_sentence", months: ["2026-08"], catalog_category: "other", title: "套题002" })
  ];
  assert.equal(ASSIGNMENT_ITEM_CONFIG.build_sentence.hasTopic, false);
  assert.equal(ASSIGNMENT_ITEM_CONFIG.build_sentence.hasLength, false);
  assert.deepEqual(
    filterAssignmentCatalogEntries(entries, { itemType: "build_sentence", month: "2026-09" }).map((item) => item.item_id),
    ["bas-1"]
  );
  assert.deepEqual(
    filterAssignmentCatalogEntries(entries, { itemType: "build_sentence", query: "套题002" }).map((item) => item.item_id),
    ["bas-2"]
  );
});

test("CTW / RAP filter month + topic; RDL adds the shared 长篇/短篇 length rule", () => {
  const entries = [
    entry({ item_id: "ctw-1", item_type: "ctw", months: ["2026-09"], catalog_category: "动物", title: "Tiger Territorial Behavior" }),
    entry({ item_id: "rap-1", item_type: "rap", months: ["2026-09"], catalog_category: "邮件", title: "A Short Passage" }),
    entry({ item_id: "rdl-short", item_type: "rdl", months: ["2026-09"], catalog_category: "邮件", reading_length: "short", title: "Package Delivery" }),
    entry({ item_id: "rdl-long", item_type: "rdl", months: ["2026-09"], catalog_category: "邮件", reading_length: "long", title: "Course Description" })
  ];
  assert.deepEqual(
    filterAssignmentCatalogEntries(entries, { itemType: "ctw", month: "2026-09", topic: "动物" }).map((item) => item.item_id),
    ["ctw-1"]
  );
  assert.deepEqual(
    filterAssignmentCatalogEntries(entries, { itemType: "rap", month: "2026-09", topic: "邮件" }).map((item) => item.item_id),
    ["rap-1"]
  );
  const rdl = (filters) => filterAssignmentCatalogEntries(entries, { itemType: "rdl", ...filters }).map((item) => item.item_id);
  assert.deepEqual(rdl({ month: "2026-09", topic: "邮件" }), ["rdl-short", "rdl-long"]);
  assert.deepEqual(rdl({ month: "2026-09", topic: "邮件", length: "short" }), ["rdl-short"]);
  assert.deepEqual(rdl({ length: "long" }), ["rdl-long"]);
  assert.deepEqual(rdl({ length: "all" }), ["rdl-short", "rdl-long"]);
  // RDL length metadata is the same field the student catalog uses.
  const catalogServer = source(CATALOG_SERVER);
  assert.match(catalogServer, /question_count/);
  assert.match(catalogServer, /count === 2\) return "short"/);
  assert.match(catalogServer, /count === 3\) return "long"/);
});

test("Full Set filters only month + title search", () => {
  const entries = [
    entry({ item_id: "20260902A", item_type: "full_set", months: ["2026-09"], title: "20260902A" }),
    entry({ item_id: "20260802A", item_type: "full_set", months: ["2026-08"], title: "20260802A" })
  ];
  assert.equal(ASSIGNMENT_ITEM_CONFIG.full_set.hasTopic, false);
  assert.equal(ASSIGNMENT_ITEM_CONFIG.full_set.hasLength, false);
  assert.equal(ASSIGNMENT_ITEM_CONFIG.full_set.hasQuestionView, false);
  assert.deepEqual(
    filterAssignmentCatalogEntries(entries, { itemType: "full_set", month: "2026-09" }).map((item) => item.item_id),
    ["20260902A"]
  );
  assert.deepEqual(
    filterAssignmentCatalogEntries(entries, { itemType: "full_set", query: "20260802" }).map((item) => item.item_id),
    ["20260802A"]
  );
});

test("the title search never matches passage / question content", () => {
  // The lightweight entry has no body fields at all, and the filter only ever
  // reads `title`.
  const entry = {
    catalog_category: null,
    item_id: "we-1",
    item_type: "email",
    months: ["2026-09"],
    reading_length: null,
    title: "Requesting a Refund",
    year_month: "2026-09",
    // A body field that exists on the raw question must be ignored.
    scenario: "You bought a broken laptop charger.",
    requirement_1: "Explain the problem."
  };
  assert.deepEqual(
    filterAssignmentCatalogEntries([entry], { itemType: "email", query: "laptop charger" }),
    []
  );
  assert.deepEqual(
    filterAssignmentCatalogEntries([entry], { itemType: "email", query: "refund" }).map((item) => item.item_id),
    ["we-1"]
  );
  const picker = source(PICKER);
  assert.match(picker, /filterAssignmentCatalogEntries/);
  assert.doesNotMatch(picker, /searchText|search_text/);
});

test("the catalog exposes month and topic option lists", () => {
  const entries = [
    entry({ item_id: "a", months: ["2026-09", "2026-08"] }),
    entry({ item_id: "b", item_type: "academic_discussion", months: ["2026-07"], catalog_category: "教育" })
  ];
  assert.deepEqual(assignmentCatalogMonths(entries), ["2026-09", "2026-08", "2026-07"]);
  assert.deepEqual(assignmentCatalogTopics(entries), ["教育"]);
});

// ---------------------------------------------------------------------------
// 2. Selection
// ---------------------------------------------------------------------------

test("mixed WRITING selection (WE + AD + BAS) keeps every stable item once", () => {
  let selection = new Map();
  const we = entry({ item_id: "we-1", item_type: "email" });
  const ad = entry({ item_id: "ad-1", item_type: "academic_discussion" });
  const bas = entry({ item_id: "bas-1", item_type: "build_sentence" });
  selection = toggleAssignmentCatalogSelection(selection, we);
  selection = toggleAssignmentCatalogSelection(selection, ad);
  selection = toggleAssignmentCatalogSelection(selection, bas);
  assert.deepEqual(
    Array.from(selection.keys()),
    ["email:we-1", "academic_discussion:ad-1", "build_sentence:bas-1"]
  );
  // The same stable item can never enter twice.
  selection = toggleAssignmentCatalogSelection(selection, { ...we });
  assert.equal(selection.size, 2);
  assert.equal(isAssignmentCatalogEntrySelected(selection, we), false);
});

test("mixed READING selection (CTW + RDL + RAP + Full Set) keeps every stable item once", () => {
  let selection = new Map();
  const items = [
    entry({ item_id: "ctw-1", item_type: "ctw" }),
    entry({ item_id: "rdl-1", item_type: "rdl" }),
    entry({ item_id: "rap-1", item_type: "rap" }),
    entry({ item_id: "20260902A", item_type: "full_set" })
  ];
  for (const item of items) selection = toggleAssignmentCatalogSelection(selection, item);
  assert.equal(selection.size, 4);
  assert.deepEqual(
    Array.from(selection.values()).map(assignmentCatalogEntryKey),
    ["ctw:ctw-1", "rdl:rdl-1", "rap:rap-1", "full_set:20260902A"]
  );
});

test("switching the tab or the filters never clears the cross-type selection", () => {
  let selection = new Map();
  selection = toggleAssignmentCatalogSelection(selection, entry({ item_id: "we-1", item_type: "email" }));
  selection = toggleAssignmentCatalogSelection(selection, entry({ item_id: "ad-1", item_type: "academic_discussion" }));
  // Tab switch: the picker only changes its filter state, never the selection.
  const filteredByTab = filterAssignmentCatalogEntries(
    Array.from(selection.values()),
    { itemType: "email" }
  );
  assert.deepEqual(filteredByTab.map((item) => item.item_id), ["we-1"]);
  assert.equal(selection.size, 2);
  // Filter switch: filtering twice still keeps the other tab's item.
  assert.equal(
    filterAssignmentCatalogEntries(Array.from(selection.values()), { itemType: "academic_discussion", month: "2026-09" })
      .length,
    1
  );
  assert.equal(selection.size, 2);
  const picker = source(PICKER);
  assert.match(picker, /onStateChange\(updateAssignmentPickerFilters\(state, activeItemType/);
  assert.match(picker, /onStateChange\(selectAssignmentPickerItemType\(state, itemType\)\)/);
  assert.doesNotMatch(picker, /setSelection|onSelectionChange\(new Map/);
});

test("全选当前结果 only selects the currently filtered rows", () => {
  const entries = [
    entry({ item_id: "we-1", item_type: "email", months: ["2026-09"] }),
    entry({ item_id: "we-2", item_type: "email", months: ["2026-08"] }),
    entry({ item_id: "we-3", item_type: "email", months: ["2026-09"] })
  ];
  const filtered = filterAssignmentCatalogEntries(entries, { itemType: "email", month: "2026-09" });
  assert.deepEqual(filtered.map((item) => item.item_id), ["we-1", "we-3"]);
  let selection = selectAllAssignmentCatalogEntries(new Map(), filtered);
  assert.equal(selection.size, 2);
  assert.equal(isAssignmentCatalogEntrySelected(selection, entries[1]), false);
  // Selecting all again is idempotent and never duplicates.
  selection = selectAllAssignmentCatalogEntries(selection, filtered);
  assert.equal(selection.size, 2);
  assert.equal(someAssignmentCatalogEntriesSelected(selection, filtered), true);
  // Unchecking removes exactly the filtered rows, never the others.
  selection = toggleAssignmentCatalogSelection(selection, entry({ item_id: "ad-1", item_type: "academic_discussion" }));
  selection = clearAssignmentCatalogEntries(selection, filtered);
  assert.deepEqual(Array.from(selection.keys()), ["academic_discussion:ad-1"]);
  const picker = source(PICKER);
  assert.match(picker, /selectAllAssignmentCatalogEntries\(selection, filteredEntries\)/);
  assert.match(picker, /clearAssignmentCatalogEntries\(selection, filteredEntries\)/);
});

test("the visible row number restarts at 1 and never becomes an identity", () => {
  const picker = source(PICKER);
  assert.match(picker, /\{index \+ 1\}\. \{entry\.title\}/);
  assert.match(picker, /key=\{assignmentCatalogEntryKey\(entry\)\}/);
  assert.match(picker, /序号按当前筛选结果从 1 开始/);
});

// ---------------------------------------------------------------------------
// 3. Preview fold
// ---------------------------------------------------------------------------

test("the preview shows up to five items and folds the rest", () => {
  const five = Array.from({ length: ASSIGNMENT_PREVIEW_LIMIT }, (_, index) => ({ key: `k${index}`, label: `第${index + 1}题` }));
  const collapsedFive = assignmentPreviewVisibility(five, false);
  assert.equal(collapsedFive.visible.length, 5);
  assert.equal(collapsedFive.remaining, 0);
  assert.equal(collapsedFive.expandable, false);

  const many = Array.from({ length: 22 }, (_, index) => ({ key: `k${index}`, label: `第${index + 1}题` }));
  const collapsed = assignmentPreviewVisibility(many, false);
  assert.equal(collapsed.visible.length, 5);
  assert.equal(collapsed.remaining, 17);
  assert.equal(collapsed.expandable, true);
  const expanded = assignmentPreviewVisibility(many, true);
  assert.equal(expanded.visible.length, 22);
  assert.equal(expanded.remaining, 0);

  const preview = source(PREVIEW);
  assert.match(preview, /assignmentPreviewVisibility\(items, expanded\)/);
  assert.match(preview, /查看剩余 \{remaining\} 题/);
  assert.match(preview, /收起/);
  assert.match(preview, /useState\(false\)/);
});

// ---------------------------------------------------------------------------
// 4. Auto title
// ---------------------------------------------------------------------------

test("automatic titles carry the subject and keep the sequence per subject", () => {
  const assignedAt = new Date("2026-09-28T04:00:00.000Z");
  assert.equal(
    defaultWritingAssignmentTitle({ assignedAt, firstStudentName: "张三", studentCount: 1 }),
    "张三 写作 2026-09-28"
  );
  assert.equal(
    defaultWritingAssignmentTitle({ assignedAt, firstStudentName: "张三", studentCount: 1, subject: "reading" }),
    "张三 阅读 2026-09-28"
  );
  assert.equal(
    defaultWritingAssignmentTitle({ assignedAt, firstStudentName: "张三", studentCount: 3 }),
    "张三等 写作 2026-09-28"
  );
  assert.equal(
    classAssignmentTitleBase("托福A班", assignedAt, "reading"),
    "托福A班 阅读 2026-09-28"
  );
  // Same subject repeats get (2), (3); the other subject never occupies a slot.
  assert.equal(
    nextWritingAssignmentAutoTitle("张三 阅读 2026-09-28", ["张三 阅读 2026-09-28"]),
    "张三 阅读 2026-09-28 (2)"
  );
  assert.equal(
    nextWritingAssignmentAutoTitle("张三 阅读 2026-09-28", [
      "张三 写作 2026-09-28",
      "张三 写作 2026-09-28 (2)"
    ]),
    "张三 阅读 2026-09-28"
  );
  assert.equal(
    nextWritingAssignmentAutoTitle("张三 写作 2026-09-28", ["张三 阅读 2026-09-28 (2)"]),
    "张三 写作 2026-09-28"
  );
  // A BAS-only assignment is still 写作: the subject comes from step 1.
  const form = source(CREATE_FORM);
  assert.match(form, /subject: assignmentSubject/);
  assert.match(form, /const assignmentSubject: AssignmentSubject = subject \?\? "writing"/);

  // Class titles follow the same rule, and the class list is subject-scoped.
  assert.equal(
    classAssignmentTitleBase("托福A班", assignedAt),
    "托福A班 写作 2026-09-28"
  );
  assert.equal(
    classAssignmentTitleBase("托福A班", assignedAt, "reading"),
    "托福A班 阅读 2026-09-28"
  );
  const classes = [
    { class_id: "w", name: "写作班", subjects: ["writing"] },
    { class_id: "r", name: "阅读班", subjects: ["reading"] },
    { class_id: "b", name: "双科班", subjects: ["reading", "writing"] }
  ];
  assert.deepEqual(
    classesForAssignmentSubject(classes, "writing").map((entry) => entry.class_id),
    ["w", "b"]
  );
  assert.deepEqual(
    classesForAssignmentSubject(classes, "reading").map((entry) => entry.class_id),
    ["r", "b"]
  );
  assert.match(form, /classesForAssignmentSubject\(classesState\.data\?\.classes \?\? \[\], assignmentSubject\)/);
});

// ---------------------------------------------------------------------------
// 5. Card status adapter
// ---------------------------------------------------------------------------

test("Reading and Writing cards share one group status badge mapping", () => {
  const writing = assignmentGroupProgress({ completedCount: 2, totalCount: 2 });
  const reading = assignmentGroupProgress({ completedCount: 2, totalCount: 2 });
  assert.equal(writing.label, "已完成");
  assert.equal(reading.label, "已完成");
  assert.equal(writing.badgeClass, reading.badgeClass);
  assert.equal(
    assignmentGroupProgress({ completedCount: 1, totalCount: 3 }).label,
    "进行中"
  );
  assert.equal(
    assignmentGroupProgress({ completedCount: 1, totalCount: 3 }).progressText,
    "1 / 3 已完成"
  );
  assert.equal(
    assignmentGroupProgress({ completedCount: 0, totalCount: 4 }).label,
    "未完成"
  );
  assert.equal(
    assignmentGroupProgress({ completedCount: 0, totalCount: 4 }).badgeClass,
    "bg-amber-50 text-amber-700"
  );
  const list = source(LIST);
  assert.match(list, /AssignmentStatusBadge/);
  assert.match(list, /AssignmentProgressText/);
});

// ---------------------------------------------------------------------------
// 6. Detail row actions (批改 vs 查看)
// ---------------------------------------------------------------------------

test("WE / AD rows are 批改 and every other item type is 查看", () => {
  const reviewStudent = {
    available_result: null,
    latest_review_status: null,
    latest_submitted_attempt_id: "attempt-1"
  };
  for (const itemType of ["email", "academic_discussion"]) {
    const action = teacherAssignmentItemAction({
      itemType,
      returnTo: "/teacher/writing/assignments",
      student: reviewStudent,
      studentId: "student-1"
    });
    assert.equal(action.kind, "review");
    assert.equal(action.label, "批改");
    assert.match(action.href, /^\/teacher\/writing\/reviews\/attempt-1/);
  }
  const results = {
    build_sentence: { kind: "bas_set", id: "set-1", completed_at: null },
    ctw: { kind: "reading_attempt", id: "ra-1", completed_at: null },
    rdl: { kind: "reading_attempt", id: "ra-2", completed_at: null },
    rap: { kind: "reading_attempt", id: "ra-3", completed_at: null },
    full_set: { kind: "reading_full_set", id: "fs-1", completed_at: null }
  };
  const expectedHref = {
    build_sentence: "/teacher/students/student-1/details/set-1",
    ctw: "/teacher/students/student-1/reading/attempts/ra-1",
    rdl: "/teacher/students/student-1/reading/attempts/ra-2",
    rap: "/teacher/students/student-1/reading/attempts/ra-3",
    full_set: "/teacher/students/student-1/reading/full-set-attempts/fs-1"
  };
  for (const itemType of ["build_sentence", "ctw", "rdl", "rap", "full_set"]) {
    const action = teacherAssignmentItemAction({
      itemType,
      student: {
        available_result: results[itemType],
        latest_review_status: null,
        latest_submitted_attempt_id: null
      },
      studentId: "student-1"
    });
    assert.equal(action.kind, "view", itemType);
    assert.equal(action.label, "查看", itemType);
    assert.equal(action.href, expectedHref[itemType], itemType);
  }
  // An unfinished read-only item never offers 查看.
  assert.equal(
    teacherAssignmentItemAction({
      itemType: "rdl",
      student: { available_result: null, latest_review_status: null, latest_submitted_attempt_id: null },
      studentId: "student-1"
    }),
    null
  );
  assert.equal(
    teacherAssignmentItemAction({
      itemType: "full_set",
      student: { available_result: null, latest_review_status: null, latest_submitted_attempt_id: null },
      studentId: "student-1"
    }),
    null
  );
});

test("WE / AD are the only Writing Review item types", () => {
  assert.equal(isWritingReviewItemType("email"), true);
  assert.equal(isWritingReviewItemType("academic_discussion"), true);
  for (const itemType of ["build_sentence", "ctw", "rdl", "rap", "full_set"]) {
    assert.equal(isWritingReviewItemType(itemType), false, itemType);
  }
  const body = source(DETAIL_BODY);
  assert.match(body, /teacherAssignmentItemAction/);
  const resultsServer = source(RESULTS_SERVER);
  // The locator only reads the existing practice tables and never reviews.
  assert.doesNotMatch(resultsServer, /writing_reviews|writing_attempts/);
  assert.match(resultsServer, /from\("reading_attempts"\)/);
  assert.match(resultsServer, /from\("reading_full_set_attempts"\)/);
  assert.match(resultsServer, /from\("attempts"\)/);
});

// ---------------------------------------------------------------------------
// 7. 查看题目 route mapping
// ---------------------------------------------------------------------------

test("查看题目 maps every item type to the existing teacher question-bank route", () => {
  const cases = [
    ["email", "/teacher/question-bank/EMAIL-1?taskType=email&preview=1"],
    ["academic_discussion", "/teacher/question-bank/AD-1?taskType=academic_discussion&preview=1"],
    ["build_sentence", "/teacher/question-bank/item-bas-1?taskType=build_sentence&preview=1"],
    ["ctw", "/teacher/question-bank/reading-ctw-abc?taskType=ctw&preview=1"],
    ["rdl", "/teacher/question-bank/reading-rdl-abc?taskType=rdl&preview=1"],
    ["rap", "/teacher/question-bank/reading-rap-abc?taskType=rap&preview=1"]
  ];
  for (const [itemType, expected] of cases) {
    const itemId = expected.split("?")[0].split("/").pop();
    assert.equal(
      assignmentItemViewerHref({ item_id: itemId, item_type: itemType }),
      expected,
      itemType
    );
  }
  // Every 查看题目 entry point opens the standalone preview in a new tab.
  assert.match(
    source(PICKER),
    /<Link[\s\S]*?href=\{viewerHref\}[\s\S]*?rel="noopener noreferrer"[\s\S]*?target="_blank"[\s\S]*?>/
  );
  // Full Set deliberately has no 查看题目 link, and no alternative entry.
  assert.equal(
    assignmentItemViewerHref({ item_id: "20260902A", item_type: "full_set" }),
    null
  );
  const picker = source(PICKER);
  assert.match(picker, /assignmentItemViewerHref\(entry\)/);
  assert.match(picker, /查看题目/);
  // The route identity is never the visible row number.
  assert.doesNotMatch(picker, /assignmentItemViewerHref\(\{[^}]*index/);
});

test("查看题目 is a link, not a button, and never toggles the row", () => {
  const picker = source(PICKER);
  const row = picker.match(/function renderSelectableRow[\s\S]*?\n  \}\n\}/)?.[0] ?? "";
  assert.ok(row.includes("查看题目"), "row must render 查看题目");
  // The clickable label (checkbox + number + title) and the link are siblings:
  // clicking the link can never reach the row's checkbox, and the link only
  // stops propagation.
  assert.match(row, /<label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">/);
  const labelEnd = row.indexOf("</label>");
  const linkStart = row.indexOf("<Link");
  assert.ok(labelEnd > 0 && linkStart > labelEnd, "查看题目 must live outside the row label");
  assert.match(row, /<label[\s\S]*?type="checkbox"[\s\S]*?<\/label>/);
  assert.match(row, /onClick=\{\(event\) => \{[\s\S]*?event\.stopPropagation\(\);/);
  assert.match(row, /className="shrink-0 text-sm font-normal text-student-primary underline-offset-4/);
  assert.doesNotMatch(row, /teacher-button/);
  // Full Set rows still render the checkbox and title, just without the link.
  assert.match(row, /\{viewerHref \? \(/);
});

// ---------------------------------------------------------------------------
// 8. Filters + 查看题目 after filtering
// ---------------------------------------------------------------------------

test("查看题目 keeps the stable item id after month / topic / length / search filters", () => {
  const entries = [
    entry({ item_id: "reading-rdl-111", item_type: "rdl", months: ["2026-09"], catalog_category: "邮件", reading_length: "short", title: "Package Delivery" }),
    entry({ item_id: "reading-rdl-222", item_type: "rdl", months: ["2026-09"], catalog_category: "邮件", reading_length: "long", title: "Course Description" })
  ];
  const filtered = filterAssignmentCatalogEntries(entries, {
    itemType: "rdl",
    length: "long",
    month: "2026-09",
    query: "course",
    topic: "邮件"
  });
  assert.equal(filtered.length, 1);
  assert.equal(
    assignmentItemViewerHref(filtered[0]),
    "/teacher/question-bank/reading-rdl-222?taskType=rdl&preview=1"
  );
  assert.notEqual(
    assignmentItemViewerHref(filtered[0]),
    assignmentItemViewerHref(entries[0])
  );
});

// ---------------------------------------------------------------------------
// 9. Performance / N+1
// ---------------------------------------------------------------------------

test("the Assignment catalog stays lightweight and never preloads question bodies", () => {
  const catalogServer = source(CATALOG_SERVER);
  const catalogRoute = source(CATALOG_ROUTE);
  const picker = source(PICKER);
  // Only identity / title / month / topic / length metadata is selected.
  assert.doesNotMatch(catalogServer, /catalog_search_text|reading_passages|reading_questions|reading_question_options|scenario|requirement_1|professor_prompt/);
  assert.match(catalogServer, /"logical_item_id,module,title,first_seen_date,first_seen_source_label,first_seen_source_order,question_count,catalog_category,reading_source_occurrences\(occurrence_id,occurrence_date\)"/);
  assert.match(catalogServer, /loadPracticeCatalogDirectory/);
  assert.match(catalogRoute, /subject/);
  // One request per subject; filters are pure client-side.
  assert.match(picker, /TEACHER_ASSIGNMENT_CATALOG_CACHE_PREFIX/);
  assert.match(picker, /catalog\?subject=\$\{subject\}/);
  assert.match(picker, /useMemo/);
  assert.doesNotMatch(picker, /assignments\/questions/);
  assert.doesNotMatch(picker, /itemId=/);
  assert.doesNotMatch(picker, /teacherApiFetch\(`\/api\/teacher\/question-bank/);
});

test("the item result locator batches its queries instead of one per row", () => {
  const resultsServer = source(RESULTS_SERVER);
  assert.match(resultsServer, /loadAssignmentStudentResults/);
  assert.match(resultsServer, /\.in\("logical_item_id", itemBatch\)/);
  assert.match(resultsServer, /\.in\("student_id", studentBatch\)/);
  assert.match(resultsServer, /for \(const itemBatch of chunk\(/);
  // No attempt / result writes.
  assert.doesNotMatch(resultsServer, /\.insert\(|\.update\(|\.delete\(|\.upsert\(/);
});

// ---------------------------------------------------------------------------
// 10. Picker state preservation
// ---------------------------------------------------------------------------

test("the picker draft survives 查看题目 and clears after 布置", () => {
  const form = source(CREATE_FORM);
  const pickerState = source("lib/assignmentPickerState.ts");
  assert.match(pickerState, /ASSIGNMENT_DRAFT_STORAGE_KEY = "tps:teacher:assignment-draft:v2"/);
  assert.match(form, /readAssignmentDraft/);
  assert.match(form, /writeAssignmentDraft/);
  assert.match(pickerState, /window\.sessionStorage\.setItem\(ASSIGNMENT_DRAFT_STORAGE_KEY/);
  assert.match(pickerState, /window\.sessionStorage\.removeItem\(ASSIGNMENT_DRAFT_STORAGE_KEY\)/);
  assert.match(form, /writeAssignmentDraft\(null\)/);
  assert.match(form, /readAssignmentDraft\(\)/);
  assert.match(form, /setSelection\(new Map\(draft\.selection\.map/);
  assert.match(form, /setPickerState\(draft\.picker\)/);

  // Round trip with a stubbed sessionStorage.
  const store = new Map();
  const previousWindow = globalThis.window;
  globalThis.window = {
    sessionStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      removeItem: (key) => store.delete(key),
      setItem: (key, value) => store.set(key, value)
    }
  };
  try {
    const key = ASSIGNMENT_DRAFT_STORAGE_KEY;
    assert.equal(readAssignmentDraft(), null);
    writeAssignmentDraft({
      picker: defaultAssignmentPickerState("reading"),
      selection: [entry({ item_id: "ctw-1", item_type: "ctw" })],
      source: "question_bank",
      subject: "reading",
      version: 2
    });
    const draft = readAssignmentDraft();
    assert.equal(draft.subject, "reading");
    assert.equal(draft.picker.activeItemType, "ctw");
    assert.equal(draft.selection[0].item_id, "ctw-1");
    writeAssignmentDraft(null);
    assert.equal(readAssignmentDraft(), null);
    assert.equal(store.has(key), false);
    // Invalid drafts are ignored instead of crashing the wizard.
    store.set(key, JSON.stringify({ version: 2, subject: "nope" }));
    assert.equal(readAssignmentDraft(), null);
    // A previous-version draft is ignored as well.
    store.set(key, JSON.stringify({ version: 1, subject: "reading" }));
    assert.equal(readAssignmentDraft(), null);
    store.set(key, "{not json");
    assert.equal(readAssignmentDraft(), null);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

// ---------------------------------------------------------------------------
// 10b. Pure front-end pagination + per-tab filter isolation
// ---------------------------------------------------------------------------

test("pagination keeps ten rows per page and clamps the last page", () => {
  assert.equal(ASSIGNMENT_CATALOG_PAGE_SIZE, 10);
  const pageIds = (count, page) => paginateAssignmentCatalogEntries(
    Array.from({ length: count }, (_, index) => `item-${index + 1}`),
    page
  );
  assert.deepEqual(pageIds(0, 1), {
    from: 0,
    items: [],
    page: 1,
    pageCount: 1,
    total: 0
  });
  assert.equal(pageIds(1, 1).items.length, 1);
  assert.equal(pageIds(1, 1).pageCount, 1);
  assert.equal(pageIds(10, 1).items.length, 10);
  assert.equal(pageIds(10, 1).pageCount, 1);
  assert.equal(pageIds(11, 1).items.length, 10);
  assert.equal(pageIds(11, 1).pageCount, 2);
  assert.deepEqual(pageIds(11, 2), {
    from: 10,
    items: ["item-11"],
    page: 2,
    pageCount: 2,
    total: 11
  });
  assert.equal(pageIds(11, 9).page, 2);
  assert.equal(pageIds(11, 0).page, 1);
  assert.equal(pageIds(21, 3).items.length, 1);
  assert.equal(pageIds(21, 3).pageCount, 3);
  assert.deepEqual(pageIds(21, 2).items[0], "item-11");
  // The picker renders the page slice; paging never re-fetches the catalog.
  const picker = source(PICKER);
  assert.match(picker, /paginateAssignmentCatalogEntries\(filteredEntries, filters\.page, ASSIGNMENT_CATALOG_PAGE_SIZE\)/);
  assert.match(picker, /页码|第 \{pageData\.page\}\/\{pageData\.pageCount\} 页/);
  assert.match(picker, /setAssignmentPickerPage\(state, activeItemType, pageData\.page - 1\)/);
  assert.match(picker, /setAssignmentPickerPage\(state, activeItemType, pageData\.page \+ 1\)/);
});

test("selection survives paging and 全选当前结果 still covers the whole filtered result", () => {
  const entries = Array.from({ length: 21 }, (_, index) =>
    entry({ item_id: `we-${index + 1}`, item_type: "email" })
  );
  const filtered = filterAssignmentCatalogEntries(entries, { itemType: "email" });
  const pageThree = paginateAssignmentCatalogEntries(filtered, 3);
  assert.equal(pageThree.items.length, 1);
  // 全选当前结果 acts on the whole filtered result, not the visible page.
  let selection = selectAllAssignmentCatalogEntries(new Map(), filtered);
  assert.equal(selection.size, 21);
  assert.equal(isAssignmentCatalogEntrySelected(selection, pageThree.items[0]), true);
  // Selection still survives a page change (nothing reads the page).
  selection = toggleAssignmentCatalogSelection(selection, entries[0]);
  assert.equal(selection.size, 20);
  assert.equal(isAssignmentCatalogEntrySelected(selection, pageThree.items[0]), true);
  const picker = source(PICKER);
  assert.match(picker, /selectAllAssignmentCatalogEntries\(selection, filteredEntries\)/);
  assert.match(picker, /clearAssignmentCatalogEntries\(selection, filteredEntries\)/);
  assert.match(picker, /pageData\.from \+ index/);
});

test("every item type keeps its own filter set and page", () => {
  let state = defaultAssignmentPickerState("reading");
  assert.equal(state.activeItemType, "ctw");
  // CTW: month + topic + page 3.
  state = updateAssignmentPickerFilters(state, "ctw", { month: "2026-09", topic: "生物健康" });
  state = setAssignmentPickerPage(state, "ctw", 3);
  // RDL keeps its own length and page 2.
  state = selectAssignmentPickerItemType(state, "rdl");
  state = updateAssignmentPickerFilters(state, "rdl", { topic: "教育", length: "long" });
  state = setAssignmentPickerPage(state, "rdl", 2);
  // RAP stays untouched.
  state = selectAssignmentPickerItemType(state, "rap");
  assert.deepEqual(assignmentPickerFiltersFor(state, "rap"), {
    itemType: "rap",
    length: "all",
    month: "",
    page: 1,
    query: "",
    topic: ""
  });
  assert.deepEqual(assignmentPickerFiltersFor(state, "ctw"), {
    itemType: "ctw",
    length: "all",
    month: "2026-09",
    page: 3,
    query: "",
    topic: "生物健康"
  });
  assert.deepEqual(assignmentPickerFiltersFor(state, "rdl"), {
    itemType: "rdl",
    length: "long",
    month: "",
    page: 2,
    query: "",
    topic: "教育"
  });
  // A filter change resets only its own page; other tabs keep theirs.
  const changed = updateAssignmentPickerFilters(state, "ctw", { topic: "动物" });
  assert.equal(assignmentPickerFiltersFor(changed, "ctw").page, 1);
  assert.equal(assignmentPickerFiltersFor(changed, "ctw").topic, "动物");
  assert.equal(assignmentPickerFiltersFor(changed, "rdl").page, 2);
  assert.equal(assignmentPickerFiltersFor(changed, "rdl").topic, "教育");
  // Keeping the same value does not reset the page.
  const unchanged = updateAssignmentPickerFilters(
    state,
    "ctw",
    { topic: "生物健康" }
  );
  assert.equal(assignmentPickerFiltersFor(unchanged, "ctw").page, 3);
  // Search is per-tab too.
  const searched = updateAssignmentPickerFilters(
    updateAssignmentPickerFilters(state, "ctw", { query: "refund" }),
    "rdl",
    { query: "technology" }
  );
  assert.equal(assignmentPickerFiltersFor(searched, "ctw").query, "refund");
  assert.equal(assignmentPickerFiltersFor(searched, "rdl").query, "technology");
  assert.equal(assignmentPickerFiltersFor(searched, "rap").query, "");
});

test("the real CTW topic → RDL/RAP isolation case never inherits another tab", () => {
  const ctwA = entry({
    item_id: "ctw-a",
    item_type: "ctw",
    months: ["2026-09"],
    catalog_category: "生物健康",
    title: "Tiger"
  });
  const rdl = entry({
    item_id: "rdl-1",
    item_type: "rdl",
    months: ["2026-09"],
    catalog_category: "教育",
    reading_length: "short",
    title: "A Short Passage"
  });
  const rapSameTopic = entry({
    item_id: "rap-1",
    item_type: "rap",
    months: ["2026-06"],
    catalog_category: "生物健康",
    title: "Biology Passage"
  });
  const entries = [ctwA, rdl, rapSameTopic];
  let state = defaultAssignmentPickerState("reading");
  state = updateAssignmentPickerFilters(state, "ctw", { topic: "生物健康" });
  assert.deepEqual(
    filterAssignmentCatalogEntries(entries, {
      itemType: state.activeItemType,
      ...assignmentPickerFiltersFor(state, "ctw")
    }).map((item) => item.item_id),
    ["ctw-a"]
  );
  // Switch to RDL: its own filter is 全部, so the full RDL result shows.
  state = selectAssignmentPickerItemType(state, "rdl");
  assert.equal(assignmentPickerFiltersFor(state, "rdl").topic, "");
  assert.deepEqual(
    filterAssignmentCatalogEntries(entries, {
      itemType: "rdl",
      ...assignmentPickerFiltersFor(state, "rdl")
    }).map((item) => item.item_id),
    ["rdl-1"]
  );
  // Switch to RAP: even though a same-named topic exists there, it never
  // inherits the CTW filter.
  state = selectAssignmentPickerItemType(state, "rap");
  assert.deepEqual(
    filterAssignmentCatalogEntries(entries, {
      itemType: "rap",
      ...assignmentPickerFiltersFor(state, "rap")
    }).map((item) => item.item_id),
    ["rap-1"]
  );
  // Returning to CTW restores its own month / topic / page.
  state = setAssignmentPickerPage(state, "ctw", 2);
  state = selectAssignmentPickerItemType(state, "rdl");
  state = selectAssignmentPickerItemType(state, "ctw");
  assert.deepEqual(assignmentPickerFiltersFor(state, "ctw"), {
    itemType: "ctw",
    length: "all",
    month: "",
    page: 2,
    query: "",
    topic: "生物健康"
  });
  // RDL length only ever participates in the RDL tab.
  const rdlLengthState = updateAssignmentPickerFilters(state, "rdl", { length: "long" });
  assert.equal(assignmentPickerFiltersFor(rdlLengthState, "rdl").length, "long");
  assert.equal(assignmentPickerFiltersFor(rdlLengthState, "ctw").length, "all");
  assert.equal(assignmentPickerFiltersFor(rdlLengthState, "rap").length, "all");
  assert.deepEqual(
    filterAssignmentCatalogEntries(entries, {
      itemType: "ctw",
      ...assignmentPickerFiltersFor(rdlLengthState, "ctw")
    }).map((item) => item.item_id),
    ["ctw-a"]
  );
});

test("the row style is compact, unbolded and shared by Writing and Reading", () => {
  const picker = source(PICKER);
  const row = picker.match(/function renderSelectableRow[\s\S]*?\n  \}\n\}/)?.[0] ?? "";
  // Title and 查看题目 use the same font size; the title is normal weight.
  assert.match(row, /text-sm font-normal text-student-text/);
  assert.match(row, /text-sm font-normal text-student-primary/);
  assert.doesNotMatch(row, /font-semibold|font-bold/);
  // Compact rows with a still-clickable height.
  assert.match(picker, /<li className="flex min-h-10 items-center gap-3 bg-white px-4 py-2"/);
  assert.match(row, /<label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">/);
  assert.match(row, /<input[\s\S]*?type="checkbox"/);
  // The natural number stays a display-only prefix.
  assert.match(row, /\{index \+ 1\}\. \{entry\.title\}/);
  // Writing and Reading share this exact picker component.
  const form = source(CREATE_FORM);
  assert.match(form, /TeacherAssignmentCatalogPicker/);
  assert.equal((form.match(/TeacherAssignmentCatalogPicker/g) ?? []).length >= 1, true);
});

test("the list block keeps a stable height across pages", () => {
  const picker = source(PICKER);
  // Every page pads to ten row slots so a short last page cannot move the
  // content below the list.
  assert.match(picker, /const emptySlots = pageData\.total === 0/);
  assert.match(picker, /ASSIGNMENT_CATALOG_PAGE_SIZE - pageData\.items\.length/);
  assert.match(picker, /ASSIGNMENT_CATALOG_PAGE_SIZE - 1/);
  assert.match(picker, /\{pageSlots\.map\(\(slot\) => \(/);
  assert.match(picker, /className="invisible min-h-10 bg-white px-4 py-2"/);
  // Pagination lives inside the list block, next to the count line.
  const listIndex = picker.indexOf("data-assignment-catalog-list");
  const pagerIndex = picker.indexOf("题目分页");
  assert.ok(listIndex > 0 && pagerIndex > listIndex);
});

// ---------------------------------------------------------------------------
// 11. Database migration
// ---------------------------------------------------------------------------

test("the migration adds the subject column, item types and subject-aware RPCs", () => {
  const sql = source(MIGRATION);
  assert.match(sql, /alter table public\.writing_assignments\s*\n\s*add column if not exists subject text not null default 'writing'/);
  assert.match(sql, /writing_assignments_subject_check/);
  assert.match(sql, /check \(subject in \('writing', 'reading'\)\)/);
  assert.match(sql, /writing_assignments_task_type_check/);
  assert.match(sql, /'build_sentence',\s*\n\s*'ctw',\s*\n\s*'rdl',\s*\n\s*'rap',\s*\n\s*'full_set'/);
  assert.match(sql, /writing_assignments_subject_item_type_check/);
  // Subject consistency inside the create / edit RPCs.
  assert.match(sql, /raise exception 'MIXED_ASSIGNMENT_SUBJECT'/);
  assert.match(sql, /and binding\.domain = p_subject/);
  assert.match(sql, /and binding\.domain = derived_subject/);
  assert.match(sql, /raise exception 'CLASS_NOT_READING_CLASS'/);
  assert.match(sql, /'subject', p_subject/);
  // The old overloads are replaced, not shadowed.
  assert.match(sql, /drop function if exists public\.create_writing_assignment_group\(uuid, jsonb, uuid\[\], text, boolean\)/);
  assert.match(sql, /drop function if exists public\.create_writing_assignment_group\(uuid, jsonb, uuid\[\], text, boolean, uuid\)/);
  assert.match(sql, /create_writing_assignment_group\(uuid, jsonb, uuid\[\], text, boolean, text\)/);
  assert.match(sql, /create_writing_assignment_group\(uuid, jsonb, uuid\[\], text, boolean, text, uuid\)/);
  // Historical Writing data stays untouched.
  assert.doesNotMatch(sql, /update public\.writing_assignments\s*\nset task_type/);
});

// ---------------------------------------------------------------------------
// 12. Snapshot shape
// ---------------------------------------------------------------------------

test("the Assignment snapshot keeps only lightweight catalog metadata", () => {
  const snapshot = buildAssignmentItemSnapshot(entry({
    item_id: "reading-rdl-111",
    item_type: "rdl",
    reading_length: "short",
    catalog_category: "邮件",
    title: "Package Delivery"
  }));
  assert.deepEqual(snapshot, {
    catalog_category: "邮件",
    item_id: "reading-rdl-111",
    item_type: "rdl",
    reading_length: "short",
    set_title: "Package Delivery",
    source_set_id: null,
    year_month: "2026-09"
  });
  const basSnapshot = buildAssignmentItemSnapshot(entry({
    item_id: "item-bas-1",
    item_type: "build_sentence",
    source_set_id: "set-1",
    title: "套题001"
  }));
  assert.equal(basSnapshot.source_set_id, "set-1");
  // The persisted snapshot never carries question content.
  const serialized = JSON.stringify(snapshot);
  assert.doesNotMatch(serialized, /scenario|professor_prompt|requirement|passage/);
});

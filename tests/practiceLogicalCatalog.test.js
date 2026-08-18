const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const {
  buildLogicalPracticeCatalog,
  isLogicalPracticeTaskType,
  parseLogicalPracticePage
} = require("../lib/practiceLogicalCatalog.ts");
const {
  createPracticePublicUniverse
} = require("../lib/practicePublicUniverse.ts");

const projectRoot = path.resolve(__dirname, "..");

function emptySnapshot() {
  return {
    items: [],
    sources: [],
    questionMaps: [],
    buildSentenceQuestions: [],
    emailQuestions: [],
    academicDiscussionQuestions: []
  };
}

function dateFromIndex(index) {
  return new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10);
}

function displayNumber(index) {
  return String(index + 1).padStart(3, "0");
}

function addBasItem(snapshot, occurrences, index, setId = `bas-set-${index + 1}`) {
  const itemId = `bas-item-${index + 1}`;
  const sourceId = `bas-source-${index + 1}`;
  snapshot.items.push({
    item_id: itemId,
    task_type: "build_sentence",
    display_number: displayNumber(index),
    display_title: null,
    first_seen_date: dateFromIndex(index),
    is_active: true
  });
  snapshot.sources.push({
    source_id: sourceId,
    item_id: itemId,
    task_type: "build_sentence",
    source_set_id: setId,
    source_question_id: null,
    is_canonical: true
  });
  for (let order = 1; order <= 10; order += 1) {
    const questionId = `${setId}-q${order}`;
    snapshot.buildSentenceQuestions.push({
      question_id: questionId,
      set_id: setId,
      question_order: order
    });
    snapshot.questionMaps.push({
      source_id: sourceId,
      source_question_id: questionId,
      source_question_order: order,
      logical_question_order: order
    });
  }
  occurrences.push({ source_id: sourceId, occurred_on: dateFromIndex(index) });
  return { itemId, sourceId };
}

function addWritingItem(snapshot, occurrences, taskType, index) {
  const prefix = taskType === "email" ? "email" : "ad";
  const itemId = `${prefix}-item-${index + 1}`;
  const sourceId = `${prefix}-source-${index + 1}`;
  const questionId = `${prefix}-question-${index + 1}`;
  snapshot.items.push({
    item_id: itemId,
    task_type: taskType,
    display_number: displayNumber(index),
    display_title: `${prefix.toUpperCase()} permanent title ${index + 1}`,
    first_seen_date: dateFromIndex(index),
    is_active: true
  });
  snapshot.sources.push({
    source_id: sourceId,
    item_id: itemId,
    task_type: taskType,
    source_set_id: null,
    source_question_id: questionId,
    is_canonical: true
  });
  const rawRow = {
    question_id: questionId,
    subject: `Raw subject that must not replace title ${index + 1}`
  };
  if (taskType === "email") snapshot.emailQuestions.push(rawRow);
  else snapshot.academicDiscussionQuestions.push(rawRow);
  occurrences.push({ source_id: sourceId, occurred_on: dateFromIndex(index) });
  return { itemId, questionId, sourceId };
}

function buildFixture({ basCount = 108, emailCount = 58, adCount = 63 } = {}) {
  const snapshot = emptySnapshot();
  const occurrences = [];
  const bas = Array.from({ length: basCount }, (_, index) =>
    addBasItem(snapshot, occurrences, index)
  );
  const emails = Array.from({ length: emailCount }, (_, index) =>
    addWritingItem(snapshot, occurrences, "email", index)
  );
  const discussions = Array.from({ length: adCount }, (_, index) =>
    addWritingItem(snapshot, occurrences, "academic_discussion", index)
  );

  for (let index = 0; index < Math.min(14, bas.length); index += 1) {
    snapshot.sources.push({
      source_id: `bas-duplicate-source-${index + 1}`,
      item_id: bas[index].itemId,
      task_type: "build_sentence",
      source_set_id: `bas-duplicate-set-${index + 1}`,
      source_question_id: null,
      is_canonical: false
    });
  }
  if (emails[0]) {
    snapshot.sources.push({
      source_id: "email-duplicate-source",
      item_id: emails[0].itemId,
      task_type: "email",
      source_set_id: null,
      source_question_id: "email-duplicate-question",
      is_canonical: false
    });
    snapshot.emailQuestions.push({ question_id: "email-duplicate-question" });
  }
  if (discussions[0]) {
    snapshot.sources.push({
      source_id: "ad-duplicate-source",
      item_id: discussions[0].itemId,
      task_type: "academic_discussion",
      source_set_id: null,
      source_question_id: "ad-duplicate-question",
      is_canonical: false
    });
    snapshot.academicDiscussionQuestions.push({ question_id: "ad-duplicate-question" });
  }
  snapshot.emailQuestions.push({ question_id: "pending-email-question" });
  snapshot.academicDiscussionQuestions.push({ question_id: "pending-ad-question" });

  return { snapshot, occurrences, bas, emails, discussions };
}

function catalog(fixture, taskType, page = 1) {
  return buildLogicalPracticeCatalog({
    universe: createPracticePublicUniverse(fixture.snapshot),
    occurrences: fixture.occurrences,
    taskType,
    page
  });
}

test("122 BAS raw sources collapse to 108 logical cards", () => {
  const fixture = buildFixture();
  assert.equal(
    fixture.snapshot.sources.filter(({ task_type }) => task_type === "build_sentence").length,
    122
  );
  const result = catalog(fixture, "build_sentence");
  assert.equal(result.pagination.total_items, 108);
  assert.equal(new Set(result.items.map(({ item_id }) => item_id)).size, result.items.length);
  assert.ok(result.items.every(({ question_count, display_title }) =>
    question_count === 10 && display_title === null
  ));
});

test("duplicate Email and AD raw sources each remain one logical item", () => {
  const fixture = buildFixture({ basCount: 0, emailCount: 2, adCount: 2 });
  assert.equal(catalog(fixture, "email").pagination.total_items, 2);
  assert.equal(catalog(fixture, "academic_discussion").pagination.total_items, 2);
});

test("inactive items and pending-only raw questions are absent", () => {
  const fixture = buildFixture({ basCount: 0, emailCount: 1, adCount: 1 });
  fixture.snapshot.items.push({
    item_id: "inactive-email-item",
    task_type: "email",
    display_number: "099",
    display_title: "Inactive",
    first_seen_date: "2026-12-01",
    is_active: false
  });
  fixture.snapshot.sources.push({
    source_id: "inactive-email-source",
    item_id: "inactive-email-item",
    task_type: "email",
    source_set_id: null,
    source_question_id: "inactive-email-question",
    is_canonical: true
  });
  fixture.snapshot.emailQuestions.push({ question_id: "inactive-email-question" });
  const result = catalog(fixture, "email");
  assert.equal(result.pagination.total_items, 1);
  assert.equal(result.items.some(({ item_id }) => item_id === "inactive-email-item"), false);
  assert.equal(
    result.items.some(({ canonical }) => canonical.source_question_id === "pending-email-question"),
    false
  );
});

test("occurrence dates aggregate every source, deduplicate same-day variants, and sort DESC", () => {
  const fixture = buildFixture({ basCount: 0, emailCount: 1, adCount: 0 });
  fixture.occurrences.push(
    { source_id: fixture.emails[0].sourceId, occurred_on: "2026-05-06" },
    { source_id: "email-duplicate-source", occurred_on: "2026-05-06" },
    { source_id: "email-duplicate-source", occurred_on: "2026-06-07" }
  );
  assert.deepEqual(catalog(fixture, "email").items[0].occurrence_dates, [
    "2026-06-07",
    "2026-05-06",
    "2026-01-01"
  ]);
});

test("logical list sorts by first_seen_date DESC with stable display-number secondary order", () => {
  const fixture = buildFixture({ basCount: 0, emailCount: 3, adCount: 0 });
  fixture.snapshot.items[0].first_seen_date = "2026-08-20";
  fixture.snapshot.items[1].first_seen_date = "2026-08-20";
  fixture.snapshot.items[2].first_seen_date = "2026-08-21";
  assert.deepEqual(
    catalog(fixture, "email").items.map(({ item_id }) => item_id),
    ["email-item-3", "email-item-2", "email-item-1"]
  );
});

test("all task types use fixed 10-item pages and correct fixture totals", () => {
  const fixture = buildFixture();
  const bas = catalog(fixture, "build_sentence");
  const email = catalog(fixture, "email");
  const ad = catalog(fixture, "academic_discussion");
  assert.deepEqual(bas.pagination, {
    page: 1,
    page_size: 10,
    total_items: 108,
    total_pages: 11
  });
  assert.equal(email.pagination.total_items, 58);
  assert.equal(email.pagination.total_pages, 6);
  assert.equal(ad.pagination.total_items, 63);
  assert.equal(ad.pagination.total_pages, 7);
  assert.equal(bas.items.length, 10);
  assert.equal(email.items.length, 10);
  assert.equal(ad.items.length, 10);
  assert.equal(catalog(fixture, "build_sentence", 12).items.length, 0);
});

test("page validation is shared and rejects zero, fractions, signs, and unsafe integers", () => {
  assert.equal(parseLogicalPracticePage(null), 1);
  assert.equal(parseLogicalPracticePage("1"), 1);
  for (const invalid of ["0", "-1", "+1", "1.5", "abc", "9007199254740992"]) {
    assert.equal(parseLogicalPracticePage(invalid), null);
  }
  assert.equal(isLogicalPracticeTaskType("build_sentence"), true);
  assert.equal(isLogicalPracticeTaskType("email"), true);
  assert.equal(isLogicalPracticeTaskType("academic_discussion"), true);
  assert.equal(isLogicalPracticeTaskType("custom"), false);
});

test("display-number correction is read fresh while item_id identity remains stable", () => {
  const fixture = buildFixture({ basCount: 0, emailCount: 1, adCount: 0 });
  fixture.snapshot.items[0].display_number = "060";
  const before = catalog(fixture, "email").items[0];
  fixture.snapshot.items[0].display_number = "057B";
  const after = catalog(fixture, "email").items[0];
  assert.equal(before.item_id, after.item_id);
  assert.equal(before.display_number, "060");
  assert.equal(after.display_number, "057B");
});

test("Email and AD titles come only from practice_items and catalog never invokes title AI", () => {
  const fixture = buildFixture({ basCount: 0, emailCount: 1, adCount: 1 });
  assert.equal(catalog(fixture, "email").items[0].display_title, "EMAIL permanent title 1");
  assert.equal(catalog(fixture, "academic_discussion").items[0].display_title, "AD permanent title 1");
  const source = fs.readFileSync(
    path.join(projectRoot, "lib/practiceLogicalCatalog.ts"),
    "utf8"
  );
  assert.doesNotMatch(source, /generateAcademicDiscussionTitle|OpenRouter|subject/);
});

test("grammar, wrongbook, and custom Assignment data never appear in logical catalogs", () => {
  const fixture = buildFixture({ basCount: 1, emailCount: 1, adCount: 0 });
  addBasItem(fixture.snapshot, fixture.occurrences, 20, "grammar-all-conditionals");
  addBasItem(fixture.snapshot, fixture.occurrences, 21, "wrongbook-random-student-1");
  const universe = createPracticePublicUniverse(fixture.snapshot);
  assert.equal(
    buildLogicalPracticeCatalog({
      universe,
      occurrences: fixture.occurrences,
      taskType: "build_sentence",
      page: 1
    }).pagination.total_items,
    1
  );
  assert.equal(
    universe.resolveWritingAssignment({
      questionSource: "custom",
      taskType: "email",
      questionId: "custom:assignment-1"
    }).publicMappingAvailable,
    false
  );
  assert.equal(catalog(fixture, "email").pagination.total_items, 1);
});

test("logical API is a new no-store route and leaves legacy list/detail routes in place", () => {
  const route = fs.readFileSync(
    path.join(projectRoot, "app/api/practice-catalog/route.ts"),
    "utf8"
  );
  assert.match(route, /getLogicalPracticeItems/);
  assert.match(route, /Cache-Control": "no-store"/);
  assert.match(route, /force-dynamic/);
  assert.equal(fs.existsSync(path.join(projectRoot, "app/api/sets/route.ts")), true);
  assert.equal(
    fs.existsSync(path.join(projectRoot, "app/api/sets/[setId]/questions/route.ts")),
    true
  );
  assert.equal(fs.existsSync(path.join(projectRoot, "app/api/writing/catalog/route.ts")), true);
});

test("contract contains canonical metadata and no Step 13 student status fields", () => {
  const item = catalog(
    buildFixture({ basCount: 0, emailCount: 1, adCount: 0 }),
    "email"
  ).items[0];
  assert.deepEqual(Object.keys(item), [
    "item_id",
    "task_type",
    "display_number",
    "display_title",
    "first_seen_date",
    "occurrence_dates",
    "canonical",
    "question_count"
  ]);
  assert.deepEqual(Object.keys(item.canonical), [
    "source_id",
    "source_set_id",
    "source_question_id"
  ]);
  for (const forbidden of ["status", "completed", "draft", "attempt_count", "score"] ) {
    assert.equal(forbidden in item, false);
  }
});

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  attachLogicalPracticeStudentStateFromRows
} = require("../lib/practiceLogicalState.ts");
const {
  attachReadingCatalogStudentStates,
  buildReadingCatalogPublicPayload
} = require("../lib/reading/catalog.ts");
const {
  attachReadingFullSetStudentStates,
  buildReadingFullSetCatalog,
  buildReadingFullSetCatalogStates,
  buildReadingFullSetPublicCatalog,
  buildReadingFullSets
} = require("../lib/reading/fullSets.ts");

const projectRoot = path.join(__dirname, "..");

function stateRow(overrides = {}) {
  return {
    student_id: "student-1",
    task_type: "email",
    item_id: "item-1",
    status: "completed",
    resume_attempt_id: null,
    resume_source_question_id: null,
    latest_attempt_id: null,
    latest_completed_attempt_id: null,
    attempt_count: 1,
    last_started_at: null,
    last_completed_at: null,
    latest_result: null,
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides
  };
}

function practiceItem(overrides = {}) {
  return {
    item_id: "item-1",
    task_type: "email",
    canonical: {
      source_id: "source-1",
      source_set_id: null,
      source_question_id: "question-1"
    },
    ...overrides
  };
}

test("items without a state row stay unstarted and untouched", () => {
  const items = [
    practiceItem(),
    practiceItem({
      item_id: "item-2",
      canonical: {
        source_id: "source-2",
        source_set_id: null,
        source_question_id: "question-2"
      }
    })
  ];
  const merged = attachLogicalPracticeStudentStateFromRows({ items, states: [] });

  assert.equal(merged.length, 2);
  for (const item of merged) {
    assert.equal(item.student_state.status, "unstarted");
    assert.equal(item.student_state.resume_attempt_id, null);
    assert.equal(item.student_state.latest_attempt_id, null);
    assert.equal(item.student_state.can_start, true);
    assert.equal(item.student_state.can_resume, false);
    assert.equal(item.student_state.can_retake, false);
    assert.equal(item.student_state.can_view_result, false);
    assert.deepEqual(item.actions.start, {
      source_id: item.canonical.source_id,
      source_set_id: item.canonical.source_set_id,
      source_question_id: item.canonical.source_question_id
    });
    assert.equal(item.actions.resume, null);
    assert.equal(item.actions.view_result, null);
    assert.equal(item.actions.retake, null);
  }
});

test("one state row only changes the matching item", () => {
  const items = [practiceItem(), practiceItem({ item_id: "item-2" })];
  const merged = attachLogicalPracticeStudentStateFromRows({
    items,
    states: [
      stateRow({
        item_id: "item-1",
        status: "completed",
        latest_attempt_id: "attempt-1",
        latest_completed_attempt_id: "attempt-1",
        attempt_count: 3
      })
    ]
  });

  assert.equal(merged[0].student_state.status, "completed");
  assert.equal(merged[0].student_state.latest_completed_attempt_id, "attempt-1");
  assert.equal(merged[0].student_state.can_retake, true);
  assert.equal(merged[1].student_state.status, "unstarted");
  assert.equal(merged[1].student_state.can_start, true);
});

test("state rows of another task type never leak into the catalog merge", () => {
  const merged = attachLogicalPracticeStudentStateFromRows({
    items: [practiceItem()],
    states: [
      stateRow({ task_type: "ctw", item_id: "question-1", status: "completed" })
    ]
  });
  assert.equal(merged[0].student_state.status, "unstarted");
});

test("BAS state keeps completed / view result / retake navigation", () => {
  const item = practiceItem({
    item_id: "bas-item",
    task_type: "build_sentence",
    canonical: {
      source_id: "bas-source",
      source_set_id: "20260801-A",
      source_question_id: null
    }
  });
  const merged = attachLogicalPracticeStudentStateFromRows({
    items: [item],
    states: [
      stateRow({
        task_type: "build_sentence",
        item_id: "bas-item",
        latest_attempt_id: "attempt-9",
        latest_completed_attempt_id: "attempt-9"
      })
    ]
  })[0];

  assert.equal(merged.student_state.status, "completed");
  assert.equal(merged.student_state.resume_attempt_id, null);
  assert.equal(merged.student_state.can_resume, false);
  assert.equal(merged.student_state.can_view_result, true);
  assert.equal(merged.actions.view_result.attempt_id, "attempt-9");
  assert.deepEqual(merged.actions.retake, {
    source_id: "bas-source",
    source_set_id: "20260801-A",
    source_question_id: null
  });
});

test("Writing draft resumes the exact raw question even when it differs from canonical", () => {
  const merged = attachLogicalPracticeStudentStateFromRows({
    items: [practiceItem()],
    states: [
      stateRow({
        status: "in_progress",
        resume_attempt_id: "draft-1",
        resume_source_question_id: "question-old",
        latest_attempt_id: "draft-1",
        attempt_count: 1
      })
    ]
  })[0];

  assert.equal(merged.student_state.status, "in_progress");
  assert.equal(merged.student_state.can_resume, true);
  assert.deepEqual(merged.actions.resume, {
    attempt_id: "draft-1",
    source_set_id: null,
    source_question_id: "question-old"
  });
  assert.equal(merged.actions.view_result, null);
});

test("Writing retake keeps both the resume draft and the previous completion", () => {
  const merged = attachLogicalPracticeStudentStateFromRows({
    items: [practiceItem()],
    states: [
      stateRow({
        status: "in_progress",
        resume_attempt_id: "draft-2",
        latest_attempt_id: "draft-2",
        latest_completed_attempt_id: "submitted-1",
        attempt_count: 2
      })
    ]
  })[0];

  assert.equal(merged.student_state.status, "in_progress");
  assert.equal(merged.student_state.latest_completed_attempt_id, "submitted-1");
  assert.equal(merged.actions.view_result.attempt_id, "submitted-1");
  assert.equal(merged.actions.view_result.source_question_id, "question-1");
  assert.equal(merged.actions.resume.attempt_id, "draft-2");
});

function readingItem(module, id, date, label, order, overrides = {}) {
  return {
    logical_item_id: id,
    module,
    title: module === "ctw" ? null : `${id} title`,
    first_seen_date: date,
    first_seen_source_label: label,
    first_seen_source_order: order,
    question_count: 3,
    scored_item_count: 3,
    catalog_category: "Category A",
    reading_source_occurrences: [
      { occurrence_id: `${id}-o1`, occurrence_date: date },
      { occurrence_id: `${id}-o2`, occurrence_date: "2026-08-11" }
    ],
    ...overrides
  };
}

test("Reading merge produces unstarted, in-progress, and completed cards from sparse rows", () => {
  const publicPayload = buildReadingCatalogPublicPayload({
    taskType: "rdl",
    items: [
      readingItem("rdl", "rdl-a", "2026-08-01", "8.1A", 1, { title: "Library Notice" }),
      readingItem("rdl", "rdl-b", "2026-08-02", "8.2A", 1, { title: "Campus Notice" })
    ]
  });
  const payload = attachReadingCatalogStudentStates(publicPayload, [
    stateRow({
      task_type: "rdl",
      item_id: "rdl-a",
      status: "in_progress",
      resume_attempt_id: "draft-a",
      latest_attempt_id: "draft-a"
    }),
    stateRow({
      task_type: "rdl",
      item_id: "rdl-b",
      status: "completed",
      latest_attempt_id: "submitted-b",
      latest_completed_attempt_id: "submitted-b",
      last_completed_at: "2026-08-12T00:00:00.000Z",
      latest_result: { correctPoints: 2, totalPoints: 3, elapsedSeconds: 120 }
    })
  ]);
  const byId = new Map(payload.items.map((item) => [item.itemId, item]));

  assert.equal(byId.get("rdl-a").status, "in_progress");
  assert.equal(byId.get("rdl-a").draftAttemptId, "draft-a");
  assert.equal(byId.get("rdl-a").latestSubmittedAttempt, null);
  assert.equal(byId.get("rdl-b").status, "completed");
  assert.deepEqual(byId.get("rdl-b").latestSubmittedAttempt, {
    attemptId: "submitted-b",
    correctPoints: 2,
    totalPoints: 3,
    accuracy: 2 / 3,
    elapsedSeconds: 120,
    submittedAt: "2026-08-12T00:00:00.000Z"
  });
  // Directory fields and occurrence counts stay untouched by the merge.
  assert.deepEqual(byId.get("rdl-a").occurrenceDateCounts, [
    { date: "2026-08-11", count: 1 },
    { date: "2026-08-01", count: 1 }
  ]);
  assert.equal(publicPayload.items.some((item) => "status" in item), false);
});

test("Reading state rows for items outside the public catalog are ignored", () => {
  const publicPayload = buildReadingCatalogPublicPayload({
    taskType: "rdl",
    items: [readingItem("rdl", "rdl-a", "2026-08-01", "8.1A", 1, { title: "Library Notice" })]
  });
  const payload = attachReadingCatalogStudentStates(publicPayload, [
    stateRow({ task_type: "rdl", item_id: "rdl-missing", status: "completed", latest_completed_attempt_id: "x" })
  ]);
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].status, "unstarted");
});

function repositoryFullSetInputs() {
  const directory = path.join(projectRoot, "data/reading/import-packages");
  const files = collectJsonFiles(directory);
  return files.flatMap((file) => {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return data.occurrences.map((occurrence) => ({
      occurrenceId: occurrence.occurrenceId,
      logicalItemId: occurrence.logicalItemId,
      taskType: data.item.module,
      occurrenceDate: occurrence.occurrenceDate,
      sourceLabel: occurrence.sourceLabel,
      sourceModule: occurrence.sourceModule,
      sourceOrder: occurrence.sourceOrder,
      sourceQuestionStart: occurrence.sourceQuestionStart,
      sourceQuestionEnd: occurrence.sourceQuestionEnd,
      scoringPointCount: data.item.scoredItemCount
    }));
  });
}

function collectJsonFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory()
      ? collectJsonFiles(target)
      : entry.name.endsWith(".json") ? [target] : [];
  }).sort();
}

test("Full Set sparse merge matches the legacy attempt-based state builder exactly", () => {
  const fullSets = buildReadingFullSets(repositoryFullSetInputs());
  const publicCatalog = buildReadingFullSetPublicCatalog(fullSets);
  assert.ok(publicCatalog.length > 11);

  const target = publicCatalog[0];
  const attempts = [
    {
      attempt_id: "attempt-old",
      full_set_id: target.fullSetId,
      status: "completed",
      completed_at: "2026-01-01T00:00:00.000Z",
      created_at: "2026-01-01T00:00:00.000Z"
    },
    {
      attempt_id: "attempt-active",
      full_set_id: target.fullSetId,
      status: "in_progress",
      completed_at: null,
      created_at: "2026-02-01T00:00:00.000Z"
    }
  ];
  const legacy = buildReadingFullSetCatalog(fullSets, attempts);
  const legacyTarget = legacy.find((item) => item.fullSetId === target.fullSetId);
  assert.equal(legacyTarget.studentState.status, "in_progress");

  const merged = attachReadingFullSetStudentStates(publicCatalog, [
    stateRow({
      task_type: "full_set",
      item_id: target.fullSetId,
      status: "in_progress",
      resume_attempt_id: "attempt-active",
      latest_attempt_id: "attempt-active",
      latest_completed_attempt_id: "attempt-old"
    })
  ]);
  const mergedTarget = merged.find((item) => item.fullSetId === target.fullSetId);

  assert.deepEqual(mergedTarget.studentState, legacyTarget.studentState);
  // Untouched Full Sets stay unstarted without any state row.
  const untouched = merged.find((item) => item.fullSetId !== target.fullSetId);
  assert.equal(untouched.studentState.status, "unstarted");
  assert.equal(untouched.studentState.activeAttemptId, null);
});

test("Full Set catalog state also matches the legacy unstarted / completed cases", () => {
  const fullSets = buildReadingFullSets(repositoryFullSetInputs());
  const catalog = buildReadingFullSetPublicCatalog(fullSets);
  const firstId = catalog[0].fullSetId;
  const secondId = catalog[1].fullSetId;

  const legacyStates = buildReadingFullSetCatalogStates([
    {
      attempt_id: "attempt-1",
      full_set_id: secondId,
      status: "completed",
      completed_at: "2026-03-01T00:00:00.000Z",
      created_at: "2026-03-01T00:00:00.000Z"
    }
  ]);
  const merged = attachReadingFullSetStudentStates(catalog, [
    stateRow({
      task_type: "full_set",
      item_id: secondId,
      status: "completed",
      latest_attempt_id: "attempt-1",
      latest_completed_attempt_id: "attempt-1"
    })
  ]);

  assert.equal(merged.find((item) => item.fullSetId === secondId).studentState.status, "completed");
  assert.deepEqual(
    merged.find((item) => item.fullSetId === secondId).studentState,
    legacyStates.get(secondId)
  );
  assert.equal(merged.find((item) => item.fullSetId === firstId).studentState.status, "unstarted");
});

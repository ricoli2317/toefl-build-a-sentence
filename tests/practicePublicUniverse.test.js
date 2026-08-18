const assert = require("node:assert/strict");
const test = require("node:test");
const {
  createPracticePublicUniverse
} = require("../lib/practicePublicUniverse.ts");
const {
  resolveWritingAssignmentQuestionIsolation
} = require("../lib/writingAssignments.ts");

function practiceItem(itemId, taskType, displayNumber, isActive = true) {
  return {
    item_id: itemId,
    task_type: taskType,
    display_number: displayNumber,
    display_title: taskType === "build_sentence" ? null : `${itemId} title`,
    first_seen_date: "2026-08-01",
    is_active: isActive
  };
}

function practiceSource(sourceId, itemId, taskType, rawId, isCanonical = true) {
  return {
    source_id: sourceId,
    item_id: itemId,
    task_type: taskType,
    source_set_id: taskType === "build_sentence" ? rawId : null,
    source_question_id: taskType === "build_sentence" ? null : rawId,
    is_canonical: isCanonical
  };
}

function addBuildSentenceSource(snapshot, { itemId, sourceId, setId, displayNumber }) {
  snapshot.items.push(practiceItem(itemId, "build_sentence", displayNumber));
  snapshot.sources.push(practiceSource(sourceId, itemId, "build_sentence", setId));
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
}

function baseSnapshot() {
  const snapshot = {
    items: [
      practiceItem("item-email", "email", "001"),
      practiceItem("item-ad", "academic_discussion", "001"),
      practiceItem("item-inactive", "email", "002", false)
    ],
    sources: [
      practiceSource("source-email", "item-email", "email", "q-email"),
      practiceSource("source-ad", "item-ad", "academic_discussion", "q-ad"),
      practiceSource("source-inactive", "item-inactive", "email", "q-inactive")
    ],
    questionMaps: [],
    buildSentenceQuestions: [],
    emailQuestions: [
      { question_id: "q-email" },
      { question_id: "q-inactive" },
      { question_id: "q-email-orphan" }
    ],
    academicDiscussionQuestions: [
      { question_id: "q-ad" },
      { question_id: "q-ad-pending" }
    ]
  };
  addBuildSentenceSource(snapshot, {
    itemId: "item-bas",
    sourceId: "source-bas",
    setId: "202608-0801-1",
    displayNumber: "001"
  });
  return snapshot;
}

test("active BAS item requires a real canonical 10-question source and complete Q1-Q10 map", () => {
  const universe = createPracticePublicUniverse(baseSnapshot());
  const source = universe.getPublicCanonicalSource("item-bas");
  assert.equal(universe.isPublicPracticeItem("item-bas"), true);
  assert.equal(source.sourceSetId, "202608-0801-1");
  assert.deepEqual(
    source.canonicalQuestions.map(({ logicalQuestionOrder }) => logicalQuestionOrder),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  );
});

test("inactive item is excluded from active public eligibility but remains historically resolvable", () => {
  const universe = createPracticePublicUniverse(baseSnapshot());
  assert.equal(universe.isPublicPracticeItem("item-inactive"), false);
  assert.deepEqual(universe.resolveHistoricalPracticeItem("item-inactive"), {
    itemId: "item-inactive",
    taskType: "email",
    displayNumber: "002",
    displayTitle: "item-inactive title",
    firstSeenDate: "2026-08-01",
    isActive: false
  });
  assert.equal(
    universe.resolveHistoricalRawQuestionToPracticeItem("email", "q-inactive").itemId,
    "item-inactive"
  );
  assert.deepEqual(
    universe.resolveWritingAssignment({
      questionSource: "question_bank",
      taskType: "email",
      questionId: "q-inactive"
    }),
    {
      questionSource: "question_bank",
      rawQuestionId: "q-inactive",
      historicalPracticeItemId: "item-inactive",
      publicPracticeItemId: null,
      publicMappingAvailable: false
    }
  );
});

test("Email with a valid formal canonical raw question is public", () => {
  const source = createPracticePublicUniverse(baseSnapshot())
    .getPublicCanonicalSource("item-email");
  assert.equal(source.taskType, "email");
  assert.equal(source.sourceQuestionId, "q-email");
  assert.equal(source.canonicalQuestions, null);
});

test("Academic Discussion with a valid formal canonical raw question is public", () => {
  const source = createPracticePublicUniverse(baseSnapshot())
    .getPublicCanonicalSource("item-ad");
  assert.equal(source.taskType, "academic_discussion");
  assert.equal(source.sourceQuestionId, "q-ad");
});

test("legacy Writing sources with both set and question IDs remain public", () => {
  const snapshot = baseSnapshot();
  snapshot.sources.find(({ source_id }) => source_id === "source-email").source_set_id =
    "legacy-email-set";
  snapshot.sources.find(({ source_id }) => source_id === "source-ad").source_set_id =
    "legacy-ad-set";

  const universe = createPracticePublicUniverse(snapshot);
  assert.equal(
    universe.resolveActivePublicRawQuestionToPracticeItem("email", "q-email").itemId,
    "item-email"
  );
  assert.equal(
    universe.resolveActivePublicRawQuestionToPracticeItem("academic_discussion", "q-ad").itemId,
    "item-ad"
  );
});

test("raw Email question without practice_item_source is not public", () => {
  const universe = createPracticePublicUniverse(baseSnapshot());
  assert.equal(
    universe.resolveActivePublicRawQuestionToPracticeItem("email", "q-email-orphan"),
    null
  );
});

test("pending-review AD raw question without a formal logical source is not public", () => {
  const universe = createPracticePublicUniverse(baseSnapshot());
  assert.equal(
    universe.resolveActivePublicRawQuestionToPracticeItem(
      "academic_discussion",
      "q-ad-pending"
    ),
    null
  );
});

test("custom assignment is isolated from the public logical universe", () => {
  const universe = createPracticePublicUniverse(baseSnapshot());
  assert.deepEqual(
    universe.resolveWritingAssignment({
      questionSource: "custom",
      taskType: "email",
      questionId: "custom:assignment-1"
    }),
    {
      questionSource: "custom",
      rawQuestionId: null,
      historicalPracticeItemId: null,
      publicPracticeItemId: null,
      publicMappingAvailable: false
    }
  );
  assert.deepEqual(
    resolveWritingAssignmentQuestionIsolation({
      questionSource: "custom",
      questionId: "custom:assignment-1",
      resolvedHistoricalPracticeItemId: "must-also-be-ignored",
      resolvedPublicPracticeItemId: "must-be-ignored"
    }),
    {
      questionSource: "custom",
      rawQuestionId: null,
      historicalPracticeItemId: null,
      publicPracticeItemId: null,
      publicMappingAvailable: false
    }
  );
});

test("question_bank assignment preserves raw question_id and can resolve logical display metadata", () => {
  const universe = createPracticePublicUniverse(baseSnapshot());
  assert.deepEqual(
    universe.resolveWritingAssignment({
      questionSource: "question_bank",
      taskType: "email",
      questionId: "q-email"
    }),
    {
      questionSource: "question_bank",
      rawQuestionId: "q-email",
      historicalPracticeItemId: "item-email",
      publicPracticeItemId: "item-email",
      publicMappingAvailable: true
    }
  );
});

test("assignment writing attempt never counts as a free-practice writing attempt", () => {
  const universe = createPracticePublicUniverse(baseSnapshot());
  assert.equal(
    universe.isFreePracticeWritingAttempt({
      assignment_id: "assignment-1",
      task_type: "email",
      question_id: "q-email"
    }),
    false
  );
});

test("unassigned attempt with a public raw question is a free-practice writing attempt", () => {
  const universe = createPracticePublicUniverse(baseSnapshot());
  assert.equal(
    universe.isFreePracticeWritingAttempt({
      assignment_id: null,
      task_type: "email",
      question_id: "q-email"
    }),
    true
  );
  assert.equal(
    universe.isFreePracticeWritingAttempt({
      assignment_id: null,
      task_type: "academic_discussion",
      question_id: "q-ad-pending"
    }),
    false
  );
});

test("grammar-all and grammar-random virtual sets are never public BAS logical sets", () => {
  const snapshot = baseSnapshot();
  addBuildSentenceSource(snapshot, {
    itemId: "item-grammar-all",
    sourceId: "source-grammar-all",
    setId: "grammar-all-verb-tense",
    displayNumber: "002"
  });
  addBuildSentenceSource(snapshot, {
    itemId: "item-grammar-random",
    sourceId: "source-grammar-random",
    setId: "grammar-random-verb-tense",
    displayNumber: "003"
  });
  const universe = createPracticePublicUniverse(snapshot);
  assert.equal(universe.isPublicPracticeItem("item-grammar-all"), false);
  assert.equal(universe.isPublicPracticeItem("item-grammar-random"), false);
});

test("wrongbook virtual sets are never public BAS logical sets", () => {
  const snapshot = baseSnapshot();
  addBuildSentenceSource(snapshot, {
    itemId: "item-wrongbook",
    sourceId: "source-wrongbook",
    setId: "wrongbook-all-student-1",
    displayNumber: "004"
  });
  const universe = createPracticePublicUniverse(snapshot);
  assert.equal(universe.isPublicPracticeItem("item-wrongbook"), false);
});

test("missing canonical raw source is excluded and never falls back to a duplicate source", () => {
  const snapshot = baseSnapshot();
  snapshot.items.push(practiceItem("item-broken", "email", "003"));
  snapshot.sources.push(
    practiceSource("source-broken-canonical", "item-broken", "email", "q-missing", true),
    practiceSource("source-broken-duplicate", "item-broken", "email", "q-fallback", false)
  );
  snapshot.emailQuestions.push({ question_id: "q-fallback" });
  const universe = createPracticePublicUniverse(snapshot);
  assert.equal(universe.getPublicCanonicalSource("item-broken"), null);
  assert.equal(
    universe.resolveActivePublicRawQuestionToPracticeItem("email", "q-fallback"),
    null
  );
  assert.equal(
    universe.warnings.some(
      ({ code, itemId, sourceId }) =>
        code === "CANONICAL_RAW_SOURCE_MISSING" &&
        itemId === "item-broken" &&
        sourceId === "source-broken-canonical"
    ),
    true
  );
});

test("item_id-based resolution survives a mutable display_number correction", () => {
  const before = baseSnapshot();
  const after = baseSnapshot();
  after.items.find(({ item_id }) => item_id === "item-email").display_number = "057B";
  const beforeUniverse = createPracticePublicUniverse(before);
  const afterUniverse = createPracticePublicUniverse(after);
  assert.equal(
    beforeUniverse.resolveActivePublicRawQuestionToPracticeItem("email", "q-email").itemId,
    "item-email"
  );
  assert.equal(
    afterUniverse.resolveActivePublicRawQuestionToPracticeItem("email", "q-email").itemId,
    "item-email"
  );
  assert.equal(afterUniverse.getPublicCanonicalSource("item-email").displayNumber, "057B");
});

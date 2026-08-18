const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const {
  academicDiscussionFingerprint,
  buildSentenceQuestionFingerprint,
  buildSentenceSetFingerprint,
  emailFingerprint,
  normalizeComparableText
} = require("../lib/practiceImporter/normalization.ts");
const {
  classifyAcademicDiscussion,
  classifyBuildSentence,
  classifyEmail
} = require("../lib/practiceImporter/classification.ts");
const {
  mapMergedBuildSentenceQuestions,
  mapNewBuildSentenceQuestions
} = require("../lib/practiceImporter/buildSentenceMap.ts");
const {
  allocateDisplayNumbers,
  compareDisplayNumbers,
  excelSuffix,
  parseDisplayNumber,
  reconcileDisplayNumbers
} = require("../lib/practiceImporter/numbering.ts");
const {
  parseBuildSentenceOccurrences,
  parseWritingOccurrences
} = require("../lib/practiceImporter/occurrences.ts");
const {
  generateAcademicDiscussionTitle,
  validateAcademicDiscussionTitle
} = require("../lib/practiceImporter/adTitle.ts");

function basQuestion(index, overrides = {}) {
  return {
    questionId: `q-${index}`,
    questionOrder: index,
    sentenceTemplate: `The student ___ sentence number ${index}.`,
    blankCount: 1,
    correctOrderText: JSON.stringify(["writes", `item ${index}`]),
    optionsText: JSON.stringify([`item ${index}`, "writes", "quickly"]),
    distractorsText: JSON.stringify(["slow", "wrong"]),
    finalSentence: `The student writes item ${index}.`,
    ...overrides
  };
}

function basSet(overrides = new Map()) {
  return Array.from({ length: 10 }, (_, index) => basQuestion(index + 1, overrides.get(index + 1)));
}

const email = {
  scenario: "Your course schedule conflicts with work.",
  taskInstruction: "Write an email explaining the problem.",
  requirements: ["Explain the conflict.", "Request a new section.", "Thank the adviser."],
  recipient: "Academic adviser"
};

const discussion = {
  professorPrompt: "Should employers allow staff to work remotely several days each week?",
  studentResponses: [
    "Remote work improves focus and reduces commuting time for employees.",
    "Office work supports collaboration and helps new employees learn quickly."
  ]
};

test("normalization ignores casing, whitespace, quote width, and meaningless terminal punctuation", () => {
  assert.equal(normalizeComparableText("  Ｈｅｌｌｏ  “World”！\n"), "hello world");
});

test("BAS fingerprint treats options and distractors as sets but correct_order as ordered", () => {
  const original = basQuestion(1);
  const reorderedSets = {
    ...original,
    optionsText: JSON.stringify(["quickly", "writes", "item 1"]),
    distractorsText: JSON.stringify(["wrong", "slow"])
  };
  assert.equal(
    buildSentenceQuestionFingerprint(original),
    buildSentenceQuestionFingerprint(reorderedSets)
  );
  assert.notEqual(
    buildSentenceQuestionFingerprint(original),
    buildSentenceQuestionFingerprint({
      ...original,
      correctOrderText: JSON.stringify(["item 1", "writes"])
    })
  );
  assert.equal(
    buildSentenceQuestionFingerprint({ ...original, distractorsText: "" }).length,
    32
  );
});

test("BAS exact sets auto merge despite source order changes and map to canonical Q1-Q10", () => {
  const canonical = basSet();
  const incoming = [...canonical]
    .reverse()
    .map((question, index) => ({ ...question, questionId: `new-${question.questionId}`, questionOrder: index + 1 }));
  const classification = classifyBuildSentence(incoming, [{ itemId: "item-1", content: canonical }]);
  assert.equal(classification.classification, "AUTO_MERGE");
  const canonicalMap = new Map(canonical.map((question) => [question.questionId, question.questionOrder]));
  const mapped = mapMergedBuildSentenceQuestions(incoming, canonical, canonicalMap);
  assert.deepEqual(mapped.map((row) => row.logicalQuestionOrder), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
});

test("BAS 9 exact plus one light edit needs review, while a substantive difference is new", () => {
  const canonical = basSet();
  const light = basSet(new Map([[10, {
    sentenceTemplate: "The student ___ sentence number 10 for class.",
    finalSentence: "The student writes item 10 for class."
  }]]));
  assert.equal(
    classifyBuildSentence(light, [{ itemId: "item-1", content: canonical }]).classification,
    "NEEDS_REVIEW"
  );

  const different = basSet(new Map([[10, {
    sentenceTemplate: "A volcano ___ beneath the distant ocean.",
    correctOrderText: JSON.stringify(["erupted", "suddenly"]),
    optionsText: JSON.stringify(["erupted", "suddenly", "ocean"]),
    distractorsText: JSON.stringify(["quiet", "mountain"]),
    finalSentence: "A volcano erupted suddenly beneath the distant ocean."
  }]]));
  assert.equal(
    classifyBuildSentence(different, [{ itemId: "item-1", content: canonical }]).classification,
    "NEW_ITEM"
  );
});

test("new BAS sources define logical order from their own Q1-Q10", () => {
  assert.deepEqual(
    mapNewBuildSentenceQuestions(basSet()).map((row) => row.logicalQuestionOrder),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
  );
  assert.equal(buildSentenceSetFingerprint(basSet()).length, 32);
});

test("Email ignores subject externally, treats requirements as unordered, and classifies conservatively", () => {
  const reordered = { ...email, requirements: [...email.requirements].reverse() };
  assert.equal(emailFingerprint(email), emailFingerprint(reordered));
  assert.equal(
    classifyEmail(reordered, [{ itemId: "email-1", content: email }]).classification,
    "AUTO_MERGE"
  );

  const light = { ...email, recipient: "Academic advisor" };
  assert.equal(
    classifyEmail(light, [{ itemId: "email-1", content: email }]).classification,
    "NEEDS_REVIEW"
  );
  const different = { ...email, recipient: "The city mayor" };
  assert.equal(
    classifyEmail(different, [{ itemId: "email-1", content: email }]).classification,
    "NEW_ITEM"
  );
});

test("Academic Discussion ignores names by design and treats student responses as an unordered pair", () => {
  const swapped = { ...discussion, studentResponses: [...discussion.studentResponses].reverse() };
  assert.equal(academicDiscussionFingerprint(discussion), academicDiscussionFingerprint(swapped));
  assert.equal(
    classifyAcademicDiscussion(swapped, [{ itemId: "ad-1", content: discussion }]).classification,
    "AUTO_MERGE"
  );
  const light = {
    ...discussion,
    professorPrompt: `${discussion.professorPrompt.slice(0, -1)} today?`
  };
  assert.equal(
    classifyAcademicDiscussion(light, [{ itemId: "ad-1", content: discussion }]).classification,
    "NEEDS_REVIEW"
  );
  const different = {
    ...discussion,
    studentResponses: [discussion.studentResponses[0], "Public parks should charge tourists an entrance fee."]
  };
  assert.equal(
    classifyAcademicDiscussion(different, [{ itemId: "ad-1", content: discussion }]).classification,
    "NEW_ITEM"
  );
});

test("number allocation appends and inserts historical NEW_ITEM suffixes without moving pure numbers", () => {
  const existing = [
    { displayNumber: "058", firstSeenDate: "2026-08-20" },
    { displayNumber: "059", firstSeenDate: "2026-08-28" },
    { displayNumber: "060", firstSeenDate: "2026-08-30" }
  ];
  assert.equal(
    allocateDisplayNumbers(existing, [{ firstSeenDate: "2026-08-31", stableKey: "new" }]).get("new"),
    "061"
  );
  const inserted = allocateDisplayNumbers(existing, [
    { firstSeenDate: "2026-08-26", stableKey: "a" },
    { firstSeenDate: "2026-08-27", stableKey: "b" }
  ]);
  assert.equal(inserted.get("a"), "058A");
  assert.equal(inserted.get("b"), "058B");
  assert.deepEqual(existing.map((item) => item.displayNumber), ["058", "059", "060"]);

  const withAlphabet = [
    ...existing,
    ...Array.from({ length: 26 }, (_, index) => ({
      displayNumber: `058${excelSuffix(index + 1)}`,
      firstSeenDate: "2026-08-26"
    }))
  ];
  assert.equal(
    allocateDisplayNumbers(withAlphabet, [{ firstSeenDate: "2026-08-27", stableKey: "aa" }]).get("aa"),
    "058AA"
  );

  const historical = [
    { displayNumber: "057", firstSeenDate: "2026-08-15" },
    { displayNumber: "058", firstSeenDate: "2026-08-20" },
    { displayNumber: "059", firstSeenDate: "2026-08-28" }
  ];
  assert.equal(
    allocateDisplayNumbers(historical, [{ firstSeenDate: "2026-08-18", stableKey: "historical" }]).get("historical"),
    "057A"
  );
  assert.deepEqual(historical.map((item) => item.displayNumber), ["057", "058", "059"]);
});

test("display-number comparison uses numeric base plus Excel suffix rank", () => {
  assert.deepEqual(
    ["058", "057B", "057", "057A"].sort(compareDisplayNumbers),
    ["057", "057A", "057B", "058"]
  );
  assert.deepEqual(
    ["058", "057AA", "057Z", "057AB"].sort(compareDisplayNumbers),
    ["057Z", "057AA", "057AB", "058"]
  );
  assert.equal(parseDisplayNumber("057Z").suffixRank, 26);
  assert.equal(parseDisplayNumber("057AA").suffixRank, 27);
  assert.ok("057AA" < "057Z", "ordinary string ordering is intentionally different");
});

test("an earlier duplicate moves by item_id and locally shifts occupied suffixes", () => {
  const records = [
    { itemId: "item-057", displayNumber: "057", firstSeenDate: "2026-08-15", canonical: "source-057", title: "Anchor" },
    { itemId: "item-057a", displayNumber: "057A", firstSeenDate: "2026-08-17", canonical: "source-057a", title: "First suffix" },
    { itemId: "item-057b", displayNumber: "057B", firstSeenDate: "2026-08-19", canonical: "source-057b", title: "Second suffix" },
    { itemId: "item-058", displayNumber: "058", firstSeenDate: "2026-08-20", canonical: "source-058", title: "Next anchor" },
    { itemId: "item-060", displayNumber: "060", firstSeenDate: "2026-08-18", canonical: "source-060", title: "Original title" }
  ];
  const changes = reconcileDisplayNumbers(
    records,
    new Map([["item-060", "earlier_duplicate_occurrence"]])
  );
  assert.deepEqual(changes, [
    {
      itemId: "item-057b",
      oldDisplayNumber: "057B",
      newDisplayNumber: "057C",
      reason: "local_resequence"
    },
    {
      itemId: "item-060",
      oldDisplayNumber: "060",
      newDisplayNumber: "057B",
      reason: "earlier_duplicate_occurrence"
    }
  ]);

  const numberByItem = new Map(changes.map((change) => [change.itemId, change.newDisplayNumber]));
  const reconciled = records.map((record) => ({
    ...record,
    displayNumber: numberByItem.get(record.itemId) ?? record.displayNumber
  }));
  assert.deepEqual(
    [...reconciled].sort((left, right) => compareDisplayNumbers(left.displayNumber, right.displayNumber))
      .map(({ displayNumber, firstSeenDate }) => [displayNumber, firstSeenDate]),
    [
      ["057", "2026-08-15"],
      ["057A", "2026-08-17"],
      ["057B", "2026-08-18"],
      ["057C", "2026-08-19"],
      ["058", "2026-08-20"]
    ]
  );
  assert.deepEqual(
    reconciled.find(({ itemId }) => itemId === "item-060"),
    {
      itemId: "item-060",
      displayNumber: "057B",
      firstSeenDate: "2026-08-18",
      canonical: "source-060",
      title: "Original title"
    }
  );
});

test("a historical NEW_ITEM inserted before an occupied suffix locally resequences the interval", () => {
  const existing = [
    { itemId: "item-057", displayNumber: "057", firstSeenDate: "2026-08-15" },
    { itemId: "item-old-057a", displayNumber: "057A", firstSeenDate: "2026-08-18" },
    { itemId: "item-058", displayNumber: "058", firstSeenDate: "2026-08-20" }
  ];
  const initiallyAllocated = allocateDisplayNumbers(
    existing,
    [{ firstSeenDate: "2026-08-17", stableKey: "item-new" }]
  ).get("item-new");
  assert.equal(initiallyAllocated, "057B");

  const items = [
    ...existing,
    {
      itemId: "item-new",
      displayNumber: initiallyAllocated,
      firstSeenDate: "2026-08-17"
    }
  ];
  const changes = reconcileDisplayNumbers(
    items,
    new Map([["item-new", "historical_new_item_insert"]])
  );
  assert.deepEqual(changes, [
    {
      itemId: "item-old-057a",
      oldDisplayNumber: "057A",
      newDisplayNumber: "057B",
      reason: "local_resequence"
    },
    {
      itemId: "item-new",
      oldDisplayNumber: "057B",
      newDisplayNumber: "057A",
      reason: "historical_new_item_insert"
    }
  ]);

  const finalNumberByItem = new Map(
    items.map(({ itemId, displayNumber }) => [itemId, displayNumber])
  );
  for (const { itemId, newDisplayNumber } of changes) {
    finalNumberByItem.set(itemId, newDisplayNumber);
  }
  assert.deepEqual(
    items
      .map(({ itemId, firstSeenDate }) => ({
        itemId,
        displayNumber: finalNumberByItem.get(itemId),
        firstSeenDate
      }))
      .sort((left, right) => compareDisplayNumbers(left.displayNumber, right.displayNumber)),
    [
      { itemId: "item-057", displayNumber: "057", firstSeenDate: "2026-08-15" },
      { itemId: "item-new", displayNumber: "057A", firstSeenDate: "2026-08-17" },
      { itemId: "item-old-057a", displayNumber: "057B", firstSeenDate: "2026-08-18" },
      { itemId: "item-058", displayNumber: "058", firstSeenDate: "2026-08-20" }
    ]
  );
});

test("a historical NEW_ITEM after an occupied suffix keeps the existing suffix unchanged", () => {
  const existing = [
    { itemId: "item-057", displayNumber: "057", firstSeenDate: "2026-08-15" },
    { itemId: "item-old-057a", displayNumber: "057A", firstSeenDate: "2026-08-17" },
    { itemId: "item-058", displayNumber: "058", firstSeenDate: "2026-08-20" }
  ];
  const initiallyAllocated = allocateDisplayNumbers(
    existing,
    [{ firstSeenDate: "2026-08-18", stableKey: "item-new" }]
  ).get("item-new");
  assert.equal(initiallyAllocated, "057B");
  assert.deepEqual(
    reconcileDisplayNumbers(
      [
        ...existing,
        {
          itemId: "item-new",
          displayNumber: initiallyAllocated,
          firstSeenDate: "2026-08-18"
        }
      ],
      new Map([["item-new", "historical_new_item_insert"]])
    ),
    []
  );
  assert.equal(existing.find(({ itemId }) => itemId === "item-old-057a").displayNumber, "057A");
});

test("retired display numbers remain reserved for normal and suffix allocation", () => {
  assert.equal(
    allocateDisplayNumbers(
      [{ displayNumber: "059", firstSeenDate: "2026-08-28" }],
      [{ firstSeenDate: "2026-08-31", stableKey: "new" }],
      ["060"]
    ).get("new"),
    "061"
  );
  assert.equal(
    allocateDisplayNumbers(
      [
        { displayNumber: "057", firstSeenDate: "2026-08-15" },
        { displayNumber: "057A", firstSeenDate: "2026-08-17" },
        { displayNumber: "058", firstSeenDate: "2026-08-20" }
      ],
      [{ firstSeenDate: "2026-08-18", stableKey: "historical" }],
      ["057B"]
    ).get("historical"),
    "057C"
  );
});

test("one batch reconciliation records only each item's final necessary change", () => {
  const items = [
    { itemId: "item-057", displayNumber: "057", firstSeenDate: "2026-08-15" },
    { itemId: "item-057a", displayNumber: "057A", firstSeenDate: "2026-08-17" },
    { itemId: "item-057b", displayNumber: "057B", firstSeenDate: "2026-08-19" },
    { itemId: "item-058", displayNumber: "058", firstSeenDate: "2026-08-20" },
    { itemId: "item-060", displayNumber: "060", firstSeenDate: "2026-08-18" },
    { itemId: "item-061", displayNumber: "061", firstSeenDate: "2026-08-16" }
  ];
  const changes = reconcileDisplayNumbers(
    items,
    new Map([
      ["item-060", "earlier_duplicate_occurrence"],
      ["item-061", "earlier_duplicate_occurrence"]
    ])
  );
  assert.equal(changes.length, 4);
  assert.equal(new Set(changes.map(({ itemId }) => itemId)).size, changes.length);
  assert.deepEqual(
    new Map(changes.map(({ itemId, newDisplayNumber }) => [itemId, newDisplayNumber])),
    new Map([
      ["item-057a", "057B"],
      ["item-057b", "057D"],
      ["item-060", "057C"],
      ["item-061", "057A"]
    ])
  );
  assert.ok(changes.every(({ oldDisplayNumber, newDisplayNumber }) => oldDisplayNumber !== newDisplayNumber));
});

test("batch reconciliation catches adjacent affected items that both crossed a later item", () => {
  const changes = reconcileDisplayNumbers(
    [
      { itemId: "item-057", displayNumber: "057", firstSeenDate: "2026-08-15" },
      { itemId: "item-057a", displayNumber: "057A", firstSeenDate: "2026-08-18" },
      { itemId: "item-060", displayNumber: "060", firstSeenDate: "2026-08-16" },
      { itemId: "item-061", displayNumber: "061", firstSeenDate: "2026-08-17" },
      { itemId: "item-058", displayNumber: "058", firstSeenDate: "2026-08-20" }
    ],
    new Map([
      ["item-060", "earlier_duplicate_occurrence"],
      ["item-061", "earlier_duplicate_occurrence"]
    ])
  );
  assert.deepEqual(
    new Map(changes.map(({ itemId, newDisplayNumber }) => [itemId, newDisplayNumber])),
    new Map([
      ["item-057a", "057C"],
      ["item-060", "057A"],
      ["item-061", "057B"]
    ])
  );
});

test("numbering handles dates before 001 and processes unsorted CSV by date plus stable key", () => {
  const existing = [{ displayNumber: "001", firstSeenDate: "2026-08-20" }];
  assert.equal(
    allocateDisplayNumbers(existing, [{ firstSeenDate: "2026-08-01", stableKey: "early" }]).get("early"),
    "000A"
  );
  const allocations = allocateDisplayNumbers([], [
    { firstSeenDate: "2026-08-30", stableKey: "c" },
    { firstSeenDate: "2026-08-26", stableKey: "a" },
    { firstSeenDate: "2026-08-28", stableKey: "b" }
  ]);
  assert.deepEqual(
    [allocations.get("a"), allocations.get("b"), allocations.get("c")],
    ["001", "002", "003"]
  );
});

test("occurrence parsing records every writing label and never falls back to today", () => {
  assert.deepEqual(parseBuildSentenceOccurrences("202601-0121-1", "January set"), [
    { occurredOn: "2026-01-21", sourceLabel: "January set" }
  ]);
  assert.deepEqual(
    parseWritingOccurrences({ sourceLabels: "5.6A|5.6B / 5.7A", yearMonth: "202605" }),
    [
      { occurredOn: "2026-05-06", sourceLabel: "5.6A" },
      { occurredOn: "2026-05-06", sourceLabel: "5.6B" },
      { occurredOn: "2026-05-07", sourceLabel: "5.7A" }
    ]
  );
  assert.deepEqual(
    parseWritingOccurrences({ sourceLabels: "2.1-1|2.1-2", yearMonth: "202602" }),
    [
      { occurredOn: "2026-02-01", sourceLabel: "2.1-1" },
      { occurredOn: "2026-02-01", sourceLabel: "2.1-2" }
    ]
  );
  assert.deepEqual(
    parseWritingOccurrences({
      sourceLabels: "",
      yearMonth: "202601",
      setTitle: "",
      setId: "202601-0121-1"
    }),
    [{ occurredOn: "2026-01-21", sourceLabel: "202601-0121-1" }]
  );
  assert.throws(
    () => parseWritingOccurrences({ sourceLabels: "official", yearMonth: "202605" }),
    /无法.*解析真实日期/
  );
});

test("Academic Discussion titles are validated server-side and generated through an independent call", async () => {
  assert.equal(validateAcademicDiscussionTitle("Nature vs Nurture"), "Nature vs Nurture");
  assert.throws(() => validateAcademicDiscussionTitle("one two three four five six"), /at most 5/);
  assert.throws(() => validateAcademicDiscussionTitle("技术与教育"), /English/);
  let calls = 0;
  const title = await generateAcademicDiscussionTitle("prompt", {
    env: {
      OPENROUTER_API_KEY: "test-key",
      OPENROUTER_WRITING_MODEL: "test-model",
      PRACTICE_IMPORT_TITLE_MODEL: ""
    },
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: "Remote Work Tradeoffs" } }] }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      });
    }
  });
  assert.equal(title, "Remote Work Tradeoffs");
  assert.equal(calls, 1);
});

test("migration enforces idempotency, canonical stability, and auditable local numbering", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../supabase/practice_importer_v2.sql"), "utf8");
  assert.match(sql, /pg_advisory_xact_lock/);
  assert.match(sql, /practice_item_sources_one_canonical_uidx/);
  assert.match(sql, /practice_item_occurrences_identity_uidx/);
  assert.match(sql, /practice_item_question_map_source_logical_uidx/);
  assert.match(sql, /practice_import_review_queue/);
  assert.match(sql, /practice_item_number_history/);
  assert.match(sql, /reconcile_practice_item_numbers_v2/);
  assert.match(sql, /earlier_duplicate_occurrence/);
  assert.match(sql, /local_resequence/);
  assert.match(sql, /old_display_number = v_candidate/);
  assert.match(
    sql,
    /insert into public\.practice_item_number_history[\s\S]*from _practice_import_number_plan/
  );
  assert.match(sql, /p_first_seen_date >= v_latest_date/);
  assert.match(sql, /update\s+public\.practice_items\s+item\s+set\s+display_number/i);
  assert.match(sql, /'first_seen_before', v_first_seen_before/);
  assert.match(sql, /'first_seen_after', v_first_seen_after/);
  assert.doesNotMatch(sql, /update\s+public\.practice_item_sources\s+set\s+is_canonical/i);
  assert.doesNotMatch(sql, /update\s+public\.practice_items\s+set\s+display_title/i);
});

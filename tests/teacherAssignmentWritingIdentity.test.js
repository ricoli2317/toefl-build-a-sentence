const test = require("node:test");
const assert = require("node:assert/strict");
const { createMockSupabase } = require("./fixtures/mockSupabase.js");
const {
  resolveCanonicalWritingAssignmentQuestionId,
  prepareWritingAssignmentQuestion
} = require("../lib/writingAssignmentMutation.server.ts");
const { resolveAssignmentCatalogItemIds } = require("../lib/assignmentCatalog.server.ts");
const {
  assignmentCatalogEntryFromAssignment,
  assignmentCatalogEntryKey,
  buildAssignmentItemSnapshot
} = require("../lib/assignmentCatalog.ts");

const AD_ITEM_ID = "11111111-1111-4111-8111-111111111111";
const WE_ITEM_ID = "22222222-2222-4222-8222-222222222222";

function identityDb() {
  return createMockSupabase({
    practice_item_sources: [
      {
        source_id: "src-ad-old",
        item_id: AD_ITEM_ID,
        task_type: "academic_discussion",
        source_set_id: "ad-set-1",
        source_question_id: "AD-202608-0826-A",
        is_canonical: false
      },
      {
        source_id: "src-ad-canonical",
        item_id: AD_ITEM_ID,
        task_type: "academic_discussion",
        source_set_id: "ad-set-1",
        source_question_id: "AD-202608-0826-B",
        is_canonical: true
      },
      {
        source_id: "src-we-canonical",
        item_id: WE_ITEM_ID,
        task_type: "email",
        source_set_id: "we-set-1",
        source_question_id: "WE-202609-0001",
        is_canonical: true
      }
    ],
    email_questions: [
      {
        question_id: "WE-202609-0001",
        set_id: "we-set-1",
        set_title: "Requesting a Refund",
        year_month: "2026-09",
        source_labels: "202609",
        scenario: "You bought a broken charger.",
        task_instruction: "Write an email to the store.",
        requirement_1: "Explain the problem.",
        requirement_2: "Ask for a refund.",
        requirement_3: "Say what you need.",
        closing_instruction: "Write as much as you can.",
        recipient: "the store manager",
        subject: "Refund request"
      }
    ],
    academic_discussion_questions: [
      {
        question_id: "AD-202608-0826-B",
        set_id: "ad-set-1",
        set_title: "Online Learning Debate",
        year_month: "2026-08",
        source_labels: "202608",
        professor_name: "Dr. Lee",
        professor_prompt: "Should universities keep online courses?",
        student_1_name: "Alex",
        student_1_response: "Online courses save time.",
        student_2_name: "Bailey",
        student_2_response: "In-person classes build community."
      }
    ]
  });
}

// ---------------------------------------------------------------------------
// 1. The stable catalog item id is the picker identity for WE / AD
// ---------------------------------------------------------------------------

test("a WE / AD picker item id resolves to the canonical raw question id", async () => {
  const db = identityDb();
  assert.equal(
    await resolveCanonicalWritingAssignmentQuestionId(db, "academic_discussion", AD_ITEM_ID),
    "AD-202608-0826-B"
  );
  assert.equal(
    await resolveCanonicalWritingAssignmentQuestionId(db, "email", WE_ITEM_ID),
    "WE-202609-0001"
  );
});

test("the historical raw question id keeps resolving through its logical item", async () => {
  const db = identityDb();
  // A non-canonical raw id still resolves to the canonical version of its item.
  assert.equal(
    await resolveCanonicalWritingAssignmentQuestionId(db, "academic_discussion", "AD-202608-0826-A"),
    "AD-202608-0826-B"
  );
  assert.equal(
    await resolveCanonicalWritingAssignmentQuestionId(db, "email", "WE-202609-0001"),
    "WE-202609-0001"
  );
});

test("an id that belongs to no paragraph item is rejected, never silently allowed", async () => {
  const db = identityDb();
  await assert.rejects(
    () => resolveCanonicalWritingAssignmentQuestionId(db, "email", "WE-209901-0001"),
    /所选题目不属于当前练习题库/
  );
  await assert.rejects(
    () => resolveCanonicalWritingAssignmentQuestionId(db, "email", "not-a-uuid-at-all"),
    /所选题目不属于当前练习题库/
  );
  await assert.rejects(
    // The id exists, but for the other task type.
    () => resolveCanonicalWritingAssignmentQuestionId(db, "email", AD_ITEM_ID),
    /所选题目不属于当前练习题库/
  );
});

test("WE / AD creation stores the canonical question id with the full question snapshot", async () => {
  const db = identityDb();
  const we = await prepareWritingAssignmentQuestion(db, {
    itemType: "email",
    questionId: WE_ITEM_ID,
    questionSource: "question_bank"
  }, { canonicalizeQuestionBank: true });
  assert.equal(we.questionId, "WE-202609-0001");
  assert.equal(we.taskType, "email");
  assert.equal(we.questionSource, "question_bank");
  assert.equal(we.questionSnapshot.question_id, "WE-202609-0001");
  assert.equal(we.questionSnapshot.set_title, "Requesting a Refund");

  const ad = await prepareWritingAssignmentQuestion(db, {
    itemType: "academic_discussion",
    questionId: AD_ITEM_ID,
    questionSource: "question_bank"
  }, { canonicalizeQuestionBank: true });
  assert.equal(ad.questionId, "AD-202608-0826-B");
  assert.equal(ad.questionSnapshot.question_id, "AD-202608-0826-B");
  assert.equal(ad.questionSnapshot.professor_name, "Dr. Lee");

  // The invalid identity never reaches the raw question lookup.
  await assert.rejects(
    () => prepareWritingAssignmentQuestion(db, {
      itemType: "email",
      questionId: "33333333-3333-4333-8333-333333333333",
      questionSource: "question_bank"
    }, { canonicalizeQuestionBank: true }),
    /所选题目不属于当前练习题库/
  );
});

test("BAS keeps the lightweight catalog identity through the shared entry map", async () => {
  const db = identityDb();
  const entry = {
    catalog_category: null,
    item_id: "bas-item-1",
    item_type: "build_sentence",
    months: ["2026-09"],
    reading_length: null,
    source_set_id: "bas-set-1",
    title: "套题001",
    year_month: "2026-09"
  };
  const prepared = await prepareWritingAssignmentQuestion(db, {
    itemType: "build_sentence",
    questionId: "bas-item-1",
    questionSource: "question_bank"
  }, { catalogEntries: new Map([[assignmentCatalogEntryKey(entry), entry]]) });
  assert.equal(prepared.questionId, "bas-item-1");
  assert.equal(prepared.questionSnapshot.item_id, "bas-item-1");
  assert.equal(prepared.questionSnapshot.set_title, "套题001");
  assert.deepEqual(prepared.questionSnapshot, buildAssignmentItemSnapshot(entry));
});

// ---------------------------------------------------------------------------
// 2. The withdrawn edit seeds the same stable identity it selects
// ---------------------------------------------------------------------------

test("the detail API resolves the stored WE / AD raw id back to the catalog item id", async () => {
  const db = identityDb();
  const map = await resolveAssignmentCatalogItemIds(db, [
    { itemType: "email", questionId: "WE-202609-0001", questionSource: "question_bank" },
    { itemType: "academic_discussion", questionId: "AD-202608-0826-B", questionSource: "question_bank" },
    { itemType: "build_sentence", questionId: "bas-item-1", questionSource: "question_bank" },
    { itemType: "rdl", questionId: "reading-rdl-1", questionSource: "question_bank" },
    { itemType: "email", questionId: null, questionSource: "custom" }
  ]);
  assert.equal(map.get("email:WE-202609-0001"), WE_ITEM_ID);
  assert.equal(map.get("academic_discussion:AD-202608-0826-B"), AD_ITEM_ID);
  // BAS / Reading already store the catalog id.
  assert.equal(map.get("build_sentence:bas-item-1"), "bas-item-1");
  assert.equal(map.get("rdl:reading-rdl-1"), "reading-rdl-1");
  assert.equal(map.size, 4);
});

test("a seeded picker row carries the catalog id, never the stored raw id", () => {
  const weEntry = assignmentCatalogEntryFromAssignment({
    assignment_id: "assignment-we",
    catalog_item_id: WE_ITEM_ID,
    display_name: "Write an Email",
    question_id: "WE-202609-0001",
    question_source: "question_bank",
    question_snapshot: { set_title: "Requesting a Refund", year_month: "2026-09" },
    task_type: "email"
  });
  assert.equal(weEntry.item_id, WE_ITEM_ID);
  assert.equal(assignmentCatalogEntryKey(weEntry), `email:${WE_ITEM_ID}`);
  assert.equal(weEntry.title, "Write an Email");
  assert.deepEqual(weEntry.months, ["2026-09"]);

  // Without a resolved catalog id the legacy stored id is used, so an old
  // assignment still seeds something the server accepts.
  const legacyEntry = assignmentCatalogEntryFromAssignment({
    assignment_id: "assignment-ad",
    display_name: "",
    question_id: "AD-202608-0826-B",
    question_source: "question_bank",
    question_snapshot: { set_title: "Online Learning Debate", year_month: "2026-08" },
    task_type: "academic_discussion"
  });
  assert.equal(legacyEntry.item_id, "AD-202608-0826-B");
  assert.equal(legacyEntry.title, "Online Learning Debate");

  // Reading rows keep their stored stable id and RDL metadata.
  const rdlEntry = assignmentCatalogEntryFromAssignment({
    assignment_id: "assignment-rdl",
    display_name: "Package Delivery",
    question_id: "reading-rdl-222",
    question_source: "question_bank",
    question_snapshot: {
      catalog_category: "邮件",
      reading_length: "long",
      set_title: "Package Delivery",
      year_month: "2026-09"
    },
    task_type: "rdl"
  });
  assert.equal(rdlEntry.item_id, "reading-rdl-222");
  assert.equal(rdlEntry.reading_length, "long");
  assert.equal(rdlEntry.catalog_category, "邮件");
});

// ---------------------------------------------------------------------------
// 3. Route contract: the picker id is what the create payload submits
// ---------------------------------------------------------------------------

test("the create payload submits the picker's stable item id, never a raw id", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const root = path.resolve(__dirname, "..");
  const wizard = fs.readFileSync(
    path.join(root, "components/teacher/TeacherWritingAssignmentForm.tsx"),
    "utf8"
  );
  const picker = fs.readFileSync(
    path.join(root, "components/teacher/TeacherAssignmentCatalogPicker.tsx"),
    "utf8"
  );
  assert.match(wizard, /questionId: entry\.item_id/);
  assert.match(picker, /assignmentCatalogEntryKey\(entry\)/);
  assert.match(picker, /filterAssignmentCatalogEntries/);
  // No layer converts the stable id into a raw source_question_id.
  assert.doesNotMatch(wizard, /source_question_id/);
  assert.doesNotMatch(picker, /source_question_id/);
});

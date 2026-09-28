const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createMockSupabase } = require("./fixtures/mockSupabase.js");
const {
  prepareWritingAssignmentGroupEditMutation
} = require("../lib/writingAssignmentMutation.server.ts");

const projectRoot = path.resolve(__dirname, "..");
const source = (relativePath) =>
  fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

const FORM = "components/teacher/TeacherWritingAssignmentForm.tsx";
const GROUP_EDIT_FORM = "components/teacher/TeacherWritingAssignmentGroupEditForm.tsx";
const BATCH_ROUTE = "app/api/teacher/writing/assignments/batches/[batchId]/route.ts";
const SINGLE_ROUTE = "app/api/teacher/writing/assignments/[assignmentId]/route.ts";

const WE_ITEM_ID = "22222222-2222-4222-8222-222222222222";

function withdrawnEditDb() {
  return createMockSupabase({
    practice_item_sources: [
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
      },
      {
        question_id: "WE-202609-0002",
        set_id: "we-set-2",
        set_title: "Ask About Housing",
        year_month: "2026-09",
        source_labels: "202609",
        scenario: "You move next month.",
        task_instruction: "Write an email to housing.",
        requirement_1: "Explain the timing.",
        requirement_2: "Ask about rooms.",
        requirement_3: "Request a reply.",
        closing_instruction: "Write as much as you can.",
        recipient: "the housing office",
        subject: "Housing"
      }
    ],
    profiles: [
      { id: "student-1", role: "student", is_active: true },
      { id: "student-2", role: "student", is_active: true }
    ],
    teacher_student_bindings: [
      { teacher_id: "teacher-1", student_id: "student-1", domain: "writing" },
      { teacher_id: "teacher-1", student_id: "student-2", domain: "writing" }
    ]
  });
}

// ---------------------------------------------------------------------------
// 1. The shared withdrawn-edit payload: keep / add / remove items
// ---------------------------------------------------------------------------

test("a withdrawn edit prepares kept items and brand-new items in one payload", async () => {
  const db = withdrawnEditDb();
  const prepared = await prepareWritingAssignmentGroupEditMutation(db, {
    dueAt: "2026-10-01T04:00:00.000Z",
    items: [
      {
        assignmentId: "assignment-1",
        itemType: "email",
        questionId: WE_ITEM_ID,
        questionSource: "question_bank"
      },
      {
        // A newly added item has no assignment id yet.
        itemType: "email",
        questionId: "WE-202609-0001",
        questionSource: "question_bank"
      },
      {
        customQuestion: {
          parsed_email: true,
          recipient: "the housing office",
          requirement_1: "Explain the timing.",
          requirement_2: "Ask about rooms.",
          requirement_3: "Request a reply.",
          scenario: "You move next month.",
          subject: "Housing",
          task_instruction: "Write an email to housing.",
          title: "Ask About Housing"
        },
        itemType: "email",
        questionId: null,
        questionSource: "custom"
      }
    ],
    studentIds: ["student-1", "student-2"]
  }, { actor: { role: "teacher", userId: "teacher-1" } });

  assert.equal(prepared.subject, "writing");
  assert.deepEqual(prepared.studentIds, ["student-1", "student-2"]);
  assert.equal(prepared.items.length, 3);
  // The kept item keeps its assignment identity; the added item has none.
  assert.equal(prepared.items[0].assignmentId, "assignment-1");
  assert.equal(prepared.items[0].questionId, "WE-202609-0001");
  assert.equal(prepared.items[1].assignmentId, null);
  assert.equal(prepared.items[1].questionId, "WE-202609-0001");
  assert.equal(prepared.items[2].assignmentId, null);
  assert.equal(prepared.items[2].questionSource, "custom");
  assert.equal(prepared.items[2].questionSnapshot.set_title, "Ask About Housing");
  assert.equal(prepared.dueAt, "2026-10-01T04:00:00.000Z");
});

test("the withdrawn edit can re-target a class without a pre-resolved student list", async () => {
  const db = withdrawnEditDb();
  const prepared = await prepareWritingAssignmentGroupEditMutation(db, {
    classId: "class-1",
    items: [{
      assignmentId: "assignment-1",
      itemType: "email",
      questionId: WE_ITEM_ID,
      questionSource: "question_bank"
    }]
  }, { actor: { role: "teacher", userId: "teacher-1" } });
  // Class mode resolves recipients inside the RPC at save time.
  assert.deepEqual(prepared.studentIds, []);
  assert.equal(prepared.subject, "writing");
});

test("an empty withdrawn edit is rejected instead of deleting everything", async () => {
  const db = withdrawnEditDb();
  await assert.rejects(
    () => prepareWritingAssignmentGroupEditMutation(db, {
      items: [],
      studentIds: ["student-1"]
    }, { actor: { role: "teacher", userId: "teacher-1" } }),
    /请至少添加一道题目/
  );
  await assert.rejects(
    () => prepareWritingAssignmentGroupEditMutation(db, {
      items: [{
        itemType: "email",
        questionId: "unknown-item",
        questionSource: "question_bank"
      }],
      studentIds: []
    }, { actor: { role: "teacher", userId: "teacher-1" } }),
    /请至少选择一名学生|所选题目/
  );
});

// ---------------------------------------------------------------------------
// 3. Every required item-type combination validates through the same path
// ---------------------------------------------------------------------------

function mixedCatalogDb() {
  const questions = Array.from({ length: 10 }, (_, index) => ({
    question_id: `bas-q-${index + 1}`,
    set_id: "bas-set-1",
    question_order: index + 1,
    prompt: `Prompt ${index + 1}`,
    sentence_template: "Template",
    options_text: "a|b|c|d|e|f",
    correct_order_text: "a b c d e f",
    distractors_text: "",
    final_sentence: "Final sentence"
  }));
  return createMockSupabase({
    practice_item_sources: [
      {
        source_id: "src-we-canonical",
        item_id: WE_ITEM_ID,
        task_type: "email",
        source_set_id: "we-set-1",
        source_question_id: "WE-202609-0001",
        is_canonical: true
      },
      {
        source_id: "src-ad-canonical",
        item_id: "11111111-1111-4111-8111-111111111111",
        task_type: "academic_discussion",
        source_set_id: "ad-set-1",
        source_question_id: "AD-202608-0826-B",
        is_canonical: true
      },
      {
        source_id: "src-bas-canonical",
        item_id: "bas-item-1",
        task_type: "build_sentence",
        source_set_id: "bas-set-1",
        source_question_id: null,
        is_canonical: true
      }
    ],
    practice_items: [
      {
        item_id: "bas-item-1",
        task_type: "build_sentence",
        display_number: "144",
        display_title: null,
        first_seen_date: "2026-09-10",
        is_active: true
      }
    ],
    practice_item_occurrences: [
      { occurrence_id: "occ-bas-1", source_id: "src-bas-canonical", occurred_on: "2026-09-16" }
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
    ],
    questions,
    profiles: [{ id: "student-1", role: "student", is_active: true }],
    teacher_student_bindings: [
      { teacher_id: "teacher-1", student_id: "student-1", domain: "writing" }
    ]
  });
}

const WE_ITEM = {
  itemType: "email",
  questionId: WE_ITEM_ID,
  questionSource: "question_bank"
};
const AD_ITEM = {
  itemType: "academic_discussion",
  questionId: "11111111-1111-4111-8111-111111111111",
  questionSource: "question_bank"
};
const BAS_ITEM = {
  itemType: "build_sentence",
  questionId: "bas-item-1",
  questionSource: "question_bank"
};

test("WE only, AD only, BAS only and every required mix pass the same create validation", async () => {
  const actor = { role: "teacher", userId: "teacher-1" };
  const cases = [
    { items: [WE_ITEM], expected: ["WE-202609-0001"] },
    { items: [AD_ITEM], expected: ["AD-202608-0826-B"] },
    { items: [BAS_ITEM], expected: ["bas-item-1"] },
    { items: [WE_ITEM, AD_ITEM], expected: ["WE-202609-0001", "AD-202608-0826-B"] },
    { items: [WE_ITEM, BAS_ITEM], expected: ["WE-202609-0001", "bas-item-1"] },
    { items: [AD_ITEM, BAS_ITEM], expected: ["AD-202608-0826-B", "bas-item-1"] },
    {
      items: [WE_ITEM, AD_ITEM, BAS_ITEM],
      expected: ["WE-202609-0001", "AD-202608-0826-B", "bas-item-1"]
    }
  ];
  for (const entry of cases) {
    const prepared = await prepareWritingAssignmentGroupEditMutation(
      mixedCatalogDb(),
      { items: entry.items, studentIds: ["student-1"] },
      { actor }
    );
    assert.equal(prepared.subject, "writing", JSON.stringify(entry.items.map((item) => item.itemType)));
    assert.deepEqual(
      prepared.items.map((item) => item.questionId),
      entry.expected
    );
    // WE / AD keep the full raw question snapshot; BAS keeps only the
    // lightweight catalog metadata (never a question body).
    assert.equal(prepared.items[0].questionSnapshot.set_title.length > 0, true);
    const bas = prepared.items.find((item) => item.taskType === "build_sentence");
    if (bas) {
      const serialized = JSON.stringify(bas.questionSnapshot);
      assert.doesNotMatch(serialized, /Prompt 1|Template|Final sentence/);
      assert.equal(bas.questionSnapshot.item_id, "bas-item-1");
      assert.equal(bas.questionSnapshot.source_set_id, "bas-set-1");
    }
  }
});


// ---------------------------------------------------------------------------
// 4. The wizard re-enters the create flow with the persisted group as seed
// ---------------------------------------------------------------------------

test("the withdrawn editor reuses the create wizard seeded with the persisted group", () => {
  const form = source(FORM);
  const groupEdit = source(GROUP_EDIT_FORM);
  // The wrapper only loads the persisted group; the wizard owns the UI.
  assert.match(groupEdit, /TeacherWritingAssignmentForm/);
  assert.match(groupEdit, /initialCollection=\{state\.data\.collection\}/);
  assert.doesNotMatch(groupEdit, /lockedStudentIds|题目（不可修改）/);

  // The wizard seeds subject / source / items / students / title / deadline.
  assert.match(form, /buildWizardSeed/);
  assert.match(form, /assignmentCatalogEntryFromAssignment/);
  assert.match(form, /customQuestionDraftFromAssignment/);
  assert.match(form, /students: assignments\[0\]\?\.students\.map/);
  assert.match(form, /dueAt: assignments\.flatMap/);
  assert.match(form, /title: groupTitle\?\.trim\(\)/);
  // Adding and removing items: custom drafts can be added and removed, the
  // bank selection is toggled by the shared picker, and everything still held
  // is submitted.
  assert.match(form, /createCustomQuestionDraft\(customTaskType/);
  assert.match(form, /setCustomQuestions\(\(current\) => current\.filter/);
  assert.match(form, /submitBankEntries/);
  assert.match(form, /submitCustomQuestions/);
  // Students and class stay editable; the title and the deadline stay editable.
  assert.match(form, /选 班级|一次只能选择一个班级/);
  assert.match(form, /setAssignmentTitleManuallyEdited\(true\)/);
  assert.match(form, /uniformDueAt/);
  // Preview + save keep the shared behavior.
  assert.match(form, /TeacherAssignmentSelectionPreview/);
  assert.match(form, /保存并重新布置/);
  assert.match(form, /action: "edit"/);
  assert.match(form, /method: "PATCH"/);
  assert.match(form, /items,/);
});

test("the withdrawn edit submits to the group route when a group exists", () => {
  const form = source(FORM);
  assert.match(
    form,
    /initialGroupId\s*\n?\s*\? `\/api\/teacher\/writing\/assignments\/batches\/\$\{encodeURIComponent\(initialGroupId\)\}`/
  );
  const batchRoute = source(BATCH_ROUTE);
  assert.match(batchRoute, /p_legacy_assignment_id: null/);
  assert.match(batchRoute, /p_group_id: params\.batchId/);
  // Every provided existing item must belong to the group; new items are
  // inserted; removed items are soft-deleted in the same transaction.
  assert.match(batchRoute, /assignmentIds: rpcItems\.flatMap/);
  const sql = source("supabase/writing_assignment_group_edit_items_20260928.sql");
  assert.match(sql, /insert into public\.writing_assignments \(/);
  assert.match(sql, /set deleted_at = now\(\)/);
});

test("the legacy group-less withdrawn edit is adopted by the same RPC", () => {
  const route = source(SINGLE_ROUTE);
  assert.match(route, /p_group_id: null/);
  assert.match(route, /p_legacy_assignment_id: params\.assignmentId/);
  assert.match(route, /prepareWritingAssignmentGroupEditMutation/);
  // Only the legacy row itself can be updated in place; every other item id
  // must be a new item.
  assert.match(route, /item\.assignmentId !== params\.assignmentId/);
  assert.match(route, /INVALID_GROUP_ITEMS/);
});

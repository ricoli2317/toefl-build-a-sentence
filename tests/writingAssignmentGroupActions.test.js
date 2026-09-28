const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  teacherWritingAssignmentCardActions
} = require("../lib/writingAssignments.ts");

const projectRoot = path.resolve(__dirname, "..");
const source = (relativePath) =>
  fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

const ROUTE = "app/api/teacher/writing/assignments/[assignmentId]/route.ts";
const BATCH_ROUTE = "app/api/teacher/writing/assignments/batches/[batchId]/route.ts";
const LIST = "components/teacher/TeacherWritingAssignmentList.tsx";
const GROUP_EDIT_FORM = "components/teacher/TeacherWritingAssignmentGroupEditForm.tsx";
const GROUP_EDIT_SQL = "supabase/writing_assignment_group_edit.sql";

test("single and group cards share one action matrix for the same lifecycle state", () => {
  assert.deepEqual(teacherWritingAssignmentCardActions({ status: "withdrawn", hasAttempts: true }), {
    canWithdraw: false,
    canEdit: true,
    canReactivate: true,
    canSoftDelete: true
  });
  assert.deepEqual(teacherWritingAssignmentCardActions({ status: "active", hasAttempts: false }), {
    canWithdraw: true,
    canEdit: false,
    canReactivate: false,
    canSoftDelete: false
  });
  assert.deepEqual(teacherWritingAssignmentCardActions({ status: "active", hasAttempts: true }), {
    canWithdraw: false,
    canEdit: false,
    canReactivate: false,
    canSoftDelete: false
  });
  const list = source(LIST);
  // Both render branches call the shared matrix instead of local if-chains.
  assert.equal((list.match(/teacherWritingAssignmentCardActions\(/g) ?? []).length, 2);
});

test("group cards render the same withdrawn actions as legacy single cards", () => {
  const list = source(LIST);
  const card = list.slice(list.indexOf("function TeacherWritingAssignmentCollectionCard"));
  assert.match(card, /href=\{editHref\}/);
  assert.match(card, /<Pencil[\s\S]{0,60}编辑作业/);
  assert.match(card, /<RotateCcw[\s\S]{0,60}重新布置/);
  assert.match(card, /<Trash2[\s\S]{0,60}删除作业/);
  assert.match(card, /onReactivate\(actionAssignmentId\)/);
  assert.match(card, /onSoftDelete\(actionAssignmentId\)/);
  const editIndex = card.indexOf("编辑作业");
  const reactivateIndex = card.indexOf("重新布置");
  const deleteIndex = card.indexOf("删除作业");
  const progressIndex = card.indexOf("查看进度");
  assert.ok(editIndex > -1 && editIndex < reactivateIndex);
  assert.ok(reactivateIndex < deleteIndex && deleteIndex < progressIndex);
  // The single card keeps the exact same labels/icons/classes/order.
  const singleCard = list.slice(0, list.indexOf("function TeacherWritingAssignmentCollectionCard"));
  for (const label of ["编辑作业", "重新布置", "删除作业"]) {
    assert.match(singleCard, new RegExp(label));
  }
  assert.match(singleCard, /teacher-button-secondary"[\s\S]{0,120}<Pencil[\s\S]{0,40}编辑作业/);
  assert.match(singleCard, /teacher-button-primary"[\s\S]{0,140}mutate\(assignment\.assignment_id, "reactivate"\)/);
  assert.match(singleCard, /text-student-error"[\s\S]{0,220}<Trash2[\s\S]{0,40}删除作业/);
  // The group card uses the same classes for the same three actions.
  assert.match(card, /teacher-button-secondary"[\s\S]{0,120}<Pencil[\s\S]{0,40}编辑作业/);
  assert.match(card, /teacher-button-primary"[\s\S]{0,140}onReactivate\(actionAssignmentId\)/);
  assert.match(card, /text-student-error"[\s\S]{0,220}<Trash2[\s\S]{0,40}删除作业/);
});

test("group reactivate and delete act on the whole group in one statement each", () => {
  const route = source(ROUTE);
  assert.match(route, /reactivateWritingAssignmentGroup/);
  assert.match(route, /softDeleteWritingAssignmentGroup/);
  // Reactivate: one update over the whole group.
  assert.match(route, /update\(\{ status: "active" \}\)[\s\S]{0,220}\.eq\("group_id", groupId\)[\s\S]{0,120}\.eq\("status", "withdrawn"\)/);
  // Delete: group members must all be withdrawn first, then one group update.
  assert.match(route, /members\.some\(\(item\) => item\.status !== "withdrawn"\)/);
  assert.match(route, /update\(\{ deleted_at: new Date\(\)\.toISOString\(\) \}\)[\s\S]{0,240}\.eq\("group_id", groupId\)/);
  assert.match(route, /\(data \?\? \[\]\)\.length !== members\.length/);
  // Legacy single assignments keep updateLifecycle untouched.
  assert.match(route, /if \(assignment\.group_id\)/);
  assert.match(route, /updateLifecycle\(auth\.supabase, params\.assignmentId/);
});

test("group edit API loads every item and saves the group in one RPC", () => {
  const route = source(BATCH_ROUTE);
  assert.match(route, /export async function PATCH/);
  assert.match(route, /body\.action !== "edit"/);
  assert.match(route, /prepareWritingAssignmentGroupEditMutation/);
  assert.match(route, /update_withdrawn_writing_assignment_group/);
  assert.match(route, /p_items:/);
  assert.match(route, /p_student_ids: classId \? \[\] : prepared\.studentIds/);
  assert.match(route, /p_due_at: prepared\.dueAt/);
  assert.match(route, /p_reactivate: body\.reactivate === true/);
  assert.match(route, /p_class_id: classId \|\| null/);
  assert.match(route, /p_title: title/);
  assert.match(route, /p_legacy_assignment_id: null/);
  assert.match(route, /currentItems\.some\(\(item\) => item\.status !== "withdrawn"\)/);
  // The withdrawn edit can add / remove / re-type items: existing ids are
  // matched against the group, new items carry no id and are inserted by the
  // RPC, and the frozen-question rule still guards submitted items.
  assert.match(route, /if \(!preparedItem\.assignmentId\) return preparedItem/);
  assert.match(route, /INVALID_GROUP_ITEMS/);
  assert.match(route, /QUESTION_LOCKED_AFTER_SUBMISSION/);
  // Recipients keep the persisted selection order for the edit form.
  assert.match(route, /\.order\("sort_order", \{ ascending: true, nullsFirst: false \}\)/);
});

test("group edit RPC writes items, recipients and status in one transaction", () => {
  const sql = source(GROUP_EDIT_SQL);
  assert.match(sql, /create or replace function public\.update_withdrawn_writing_assignment_group\(\s*\n\s*p_group_id uuid,\s*\n\s*p_teacher_id uuid,\s*\n\s*p_items jsonb,\s*\n\s*p_student_ids uuid\[\],\s*\n\s*p_due_at timestamptz,\s*\n\s*p_reactivate boolean default false/);
  assert.match(sql, /for update/);
  assert.match(sql, /ASSIGNMENT_GROUP_NOT_WITHDRAWN/);
  assert.match(sql, /QUESTION_LOCKED_AFTER_SUBMISSION/);
  assert.match(sql, /STUDENT_HAS_ATTEMPT/);
  assert.match(sql, /INVALID_GROUP_ITEMS/);
  assert.match(sql, /insert into public\.writing_assignment_students \(assignment_id, student_id, sort_order\)/);
  assert.match(sql, /on conflict \(assignment_id, student_id\)/);
  assert.match(sql, /status = case when p_reactivate then 'active' else 'withdrawn' end/);
  assert.match(sql, /grant execute on function public\.update_withdrawn_writing_assignment_group\(uuid, uuid, jsonb, uuid\[\], timestamptz, boolean\)[\s\S]{0,40}to service_role/);
  assert.doesNotMatch(sql, /drop function/i);
});

test("the withdrawn group RPC supports add / remove / class / title with unchanged safety", () => {
  const sql = source("supabase/writing_assignment_group_edit_items_20260928.sql");
  // The old 6-argument overload is replaced, not shadowed.
  assert.match(sql, /drop function if exists public\.update_withdrawn_writing_assignment_group\(/);
  assert.match(sql, /p_legacy_assignment_id uuid/);
  assert.match(sql, /p_class_id uuid default null/);
  assert.match(sql, /grant execute on function public\.update_withdrawn_writing_assignment_group\(\s*\n\s*uuid, uuid, uuid, text, jsonb, uuid\[\], timestamptz, boolean, uuid\s*\n\) to service_role/);
  // Safety rules stay in place.
  assert.match(sql, /ASSIGNMENT_GROUP_NOT_WITHDRAWN/);
  assert.match(sql, /QUESTION_LOCKED_AFTER_SUBMISSION/);
  assert.match(sql, /STUDENT_HAS_ATTEMPT/);
  assert.match(sql, /ITEM_HAS_ATTEMPT/);
  assert.match(sql, /MIXED_ASSIGNMENT_SUBJECT/);
  assert.match(sql, /INVALID_GROUP_ITEMS/);
  assert.match(sql, /binding\.domain = derived_subject/);
  assert.match(sql, /CLASS_NOT_READING_CLASS/);
  assert.match(sql, /CLASS_HAS_NO_MEMBERS/);
  // Add / remove / re-title.
  assert.match(sql, /insert into public\.writing_assignments \(/);
  assert.match(sql, /set deleted_at = now\(\)/);
  assert.match(sql, /set title = btrim\(p_title\)/);
  assert.match(sql, /set class_id = p_class_id/);
  assert.doesNotMatch(sql, /owner_id/);
});

test("group edit form loads the whole group and reuses the one shared wizard", () => {
  const form = source(GROUP_EDIT_FORM);
  // Whole group is loaded, not just the first assignment.
  assert.match(form, /state\.data\?\.collection\?\.assignments/);
  // There is no second edit UI: the persisted group seeds the shared wizard.
  assert.match(form, /TeacherWritingAssignmentForm/);
  assert.match(form, /initialCollection=\{state\.data\.collection\}/);
  assert.match(form, /returnTo=\{returnTo\}/);
  // The wizard seeds every item, keeps custom drafts editable, submits one
  // group payload and invalidates the list cache.
  const wizard = source("components/teacher/TeacherWritingAssignmentForm.tsx");
  assert.match(wizard, /buildWizardSeed/);
  assert.match(wizard, /assignmentCatalogEntryFromAssignment/);
  assert.match(wizard, /customQuestionDraftFromAssignment/);
  assert.match(wizard, /questionSource: "question_bank"/);
  assert.match(wizard, /questionSource: "custom" as const/);
  assert.match(wizard, /CustomQuestionFields/);
  assert.match(wizard, /WritingAssignmentQuestionPreview/);
  assert.match(wizard, /buildCustomWritingQuestionSnapshot/);
  // Save goes through the batch edit API and invalidates the list cache.
  assert.match(wizard, /\/api\/teacher\/writing\/assignments\/batches\//);
  assert.match(wizard, /cache\.invalidate\(TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX\)/);
  // The page and the group card link exist.
  const page = source("app/teacher/writing/assignments/batches/[batchId]/edit/page.tsx");
  assert.match(page, /TeacherWritingAssignmentGroupEditForm/);
  assert.match(
    source(LIST),
    /const editHref = teacherReturnToHref\(`\$\{detailHref\}\/edit`, listReturnTo\)/
  );
});

test("legacy single withdrawn edit and reassign keep their original APIs", () => {
  const route = source(ROUTE);
  // A group-less legacy row is adopted into the same group edit RPC instead of
  // a separate single-item editing implementation.
  assert.match(route, /prepareWritingAssignmentGroupEditMutation/);
  assert.match(route, /p_legacy_assignment_id: params\.assignmentId/);
  assert.match(route, /p_group_id: null/);
  assert.match(route, /QUESTION_LOCKED_AFTER_SUBMISSION/);
  assert.match(route, /\.eq\("status", "submitted"\)/);
  assert.match(route, /action === "withdraw"/);
  assert.match(route, /action === "reactivate"/);
  assert.match(route, /action === "soft_delete"/);
  // The single edit form and page are untouched entry points.
  const page = source("app/teacher/writing/assignments/[assignmentId]/edit/page.tsx");
  assert.match(page, /TeacherWritingAssignmentEditForm/);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");
const source = (relativePath) =>
  fs.readFileSync(path.join(projectRoot, relativePath), "utf8");

const ROUTE = "app/api/teacher/writing/assignments/[assignmentId]/route.ts";
const WITHDRAW_SQL = "supabase/writing_assignment_group_withdraw.sql";

test("group withdrawal uses the transactional RPC; legacy single keeps the original RPC", () => {
  const route = source(ROUTE);
  assert.match(route, /rpc\(\s*"withdraw_writing_assignment_group"/);
  assert.match(route, /p_group_id: assignment\.group_id/);
  assert.match(route, /if \(assignment\.group_id\)/);
  // Historical assignments without a group still use withdraw_writing_assignment.
  assert.equal((route.match(/rpc\("withdraw_writing_assignment"/g) ?? []).length, 1);
  // The batch PATCH endpoint is the group edit API; withdrawal still has no
  // dedicated group HTTP endpoint.
  const batchesRoute = source("app/api/teacher/writing/assignments/batches/[batchId]/route.ts");
  assert.match(batchesRoute, /body\.action !== "edit"/);
  assert.doesNotMatch(batchesRoute, /action === "withdraw"/);
});

test("route no longer contains application-level compensation", () => {
  const route = source(ROUTE);
  assert.doesNotMatch(route, /restoreWithdrawnAssignments/);
  assert.doesNotMatch(route, /group_withdraw_rollback_failed/);
  assert.doesNotMatch(route, /withdrawWritingAssignmentGroup/);
  assert.doesNotMatch(route, /\.in\("assignment_id", withdrawnIds\)/);
  // No per-item loop over a group's assignments.
  assert.doesNotMatch(route, /for \(const assignmentId of assignmentIds\)/);
});

test("group error mapping keeps teacher-facing semantics", () => {
  const route = source(ROUTE);
  assert.match(route, /ASSIGNMENT_GROUP_HAS_ATTEMPT[\s\S]{0,80}已有学生开始作答，该作业不能撤回。/);
  assert.match(route, /ASSIGNMENT_GROUP_NOT_ACTIVE[\s\S]{0,80}作业状态已经发生变化，请刷新后重试。/);
  assert.match(route, /ASSIGNMENT_GROUP_NOT_FOUND[\s\S]{0,60}return notFound\(\)/);
  // Legacy single messages keep the existing ASSIGNMENT_HAS_ATTEMPT mapping.
  assert.match(route, /message\.includes\("ASSIGNMENT_HAS_ATTEMPT"\)/);
});

test("group withdraw RPC is one transaction with locks, checks and a single update", () => {
  const sql = source(WITHDRAW_SQL);
  assert.match(sql, /create or replace function public\.withdraw_writing_assignment_group\(\s*\n\s*p_teacher_id uuid,\s*\n\s*p_group_id uuid/);
  assert.match(sql, /returns jsonb/);
  assert.match(sql, /security definer/);
  // Ownership + group row lock.
  assert.match(sql, /from public\.writing_assignment_groups[\s\S]{0,120}and teacher_id = p_teacher_id[\s\S]{0,40}for update/);
  assert.match(sql, /raise exception 'ASSIGNMENT_GROUP_NOT_FOUND'/);
  // Item rows locked before the checks.
  assert.match(sql, /from public\.writing_assignments[\s\S]{0,160}for update/);
  assert.match(sql, /active_count <> item_count/);
  assert.match(sql, /raise exception 'ASSIGNMENT_GROUP_NOT_ACTIVE'/);
  assert.match(sql, /from public\.writing_attempts/);
  assert.match(sql, /raise exception 'ASSIGNMENT_GROUP_HAS_ATTEMPT'/);
  // Exactly one group-wide update, guarded to active rows only.
  const updateIndex = sql.indexOf("update public.writing_assignments");
  const attemptIndex = sql.indexOf("from public.writing_attempts");
  assert.ok(updateIndex > -1 && attemptIndex > -1 && attemptIndex < updateIndex);
  assert.match(sql, /set status = 'withdrawn'[\s\S]{0,160}status = 'active'/);
  assert.equal((sql.match(/update public\.writing_assignments/g) ?? []).length, 1);
  assert.match(sql, /get diagnostics withdrawn_count = row_count/);
  assert.match(sql, /'withdrawn_count', withdrawn_count/);
  // Idempotent and independent from the title / Phase B migrations.
  assert.match(sql, /create or replace/);
  assert.doesNotMatch(sql, /drop function/i);
  const sqlCode = sql.replace(/--[^\n]*/g, "");
  assert.doesNotMatch(sqlCode, /writing_assignment_groups\.title|sort_order|create_writing_assignment_group/);
  // service_role only, same as the existing withdraw RPC.
  assert.match(sql, /revoke all on function public\.withdraw_writing_assignment_group\(uuid, uuid\)[\s\S]{0,60}from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.withdraw_writing_assignment_group\(uuid, uuid\)[\s\S]{0,40}to service_role/);
});

test("collection card renders 撤回 left of 查看进度 under the shared action rule", () => {
  const list = source("components/teacher/TeacherWritingAssignmentList.tsx");
  const card = list.slice(list.indexOf("function TeacherWritingAssignmentCollectionCard"));
  assert.match(card, /teacherWritingAssignmentCardActions\(/);
  assert.match(card, /onWithdraw\(actionAssignmentId\)/);
  const withdrawIndex = card.indexOf("撤回</button>");
  const progressIndex = card.indexOf("查看进度");
  assert.ok(withdrawIndex > -1 && progressIndex > -1 && withdrawIndex < progressIndex);
  assert.match(card, /allWithdrawn[\s\S]{0,120}已撤回/);
  assert.match(list, /cache\.invalidate\(TEACHER_WRITING_ASSIGNMENTS_CACHE_PREFIX\)/);
  assert.doesNotMatch(list, /window\.location\.reload/);
});

test("the single card withdrawal action is unchanged", () => {
  const list = source("components/teacher/TeacherWritingAssignmentList.tsx");
  const singleCard = list.slice(0, list.indexOf("function TeacherWritingAssignmentCollectionCard"));
  assert.match(singleCard, /teacherWritingAssignmentCardActions\(/);
  assert.match(singleCard, /mutate\(assignment\.assignment_id, "withdraw"\)/);
});

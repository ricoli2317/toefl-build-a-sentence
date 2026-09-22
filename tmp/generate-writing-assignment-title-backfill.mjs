import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
import { getPreferredUserDisplayName } from "../lib/userDisplayName.ts";
import { loadWritingAssignmentDisplayNames } from "../lib/historicalPracticeDisplay.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Missing supabase env");

const supabase = createClient(url, key, { auth: { persistSession: false } });

async function readAll(table, select, order) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase
      .from(table)
      .select(select)
      .order(order, { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

const groups = await readAll("writing_assignment_groups", "group_id,teacher_id,created_at", "group_id");
const assignments = await readAll(
  "writing_assignments",
  "assignment_id,group_id,group_position,task_type,question_source,question_id,set_title:question_snapshot->>set_title,deleted_at,created_at",
  "assignment_id"
);
const members = await readAll(
  "writing_assignment_students",
  "assignment_id,student_id,assigned_at",
  "assignment_id"
);
const studentIds = Array.from(new Set(members.map((m) => m.student_id)));
const profiles = [];
for (let i = 0; i < studentIds.length; i += 200) {
  const { data, error } = await supabase
    .from("profiles")
    .select("id,email,full_name")
    .in("id", studentIds.slice(i, i + 200));
  if (error) throw new Error(`profiles: ${error.message}`);
  profiles.push(...(data ?? []));
}
const profileById = new Map(profiles.map((p) => [p.id, p]));

const assignmentsByGroup = new Map();
for (const a of assignments) {
  if (!a.group_id) continue;
  assignmentsByGroup.set(a.group_id, [...(assignmentsByGroup.get(a.group_id) ?? []), a]);
}
const membersByAssignment = new Map();
for (const m of members) {
  membersByAssignment.set(m.assignment_id, [...(membersByAssignment.get(m.assignment_id) ?? []), m]);
}

const displayNameById = await loadWritingAssignmentDisplayNames(
  supabase,
  assignments.map((a) => ({
    assignmentId: a.assignment_id,
    taskType: a.task_type,
    questionSource: a.question_source,
    questionId: a.question_id,
    fallbackDisplayName: a.set_title?.trim() || "自定义题目"
  }))
);

function legacyDateStamp(date) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    day: "2-digit", month: "2-digit", timeZone: "Asia/Shanghai", year: "2-digit"
  }).formatToParts(date);
  const part = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return `${part("year")}${part("month")}${part("day")}`;
}

function newFormatDate(date) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit", month: "2-digit", timeZone: "Asia/Shanghai", year: "numeric"
  }).formatToParts(date);
  const part = (t) => parts.find((p) => p.type === t)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

const legacyAutoPattern = /^\d{6}-.+等?$/;
const plan = [];
for (const group of groups) {
  const items = (assignmentsByGroup.get(group.group_id) ?? []).slice().sort(
    (a, b) => (a.group_position ?? 0) - (b.group_position ?? 0)
  );
  if (items.length === 0) continue;
  const recipientRows = [];
  const seen = new Set();
  for (const item of items) {
    for (const m of membersByAssignment.get(item.assignment_id) ?? []) {
      if (seen.has(m.student_id)) continue;
      seen.add(m.student_id);
      recipientRows.push(m);
    }
  }
  recipientRows.sort((a, b) =>
    (a.assigned_at ?? "").localeCompare(b.assigned_at ?? "")
    || a.student_id.localeCompare(b.student_id)
  );
  const names = recipientRows.map((m) =>
    getPreferredUserDisplayName({
      email: profileById.get(m.student_id)?.email,
      profileFullName: profileById.get(m.student_id)?.full_name
    })
  );
  const first = names[0] ?? "";
  const emailCount = items.filter((i) => i.task_type === "email").length;
  const adCount = items.filter((i) => i.task_type === "academic_discussion").length;
  const firstDisplay = displayNameById.get(items[0].assignment_id) ?? "";
  const oldTitle = items.length > 1 ? `${firstDisplay} 等 ${items.length} 篇写作` : firstDisplay;
  const proposedTitle = first
    ? `${first}${names.length > 1 ? "等" : ""} ${newFormatDate(new Date(group.created_at))}`
    : "";
  const legacyAuto = first
    ? `${legacyDateStamp(new Date(group.created_at))}-${first}${names.length > 1 ? "等" : ""}`
    : "";
  const customItems = items.filter((i) => i.question_source === "custom");
  const customTitles = customItems.map((i) => i.set_title ?? "");
  const allItemsDeleted = items.every((i) => i.deleted_at);
  const customTitlesAreLegacyAuto = customTitles.length > 0
    && customTitles.every((title) =>
      title === legacyAuto
      || (legacyAutoPattern.test(title)
        && title.startsWith(legacyDateStamp(new Date(group.created_at))))
    );
  const hasBankItem = items.some((i) => i.question_source === "question_bank");
  const safe = !allItemsDeleted && names.length > 0 && (hasBankItem || customTitlesAreLegacyAuto);
  const reason = allItemsDeleted
    ? "全部题目已删除，无可见卡片"
    : names.length === 0
      ? "无收件学生"
      : hasBankItem
        ? "题库题目从未有可编辑的作业标题，按收件人与布置日期生成"
        : customTitlesAreLegacyAuto
          ? "自定义题目标题匹配旧版系统自动命名规则"
          : "自定义题目标题无法判定是否为教师手动修改，保留现状";
  plan.push({
    group_id: group.group_id,
    teacher_id: group.teacher_id,
    old_title: oldTitle,
    base_auto_title: safe ? proposedTitle : null,
    students: names.join("、"),
    assigned_date: newFormatDate(new Date(group.created_at)),
    created_at: new Date(group.created_at).toISOString(),
    email_count: emailCount,
    ad_count: adCount,
    can_auto_update: safe,
    reason
  });
}

function sqlText(value) {
  if (value === null || value === undefined) return "null";
  return `'${String(value).replace(/'/g, "''")}'`;
}

const values = plan.map((row) => `  (${[
  sqlText(row.group_id),
  sqlText(row.teacher_id),
  sqlText(row.old_title),
  sqlText(row.base_auto_title),
  sqlText(row.students),
  `${sqlText(row.assigned_date)}::date`,
  `${sqlText(row.created_at)}::timestamptz`,
  row.email_count,
  row.ad_count,
  row.can_auto_update,
  sqlText(row.reason)
].join(", ")})`).join(",\n");

const safeCount = plan.filter((row) => row.can_auto_update).length;
const planSql = `create temporary table writing_assignment_group_title_plan (
  group_id uuid primary key,
  teacher_id uuid not null,
  old_title text,
  base_auto_title text,
  auto_title_sequence integer,
  proposed_new_title text,
  students text,
  assigned_date date,
  created_at timestamptz not null,
  email_count integer,
  ad_count integer,
  can_auto_update boolean not null,
  reason text
) on commit drop;

insert into writing_assignment_group_title_plan (
  group_id, teacher_id, old_title, base_auto_title, students, assigned_date,
  created_at, email_count, ad_count, can_auto_update, reason
) values
${values};

-- Numbering inside one teacher + one base title. The order is the real group
-- creation time with group_id as the stable tie-breaker, so re-running this
-- file always produces the same numbers. Unsafe and soft-deleted groups have
-- no base title and never occupy a number.
update writing_assignment_group_title_plan plan
set auto_title_sequence = numbered.sequence,
    proposed_new_title = case
      when numbered.sequence = 1 then plan.base_auto_title
      else plan.base_auto_title || ' (' || numbered.sequence || ')'
    end
from (
  select group_id,
         row_number() over (
           partition by teacher_id, base_auto_title
           order by created_at, group_id
         ) as sequence
  from writing_assignment_group_title_plan
  where can_auto_update
) numbered
where numbered.group_id = plan.group_id;`;

const applySql = `begin;

${planSql}

-- Only safe rows are updated, and only while no title has been written yet.
update public.writing_assignment_groups groups
set title = plan.proposed_new_title
from writing_assignment_group_title_plan plan
where groups.group_id = plan.group_id
  and plan.can_auto_update
  and groups.title is null;

commit;`;
const applySqlCommented = applySql
  .split("\n")
  .map((line) => (line ? `-- ${line}` : "--"))
  .join("\n");

const sql = `-- Generated by tmp/generate-writing-assignment-title-backfill.mjs.
-- Run supabase/writing_assignment_group_titles.sql (Phase A) first.
-- supabase/writing_assignment_group_titles_cleanup.sql (Phase B) runs only
-- after the new code is committed, deployed and verified in production.
--
-- This file is a dry-run: the SELECT below prints the plan and the trailing
-- ROLLBACK guarantees that nothing changes. Review every row, then use the
-- commented apply block at the bottom if you want the safe rows updated.
--
-- Safe rows: ${safeCount} / ${plan.length}. Only rows with can_auto_update = true
-- are ever touched; rows that may hold a teacher-edited title are kept as-is
-- (their cards keep today's display fallback until a manual decision is made).
-- base_auto_title and auto_title_sequence show the computed numbering; unsafe
-- and soft-deleted groups keep both null and never occupy a number.

begin;

${planSql}

select
  plan.group_id,
  plan.old_title,
  plan.base_auto_title,
  plan.auto_title_sequence,
  plan.proposed_new_title,
  plan.students,
  plan.assigned_date,
  plan.email_count,
  plan.ad_count,
  plan.can_auto_update,
  plan.reason,
  groups.title as current_title
from writing_assignment_group_title_plan plan
join public.writing_assignment_groups groups using (group_id)
order by
  plan.assigned_date,
  plan.base_auto_title nulls last,
  plan.auto_title_sequence nulls last,
  plan.group_id;

rollback;

-- ---------------------------------------------------------------------------
-- Apply block (uncomment and run only after reviewing the dry-run above).
-- It recomputes the same plan and numbering, then updates safe rows whose
-- title is still null. Teacher-written titles are never overwritten.
-- ---------------------------------------------------------------------------
${applySqlCommented}
`;

writeFileSync("supabase/writing_assignment_group_title_backfill_dry_run.sql", sql);
console.log(`plan rows: ${plan.length}, safe: ${safeCount}`);
console.log(plan.map((row) => ({
  id: row.group_id.slice(0, 8),
  old: row.old_title.slice(0, 28),
  base: row.base_auto_title,
  seq: row.auto_title_sequence,
  students: row.students,
  date: row.assigned_date,
  e: row.email_count,
  ad: row.ad_count,
  safe: row.can_auto_update,
  reason: row.reason
})));

import { createClient } from "@supabase/supabase-js";
import { getPreferredUserDisplayName } from "../lib/userDisplayName.ts";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) throw new Error("Missing supabase env");

const supabase = createClient(url, key, { auth: { persistSession: false } });

async function readAll(table, select, order = "assignment_id", extra = (q) => q) {
  const rows = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const query = extra(supabase.from(table).select(select)).order(order, { ascending: true });
    const { data, error } = await query.range(from, from + pageSize - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

const groupsTitleColumn = await supabase
  .from("writing_assignment_groups")
  .select("group_id,title")
  .limit(1);
console.log("groups.title column probe:", groupsTitleColumn.error ? `ERROR: ${groupsTitleColumn.error.message}` : "EXISTS");

const assignmentsTitleColumn = await supabase
  .from("writing_assignments")
  .select("assignment_id,title")
  .limit(1);
console.log("assignments.title column probe:", assignmentsTitleColumn.error ? `ERROR: ${assignmentsTitleColumn.error.message}` : "EXISTS");

const groups = await readAll(
  "writing_assignment_groups",
  "group_id,teacher_id,created_at",
  "group_id"
);
const assignments = await readAll(
  "writing_assignments",
  "assignment_id,group_id,group_position,teacher_id,task_type,question_source,question_id,set_title:question_snapshot->>set_title,status,deleted_at,created_at",
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
  const batch = studentIds.slice(i, i + 200);
  const { data, error } = await supabase
    .from("profiles")
    .select("id,email,full_name")
    .in("id", batch);
  if (error) throw new Error(`profiles: ${error.message}`);
  profiles.push(...(data ?? []));
}
const profileById = new Map(profiles.map((p) => [p.id, p]));

const assignmentsByGroup = new Map();
for (const a of assignments) {
  if (!a.group_id) continue;
  const list = assignmentsByGroup.get(a.group_id) ?? [];
  list.push(a);
  assignmentsByGroup.set(a.group_id, list);
}
const membersByAssignment = new Map();
for (const m of members) {
  const list = membersByAssignment.get(m.assignment_id) ?? [];
  list.push(m);
  membersByAssignment.set(m.assignment_id, list);
}

function legacyTitleParts(date) {
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

const legacyAutoPattern = /^\d{6}-[^等]+等?$/;

const report = [];
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
    (a.assigned_at ?? "").localeCompare(b.assigned_at ?? "") || a.student_id.localeCompare(b.student_id)
  );
  const names = recipientRows.map((m) =>
    getPreferredUserDisplayName({
      email: profileById.get(m.student_id)?.email,
      profileFullName: profileById.get(m.student_id)?.full_name
    })
  );
  const first = names[0] ?? "";
  const legacyAuto = `${legacyTitleParts(new Date(group.created_at))}-${first}${names.length > 1 ? "等" : ""}`;
  const newTitle = `${first}${names.length > 1 ? "等" : ""} ${newFormatDate(new Date(group.created_at))}`;
  const bankCount = items.filter((i) => i.question_source === "question_bank").length;
  const customCount = items.filter((i) => i.question_source === "custom").length;
  const customTitles = items.filter((i) => i.question_source === "custom").map((i) => i.set_title ?? "");
  const customTitlesAllLegacyAuto = customTitles.every(
    (t) => t === legacyAuto || (legacyAutoPattern.test(t) && t.startsWith(legacyTitleParts(new Date(group.created_at))))
  );
  const hasDeleted = items.some((i) => i.deleted_at);
  const statuses = Array.from(new Set(items.map((i) => i.status)));
  report.push({
    group_id: group.group_id,
    created_at: group.created_at,
    item_count: items.length,
    bank_count: bankCount,
    custom_count: customCount,
    students: names,
    legacy_auto_guess: legacyAuto,
    proposed_new_title: newTitle,
    custom_titles: customTitles,
    classification:
      hasDeleted ? "deleted-items"
        : bankCount > 0 ? "bank"
        : customTitlesAllLegacyAuto ? "custom-auto-legacy"
        : "custom-manual-or-unknown",
    statuses
  });
}

const byClass = {};
for (const r of report) byClass[r.classification] = (byClass[r.classification] ?? 0) + 1;
console.log("groups total:", report.length, "classification:", byClass);
console.log("assignments total:", assignments.length, "with group:", assignments.filter((a) => a.group_id).length, "without group:", assignments.filter((a) => !a.group_id).length);
console.log("ungrouped assignments:", assignments.filter((a) => !a.group_id).map((a) => ({
  id: a.assignment_id, task: a.task_type, source: a.question_source, title: a.set_title, created: a.created_at
})));
console.log("--- sample report ---");
console.log(JSON.stringify(report.slice(0, 25), null, 2));
console.log("--- non legacy-auto custom groups ---");
console.log(JSON.stringify(report.filter((r) => r.classification === "custom-manual-or-unknown"), null, 2));

import { writeFileSync } from "node:fs";
writeFileSync("tmp/writing-assignment-title-audit.json", JSON.stringify(report, null, 2));
console.log("written tmp/writing-assignment-title-audit.json");

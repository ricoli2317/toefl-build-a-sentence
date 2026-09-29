/**
 * One-off local verification helper (dialog-gated teacher actions cannot be
 * driven from the in-app browser: window.confirm blocks the renderer).
 *
 * Usage:
 *   node --env-file-if-exists=.env.local tmp/assignment-consistency-verify.mjs withdrawal <title>
 *   node --env-file-if-exists=.env.local tmp/assignment-consistency-verify.mjs group <title>
 *   node --env-file-if-exists=.env.local tmp/assignment-consistency-verify.mjs reactivate <group_id>
 *   node --env-file-if-exists=.env.local tmp/assignment-consistency-verify.mjs soft-delete <group_id>
 */
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const [command, argument] = process.argv.slice(2);

async function findGroup(title) {
  const { data: groups, error } = await supabase
    .from("writing_assignment_groups")
    .select("group_id,teacher_id,title,class_id,created_at")
    .eq("title", title)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) throw error;
  if (!groups?.length) throw new Error(`group not found: ${title}`);
  return groups[0];
}

async function printGroup(groupId) {
  const { data: items, error } = await supabase
    .from("writing_assignments")
    .select("assignment_id,group_position,task_type,subject,question_source,question_id,status,deleted_at,question_snapshot")
    .eq("group_id", groupId)
    .order("group_position", { ascending: true });
  if (error) throw error;
  const { data: members, error: memberError } = await supabase
    .from("writing_assignment_students")
    .select("assignment_id,student_id,assigned_at,sort_order")
    .in("assignment_id", (items ?? []).map((item) => item.assignment_id));
  if (memberError) throw memberError;
  console.log(JSON.stringify({ groupId, items, members }, null, 2));
}

async function main() {
  if (command === "group") {
    const group = await findGroup(argument);
    await printGroup(group.group_id);
    return;
  }
  if (command === "withdrawal") {
    const group = await findGroup(argument);
    const { data, error } = await supabase.rpc("withdraw_writing_assignment_group", {
      p_teacher_id: group.teacher_id,
      p_group_id: group.group_id
    });
    if (error) throw error;
    console.log(JSON.stringify({ rpc: data, groupId: group.group_id }));
    await printGroup(group.group_id);
    return;
  }
  if (command === "reactivate") {
    const { data, error } = await supabase
      .from("writing_assignments")
      .update({ status: "active" })
      .eq("group_id", argument)
      .eq("status", "withdrawn")
      .is("deleted_at", null)
      .select("assignment_id");
    if (error) throw error;
    console.log(JSON.stringify({ reactivated: data?.length ?? 0 }));
    return;
  }
  if (command === "soft-delete") {
    const { data, error } = await supabase
      .from("writing_assignments")
      .update({ deleted_at: new Date().toISOString() })
      .eq("group_id", argument)
      .eq("status", "withdrawn")
      .is("deleted_at", null)
      .select("assignment_id");
    if (error) throw error;
    console.log(JSON.stringify({ deleted: data?.length ?? 0 }));
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

await main();

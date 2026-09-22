import { createClient } from "@supabase/supabase-js";

const groupId = process.argv[2];
if (!groupId) throw new Error("group id required");
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } }
);

const { data: rows, error } = await supabase
  .from("writing_assignments")
  .select("assignment_id")
  .eq("group_id", groupId);
if (error) throw new Error(error.message);
const ids = rows.map((row) => row.assignment_id);
const { data: attempts, error: attemptError } = await supabase
  .from("writing_attempts")
  .select("attempt_id")
  .in("assignment_id", ids);
if (attemptError) throw new Error(attemptError.message);
if (attempts.length > 0) throw new Error(`refusing to delete: ${attempts.length} attempts exist`);

const membership = await supabase.from("writing_assignment_students").delete().in("assignment_id", ids);
if (membership.error) throw new Error(membership.error.message);
const assignments = await supabase.from("writing_assignments").delete().in("assignment_id", ids);
if (assignments.error) throw new Error(assignments.error.message);
const group = await supabase.from("writing_assignment_groups").delete().eq("group_id", groupId);
if (group.error) throw new Error(group.error.message);
console.log("deleted group", groupId, "assignments", ids.length);

import type { SupabaseClient } from "@supabase/supabase-js";
import type { UserRole } from "./types.ts";
import { readAllSupabaseRows } from "./supabasePagination.ts";

export type AccountActor = { userId: string; role: UserRole };

export function canAssignRecipient(
  actor: AccountActor,
  recipient: { id: string; role: UserRole; ownerId: string | null; isActive: boolean }
) {
  if (!recipient.isActive) return false;
  if (actor.role === "admin") return recipient.role === "student" || recipient.id === actor.userId;
  return actor.role === "teacher" && recipient.role === "student" && recipient.ownerId === actor.userId;
}

export function applyVisibleStudentFilter<T>(
  query: T,
  actor: AccountActor
): T {
  if (actor.role === "admin") return query;
  return (query as { eq: (column: string, value: string) => T }).eq(
    "owner_id",
    actor.userId
  );
}

export async function listVisibleStudentIds(
  supabase: SupabaseClient,
  actor: AccountActor
) {
  let query = supabase
    .from("profiles")
    .select("id")
    .eq("role", "student")
    .eq("is_active", true);
  if (actor.role !== "admin") query = query.eq("owner_id", actor.userId);
  const result = await readAllSupabaseRows<{ id: string }>((from, to) =>
    query.order("id", { ascending: true }).range(from, to)
  );
  if (result.error) throw result.error;
  const ids = (result.data ?? []).map((row) => String(row.id));
  if (actor.role === "admin" && !ids.includes(actor.userId)) ids.push(actor.userId);
  return ids;
}

export async function canManageStudent(
  supabase: SupabaseClient,
  actor: AccountActor,
  studentId: string
) {
  if (actor.role === "admin" && studentId === actor.userId) return true;
  let query = supabase
    .from("profiles")
    .select("id")
    .eq("id", studentId)
    .eq("role", "student")
    .eq("is_active", true);
  if (actor.role !== "admin") query = query.eq("owner_id", actor.userId);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function canManageWritingAttempt(
  supabase: SupabaseClient,
  actor: AccountActor,
  attemptId: string
) {
  const { data, error } = await supabase
    .from("writing_attempts")
    .select("user_id")
    .eq("attempt_id", attemptId)
    .maybeSingle();
  if (error) throw error;
  return data ? canManageStudent(supabase, actor, String(data.user_id)) : false;
}

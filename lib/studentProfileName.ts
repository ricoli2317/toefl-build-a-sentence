import type { SupabaseClient } from "@supabase/supabase-js";
import { getPreferredUserDisplayName } from "./userDisplayName.ts";

export const MAX_STUDENT_FULL_NAME_LENGTH = 60;

export type StudentFullNameValidation =
  | { ok: true; fullName: string }
  | { ok: false; error: string };

/**
 * profiles.full_name is the single authoritative student display name. Renaming
 * a student writes only this column: email, login account, owner_id, role,
 * bindings, assignments, attempts, reviews, and every historical record stay
 * untouched.
 */
export function normalizeStudentFullName(input: unknown) {
  if (typeof input !== "string") return "";
  return input.trim().replace(/\s+/g, " ");
}

export function validateStudentFullName(input: unknown): StudentFullNameValidation {
  const fullName = normalizeStudentFullName(input);
  if (!fullName) return { ok: false, error: "学生姓名不能为空。" };
  if (fullName.length > MAX_STUDENT_FULL_NAME_LENGTH) {
    return { ok: false, error: `学生姓名不能超过 ${MAX_STUDENT_FULL_NAME_LENGTH} 个字符。` };
  }
  return { ok: true, fullName };
}

export type RenamedStudentProfile = {
  studentId: string;
  displayName: string;
};

/**
 * Updates exactly one active student profile. Returns null when the id is not
 * an active student, so both the Teacher and the Admin route report 404 for
 * anything else without ever touching another role or an inactive account.
 */
export async function renameStudentProfile(
  supabase: SupabaseClient,
  input: { studentId: string; fullName: string }
): Promise<RenamedStudentProfile | null> {
  const { data, error } = await supabase
    .from("profiles")
    .update({ full_name: input.fullName })
    .eq("id", input.studentId)
    .eq("role", "student")
    .eq("is_active", true)
    .select("id,email,full_name")
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    studentId: String(data.id),
    displayName: getPreferredUserDisplayName({
      email: data.email,
      profileFullName: data.full_name
    })
  };
}

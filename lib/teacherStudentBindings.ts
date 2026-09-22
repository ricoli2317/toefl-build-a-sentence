import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "./supabasePagination.ts";
import { getPreferredUserDisplayName } from "./userDisplayName.ts";
import {
  STUDENT_BINDING_DOMAINS,
  type StudentBindingDomain
} from "./studentBindings.ts";

/**
 * Teacher-facing binding management. Teaching relationships and their display
 * names are always read from teacher_student_bindings joined to the teacher
 * profile; the legacy account ownership column is never used to derive a
 * teaching teacher or a teaching subject.
 */

export type TeacherStudentProfileRow = {
  id: string;
  email: string | null;
  full_name: string | null;
};

export type StudentBindingTeacherSummary = {
  teacherId: string;
  teacherName: string;
  teacherEmail: string;
  domains: StudentBindingDomain[];
};

export type StudentBindingCandidate = {
  id: string;
  displayName: string;
  email: string;
  bindings: StudentBindingTeacherSummary[];
};

export function teacherBindingDisplayName(profile: TeacherStudentProfileRow | null | undefined) {
  return (
    getPreferredUserDisplayName({
      email: profile?.email,
      profileFullName: profile?.full_name
    }) || ""
  );
}

export function groupStudentBindingsByTeacher(
  bindings: ReadonlyArray<{ teacherId: string; domain: string }>
): Array<{ teacherId: string; domains: StudentBindingDomain[] }> {
  const domainsByTeacher = new Map<string, Set<StudentBindingDomain>>();
  for (const binding of bindings) {
    const teacherId = binding.teacherId;
    if (!teacherId) continue;
    if (binding.domain !== "reading" && binding.domain !== "writing") continue;
    const domains = domainsByTeacher.get(teacherId) ?? new Set<StudentBindingDomain>();
    domains.add(binding.domain);
    domainsByTeacher.set(teacherId, domains);
  }
  return Array.from(domainsByTeacher, ([teacherId, domains]) => ({
    teacherId,
    domains: STUDENT_BINDING_DOMAINS.filter((domain) => domains.has(domain))
  }));
}

export function buildStudentBindingSummaries(input: {
  bindings: ReadonlyArray<{ studentId: string; teacherId: string; domain: string }>;
  teacherProfiles: ReadonlyArray<TeacherStudentProfileRow>;
}): Map<string, StudentBindingTeacherSummary[]> {
  const teacherById = new Map(
    input.teacherProfiles.map((profile) => [String(profile.id), profile])
  );
  const bindingsByStudent = new Map<string, Array<{ teacherId: string; domain: string }>>();
  for (const binding of input.bindings) {
    const studentId = String(binding.studentId);
    const rows = bindingsByStudent.get(studentId) ?? [];
    rows.push({ teacherId: String(binding.teacherId), domain: String(binding.domain) });
    bindingsByStudent.set(studentId, rows);
  }

  const summaries = new Map<string, StudentBindingTeacherSummary[]>();
  for (const [studentId, rows] of Array.from(bindingsByStudent.entries())) {
    const grouped = groupStudentBindingsByTeacher(rows)
      .map((group) => {
        const profile = teacherById.get(group.teacherId);
        return {
          teacherId: group.teacherId,
          teacherName: teacherBindingDisplayName(profile) || "未命名教师",
          teacherEmail: profile?.email ?? "",
          domains: group.domains
        };
      })
      .sort(
        (left, right) =>
          left.teacherId.localeCompare(right.teacherId) ||
          left.teacherName.localeCompare(right.teacherName, "zh-CN")
      );
    summaries.set(studentId, grouped);
  }
  return summaries;
}

export async function loadStudentBindingSummaries(
  supabase: SupabaseClient,
  studentIds: readonly string[]
): Promise<Map<string, StudentBindingTeacherSummary[]>> {
  const ids = Array.from(new Set(studentIds.map((id) => String(id)).filter(Boolean)));
  if (ids.length === 0) return new Map();

  const bindingsResult = await readAllSupabaseRows<{
    teacher_id: string;
    student_id: string;
    domain: string;
  }>((from, to) =>
    supabase
      .from("teacher_student_bindings")
      .select("teacher_id,student_id,domain")
      .in("student_id", ids)
      .order("student_id", { ascending: true })
      .range(from, to)
  );
  if (bindingsResult.error) throw bindingsResult.error;

  const bindings = (bindingsResult.data ?? []).map((row) => ({
    studentId: String(row.student_id),
    teacherId: String(row.teacher_id),
    domain: String(row.domain)
  }));
  if (bindings.length === 0) return new Map();

  const teacherIds = Array.from(new Set(bindings.map((binding) => binding.teacherId)));
  const teacherProfilesResult = await readAllSupabaseRows<TeacherStudentProfileRow>((from, to) =>
    supabase
      .from("profiles")
      .select("id,email,full_name")
      .in("id", teacherIds)
      .order("id", { ascending: true })
      .range(from, to)
  );
  if (teacherProfilesResult.error) throw teacherProfilesResult.error;

  return buildStudentBindingSummaries({
    bindings,
    teacherProfiles: teacherProfilesResult.data ?? []
  });
}

export async function buildStudentBindingCandidates(
  supabase: SupabaseClient,
  students: readonly TeacherStudentProfileRow[]
): Promise<StudentBindingCandidate[]> {
  const summaries = await loadStudentBindingSummaries(
    supabase,
    students.map((student) => String(student.id))
  );
  return students.map((student) => ({
    id: String(student.id),
    displayName: teacherBindingDisplayName(student) || "",
    email: student.email ?? "",
    bindings: summaries.get(String(student.id)) ?? []
  }));
}

export async function findActiveStudentsByName(supabase: SupabaseClient, name: string) {
  const trimmed = name.trim();
  if (!trimmed) return [] as TeacherStudentProfileRow[];
  const result = await readAllSupabaseRows<TeacherStudentProfileRow>((from, to) =>
    supabase
      .from("profiles")
      .select("id,email,full_name")
      .eq("role", "student")
      .eq("is_active", true)
      .ilike("full_name", escapeLikePattern(trimmed))
      .order("id", { ascending: true })
      .range(from, to)
  );
  if (result.error) throw result.error;
  return result.data ?? [];
}

function escapeLikePattern(value: string) {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

/**
 * Search is always query-driven: an empty query returns no rows and never
 * loads the full student directory.
 */
export async function searchActiveStudents(
  supabase: SupabaseClient,
  query: string,
  limit = 20
) {
  const trimmed = query.trim();
  if (!trimmed) return [] as TeacherStudentProfileRow[];
  const pattern = `%${escapeLikePattern(trimmed)}%`;
  const run = (column: "full_name" | "email") =>
    supabase
      .from("profiles")
      .select("id,email,full_name")
      .eq("role", "student")
      .eq("is_active", true)
      .ilike(column, pattern)
      .order("full_name", { ascending: true, nullsFirst: false })
      .order("id", { ascending: true })
      .limit(limit);

  const [byName, byEmail] = await Promise.all([run("full_name"), run("email")]);
  if (byName.error) throw byName.error;
  if (byEmail.error) throw byEmail.error;

  const merged = new Map<string, TeacherStudentProfileRow>();
  for (const row of [...(byName.data ?? []), ...(byEmail.data ?? [])]) {
    merged.set(String(row.id), row);
  }
  return Array.from(merged.values()).slice(0, limit);
}

export type CreateTeacherStudentBindingsResult =
  | {
      ok: true;
      created: StudentBindingDomain[];
      alreadyBound: StudentBindingDomain[];
    }
  | { ok: false; error: string };

/**
 * Adds only the missing domains for exactly one teacher/student pair. The
 * caller supplies the teacher id from the authenticated session; client input
 * can never choose another teacher.
 */
export async function createTeacherStudentBindings(
  supabase: SupabaseClient,
  input: { teacherId: string; studentId: string; domains: readonly StudentBindingDomain[] }
): Promise<CreateTeacherStudentBindingsResult> {
  const existingResult = await readAllSupabaseRows<{ domain: string }>((from, to) =>
    supabase
      .from("teacher_student_bindings")
      .select("domain")
      .eq("teacher_id", input.teacherId)
      .eq("student_id", input.studentId)
      .order("domain", { ascending: true })
      .range(from, to)
  );
  if (existingResult.error) return { ok: false, error: existingResult.error.message };

  const existingDomains = new Set((existingResult.data ?? []).map((row) => String(row.domain)));
  const alreadyBound = input.domains.filter((domain) => existingDomains.has(domain));
  const missing = input.domains.filter((domain) => !existingDomains.has(domain));
  if (missing.length === 0) return { ok: true, created: [], alreadyBound };

  const insertResult = await supabase
    .from("teacher_student_bindings")
    .insert(
      missing.map((domain) => ({
        teacher_id: input.teacherId,
        student_id: input.studentId,
        domain
      }))
    )
    .select("binding_id,domain");
  if (insertResult.error) return { ok: false, error: insertResult.error.message };

  return { ok: true, created: missing, alreadyBound };
}

/**
 * Removes a student account created during a failed request. Deleting the
 * profile row cascades to teacher_student_bindings, so no half-created
 * student or partial binding remains.
 */
export async function rollbackCreatedStudentAccount(
  supabase: SupabaseClient,
  input: { userId: string; deleteAuthUser: (userId: string) => Promise<unknown> }
) {
  const profileResult = await supabase.from("profiles").delete().eq("id", input.userId);
  if (profileResult.error) {
    console.error("[teacher-students] rollback_profile_failed", profileResult.error);
  }
  try {
    await input.deleteAuthUser(input.userId);
  } catch (error) {
    console.error("[teacher-students] rollback_auth_user_failed", error);
  }
}

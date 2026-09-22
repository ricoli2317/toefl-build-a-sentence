import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "./supabasePagination.ts";
import { STUDENT_BINDING_DOMAINS, type StudentBindingDomain } from "./studentBindings.ts";
import type { UserRole } from "./types.ts";

export type AccountActor = { userId: string; role: UserRole };

/**
 * Teaching access is authorized exclusively through teacher_student_bindings.
 * The legacy profiles.owner_id mechanism is never used as an access fallback.
 */

export async function isActiveStudent(supabase: SupabaseClient, studentId: string) {
  const { data, error } = await supabase
    .from("profiles")
    .select("id")
    .eq("id", studentId)
    .eq("role", "student")
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function canAccessStudentDomain(
  supabase: SupabaseClient,
  actor: AccountActor,
  studentId: string,
  domain: StudentBindingDomain
) {
  if (actor.role === "admin") {
    if (studentId === actor.userId) return true;
    return isActiveStudent(supabase, studentId);
  }
  const { data, error } = await supabase
    .from("teacher_student_bindings")
    .select("binding_id")
    .eq("teacher_id", actor.userId)
    .eq("student_id", studentId)
    .eq("domain", domain)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

/**
 * Writing Assignment recipients must be active students the teaching teacher
 * holds a writing-domain binding with. Admin may assign to any active student
 * or to the Admin test account itself.
 */
export async function canAssignRecipient(
  supabase: SupabaseClient,
  actor: AccountActor,
  recipient: { id: string; role: UserRole; isActive: boolean }
) {
  if (!recipient.isActive) return false;
  if (actor.role === "admin") {
    return recipient.role === "student" || recipient.id === actor.userId;
  }
  if (actor.role !== "teacher" || recipient.role !== "student") return false;
  return canAccessStudentDomain(supabase, actor, recipient.id, "writing");
}

export async function listVisibleStudentIds(
  supabase: SupabaseClient,
  actor: AccountActor,
  domain?: StudentBindingDomain
) {
  if (actor.role === "admin") {
    const result = await readAllSupabaseRows<{ id: string }>((from, to) =>
      supabase
        .from("profiles")
        .select("id")
        .eq("role", "student")
        .eq("is_active", true)
        .order("id", { ascending: true })
        .range(from, to)
    );
    if (result.error) throw result.error;
    const ids = (result.data ?? []).map((row) => String(row.id));
    if (!ids.includes(actor.userId)) ids.push(actor.userId);
    return ids;
  }

  const bindingResult = await readAllSupabaseRows<{ student_id: string }>((from, to) => {
    let query = supabase
      .from("teacher_student_bindings")
      .select("student_id")
      .eq("teacher_id", actor.userId);
    if (domain) query = query.eq("domain", domain);
    return query.order("student_id", { ascending: true }).range(from, to);
  });
  if (bindingResult.error) throw bindingResult.error;
  const studentIds = Array.from(
    new Set((bindingResult.data ?? []).map((row) => String(row.student_id)))
  );
  if (studentIds.length === 0) return [];

  const profilesResult = await readAllSupabaseRows<{ id: string }>((from, to) =>
    supabase
      .from("profiles")
      .select("id")
      .in("id", studentIds)
      .eq("role", "student")
      .eq("is_active", true)
      .order("id", { ascending: true })
      .range(from, to)
  );
  if (profilesResult.error) throw profilesResult.error;
  return (profilesResult.data ?? []).map((row) => String(row.id));
}

/**
 * Domain capabilities for the Teacher UI are binding-based, never role-based.
 * Returns the domains the teacher holds at least one binding for plus the
 * per-student domain list. Admin has no teaching bindings and gets empty data.
 */
export async function listTeacherStudentDomainBindings(
  supabase: SupabaseClient,
  actor: AccountActor
): Promise<{
  teacherDomains: StudentBindingDomain[];
  studentDomains: Map<string, StudentBindingDomain[]>;
}> {
  if (actor.role !== "teacher") {
    return { teacherDomains: [], studentDomains: new Map() };
  }

  const result = await readAllSupabaseRows<{ student_id: string; domain: string }>((from, to) =>
    supabase
      .from("teacher_student_bindings")
      .select("student_id,domain")
      .eq("teacher_id", actor.userId)
      .order("student_id", { ascending: true })
      .range(from, to)
  );
  if (result.error) throw result.error;

  const teacherDomainSet = new Set<StudentBindingDomain>();
  const studentDomainSets = new Map<string, Set<StudentBindingDomain>>();
  for (const row of result.data ?? []) {
    const domain = String(row.domain);
    if (domain !== "reading" && domain !== "writing") continue;
    teacherDomainSet.add(domain);
    const studentId = String(row.student_id);
    const domains = studentDomainSets.get(studentId) ?? new Set<StudentBindingDomain>();
    domains.add(domain);
    studentDomainSets.set(studentId, domains);
  }

  const sortDomains = (domains: Iterable<StudentBindingDomain>) => {
    const values = Array.from(domains);
    return STUDENT_BINDING_DOMAINS.filter((domain) => values.includes(domain));
  };
  const teacherDomains = sortDomains(teacherDomainSet);
  const studentDomains = new Map<string, StudentBindingDomain[]>(
    Array.from(studentDomainSets, ([studentId, domains]) => [studentId, sortDomains(domains)])
  );
  return { teacherDomains, studentDomains };
}

export async function canManageStudent(
  supabase: SupabaseClient,
  actor: AccountActor,
  studentId: string,
  domain?: StudentBindingDomain
) {
  if (actor.role === "admin") {
    if (studentId === actor.userId) return true;
    return isActiveStudent(supabase, studentId);
  }
  let query = supabase
    .from("teacher_student_bindings")
    .select("binding_id")
    .eq("teacher_id", actor.userId)
    .eq("student_id", studentId);
  if (domain) query = query.eq("domain", domain);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

/**
 * Writing review access is one of:
 * - Admin owns every attempt (its author is active or the Admin test account).
 * - Assignment attempts belong exclusively to the assignment's teacher_id.
 * - Self-practice attempts (assignment_id IS NULL) require a writing-domain
 *   binding with the attempt's author; no profiles.owner_id fallback.
 */
export async function canManageWritingAttempt(
  supabase: SupabaseClient,
  actor: AccountActor,
  attemptId: string
) {
  const { data, error } = await supabase
    .from("writing_attempts")
    .select("assignment_id,user_id")
    .eq("attempt_id", attemptId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return false;
  const userId = String(data.user_id);

  if (actor.role === "admin") {
    if (userId === actor.userId) return true;
    return isActiveStudent(supabase, userId);
  }

  const assignmentId = data.assignment_id ? String(data.assignment_id) : null;
  if (assignmentId) {
    const { data: assignment, error: assignmentError } = await supabase
      .from("writing_assignments")
      .select("teacher_id")
      .eq("assignment_id", assignmentId)
      .maybeSingle();
    if (assignmentError) throw assignmentError;
    return Boolean(assignment && String(assignment.teacher_id) === actor.userId);
  }

  return canAccessStudentDomain(supabase, actor, userId, "writing");
}

/**
 * Attempt ids a teacher may review through the AI log list: self-practice
 * attempts by writing-bound students plus attempts on the teacher's own
 * assignments. Admin sees every self and assignment attempt.
 */
export async function listVisibleWritingAttemptIds(
  supabase: SupabaseClient,
  actor: AccountActor
) {
  const ids = new Set<string>();

  const writingStudentIds = await listVisibleStudentIds(supabase, actor, "writing");
  if (writingStudentIds.length > 0) {
    const selfResult = await readAllSupabaseRows<{ attempt_id: string }>((from, to) =>
      supabase
        .from("writing_attempts")
        .select("attempt_id")
        .eq("status", "submitted")
        .in("user_id", writingStudentIds)
        .is("assignment_id", null)
        .order("attempt_id", { ascending: true })
        .range(from, to)
    );
    if (selfResult.error) throw selfResult.error;
    for (const row of selfResult.data ?? []) ids.add(String(row.attempt_id));
  }

  if (actor.role === "admin") {
    const assignmentResult = await readAllSupabaseRows<{ attempt_id: string }>((from, to) =>
      supabase
        .from("writing_attempts")
        .select("attempt_id")
        .eq("status", "submitted")
        .not("assignment_id", "is", null)
        .order("attempt_id", { ascending: true })
        .range(from, to)
    );
    if (assignmentResult.error) throw assignmentResult.error;
    for (const row of assignmentResult.data ?? []) ids.add(String(row.attempt_id));
    return Array.from(ids);
  }

  const assignmentResult = await readAllSupabaseRows<{ assignment_id: string }>((from, to) =>
    supabase
      .from("writing_assignments")
      .select("assignment_id")
      .eq("teacher_id", actor.userId)
      .order("created_at", { ascending: false })
      .range(from, to)
  );
  if (assignmentResult.error) throw assignmentResult.error;
  const assignmentIds = (assignmentResult.data ?? []).map((row) => String(row.assignment_id));
  if (assignmentIds.length === 0) return Array.from(ids);

  const attemptResult = await readAllSupabaseRows<{ attempt_id: string }>((from, to) =>
    supabase
      .from("writing_attempts")
      .select("attempt_id")
      .eq("status", "submitted")
      .in("assignment_id", assignmentIds)
      .order("attempt_id", { ascending: true })
      .range(from, to)
  );
  if (attemptResult.error) throw attemptResult.error;
  for (const row of attemptResult.data ?? []) ids.add(String(row.attempt_id));
  return Array.from(ids);
}
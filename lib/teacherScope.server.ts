import type { SupabaseClient } from "@supabase/supabase-js";
import { readAllSupabaseRows } from "./supabasePagination.ts";
import { STUDENT_BINDING_DOMAINS, type StudentBindingDomain } from "./studentBindings.ts";
import type { UserRole } from "./types.ts";
import { getPreferredUserDisplayName } from "./userDisplayName.ts";

export type TeacherScopeStudentProfile = {
  studentId: string;
  displayName: string;
  email: string;
  fullName: string | null;
};

/**
 * One request-scoped view of everything a teacher may reach: the acting
 * account, the teacher's binding domains, the visible (active, student-role)
 * bound students with their display names, and each student's bound domains.
 *
 * It resolves the whole scope with a single embedded Supabase query so teacher
 * pages never pay a bindings query plus a profiles query plus a separate
 * student-name lookup for the same data.
 */
export type TeacherScope = {
  userId: string;
  role: UserRole;
  teacherDomains: StudentBindingDomain[];
  studentDomains: Map<string, StudentBindingDomain[]>;
  visibleStudentIds: string[];
  studentProfiles: Map<string, TeacherScopeStudentProfile>;
  writingStudentIds: string[];
  readingStudentIds: string[];
};

type BindingScopeRow = {
  student_id: string;
  domain: string;
  student:
    | {
        id: string;
        role: string | null;
        email: string | null;
        full_name: string | null;
        is_active: boolean | null;
      }
    | Array<{
        id: string;
        role: string | null;
        email: string | null;
        full_name: string | null;
        is_active: boolean | null;
      }>
    | null;
};

const SCOPE_FIELDS =
  "student_id,domain,student:profiles!teacher_student_bindings_student_id_fkey(id,role,email,full_name,is_active)";

export async function loadTeacherScope(
  db: SupabaseClient,
  actor: { userId: string; role: UserRole }
): Promise<TeacherScope> {
  const result = await readAllSupabaseRows<BindingScopeRow>((from, to) =>
    db
      .from("teacher_student_bindings")
      .select(SCOPE_FIELDS)
      .eq("teacher_id", actor.userId)
      .order("student_id", { ascending: true })
      .range(from, to)
  );
  if (result.error) throw new Error(result.error.message);

  const teacherDomainSet = new Set<StudentBindingDomain>();
  const studentDomainSets = new Map<string, Set<StudentBindingDomain>>();
  const studentProfileById = new Map<string, TeacherScopeStudentProfile>();
  const visibleStudentIdSet = new Set<string>();

  for (const row of result.data ?? []) {
    const domain = String(row.domain);
    if (domain !== "reading" && domain !== "writing") continue;
    const studentId = String(row.student_id);
    teacherDomainSet.add(domain);

    const domains = studentDomainSets.get(studentId) ?? new Set<StudentBindingDomain>();
    domains.add(domain);
    studentDomainSets.set(studentId, domains);

    const embedded = Array.isArray(row.student) ? row.student[0] : row.student;
    if (!embedded) continue;
    if (embedded.role !== "student" || embedded.is_active !== true) continue;
    visibleStudentIdSet.add(studentId);
    if (!studentProfileById.has(studentId)) {
      studentProfileById.set(studentId, {
        studentId,
        displayName: getPreferredUserDisplayName({
          email: embedded.email,
          profileFullName: embedded.full_name
        }),
        email: embedded.email?.trim() ?? "",
        fullName: embedded.full_name
      });
    }
  }

  const sortDomains = (domains: Iterable<StudentBindingDomain>) => {
    const values = Array.from(domains);
    return STUDENT_BINDING_DOMAINS.filter((domain) => values.includes(domain));
  };
  const studentDomains = new Map<string, StudentBindingDomain[]>(
    Array.from(studentDomainSets, ([studentId, domains]) => [studentId, sortDomains(domains)])
  );
  const visibleStudentIds = Array.from(visibleStudentIdSet).sort();
  const writingStudentIds = visibleStudentIds.filter((studentId) =>
    studentDomains.get(studentId)?.includes("writing")
  );
  const readingStudentIds = visibleStudentIds.filter((studentId) =>
    studentDomains.get(studentId)?.includes("reading")
  );

  return {
    userId: actor.userId,
    role: actor.role,
    teacherDomains: sortDomains(teacherDomainSet),
    studentDomains,
    visibleStudentIds,
    studentProfiles: studentProfileById,
    writingStudentIds,
    readingStudentIds
  };
}

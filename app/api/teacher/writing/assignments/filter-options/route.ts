import { readAllSupabaseRows } from "@/lib/supabasePagination";
import { getPreferredUserDisplayName } from "@/lib/userDisplayName";
import {
  chunkValues,
  requireWritingAssignmentTeacher,
  writingAssignmentJson
} from "@/lib/writingAssignmentsServer";
import type { WritingAssignmentRecipient } from "@/lib/writingAssignments";

export const dynamic = "force-dynamic";

type ProfileRow = { id: string; email: string | null; full_name: string | null };
type DirectRecipientRow = { student_id: string; assignment_id: string };

/**
 * Lightweight source for the 学生作业 student filter.
 *
 * The option set is exactly the recipients of direct (non-class) assignments,
 * including students who are no longer bound: it is therefore derived from the
 * assignment recipient relation, not from the current teacher-student
 * bindings.
 *
 * PostgREST cannot return DISTINCT rows, so the exact set still requires
 * reading the recipient rows once. The previous implementation walked all
 * direct groups, then all their assignments, then all recipients; this version
 * reads the recipient projection directly through the existing foreign keys
 * (`writing_assignment_students.assignment_id -> writing_assignments`), only
 * once for standalone assignments and once for direct class-less groups.
 * No assignment, attempt or review rows are loaded, and names come from one
 * batched profile read.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireWritingAssignmentTeacher(request);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.teacherId) {
      return writingAssignmentJson({ message: "无权访问教师端作业数据。" }, { status: 401 });
    }

    const [standaloneRows, directGroupRows] = await Promise.all([
      readDirectRecipients(auth.supabase, auth.teacherId, "standalone"),
      readDirectRecipients(auth.supabase, auth.teacherId, "group")
    ]);

    const studentIds = new Set<string>();
    for (const row of standaloneRows) studentIds.add(String(row.student_id));
    for (const row of directGroupRows) studentIds.add(String(row.student_id));

    const profiles = await readProfiles(auth.supabase, Array.from(studentIds));
    const profileById = new Map(profiles.map((profile) => [profile.id, profile]));
    const collator = new Intl.Collator("zh-Hans-CN");
    const students: WritingAssignmentRecipient[] = Array.from(studentIds, (studentId) => {
      const profile = profileById.get(studentId);
      return {
        student_id: studentId,
        student_name: getPreferredUserDisplayName({
          email: profile?.email,
          profileFullName: profile?.full_name
        })
      };
    }).sort(
      (left, right) =>
        collator.compare(left.student_name, right.student_name) ||
        left.student_id.localeCompare(right.student_id)
    );

    return writingAssignmentJson({ students });
  } catch (error) {
    console.error("[writing-assignments] filter_options_load_failed", error);
    return writingAssignmentJson(
      { code: "ASSIGNMENT_FILTER_OPTIONS_LOAD_FAILED", message: "学生筛选列表加载失败，请稍后重试。" },
      { status: 500 }
    );
  }
}

/**
 * Direct-assignment recipients in one projection.
 *
 * - `standalone`: legacy and new assignments with no group.
 * - `group`: assignments inside a group whose `class_id` is null.
 *
 * `!inner` makes the assignment/group filters apply to the top-level recipient
 * rows; soft-deleted assignments are excluded exactly as before. The secondary
 * `assignment_id` order keeps range pagination stable for students with
 * several assignments.
 */
async function readDirectRecipients(
  supabase: NonNullable<Awaited<ReturnType<typeof requireWritingAssignmentTeacher>>["supabase"]>,
  teacherId: string,
  kind: "standalone" | "group"
): Promise<DirectRecipientRow[]> {
  const assignmentEmbed =
    kind === "standalone"
      ? "assignment:writing_assignments!inner(teacher_id,deleted_at,group_id)"
      : "assignment:writing_assignments!inner(teacher_id,deleted_at,group:writing_assignment_groups!inner(class_id))";
  const result = await readAllSupabaseRows<DirectRecipientRow>((from, to) => {
    let query = supabase
      .from("writing_assignment_students")
      .select(`student_id,assignment_id,${assignmentEmbed}`)
      .is("assignment.deleted_at", null);
    query = kind === "standalone"
      ? query
          .eq("assignment.teacher_id", teacherId)
          .is("assignment.group_id", null)
      : query
          .eq("assignment.group.teacher_id", teacherId)
          .is("assignment.group.class_id", null);
    return query
      .order("student_id", { ascending: true })
      .order("assignment_id", { ascending: true })
      .range(from, to);
  });
  if (result.error) throw result.error;
  return result.data ?? [];
}

async function readProfiles(
  supabase: NonNullable<Awaited<ReturnType<typeof requireWritingAssignmentTeacher>>["supabase"]>,
  studentIds: string[]
): Promise<ProfileRow[]> {
  const rows: ProfileRow[] = [];
  for (const batch of chunkValues(studentIds)) {
    const result = await readAllSupabaseRows<ProfileRow>((from, to) =>
      supabase
        .from("profiles")
        .select("id,email,full_name")
        .in("id", batch)
        .order("id", { ascending: true })
        .range(from, to)
    );
    if (result.error) throw result.error;
    rows.push(...(result.data ?? []));
  }
  return rows;
}

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

/**
 * Lightweight source for the 学生作业 student filter.
 *
 * It reads only ids + names of the recipients of direct assignments; it never
 * loads assignment rows, attempts or reviews, so generating the picker does
 * not read the full assignment history. The list endpoint still applies the
 * student filter itself before pagination.
 */
export async function GET(request: Request) {
  try {
    const auth = await requireWritingAssignmentTeacher(request);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.teacherId) {
      return writingAssignmentJson({ message: "无权访问教师端作业数据。" }, { status: 401 });
    }

    const groupResult = await readAllSupabaseRows<{ group_id: string }>((from, to) =>
      auth.supabase!
        .from("writing_assignment_groups")
        .select("group_id")
        .eq("teacher_id", auth.teacherId!)
        .is("class_id", null)
        .order("group_id", { ascending: true })
        .range(from, to)
    );
    if (groupResult.error) throw groupResult.error;
    const directGroupIds = (groupResult.data ?? []).map((row) => String(row.group_id));

    const assignmentIds = new Set<string>();
    const standaloneResult = await readAllSupabaseRows<{ assignment_id: string }>((from, to) =>
      auth.supabase!
        .from("writing_assignments")
        .select("assignment_id")
        .eq("teacher_id", auth.teacherId!)
        .is("group_id", null)
        .is("deleted_at", null)
        .order("assignment_id", { ascending: true })
        .range(from, to)
    );
    if (standaloneResult.error) throw standaloneResult.error;
    for (const row of standaloneResult.data ?? []) {
      assignmentIds.add(String(row.assignment_id));
    }
    for (const batch of chunkValues(directGroupIds)) {
      const result = await readAllSupabaseRows<{ assignment_id: string }>((from, to) =>
        auth.supabase!
          .from("writing_assignments")
          .select("assignment_id")
          .in("group_id", batch)
          .is("deleted_at", null)
          .order("assignment_id", { ascending: true })
          .range(from, to)
      );
      if (result.error) throw result.error;
      for (const row of result.data ?? []) {
        assignmentIds.add(String(row.assignment_id));
      }
    }

    const studentIds = new Set<string>();
    for (const batch of chunkValues(Array.from(assignmentIds))) {
      const result = await readAllSupabaseRows<{ student_id: string }>((from, to) =>
        auth.supabase!
          .from("writing_assignment_students")
          .select("student_id")
          .in("assignment_id", batch)
          .order("student_id", { ascending: true })
          .range(from, to)
      );
      if (result.error) throw result.error;
      for (const row of result.data ?? []) studentIds.add(String(row.student_id));
    }

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

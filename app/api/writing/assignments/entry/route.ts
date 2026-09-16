import type { WritingTaskType } from "@/lib/writing";
import type { WritingAssignmentLifecycleStatus } from "@/lib/writingAssignments";
import { embeddedAssignment } from "@/lib/studentWritingAssignments.server";
import { requireWritingStudent, writingJson } from "@/lib/writingServer";

export const dynamic = "force-dynamic";

type EntryAssignmentRow = {
  assignment_id: string;
  deleted_at: string | null;
  question_id: string;
  status: WritingAssignmentLifecycleStatus;
  task_type: WritingTaskType;
};

type EntryMembershipRow = {
  writing_assignments: EntryAssignmentRow | EntryAssignmentRow[] | null;
};

export async function GET(request: Request) {
  try {
    const assignmentId = new URL(request.url).searchParams.get("assignmentId")?.trim() ?? "";
    if (!assignmentId) {
      return writingJson({ error: "缺少作业编号。" }, { status: 400 });
    }
    const auth = await requireWritingStudent(request);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.userId) {
      return writingJson({ error: "Unauthorized" }, { status: 401 });
    }
    const result = await auth.supabase
      .from("writing_assignment_students")
      .select(`
        writing_assignments!inner(
          assignment_id,
          task_type,
          question_id:question_snapshot->>question_id,
          status,
          deleted_at
        )
      `)
      .eq("student_id", auth.userId)
      .eq("assignment_id", assignmentId)
      .maybeSingle();
    if (result.error) {
      return writingJson({ error: "暂时无法加载这项作业。" }, { status: 500 });
    }
    const row = result.data as unknown as EntryMembershipRow | null;
    const assignment = embeddedAssignment(row?.writing_assignments ?? null);
    if (!assignment || assignment.deleted_at) {
      return writingJson({ error: "未找到这项写作作业。" }, { status: 404 });
    }
    return writingJson({ assignment });
  } catch {
    return writingJson({ error: "暂时无法加载这项作业。" }, { status: 500 });
  }
}

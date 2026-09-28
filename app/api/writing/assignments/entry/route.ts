import type { AssignmentItemType } from "@/lib/assignmentCatalog";
import type { WritingAssignmentLifecycleStatus } from "@/lib/writingAssignments";
import {
  embeddedAssignment,
  resolvedAssignmentItemId
} from "@/lib/studentWritingAssignments.server";
import { requireWritingStudent, writingJson } from "@/lib/writingServer";

export const dynamic = "force-dynamic";

type EntryAssignmentRow = {
  assignment_id: string;
  deleted_at: string | null;
  question_id: string | null;
  snapshot_question_id: string | null;
  snapshot_item_id: string | null;
  snapshot_source_set_id: string | null;
  status: WritingAssignmentLifecycleStatus;
  task_type: AssignmentItemType;
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
          question_id,
          snapshot_question_id:question_snapshot->>question_id,
          snapshot_item_id:question_snapshot->>item_id,
          snapshot_source_set_id:question_snapshot->>source_set_id,
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
      return writingJson({ error: "未找到这项作业。" }, { status: 404 });
    }
    return writingJson({
      assignment: {
        assignment_id: assignment.assignment_id,
        question_id: resolvedAssignmentItemId(assignment),
        source_set_id: assignment.snapshot_source_set_id?.trim() || null,
        status: assignment.status,
        task_type: assignment.task_type
      }
    });
  } catch {
    return writingJson({ error: "暂时无法加载这项作业。" }, { status: 500 });
  }
}

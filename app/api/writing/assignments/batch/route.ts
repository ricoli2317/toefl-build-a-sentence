import {
  STUDENT_ASSIGNMENT_DETAIL_SELECT,
  loadStudentAssignmentDetails,
  type StudentAssignmentMembershipDetailRow
} from "@/lib/studentWritingAssignments.server";
import { requireWritingStudent, writingJson } from "@/lib/writingServer";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const batchId = new URL(request.url).searchParams.get("batchId")?.trim() ?? "";
    if (!batchId) {
      return writingJson({ error: "缺少作业组编号。" }, { status: 400 });
    }
    const auth = await requireWritingStudent(request);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.userId) {
      return writingJson({ error: "Unauthorized" }, { status: 401 });
    }
    const membershipResult = await auth.supabase
      .from("writing_assignment_students")
      .select(STUDENT_ASSIGNMENT_DETAIL_SELECT)
      .eq("student_id", auth.userId)
      .eq("writing_assignments.group_id", batchId)
      .eq("writing_assignments.status", "active")
      .is("writing_assignments.deleted_at", null)
      .order("assigned_at", { ascending: false })
      .limit(5000);
    if (membershipResult.error) {
      return writingJson({ error: "暂时无法加载这组作业。" }, { status: 500 });
    }
    const details = await loadStudentAssignmentDetails({
      memberships: (membershipResult.data ?? []) as unknown as StudentAssignmentMembershipDetailRow[],
      userId: auth.userId
    });
    if (!details.assignments) {
      return writingJson({ error: "暂时无法加载这组作业。" }, { status: 500 });
    }
    return writingJson({ assignments: details.assignments });
  } catch {
    return writingJson({ error: "暂时无法加载这组作业。" }, { status: 500 });
  }
}

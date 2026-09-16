import {
  STUDENT_ASSIGNMENT_DETAIL_SELECT,
  loadStudentAssignmentDetails,
  type StudentAssignmentMembershipDetailRow
} from "@/lib/studentWritingAssignments.server";
import {
  assignmentDateRange,
  isAssignmentDateKey
} from "@/lib/writingAssignments";
import { requireWritingStudent, writingJson } from "@/lib/writingServer";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const date = new URL(request.url).searchParams.get("date") ?? "";
    if (!isAssignmentDateKey(date)) {
      return writingJson({ error: "日期格式无效。" }, { status: 400 });
    }
    const range = assignmentDateRange(date)!;
    const auth = await requireWritingStudent(request);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.userId) {
      return writingJson({ error: "Unauthorized" }, { status: 401 });
    }

    const membershipResult = await auth.supabase
      .from("writing_assignment_students")
      .select(STUDENT_ASSIGNMENT_DETAIL_SELECT)
      .eq("student_id", auth.userId)
      .gte("assigned_at", range.startInclusive)
      .lt("assigned_at", range.endExclusive)
      .eq("writing_assignments.status", "active")
      .is("writing_assignments.deleted_at", null)
      .order("assigned_at", { ascending: false })
      .limit(5000);
    if (membershipResult.error) {
      return writingJson({ error: "暂时无法加载当日作业。" }, { status: 500 });
    }
    const details = await loadStudentAssignmentDetails({
      memberships: (membershipResult.data ?? []) as unknown as StudentAssignmentMembershipDetailRow[],
      supabase: auth.supabase,
      userId: auth.userId
    });
    if (!details.assignments) {
      return writingJson({ error: "暂时无法加载当日作业。" }, { status: 500 });
    }
    return writingJson({ assignments: details.assignments, date });
  } catch {
    return writingJson({ error: "暂时无法加载当日作业。" }, { status: 500 });
  }
}

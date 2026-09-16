import {
  STUDENT_ASSIGNMENT_DETAIL_SELECT,
  loadStudentAssignmentDetails,
  type StudentAssignmentMembershipDetailRow
} from "@/lib/studentWritingAssignments.server";
import {
  assignmentDateRange,
  isAssignmentDateKey
} from "@/lib/writingAssignments";
import { createStudentPerformanceTrace } from "@/lib/studentPerformance.server";
import { loadWritingStudentData, writingJson } from "@/lib/writingServer";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const timing = createStudentPerformanceTrace("/api/writing/assignments/day");
  try {
    const date = new URL(request.url).searchParams.get("date") ?? "";
    if (!isAssignmentDateKey(date)) {
      return writingJson({ error: "日期格式无效。" }, { status: 400 }, timing);
    }
    const range = assignmentDateRange(date)!;
    const access = await loadWritingStudentData(request, ({ supabase, userId }) =>
      timing.measure("database", "assignment_day_index", () =>
        supabase
          .from("writing_assignment_students")
          .select(STUDENT_ASSIGNMENT_DETAIL_SELECT)
          .eq("student_id", userId)
          .gte("assigned_at", range.startInclusive)
          .lt("assigned_at", range.endExclusive)
          .eq("writing_assignments.status", "active")
          .is("writing_assignments.deleted_at", null)
          .order("assigned_at", { ascending: false })
          .limit(5000)
      ),
      timing
    );
    if (access.error) return access.error;
    if (!access.data || !access.supabase || !access.userId) {
      return writingJson({ error: "暂时无法加载当日作业。" }, { status: 500 }, timing);
    }
    const membershipResult = access.data;
    if (membershipResult.error) {
      return writingJson({ error: "暂时无法加载当日作业。" }, { status: 500 }, timing);
    }
    const details = await loadStudentAssignmentDetails({
      memberships: (membershipResult.data ?? []) as unknown as StudentAssignmentMembershipDetailRow[],
      timing,
      userId: access.userId
    });
    if (!details.assignments) {
      return writingJson({ error: "暂时无法加载当日作业。" }, { status: 500 }, timing);
    }
    return writingJson({ assignments: details.assignments, date }, undefined, timing);
  } catch {
    return writingJson({ error: "暂时无法加载当日作业。" }, { status: 500 }, timing);
  }
}

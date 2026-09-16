import type { WritingTaskType } from "@/lib/writing";
import {
  assignmentDateKey,
  assignmentMonthRange,
  isAssignmentMonthKey,
  type StudentWritingAssignmentCalendarItem
} from "@/lib/writingAssignments";
import { embeddedAssignment } from "@/lib/studentWritingAssignments.server";
import { requireWritingStudent, writingJson } from "@/lib/writingServer";

export const dynamic = "force-dynamic";

type CalendarAssignmentRow = {
  assignment_id: string;
  task_type: WritingTaskType;
  title: string;
};

type CalendarMembershipRow = {
  assignment_id: string;
  assigned_at: string;
  writing_assignments: CalendarAssignmentRow | CalendarAssignmentRow[] | null;
};

export async function GET(request: Request) {
  try {
    const month = new URL(request.url).searchParams.get("month") ?? "";
    if (!isAssignmentMonthKey(month)) {
      return writingJson({ error: "月份格式无效。" }, { status: 400 });
    }
    const range = assignmentMonthRange(month)!;
    const auth = await requireWritingStudent(request);
    if (auth.error) return auth.error;
    if (!auth.supabase || !auth.userId) {
      return writingJson({ error: "Unauthorized" }, { status: 401 });
    }

    const result = await auth.supabase
      .from("writing_assignment_students")
      .select(`
        assignment_id,
        assigned_at,
        writing_assignments!inner(
          assignment_id,
          task_type,
          title:question_snapshot->>set_title
        )
      `)
      .eq("student_id", auth.userId)
      .gte("assigned_at", range.startInclusive)
      .lt("assigned_at", range.endExclusive)
      .eq("writing_assignments.status", "active")
      .is("writing_assignments.deleted_at", null)
      .order("assigned_at", { ascending: true })
      .limit(5000);
    if (result.error) {
      return writingJson({ error: "暂时无法加载作业月历。" }, { status: 500 });
    }

    const assignments = ((result.data ?? []) as unknown as CalendarMembershipRow[])
      .flatMap((membership): StudentWritingAssignmentCalendarItem[] => {
        const assignment = embeddedAssignment(membership.writing_assignments);
        const date = assignmentDateKey(membership.assigned_at);
        if (!assignment || !date || !assignment.title) return [];
        return [{
          assignment_id: assignment.assignment_id,
          assignment_date: date,
          task_type: assignment.task_type,
          title: assignment.title
        }];
      });
    return writingJson({ assignments, month });
  } catch {
    return writingJson({ error: "暂时无法加载作业月历。" }, { status: 500 });
  }
}

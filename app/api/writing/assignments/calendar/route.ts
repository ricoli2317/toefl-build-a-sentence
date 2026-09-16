import type { WritingTaskType } from "@/lib/writing";
import {
  assignmentDateKey,
  assignmentMonthRange,
  isAssignmentMonthKey,
  type StudentWritingAssignmentCalendarItem
} from "@/lib/writingAssignments";
import { embeddedAssignment } from "@/lib/studentWritingAssignments.server";
import { createStudentPerformanceTrace } from "@/lib/studentPerformance.server";
import { loadWritingStudentData, writingJson } from "@/lib/writingServer";

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
  const timing = createStudentPerformanceTrace("/api/writing/assignments/calendar");
  try {
    const month = new URL(request.url).searchParams.get("month") ?? "";
    if (!isAssignmentMonthKey(month)) {
      return writingJson({ error: "月份格式无效。" }, { status: 400 }, timing);
    }
    const range = assignmentMonthRange(month)!;
    const access = await loadWritingStudentData(request, ({ supabase, userId }) =>
      timing.measure("database", "assignment_calendar_index", () =>
        supabase
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
          .eq("student_id", userId)
          .gte("assigned_at", range.startInclusive)
          .lt("assigned_at", range.endExclusive)
          .eq("writing_assignments.status", "active")
          .is("writing_assignments.deleted_at", null)
          .order("assigned_at", { ascending: true })
          .limit(5000)
      ),
      timing
    );
    if (access.error) return access.error;
    const result = access.data;
    if (!result) {
      return writingJson({ error: "暂时无法加载作业月历。" }, { status: 500 }, timing);
    }
    if (result.error) {
      return writingJson({ error: "暂时无法加载作业月历。" }, { status: 500 }, timing);
    }

    const assignments = timing.measureSync("processing", "calendar_payload", () =>
      ((result.data ?? []) as unknown as CalendarMembershipRow[])
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
        })
    );
    return writingJson({ assignments, month }, undefined, timing);
  } catch {
    return writingJson({ error: "暂时无法加载作业月历。" }, { status: 500 }, timing);
  }
}

import type { WritingTaskType } from "@/lib/writing";
import {
  assignmentDateKey,
  assignmentMonthRange,
  isAssignmentMonthKey,
  type StudentWritingAssignmentCalendarItem,
  type WritingAssignmentQuestionSource
} from "@/lib/writingAssignments";
import { embeddedAssignment } from "@/lib/studentWritingAssignments.server";
import { loadWritingAssignmentDisplayNames } from "@/lib/historicalPracticeDisplay";
import { createServiceSupabase } from "@/lib/supabase/server";
import { createStudentPerformanceTrace } from "@/lib/studentPerformance.server";
import { loadWritingStudentData, writingJson } from "@/lib/writingServer";

export const dynamic = "force-dynamic";

type CalendarAssignmentRow = {
  assignment_id: string;
  task_type: WritingTaskType;
  question_source: WritingAssignmentQuestionSource;
  question_id: string | null;
  title: string | null;
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
              question_source,
              question_id:question_snapshot->>question_id,
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

    const entries = ((result.data ?? []) as unknown as CalendarMembershipRow[])
      .flatMap((membership) => {
        const assignment = embeddedAssignment(membership.writing_assignments);
        const date = assignmentDateKey(membership.assigned_at);
        const fallbackDisplayName = assignment?.title?.trim() ?? "";
        if (!assignment || !date || !fallbackDisplayName) return [];
        return [{ assignment, date, fallbackDisplayName }];
      });
    const displayNames = await loadWritingAssignmentDisplayNames(
      createServiceSupabase(),
      entries.map(({ assignment, fallbackDisplayName }) => ({
        assignmentId: String(assignment.assignment_id),
        fallbackDisplayName,
        questionId: assignment.question_id,
        questionSource: assignment.question_source,
        taskType: assignment.task_type
      })),
      timing
    );
    const assignments = timing.measureSync("processing", "calendar_payload", () =>
      entries.map(({ assignment, date, fallbackDisplayName }): StudentWritingAssignmentCalendarItem => {
        const assignmentId = String(assignment.assignment_id);
        return {
          assignment_id: assignmentId,
          assignment_date: date,
          task_type: assignment.task_type,
          title: displayNames.get(assignmentId) ?? fallbackDisplayName
        };
      })
    );
    return writingJson({ assignments, month }, undefined, timing);
  } catch {
    return writingJson({ error: "暂时无法加载作业月历。" }, { status: 500 }, timing);
  }
}

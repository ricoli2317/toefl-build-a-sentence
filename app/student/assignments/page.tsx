import { StudentWritingAssignmentCalendar } from "@/components/student/StudentWritingAssignments";
import { StudentPage } from "@/components/student/StudentUI";
import { assignmentMonthKey, isAssignmentMonthKey } from "@/lib/writingAssignments";

export default function StudentAssignmentsPage({
  searchParams
}: {
  searchParams: { month?: string | string[] };
}) {
  const requestedMonth = Array.isArray(searchParams.month)
    ? searchParams.month[0]
    : searchParams.month;
  const initialMonth = requestedMonth && isAssignmentMonthKey(requestedMonth)
    ? requestedMonth
    : assignmentMonthKey();
  return (
    <StudentPage subtitle="查看教师布置的作业，继续练习或查看结果。" title="我的作业">
      <StudentWritingAssignmentCalendar initialMonth={initialMonth} />
    </StudentPage>
  );
}

import { StudentWritingAssignmentDayDetail } from "@/components/student/StudentWritingAssignments";
import { StudentPage } from "@/components/student/StudentUI";
import { formatAssignmentDate, isAssignmentDateKey } from "@/lib/writingAssignments";

export default function StudentWritingAssignmentDayPage({
  params
}: {
  params: { date: string };
}) {
  const valid = isAssignmentDateKey(params.date);
  return (
    <StudentPage
      subtitle="仅显示这一天布置的写作任务。"
      title={valid ? formatAssignmentDate(params.date) : "作业日期无效"}
    >
      {valid ? (
        <StudentWritingAssignmentDayDetail date={params.date} />
      ) : null}
    </StudentPage>
  );
}

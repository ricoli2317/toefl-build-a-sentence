import { StudentWritingAssignmentDayDetail } from "@/components/student/StudentWritingAssignments";
import { StudentPage } from "@/components/student/StudentUI";
import { safeStudentReturnTo } from "@/lib/studentNavigation";
import { formatAssignmentDate, isAssignmentDateKey } from "@/lib/writingAssignments";

export default function StudentWritingAssignmentDayPage({
  params,
  searchParams
}: {
  params: { date: string };
  searchParams: { returnTo?: string | string[] };
}) {
  const valid = isAssignmentDateKey(params.date);
  return (
    <StudentPage
      subtitle="仅显示这一天布置的作业。"
      title={valid ? formatAssignmentDate(params.date) : "作业日期无效"}
    >
      {valid ? (
        <StudentWritingAssignmentDayDetail
          date={params.date}
          returnTo={safeStudentReturnTo(searchParams.returnTo)}
        />
      ) : null}
    </StudentPage>
  );
}

import { StudentPracticeHistory } from "@/components/student/StudentPracticeHistory";
import { StudentPage } from "@/components/student/StudentUI";
import { firstSearchParamValue } from "@/lib/studentPracticeHistory";

export default function StudentPracticeHistoryPage({
  searchParams
}: {
  searchParams?: {
    date?: string | string[];
    end?: string | string[];
    start?: string | string[];
    tasks?: string | string[];
    view?: string | string[];
  };
}) {
  return (
    <StudentPage title="练习历史">
      <StudentPracticeHistory
        initialDate={firstSearchParamValue(searchParams?.date)}
        initialEnd={firstSearchParamValue(searchParams?.end)}
        initialStart={firstSearchParamValue(searchParams?.start)}
        initialTasks={firstSearchParamValue(searchParams?.tasks)}
        initialView={firstSearchParamValue(searchParams?.view)}
      />
    </StudentPage>
  );
}

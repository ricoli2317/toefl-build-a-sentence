import { LogicalPracticeCatalog } from "@/components/LogicalPracticeCatalog";
import { StudentPage } from "@/components/student/StudentUI";
import { parseLogicalCatalogPage } from "@/lib/practiceLogicalNavigation";

export default function AcademicDiscussionPage({
  searchParams
}: {
  searchParams: { page?: string | string[] };
}) {
  return (
    <StudentPage title="Academic Discussion">
      <LogicalPracticeCatalog
        page={parseLogicalCatalogPage(searchParams.page)}
        taskType="academic_discussion"
      />
    </StudentPage>
  );
}

import { LogicalPracticeCatalog } from "@/components/LogicalPracticeCatalog";
import { StudentPage } from "@/components/student/StudentUI";
import { parseLogicalCatalogPage } from "@/lib/practiceLogicalNavigation";

export default function WriteEmailPage({
  searchParams
}: {
  searchParams: { page?: string | string[] };
}) {
  return (
    <StudentPage title="Write an Email">
      <LogicalPracticeCatalog
        page={parseLogicalCatalogPage(searchParams.page)}
        taskType="email"
      />
    </StudentPage>
  );
}

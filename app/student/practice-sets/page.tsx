import { LogicalPracticeCatalog } from "@/components/LogicalPracticeCatalog";
import { StudentPage } from "@/components/student/StudentUI";
import { parseLogicalCatalogPage } from "@/lib/practiceLogicalNavigation";

export default function StudentPracticeSetsPage({
  searchParams
}: {
  searchParams: { page?: string | string[] };
}) {
  return (
    <StudentPage title="Build a Sentence">
      <LogicalPracticeCatalog
        page={parseLogicalCatalogPage(searchParams.page)}
        taskType="build_sentence"
      />
    </StudentPage>
  );
}

import { ReadingFullSetCatalog } from "@/components/reading/ReadingFullSetCatalog";
import { StudentPage } from "@/components/student/StudentUI";

export default function ReadingFullSetsPage() {
  return (
    <StudentPage
      subtitle="按原始考试组合练习完整 Reading Module，提前查看每个 Module 的题量与时间。"
      title="套题练习"
    >
      <ReadingFullSetCatalog />
    </StudentPage>
  );
}

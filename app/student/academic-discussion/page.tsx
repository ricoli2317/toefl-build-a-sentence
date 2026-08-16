import { WritingMonthList } from "@/components/writing/WritingCatalog";
import { StudentPage } from "@/components/student/StudentUI";

export default function AcademicDiscussionPage() {
  return (
    <StudentPage subtitle="选择月份，开始或继续学术讨论写作练习。" title="Academic Discussion">
      <WritingMonthList taskType="academic_discussion" />
    </StudentPage>
  );
}

import { WritingMonthList } from "@/components/writing/WritingCatalog";
import { StudentPage } from "@/components/student/StudentUI";

export default function WriteEmailPage() {
  return (
    <StudentPage subtitle="选择月份，开始或继续邮件写作练习。" title="Write an Email">
      <WritingMonthList taskType="email" />
    </StudentPage>
  );
}
